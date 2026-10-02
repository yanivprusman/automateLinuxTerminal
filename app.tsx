import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useStdin } from "ink";
import { createWriteStream, statSync } from "fs";
import type { WriteStream } from "fs";
import { spawn } from "child_process";
import pty from "node-pty";
import xterm from "@xterm/headless";
const { Terminal: XTerminal } = xterm;

import type { Span, Line, Selection, ContextMenuState, SessionHistoryEntry } from "./types.js";
import { SESSION_ID, LAUNCH_DIR, SCRIPT_LOG_FILE, publishSessionMetadata, writeTopic, writePidTopic, propagateTopicToDashboard, fetchStoredTopic, readStoredTopic, cleanupMetadata, notifySessionEnded, detectClaudeSession, noteLiveSessionId, currentSessionId, isPidAlive, claimHostWindow, publishWindowClaim, readBookmarkedIds, setBookmarked } from "./session.js";
import { EMPTY_SPAN, spansEqual, normalizeSelection, readBufferRow, readBuffer } from "./buffer.js";
import { SESSION_MENU_INNER, formatStopwatch, computeMenuLayout, sessionRowAt, topicRowItem, topicBarWidth, marqueeWindow } from "./menu.js";
import { topicKeyAt, applyTopicAction, insertTopicText, insertFieldText } from "./topicEdit.js";
import { useMarqueeTick } from "./marquee.js";
import { ContextMenuOverlay } from "./ContextMenuOverlay.js";
import { SendDialogOverlay } from "./SendDialogOverlay.js";
import { SendFlow, openTyping, computeSendLayout, sendHitTest, fieldKeyAt, applyFieldAction, normalizeNewlines, NEWLINE, SEND_ITEM, SEND_DIALOG_INNER, FIELD_WIDTH, deliveryRefusal, SUBMIT_DELAY_MS, MESSAGE_MAX_CHARS } from "./sendToSession.js";
import type { SendDialogState, SendIo } from "./sendToSession.js";
import { startRecording, transcribeRecording, fixSpelling } from "./dictation.js";
import { clipboardWrite, clipboardRead } from "./clipboard.js";
import { resumeKeystrokes, shellState } from "./resume.js";
import { LAUNCH_KEYS, launchRefusal } from "./launch.js";
import { runExitSequence } from "./exit.js";
import { isVoiceMuted, isVoiceMutedGlobally, setVoiceMuted } from "./voice.js";

// The Claude Voice history window, narrowed to one session. A script rather than a URL we
// open ourselves: it owns "raise the existing window instead of piling up duplicates", and
// being a script it is re-read on every run -- that behaviour can change without rebuilding
// this terminal.
const VOICE_HISTORY_CMD = "/root/bin/claude-voice-history";
const SAY_CTL_CMD = "/root/bin/say-ctl";
// The Claude Voice paste box, opened holding the selection (the clipboard menu's "Say"). It
// owns its own single window -- an open one is refilled rather than duplicated -- and the
// text goes in on stdin, never argv, so a selection starting with "-" is text, not a flag.
// Through runInGuiSession so the window is not a child of this tab's scope: the first launch
// IS the window, and closing the tab must not take it with it.
const SPEAK_TEXT_CMD = "/root/bin/speak-text";
const RUN_IN_GUI_SESSION = "/opt/automateLinux/utilities/runInGuiSession.sh";

function Clock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  const date = now.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return (
    <Text>
      <Text color="cyan" bold>{time}</Text>
      <Text dimColor> {date}</Text>
    </Text>
  );
}

const TerminalLine = React.memo(function TerminalLine({ spans }: { spans: Span[] }) {
  return (
    <Text wrap="truncate">
      {spans.map((s, i) => (
        <Text
          key={i}
          color={s.fg}
          backgroundColor={s.bg}
          bold={s.bold}
          dimColor={s.dim}
          italic={s.italic}
          underline={s.underline}
          strikethrough={s.strikethrough}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
});

/** The pinned topic bar — the same sign as the menu row, drawn on the terminal itself.
 *
 *  It hangs off the RIGHT edge, so before this a long topic pushed its own left edge across
 *  the screen and eventually off it; now the bar is capped and the text scrolls inside it
 *  instead. Capped rather than full-width because this box is drawn over live terminal
 *  output — it may borrow a corner of a line, never the line. */
function TopicSign({ text, cols }: { text: string; cols: number }) {
  const width = Math.min(text.length, topicBarWidth(cols));
  const tick = useMarqueeTick(text.length > width, text);
  return (
    <Box position="absolute" marginTop={1} marginLeft={Math.max(0, cols - width - 2)}>
      <Text backgroundColor="#1c1c1c" color="#ad7fa8">{` ${marqueeWindow(text, width, tick)} `}</Text>
    </Box>
  );
}

function TerminalEmulator({ rows, cols }: { rows: number; cols: number }) {
  const { stdin, setRawMode } = useStdin();
  const [lines, setLines] = useState<Line[]>(() =>
    Array.from({ length: rows }, () => [EMPTY_SPAN])
  );
  const needsRefresh = useRef(false);
  const selection = useRef<Selection | null>(null);
  const termRef = useRef<InstanceType<typeof XTerminal> | null>(null);
  const shellRef = useRef<pty.IPty | null>(null);
  const dimsRef = useRef({ rows, cols });
  const cursorVisible = useRef(true);
  const lastCursorPos = useRef({ row: -1, col: -1 });
  const contentDirty = useRef(true);
  const contentCache = useRef<Line[]>([]);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<ContextMenuState | null>(null);
  // The "send to session" dialog, when open. It replaces the menu it was opened from and
  // owns every byte of input until it closes (processInput). The flow object holds the
  // recording and the effects; the state is what the overlay draws and the hit-test reads.
  const [sendDialog, setSendDialog] = useState<SendDialogState | null>(null);
  const sendRef = useRef<SendDialogState | null>(null);
  const sendFlowRef = useRef<SendFlow | null>(null);
  const stopwatchRef = useRef({ running: false, startMs: 0, accumulatedMs: 0 });
  const topicRef = useRef('');
  const showTopicBarRef = useRef(true);
  const [showTopicBar, setShowTopicBar] = useState(true);
  const swTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionHistoryRef = useRef<SessionHistoryEntry[]>([]);

  useEffect(() => {
    if (dimsRef.current.rows === rows && dimsRef.current.cols === cols && termRef.current) return;
    dimsRef.current = { rows, cols };
    if (termRef.current && shellRef.current) {
      termRef.current.resize(cols, rows);
      shellRef.current.resize(cols, rows);
      contentDirty.current = true;
      needsRefresh.current = true;
    }
  }, [rows, cols]);

  useEffect(() => {
    setRawMode(true);

    const term = new XTerminal({ rows, cols, scrollback: 500, allowProposedApi: true });
    termRef.current = term;

    const shellPath = process.env.SHELL || "bash";
    const shell = pty.spawn(shellPath, ["--login"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: LAUNCH_DIR || process.cwd(),
      env: { ...process.env, AUTOMATE_LINUX_TERMINAL: "1" } as Record<string, string>,
    });
    shellRef.current = shell;

    let scriptLogStream: WriteStream | null = null;
    // NOT gated on SESSION_ID. publishSessionMetadata stands the metadata file and
    // the dashboard registration under the session this tab is SHOWING, which at
    // startup is the launcher's id for a managed launch and nothing at all for a
    // tab opened by hand — that one publishes a few seconds later, when the title
    // poll finds the claude running in it. Gating on the env is what made every
    // hand-opened session invisible to the dashboard, the phone and the picker.
    publishSessionMetadata(shell.pid);
    writePidTopic(topicRef.current);
    if (SESSION_ID) {
      // Restore the topic set before a resume/reboot — it lives durably in the
      // dashboard keyed by the claude session id, which survives resumes. Only
      // fill an empty topic; a topic typed in THIS tab always wins.
      fetchStoredTopic().then(stored => {
        if (stored && !topicRef.current) {
          topicRef.current = stored;
          writeTopic(stored); writePidTopic(stored);
        }
      });
    }
    // The recording is the one piece of this tab the dashboard reads by PATH while
    // we hold an open fd to the INODE. Anything that unlinks or replaces the path
    // leaves us writing into an orphan: the recording keeps growing, invisibly, and
    // the card freezes at the moment of the unlink — a live session showing output
    // hours old (2026-08-08, session d56ebbab: two hours into a deleted inode). The
    // dashboard's /ended handler now refuses to unlink a live session's log, but a
    // writer that never notices its own file is gone is wrong regardless of who
    // removes it, so reconcile here too. Checked on a timer, not per write: this is
    // the per-keystroke path and a stat on every byte would be absurd.
    let scriptLogIno = 0;
    let scriptLogOpening = false;
    let scriptLogWatchId: ReturnType<typeof setInterval> | null = null;
    const openScriptLog = () => {
      scriptLogOpening = true;
      const stream = createWriteStream(SCRIPT_LOG_FILE, { flags: 'a' });
      stream.on('open', () => {
        try { scriptLogIno = statSync(SCRIPT_LOG_FILE).ino; } catch { scriptLogIno = 0; }
        scriptLogOpening = false;
      });
      // A write error must not take the tab down with it — the recording is a
      // convenience for the dashboard, not something the shell depends on.
      stream.on('error', () => { scriptLogOpening = false; });
      scriptLogStream = stream;
    };
    if (SCRIPT_LOG_FILE) {
      openScriptLog();
      scriptLogWatchId = setInterval(() => {
        if (scriptLogOpening) return;
        let ino = 0;
        try { ino = statSync(SCRIPT_LOG_FILE).ino; } catch { ino = 0; }
        // ino === 0 means the path is gone; a different ino means someone put a
        // new file where ours was. Both mean our fd no longer feeds the reader.
        if (ino === scriptLogIno) return;
        const previous = scriptLogStream;
        openScriptLog();
        try { previous?.end(); } catch {}
      }, 5000);
    }

    // The shell reports its directory with OSC 7 and xterm consumes it while
    // parsing, so forward it to the terminal hosting us (Ptyxis). That is how a
    // new tab knows where the tab that spawned it was. OSC occupies no cells,
    // so writing it between Ink frames does not disturb the rendering.
    let reportedCwd = "";
    term.parser.registerOscHandler(7, (uri: string) => {
      if (uri && uri !== reportedCwd) {
        reportedCwd = uri;
        process.stdout.write(`\x1b]7;${uri}\x1b\\`);
      }
      return true;
    });

    // Titles (OSC 0/2) are likewise consumed by xterm, so no title ever reached
    // Ptyxis -- every window stayed "Terminal", and Claude Voice's focus-session
    // (which finds a session's window by the title "claude-<sessionId>") could
    // never match one. Two explicit states:
    //   - a Claude session runs inside this terminal -> PIN the host title to its
    //     stable handle "claude-<sessionId>". Claude Code repaints the title with
    //     transient status text, which must not clobber the window's identity.
    //   - no Claude session -> forward child titles as-is (so `cl`'s launch-time
    //     title, used for its own windowId lookup, propagates too).
    let hostTitle = "";
    // `force` re-asserts a title this app already believes it set. Without it the
    // remembered value made the title write-once-per-value: anything else that
    // retitled the window (a launcher, a stray OSC from a program the pty did not
    // capture) owned it from then on, because the next sync saw "no change" and
    // wrote nothing. An OSC occupies no cells, so re-stating it costs nothing.
    const setHostTitle = (t: string, force = false) => {
      if (t && (force || t !== hostTitle)) {
        hostTitle = t;
        process.stdout.write(`\x1b]2;${t}\x07`);
      }
    };
    let claudeTitle = SESSION_ID ? `claude-${SESSION_ID}` : "";
    let childTitle = "";
    term.onTitleChange((t: string) => {
      childTitle = t;
      if (!claudeTitle) setHostTitle(t);
    });
    // This walk is the ONE place the running claude is identified. Everything
    // keyed by "the session in this tab" — the window title, the topic read and
    // write, the pid-topic file — reads it back through currentSessionId(), so
    // they can never disagree about which session this tab is showing.
    // What the window WEARS. A session id is unreadable — a row of tabs saying
    // `claude-c96f8e87-…` tells the user nothing about which is which — so a named
    // session wears its NAME, and only an unnamed one falls back to its handle.
    // This does not cost "focus this session's terminal" its discriminator: the
    // dashboard resolver counts a session's topic among the titles it may
    // legitimately be showing (terminal-window-match.ts::sessionWindowTitles), and
    // the window claim published above is consulted before any title anyway.
    const pinnedTitle = () => claudeTitle ? (topicRef.current || claudeTitle) : "";
    const syncClaudeTitle = () => {
      const info = detectClaudeSession(shell.pid);
      noteLiveSessionId(info?.sessionId);
      // A tab's session id is not fixed: it appears a second after startup, and a
      // /resume mints a new one. Re-file the window claim under whatever id the
      // tab is showing now, so focus keeps working under the id every other
      // surface has switched to. No-op unless the id actually changed.
      publishWindowClaim();
      // Same re-keying, for the file that says "a session lives in this tab" and
      // for its dashboard entry: a tab opened by hand has no session until a
      // claude starts in it, and a /resume replaces the one it had.
      publishSessionMetadata(shell.pid, info?.pid);
      claudeTitle = info && info.sessionId !== 'unknown' ? `claude-${info.sessionId}`
                  : SESSION_ID ? `claude-${SESSION_ID}` : "";
      // Runs every 5s, so a topic set or cleared anywhere — this tab's menu, the
      // dashboard card, the phone, the set-topic skill — reaches the title too
      // without every one of those paths having to know about the window.
      setHostTitle(pinnedTitle() || childTitle, true);
    };
    syncClaudeTitle();
    const titleSyncId = setInterval(syncClaudeTitle, 5000);

    // Adopt a topic set from outside this tab (the dashboard card, the phone,
    // the set-topic skill). The durable store keyed by the claude session id is
    // the single source of truth; without this poll the bar only ever showed a
    // topic typed here or restored at startup, so an external set looked lost.
    //
    // NOT gated on SESSION_ID: that is empty for every ordinary `terminal` tab,
    // which made this poll dead code exactly where it was needed — the topic
    // reached the dashboard and the phone but the bar above kept the old word.
    // currentSessionId() returns '' until a claude is actually running here, and
    // readStoredTopic answers null for that, so an idle tab still reads nothing.
    // Skipped while the topic is being edited here — the tab typing it wins.
    const topicSyncId = setInterval(() => {
      readStoredTopic().then(stored => {
        // null = could not read; adopting it would clear a live topic.
        if (stored === null || stored === topicRef.current) return;
        if (ctxMenuRef.current?.editingTopic) return;
        topicRef.current = stored;
        writeTopic(stored); writePidTopic(stored);
        needsRefresh.current = true;
      });
    }, 10000);

    // Publish WHICH window hosts this session, so "focus this session's
    // terminal" never has to guess between two windows wearing the same title (a
    // killed session leaves its window open with the title frozen on it, and the
    // daemon lists windows most-recently-used first). Worked out ONCE: a window id
    // is unique among live windows, so it cannot go stale while we are alive, and
    // readers drop the claim of a host whose pid is gone.
    //
    // NOT gated on SESSION_ID — that is empty for every ordinary tab, which left
    // the sessions opened by hand resolving by title alone, i.e. exactly the guess
    // this removes. publishWindowClaim files it under the session the tab is
    // actually showing, and syncClaudeTitle re-files it when a resume changes that.
    claimHostWindow(setHostTitle, () => setHostTitle(pinnedTitle() || childTitle))
      .then(id => { if (id) publishWindowClaim(id); });

    shell.onData((data: string) => {
      if (scriptLogStream) scriptLogStream.write(data);
      term.write(data, () => {
        contentDirty.current = true;
        needsRefresh.current = true;
      });
    });

    const blinkId = setInterval(() => {
      cursorVisible.current = !cursorVisible.current;
      needsRefresh.current = true;
    }, 1000);

    // The screen used to repaint on a fixed 50ms poll, so a keystroke waited up to 50ms
    // (25ms on average) before it could even be drawn -- before the React reconcile, Ink's
    // full-screen repaint and the host terminal's own render had even started. At 8ms the
    // wait is at most one frame at 120Hz. The body below is unchanged and still returns
    // immediately when nothing is new, so the faster tick costs one boolean check; only a
    // repaint that actually has work does work. Under a flood (a build log) a repaint
    // costing more than SLOW_RENDER_MS backs the next one off by twice its cost, so the
    // render cannot spin at 125Hz against a process that prints faster than we can draw.
    const REFRESH_TICK_MS = 8;
    const SLOW_RENDER_MS = 12;
    let nextAllowedRender = 0;
    const doRefresh = () => {
      needsRefresh.current = false;
      const d = dimsRef.current;
      const buf = term.buffer.active;
      const curRow = buf.cursorY + buf.baseY - buf.viewportY;
      const curCol = buf.cursorX;
      if (curRow !== lastCursorPos.current.row || curCol !== lastCursorPos.current.col) {
        lastCursorPos.current = { row: curRow, col: curCol };
        cursorVisible.current = true;
        contentDirty.current = true;
      }
      const cached = contentCache.current;
      let newLines: Line[];
      if (contentDirty.current || cached.length !== d.rows) {
        contentDirty.current = false;
        newLines = readBuffer(term, d.rows, d.cols, cached, selection.current, cursorVisible.current);
      } else {
        if (curRow < 0 || curRow >= d.rows) return;
        const startY = buf.viewportY;
        const cursorRow = readBufferRow(term, startY + curRow, d.cols, cursorVisible.current, curRow, curCol, curRow, selection.current);
        if (cached[curRow] && spansEqual(cached[curRow], cursorRow)) return;
        newLines = cached.slice();
        newLines[curRow] = cursorRow;
      }
      let anyChanged = cached.length !== newLines.length;
      if (!anyChanged) {
        for (let i = 0; i < newLines.length; i++) {
          if (newLines[i] !== cached[i]) { anyChanged = true; break; }
        }
      }
      if (!anyChanged) return;
      contentCache.current = newLines;
      setLines(newLines);
    };

    const refreshId = setInterval(() => {
      if (!needsRefresh.current) return;
      const start = Date.now();
      if (start < nextAllowedRender) return;
      doRefresh();
      const cost = Date.now() - start;
      nextAllowedRender = cost > SLOW_RENDER_MS ? Date.now() + cost * 2 : 0;
    }, REFRESH_TICK_MS);

    process.stdout.write('\x1b[?1002h\x1b[?1006h');

    let inBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBuf = () => {
      if (inBuf) {
        shell.write(inBuf);
        inBuf = '';
      }
    };

    // The selected cells as text, one line per row, trailing blanks trimmed. '' when there is
    // no selection or it is a single point.
    const selectedText = (): string => {
      if (!selection.current) return '';
      const sel = normalizeSelection(selection.current);
      if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) return '';
      const buf = term.buffer.active;
      const textLines: string[] = [];
      for (let y = sel.startRow; y <= sel.endRow; y++) {
        const line = buf.getLine(buf.viewportY + y);
        if (!line) { textLines.push(''); continue; }
        const sx = y === sel.startRow ? sel.startCol : 0;
        const ex = y === sel.endRow ? sel.endCol : dimsRef.current.cols - 1;
        let t = '';
        for (let x = sx; x <= ex; x++) {
          const cell = line.getCell(x);
          t += cell ? (cell.getChars() || ' ') : ' ';
        }
        textLines.push(t.trimEnd());
      }
      return textLines.join('\n');
    };

    const copySelectionToClipboard = () => {
      const text = selectedText();
      if (text.trim()) {
        clipboardWrite(text);
      }
      selection.current = null;
      needsRefresh.current = true;
    };

    // Open the speak box holding the selection -- or, with nothing selected, exactly as its
    // desktop icon opens it (prefilled from the clipboard, or empty to type into). Detached:
    // the launched process is the window itself (or hands over to the open one and exits).
    const saySelection = () => {
      const text = selectedText();
      const withText = !!text.trim();
      const child = spawn(RUN_IN_GUI_SESSION, withText ? [SPEAK_TEXT_CMD, '--stdin'] : [SPEAK_TEXT_CMD],
                          { detached: true, stdio: [withText ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
      child.on('error', () => {});
      if (withText) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(text);
      }
      child.unref();
      selection.current = null;
      needsRefresh.current = true;
    };

    const pasteFromClipboard = () => {
      clipboardRead().then((data) => {
        if (data && shellRef.current) {
          shellRef.current.write(data);
        }
      });
    };

    // Where the clock is drawn (see the absolute Box at the bottom of this file). It is
    // the ONE thing that says "this click is for the session menu", so it is a named
    // predicate rather than a repeated inequality: the trigger (a LEFT press) has to ask
    // the question before the click is forwarded to a child that grabbed the mouse.
    const isClockRegion = (row: number, col: number) =>
      row === 0 && col >= dimsRef.current.cols - 22;

    const openSessionMenu = (row: number, col: number) => {
      const d = dimsRef.current;
      const history = sessionHistoryRef.current;
      const info = detectClaudeSession(shell.pid);
      if (info) {
        const existing = history.find(e => e.sessionId === info.sessionId);
        if (existing) {
          existing.cwd = info.cwd;
          existing.alive = true;
        } else {
          history.push({ sessionId: info.sessionId, cwd: info.cwd, pid: info.pid, startMs: Date.now(), alive: true, bookmarked: false });
        }
      }
      for (const entry of history) {
        if (entry.alive && !isPidAlive(entry.pid)) entry.alive = false;
      }
      // Re-read on every open rather than trusting what this tab last set: the
      // same flag is toggled from the dashboard and the phone, and a checkbox
      // showing this tab's last opinion of it would be wrong on sight.
      const bookmarkedIds = readBookmarkedIds();
      for (const entry of history) entry.bookmarked = bookmarkedIds.has(entry.sessionId);
      // Who the voice segment (captions, replay) is about. currentSessionId() is the
      // ONE authority on "the session in this tab" -- never re-derive it from the list
      // below. It is empty only when no claude is running here now, and then the tab's
      // own last session is the one whose captions you mean: it just ended in front of
      // you, and "replay the last thing it said" is at its most wanted right then.
      const voiceSessionId = currentSessionId() || history[history.length - 1]?.sessionId || null;
      const sw = stopwatchRef.current;
      let swMs = sw.accumulatedMs;
      if (sw.running) swMs += Date.now() - sw.startMs;
      const layout = computeMenuLayout(history, true, false);
      const menuW = SESSION_MENU_INNER + 2;
      // One row below the click, never on it: this menu opens FROM the clock, and a
      // top border drawn on the clicked row sat exactly over the clock it came from.
      const r = Math.max(0, Math.min(row + 1, d.rows - layout.height));
      const c = Math.max(0, Math.min(col, d.cols - menuW));
      // The topic field opens FOCUSED, holding the topic it already has. Setting a topic is
      // what this menu is opened for, and it was the one row that needed a second click
      // before it would take a keystroke — the click that opened the menu landed on the
      // clock, so the field was an inch away and did nothing until you found it again.
      // Everything else here acts on a click; only this row has a keyboard to hand over,
      // so handing it over on open costs the other rows nothing (they are still clicks) and
      // costs a stray open nothing either: an untouched field is dismissed by exactly what
      // used to dismiss the menu (see cancelTopicEditOrClose and topicRowItem).
      ctxMenuRef.current = { kind: 'automateLinuxTerminalMenu', row: r, col: c, hasSelection: false, hoverItem: -1, sessions: [...history], stopwatchDisplay: formatStopwatch(swMs), stopwatchAction: sw.running ? 'stop' : 'start', stopwatchRowOff: layout.stopwatchRow, topic: topicRef.current, editingTopic: true, editBuffer: topicRef.current, editCursor: topicRef.current.length, topicRowOff: layout.topicRow, sessionsRowOff: layout.sessionsRow, helpRowOff: layout.helpRow, infoOpen: false, showTopicBar: showTopicBarRef.current, copiedSessionIdx: -1, currentSessionId: voiceSessionId, sendRowOff: layout.sendRow, captionsRowOff: layout.captionsRow, replayRowOff: layout.replayRow, captionsMsg: '', replayMsg: '', bookmarkIdx: -1, bookmarkMsg: '', resumeIdx: -1, resumeMsg: '', voiceMuted: voiceSessionId ? isVoiceMuted(voiceSessionId) : false, voiceMutedAll: isVoiceMutedGlobally(), muteRowOff: layout.muteRow, muteMsg: '', launchRowOff: layout.launchRow, launchMsg: '', exitRowOff: layout.exitRow, exitMsg: '', exitFailed: false };
      if (sw.running) {
        if (swTimerRef.current) clearInterval(swTimerRef.current);
        swTimerRef.current = setInterval(() => {
          if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
          const s = stopwatchRef.current;
          if (!s.running) return;
          const ms = s.accumulatedMs + (Date.now() - s.startMs);
          const updated: ContextMenuState = { ...ctxMenuRef.current, stopwatchDisplay: formatStopwatch(ms) };
          ctxMenuRef.current = updated;
          setCtxMenu(updated);
        }, 1000);
      }
      setCtxMenu({ ...ctxMenuRef.current });
      process.stdout.write('\x1b[?1003h');
    };

    const openClipboardMenu = (row: number, col: number) => {
      const d = dimsRef.current;
      const menuH = 5, menuW = 10;
      const r = Math.max(0, Math.min(row, d.rows - menuH));
      const c = Math.max(0, Math.min(col, d.cols - menuW));
      const hasSel = !!selection.current && (() => {
        const s = normalizeSelection(selection.current!);
        return !(s.startRow === s.endRow && s.startCol === s.endCol);
      })();
      ctxMenuRef.current = { kind: 'clipboard', row: r, col: c, hasSelection: hasSel, hoverItem: -1, sessions: [], stopwatchDisplay: null, stopwatchAction: null, stopwatchRowOff: 0, topic: '', editingTopic: false, editBuffer: '', editCursor: 0, topicRowOff: 0, sessionsRowOff: -1, helpRowOff: -1, infoOpen: false, showTopicBar: false, copiedSessionIdx: -1, currentSessionId: null, sendRowOff: -1, captionsRowOff: -1, replayRowOff: -1, captionsMsg: '', replayMsg: '', bookmarkIdx: -1, bookmarkMsg: '', resumeIdx: -1, resumeMsg: '', voiceMuted: false, voiceMutedAll: false, muteRowOff: -1, muteMsg: '', launchRowOff: -1, launchMsg: '', exitRowOff: -1, exitMsg: '', exitFailed: false };
      setCtxMenu({ ...ctxMenuRef.current });
      process.stdout.write('\x1b[?1003h');
    };

    const closeMenu = () => {
      if (!ctxMenuRef.current) return;
      ctxMenuRef.current = null;
      setCtxMenu(null);
      if (swTimerRef.current) { clearInterval(swTimerRef.current); swTimerRef.current = null; }
      process.stdout.write('\x1b[?1003l');
    };

    // ── The "send to session" dialog ───────────────────────────────────────────────────
    // The dashboard-android popup, opened from the menu's send row for the claude running
    // in this tab. What the flow does and says lives in sendToSession.ts; what the mic,
    // whisper and the spelling fixer are lives in dictation.ts; this is the wiring: where
    // it is drawn, what the bytes mean while it is open, and how the message reaches the
    // pty -- which is THIS tab's, so nothing here goes through the dashboard's send-keys.

    /** Keep the dialog on screen. Its height changes with its phase and its field, so
     *  this is applied to every state, not once at open. */
    const placeSend = (s: SendDialogState): SendDialogState => {
      const d = dimsRef.current;
      const h = computeSendLayout(s).height;
      return {
        ...s,
        row: Math.max(0, Math.min(s.row, d.rows - h)),
        col: Math.max(0, Math.min(s.col, d.cols - (SEND_DIALOG_INNER + 2))),
      };
    };

    const openSendDialog = (sessionId: string, topic: string, row: number, col: number) => {
      closeMenu();
      const io: SendIo = {
        record: startRecording,
        transcribe: transcribeRecording,
        fixSpelling,
        // Typed into this tab's own pty, as the resume, launch and exit rows type -- and
        // refused, with the reason on the dialog, when what is reading the pty is not a
        // claude (deliveryRefusal). Enter goes as a SEPARATE write a beat later, for the
        // reason on SUBMIT_DELAY_MS.
        deliver: async (text, submit) => {
          const refusal = deliveryRefusal(shellState(shell.pid), () => !!detectClaudeSession(shell.pid));
          if (refusal) throw new Error(refusal);
          // Everything typing does, because this IS typing: come back from a scrolled-back
          // screen and drop a selection whose highlight would sit over what replaces it.
          if (term.buffer.active.viewportY !== term.buffer.active.baseY) term.scrollToBottom();
          selection.current = null;
          contentDirty.current = true;
          needsRefresh.current = true;
          shell.write(text);
          if (!submit) return;
          await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
          shell.write('\r');
        },
      };
      const flow = new SendFlow(io, placeSend(openTyping(sessionId, topic, row, col)), (s) => {
        if (s) {
          const placed = placeSend(s);
          sendRef.current = placed;
          setSendDialog(placed);
        } else {
          sendRef.current = null;
          sendFlowRef.current = null;
          setSendDialog(null);
          process.stdout.write('\x1b[?1003l');
        }
      });
      sendFlowRef.current = flow;
      sendRef.current = flow.state;
      setSendDialog(flow.state);
      process.stdout.write('\x1b[?1003h');
    };

    /** A click on one of the dialog's controls. */
    const sendAct = (flow: SendFlow, hit: { item: number; cursor?: number }) => {
      const s = flow.state;
      switch (hit.item) {
        case SEND_ITEM.field: flow.edit({ buffer: s.transcript, cursor: hit.cursor ?? s.cursor }); break;
        case SEND_ITEM.speak: flow.speak(); break;
        case SEND_ITEM.fix: flow.fix(); break;
        case SEND_ITEM.useDropped: flow.useDropped(); break;
        case SEND_ITEM.undo: flow.undo(); break;
        case SEND_ITEM.send: flow.send(true); break;
        case SEND_ITEM.insert: flow.send(false); break;
        case SEND_ITEM.done: flow.done(); break;
        case SEND_ITEM.skip: flow.skip(); break;
        case SEND_ITEM.cancel: case SEND_ITEM.close: flow.cancel(); break;
      }
    };

    /** Escape: out of the recording with the words kept (the phone's Type/Back), out of
     *  the dialog otherwise. Never out of a send in flight -- cancel() refuses that. */
    const sendEscape = () => {
      const flow = sendFlowRef.current;
      if (!flow) return;
      if (flow.state.phase === 'recording') flow.skip(); else flow.cancel();
    };

    /** Every byte while the dialog is open. The menu's input loop, for a surface with a
     *  bigger field and a few more keys: the field's keys are the topic field's
     *  (topicKeyAt), Enter sends, Alt+Enter inserts, and the write-row actions have the
     *  control keys their labels show. A mouse report is hit-tested against the layout the
     *  overlay drew from, and a click outside the dialog dismisses it, as a tap outside the
     *  phone's popup does. */
    const handleSendInput = () => {
      const flow = sendFlowRef.current!;
      let pos = 0;
      while (pos < inBuf.length && sendRef.current) {
        const s = sendRef.current;
        const rest = inBuf.slice(pos);
        if (rest[0] === '\x1b') {
          const sgr = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (sgr) {
            const button = parseInt(sgr[1]);
            const mCol = parseInt(sgr[2]) - 1;
            const mRow = parseInt(sgr[3]) - 1;
            const isPress = sgr[4] === 'M';
            const layout = computeSendLayout(s);
            const rowOff = mRow - s.row, colOff = mCol - s.col;
            const inside = rowOff >= 0 && rowOff < layout.height && colOff >= 0 && colOff <= SEND_DIALOG_INNER + 1;
            const hit = inside ? sendHitTest(s, layout, rowOff, colOff) : null;
            if (button === 35 || button === 32 || button === 34) {
              flow.hover(hit ? hit.item : -1);
            } else if (button === 0 && isPress) {
              if (!inside) flow.cancel();
              else if (hit) sendAct(flow, hit);
            }
            pos += sgr[0].length; continue;
          }
          // Alt+Enter is claude's own newline (Option+Enter), and it is a newline here too
          // -- a hand that reaches for it gets a line break, never a send.
          if (rest.startsWith('\x1b\r') || rest.startsWith('\x1b\n')) {
            if (s.phase === 'confirm') flow.edit(insertFieldText({ buffer: s.transcript, cursor: s.cursor }, NEWLINE, MESSAGE_MAX_CHARS));
            pos += 2; continue;
          }
          if (s.phase === 'confirm') {
            // The box's keys: Up/Down walk the rows, Home/End and the kills work on the row
            // and the line, and everything else is the topic field's (fieldKeyAt).
            const key = fieldKeyAt(rest);
            if (key) {
              flow.edit(applyFieldAction({ buffer: s.transcript, cursor: s.cursor }, key.action, FIELD_WIDTH));
              pos += key.consumed; continue;
            }
          }
          // A sequence still arriving is not a key yet (the menu's rule, same regex): a
          // bare Escape is decided 50 ms later, when nothing has followed it.
          if (/^\x1b(\[[\d;<]*|O)?$/.test(rest)) {
            inBuf = rest;
            flushTimer = setTimeout(() => { inBuf = ''; sendEscape(); }, 50);
            return;
          }
          // Any other complete sequence (a function key, a modifier the field does not
          // claim) means nothing here and is skipped, not typed.
          const esc = rest.match(/^\x1b(\[[\x20-\x3f]*[\x40-\x7e]|O[\x40-\x7e]|[^\[O])/);
          pos += esc ? esc[0].length : 1; continue;
        }
        const ch = rest[0];
        // Enter, OUTSIDE the box, is the verb of the step: done while listening, close on
        // the failed step. In the box it is a line break -- the printable branch below
        // takes it -- because that is what it is in the phone's box (see actionRowButtons).
        if ((ch === '\r' || ch === '\n') && s.phase !== 'confirm') {
          if (s.phase === 'recording') flow.done();
          else if (s.phase === 'failed') flow.cancel();
          pos++; continue;
        }
        if (ch === '\x03') { flow.cancel(); pos++; continue; }            // Ctrl+C
        if (s.phase === 'confirm') {
          if (ch === '\x13') { flow.send(true); pos++; continue; }       // Ctrl+S: send
          if (ch === '\x0f') { flow.send(false); pos++; continue; }      // Ctrl+O: insert
          if (ch === '\x14') { flow.speak(); pos++; continue; }          // Ctrl+T: talk
          if (ch === '\x18') { flow.fix(); pos++; continue; }            // Ctrl+X: fix typos
          if (ch === '\x1a') { flow.undo(); pos++; continue; }           // Ctrl+Z: undo the fix
          if (ch === '\x12') { flow.useDropped(); pos++; continue; }     // Ctrl+R: use what I said
          const key = fieldKeyAt(ch);
          if (key) {
            flow.edit(applyFieldAction({ buffer: s.transcript, cursor: s.cursor }, key.action, FIELD_WIDTH));
            pos += key.consumed; continue;
          }
          // A run of printable characters and line breaks -- one keystroke, or a paste --
          // goes in at the caret in one step, every break as the one byte claude reads as
          // a newline (normalizeNewlines), so a pasted paragraph lands with its lines.
          let end = pos;
          while (end < inBuf.length && (inBuf.charCodeAt(end) >= 32 || inBuf[end] === '\r' || inBuf[end] === '\n') && inBuf[end] !== '\x7f') end++;
          if (end > pos) {
            const run = normalizeNewlines(inBuf.slice(pos, end));
            flow.edit(insertFieldText({ buffer: s.transcript, cursor: s.cursor }, run, MESSAGE_MAX_CHARS));
            pos = end; continue;
          }
        }
        pos++;   // a control key with no meaning on this step
      }
      inBuf = '';
    };

    /** What Escape — and every other key the topic field does not take — means, now that
     *  the field is focused from the moment the menu opens.
     *
     *  Focused is not the same as typed in. A field still holding exactly the stored topic
     *  has nothing to abandon, so the menu is in the state it was in before it auto-focused
     *  anything, and everything that used to dismiss it from that state still does: one
     *  Escape closes a menu opened by accident, as it always did. Two presses to undo one
     *  stray click on the clock would be the whole cost of the auto-focus, paid by the
     *  people who did not want it.
     *
     *  Once a single character differs the field owns the key: Escape drops what was typed
     *  and leaves the menu standing, so one stray press cannot both lose the edit and hide
     *  the row it was in. */
    const cancelTopicEditOrClose = () => {
      const m = ctxMenuRef.current;
      if (m?.editingTopic && m.editBuffer !== m.topic) {
        const upd: ContextMenuState = { ...m, editingTopic: false, editBuffer: '', editCursor: 0 };
        ctxMenuRef.current = upd;
        setCtxMenu(upd);
        return;
      }
      closeMenu();
    };

    const processInput = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

      // The dialog is modal: while it is open nothing reaches the menu or the shell.
      if (sendRef.current) { handleSendInput(); return; }

      if (ctxMenuRef.current) {
        let pos = 0;
        while (pos < inBuf.length) {
          if (!ctxMenuRef.current) {
            // The menu closed part-way through this read -- a click that dismissed it, or
            // one that opened the send dialog in its place -- and what follows belongs to
            // whatever is open NOW: the dialog, or nothing. Never to the menu that is gone
            // (the row arithmetic below would dereference it: a press and its release
            // arriving in one read used to crash the tab here), and never to the shell as
            // keystrokes, since what follows a press is its release.
            inBuf = inBuf.slice(pos);
            if (sendRef.current) handleSendInput(); else inBuf = '';
            return;
          }
          if (inBuf[pos] === '\x1b') {
            const rest = inBuf.slice(pos);
            const sgrMatch = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
            if (sgrMatch) {
              const button = parseInt(sgrMatch[1]);
              const mCol = parseInt(sgrMatch[2]) - 1;
              const mRow = parseInt(sgrMatch[3]) - 1;
              const isPress = sgrMatch[4] === 'M';
              const m: ContextMenuState = ctxMenuRef.current!;
              const rowOff = mRow - m.row;
              let itemIdx: number;
              let menuW: number;
              if (m.kind === 'automateLinuxTerminalMenu') {
                // 30 = the "?", 31 = the info line it opens; either one toggles it. Both
                // are read off the layout: the "?" is the last row of the menu, so where
                // it lands moves with every session that appears above it.
                if (rowOff === m.helpRowOff) itemIdx = 30;
                else if (m.infoOpen && rowOff === m.helpRowOff + 1) itemIdx = 31;
                // 20 = the topic field, 21 = its pin box. One row, split by COLUMN: the
                // box is the first few cells, the field is the rest.
                else if (rowOff === m.topicRowOff) itemIdx = topicRowItem(mCol - m.col, m.editingTopic, m.editBuffer !== m.topic);
                // 22/23/24 = the voice segment: mute, captions, replay. All three act on
                // one session (m.currentSessionId), so they are single items like the
                // topic -- not a band indexed by which block was clicked.
                else if (m.muteRowOff >= 0 && rowOff === m.muteRowOff) itemIdx = 22;
                else if (m.captionsRowOff >= 0 && rowOff === m.captionsRowOff) itemIdx = 23;
                else if (m.replayRowOff >= 0 && rowOff === m.replayRowOff) itemIdx = 24;
                // 25 = a message into the claude running here (opens the send dialog).
                // Its own segment above the voice rows, on the same session they act on.
                else if (m.sendRowOff >= 0 && rowOff === m.sendRowOff) itemIdx = 25;
                // 40 = end the claude running here, then the terminal itself. 41 = start one
                // here. Adjacent numbers because they are the tab's two lifecycle rows, but
                // NOT adjacent rows -- a rule sits between them, see computeMenuLayout.
                else if (m.exitRowOff >= 0 && rowOff === m.exitRowOff) itemIdx = 40;
                else if (m.launchRowOff >= 0 && rowOff === m.launchRowOff) itemIdx = 41;
                else if (rowOff === m.stopwatchRowOff) itemIdx = 10;
                else {
                  // 100 + i = the session itself (copy its id), 300 + i = its bookmark,
                  // 400 + i = resume it (the head cells of a DEAD session's row only, which
                  // is why the column goes in). Tested against what the overlay draws in
                  // tests/testMenuRows.ts -- a drift here silently mis-routes clicks.
                  const hit = sessionRowAt(rowOff, m.sessions, m.sessionsRowOff, mCol - m.col);
                  const base = hit ? { copy: 100, bookmark: 300, resume: 400 }[hit.action] : 0;
                  itemIdx = hit ? base + hit.idx : -1;
                }
                menuW = SESSION_MENU_INNER;
              } else {
                itemIdx = rowOff === 1 ? 0 : rowOff === 2 ? 1 : rowOff === 3 ? 2 : -1;
                menuW = 8;
              }
              const onItem = itemIdx >= 0 && (mCol - m.col) >= 1 && (mCol - m.col) <= menuW;
              if (button === 35 || button === 32 || button === 34) {
                const h = onItem ? itemIdx : -1;
                if (h !== m.hoverItem) {
                  const updated: ContextMenuState = { ...m, hoverItem: h };
                  ctxMenuRef.current = updated;
                  setCtxMenu(updated);
                }
              } else if (button === 0 && isPress) {
                // Open the send dialog for this tab's session, in the menu's place. The
                // session is the one the voice rows act on (currentSessionId), never
                // re-derived from the list; the row is only drawn while one is running.
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 25) {
                  if (m.currentSessionId) openSendDialog(m.currentSessionId, m.topic, m.row, m.col);
                  else closeMenu();
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 24) {
                  const sessionId = m.currentSessionId;
                  if (!sessionId) {
                    closeMenu();
                    pos += sgrMatch[0].length; continue;
                  }
                  const note = (msg: string, closeAfter: number) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, replayMsg: msg };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    if (closeAfter) setTimeout(closeMenu, closeAfter);
                  };
                  // The voice CLI owns what a replay IS -- it re-renders the session's last
                  // caption from the history and enqueues it past any mute -- exactly as the
                  // history page's Replay button does. This spawns it and reports; it does
                  // not reimplement it. stderr is piped, not discarded: "nothing spoken in
                  // this session yet" is the common answer and belongs on the row.
                  const child = spawn(SAY_CTL_CMD, ['replay', '--session', sessionId],
                                      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
                  let err = '';
                  child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });
                  // say-ctl returns once the clip is rendered and queued, not when it has
                  // been spoken -- a long caption takes a second or two of piper. The guard
                  // only stops a hung render from pinning the menu open.
                  const guard = setTimeout(closeMenu, 6000);
                  child.on('error', () => { clearTimeout(guard); note('▸ no claude-voice', 3000); });
                  child.on('exit', code => {
                    clearTimeout(guard);
                    if (!code) { setTimeout(closeMenu, 400); return; }
                    const line = (err.split('\n').find(l => l.trim()) || `failed (${code})`).trim();
                    note('▸ ' + (line.length > 30 ? line.slice(0, 29) + '…' : line), 3400);
                  });
                  child.unref();
                  note('▸ replaying…', 0);
                  pos += sgrMatch[0].length; continue;
                }
                // Start a claude in this tab: `cl --dangerously-skip-permissions`, typed into
                // the shell that will host it, exactly as it is typed by hand. What gets
                // typed and when it may be typed lives in launch.ts; this is the wiring.
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 41) {
                  const noteLaunch = (msg: string, clearAfter: number) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, launchMsg: msg };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    // Only wipe the message we put there -- another row may have reported
                    // something of its own while this one was counting down.
                    if (clearAfter) setTimeout(() => {
                      const cur = ctxMenuRef.current;
                      if (cur?.kind === 'automateLinuxTerminalMenu' && cur.launchMsg === msg) noteLaunch('', 0);
                    }, clearAfter);
                  };
                  const state = shellState(shell.pid);
                  const refusal = launchRefusal(state, () => !!detectClaudeSession(shell.pid));
                  if (refusal) {
                    // The menu stays open on a refusal, as the exit row's does: the state it
                    // refused over is the user's to clear and then click again.
                    noteLaunch('▸ ' + refusal, 4000);
                  } else {
                    // Everything typing does, because this IS typing: come back from a
                    // scrolled-back screen (the menu opens from one, and the launch would
                    // otherwise start off-screen) and drop a selection whose highlight would
                    // be left sitting over whatever text replaces it.
                    if (term.buffer.active.viewportY !== term.buffer.active.baseY) term.scrollToBottom();
                    selection.current = null;
                    contentDirty.current = true;
                    needsRefresh.current = true;
                    shell.write(LAUNCH_KEYS);
                    closeMenu();
                  }
                  pos += sgrMatch[0].length; continue;
                }
                // End the claude running here, then the terminal — the three presses
                // (Ctrl+D, Ctrl+D, then out of the shell) as one click. What each press is
                // and when it may be sent lives in exit.ts; this is the wiring.
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 40) {
                  const noteExit = (msg: string, failed: boolean) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, exitMsg: msg, exitFailed: failed };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    // A refusal clears itself; the menu stays open, because the state it
                    // refused over (a build running here, a claude on its transcript view)
                    // is the user's to clear and then click again.
                    if (failed) setTimeout(() => {
                      const cur = ctxMenuRef.current;
                      if (cur?.kind === 'automateLinuxTerminalMenu' && cur.exitMsg === msg) noteExit('', false);
                    }, 4000);
                  };
                  // Everything typing does, because this IS typing: come back from a
                  // scrolled-back screen and drop a selection whose highlight would
                  // otherwise sit over whatever replaces it.
                  if (term.buffer.active.viewportY !== term.buffer.active.baseY) term.scrollToBottom();
                  selection.current = null;
                  contentDirty.current = true;
                  needsRefresh.current = true;
                  noteExit('▸ exiting…', false);
                  runExitSequence({
                    write: keys => shell.write(keys),
                    shellState: () => shellState(shell.pid),
                    hasClaude: () => !!detectClaudeSession(shell.pid),
                    shellAlive: () => isPidAlive(shell.pid),
                    wait: ms => new Promise(r => setTimeout(r, ms)),
                    note: msg => noteExit(msg, false),
                  }).then(res => {
                    // Success is this process being torn down by the shell's own exit
                    // (shell.onExit), so there is nothing to report on the way out — only
                    // the ways it declined reach a row that is still on screen.
                    if (!res.ok) noteExit(`▸ ${res.reason}`, true);
                  });
                  pos += sgrMatch[0].length; continue;
                }
                // Resume a session that has ENDED, in the tab it ended in. Checked before
                // the bookmark band below: both are "300 or more", and this one is 400.
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx >= 400) {
                  const si = itemIdx - 400;
                  const sessEntry = m.sessions[si];
                  const noteResume = (msg: string, clearAfter: number) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, resumeIdx: msg ? si : -1, resumeMsg: msg };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    // Only wipe the message we put there -- another row may have reported
                    // something of its own while this one was counting down.
                    if (clearAfter) setTimeout(() => {
                      const cur = ctxMenuRef.current;
                      if (cur?.kind === 'automateLinuxTerminalMenu' && cur.resumeIdx === si && cur.resumeMsg === msg) {
                        noteResume('', 0);
                      }
                    }, clearAfter);
                  };
                  const keys = sessEntry ? resumeKeystrokes(sessEntry.sessionId) : null;
                  if (!sessEntry) {
                    closeMenu();
                  } else if (!keys) {
                    // No id to resume BY -- the session never fired a hook, so nothing on
                    // disk names its transcript. Same answer the bookmark row gives.
                    noteResume('▸ no session id yet', 3000);
                  } else {
                    // Typed into THIS TAB'S shell, which is the shell the session ran in --
                    // so it comes back where it was, in the window that is already showing
                    // its scrollback. A shell that is running something cannot be typed a
                    // command line, so say that instead of delivering keystrokes to
                    // whatever is reading (another claude in this tab, a build, an editor).
                    const state = shellState(shell.pid);
                    if (state === 'idle') {
                      // Everything typing does, because this IS typing: come back from a
                      // scrolled-back screen (the menu opens from one, and the resume would
                      // otherwise start off-screen) and drop a selection whose highlight
                      // would be left sitting over whatever text replaces it.
                      if (term.buffer.active.viewportY !== term.buffer.active.baseY) term.scrollToBottom();
                      selection.current = null;
                      contentDirty.current = true;
                      needsRefresh.current = true;
                      shell.write(keys);
                      closeMenu();
                    }
                    else if (state === 'busy') noteResume('▸ shell is busy here', 3000);
                    else noteResume('▸ cannot read shell state', 3000);
                  }
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx >= 300) {
                  const si = itemIdx - 300;
                  const sessEntry = m.sessions[si];
                  const noteBookmark = (msg: string, clearAfter: number) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, bookmarkIdx: msg ? si : -1, bookmarkMsg: msg };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    // Only wipe the message we put there: another row may have reported
                    // something of its own while this one was counting down.
                    if (clearAfter) setTimeout(() => {
                      const cur = ctxMenuRef.current;
                      if (cur?.kind === 'automateLinuxTerminalMenu' && cur.bookmarkIdx === si && cur.bookmarkMsg === msg) {
                        noteBookmark('', 0);
                      }
                    }, clearAfter);
                  };
                  if (!sessEntry) {
                    closeMenu();
                  } else if (!sessEntry.sessionId || sessEntry.sessionId === 'unknown') {
                    // No id to file the bookmark under -- the session has not fired a
                    // hook yet (a second at startup, or hooks off). Say so on the row:
                    // a checkbox that just refuses to tick reads as a broken menu.
                    noteBookmark('▸ no session id yet', 3000);
                  } else {
                    // Tick it where the menu AND the history read it, so the row answers
                    // the click at once and the state outlives closing the menu. The
                    // dashboard owns the store, so a refusal from it puts the tick back.
                    const next = !sessEntry.bookmarked;
                    sessEntry.bookmarked = next;
                    noteBookmark('', 0);
                    setBookmarked(sessEntry.sessionId, next).catch((err: Error) => {
                      sessEntry.bookmarked = !next;
                      noteBookmark(`▸ ${err.message}`, 4000);
                    });
                  }
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 23) {
                  const sessionId = m.currentSessionId;
                  if (sessionId) {
                    const note = (msg: string, closeAfter: number) => {
                      if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                      const u: ContextMenuState = { ...ctxMenuRef.current, captionsMsg: msg };
                      ctxMenuRef.current = u;
                      setCtxMenu(u);
                      if (closeAfter) setTimeout(closeMenu, closeAfter);
                    };
                    // Detached so the history window outlives this menu -- but stderr is
                    // PIPED, not discarded. The launcher refuses loudly (no port from the
                    // daemon, unreachable voice server) and swallowing that would leave the
                    // row saying "opening…" while nothing ever opened.
                    const child = spawn(VOICE_HISTORY_CMD, ['--session', sessionId],
                                        { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
                    let err = '';
                    child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });
                    // The menu stays up until the launcher has had its say -- closing on a
                    // timer would race the failure and hide it. The guard is only there so
                    // a hung launcher cannot pin the menu open.
                    const guard = setTimeout(closeMenu, 4000);
                    child.on('error', () => { clearTimeout(guard); note('▸ no claude-voice', 3000); });
                    child.on('exit', code => {
                      clearTimeout(guard);
                      if (!code) { setTimeout(closeMenu, 400); return; }
                      const line = (err.split('\n').find(l => l.trim()) || `failed (${code})`).trim();
                      note('▸ ' + (line.length > 23 ? line.slice(0, 22) + '…' : line), 3400);
                    });
                    child.unref();
                    note('▸ opening…', 0);
                  } else {
                    closeMenu();
                  }
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx >= 100) {
                  const si = itemIdx - 100;
                  const sessEntry = m.sessions[si];
                  if (sessEntry) {
                    clipboardWrite(sessEntry.sessionId);
                    const upd: ContextMenuState = { ...m, copiedSessionIdx: si };
                    ctxMenuRef.current = upd;
                    setCtxMenu(upd);
                    setTimeout(closeMenu, 600);
                  } else {
                    closeMenu();
                  }
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 10) {
                  const sw = stopwatchRef.current;
                  if (sw.running) {
                    sw.accumulatedMs += Date.now() - sw.startMs;
                    sw.running = false;
                    sw.startMs = 0;
                    if (swTimerRef.current) { clearInterval(swTimerRef.current); swTimerRef.current = null; }
                  } else {
                    sw.startMs = Date.now();
                    sw.running = true;
                    swTimerRef.current = setInterval(() => {
                      if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                      const s2 = stopwatchRef.current;
                      if (!s2.running) return;
                      const elapsed = s2.accumulatedMs + (Date.now() - s2.startMs);
                      const upd: ContextMenuState = { ...ctxMenuRef.current, stopwatchDisplay: formatStopwatch(elapsed) };
                      ctxMenuRef.current = upd;
                      setCtxMenu(upd);
                    }, 1000);
                  }
                  let swMs = sw.accumulatedMs;
                  if (sw.running) swMs += Date.now() - sw.startMs;
                  const upd: ContextMenuState = { ...m, stopwatchDisplay: formatStopwatch(swMs), stopwatchAction: sw.running ? 'stop' : 'start' };
                  ctxMenuRef.current = upd;
                  setCtxMenu(upd);
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 20) {
                  if (m.editingTopic) {
                    const newTopic = m.editBuffer.trim();
                    topicRef.current = newTopic; writeTopic(newTopic); writePidTopic(newTopic);
                    propagateTopicToDashboard(newTopic);
                    const upd: ContextMenuState = { ...m, topic: newTopic, editingTopic: false, editBuffer: '', editCursor: 0 };
                    ctxMenuRef.current = upd;
                    setCtxMenu(upd);
                  } else {
                    // Re-focusing puts the caret at the END, where the menu's own open puts
                    // it: the click that lands here is on a row, not on a character (the
                    // column decides pin-vs-field and nothing finer), so there is no place
                    // in the text it could honestly mean.
                    const upd: ContextMenuState = { ...m, editingTopic: true, editBuffer: m.topic, editCursor: m.topic.length };
                    ctxMenuRef.current = upd;
                    setCtxMenu(upd);
                  }
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && (itemIdx === 30 || itemIdx === 31)) {
                  // The info line opens in place and the menu gets a row taller. Below the
                  // "?" there is nothing left to move now that it sits last, but re-layout
                  // anyway rather than assuming that: two places would otherwise have to
                  // agree on a shape only computeMenuLayout knows. Re-clamp too -- a menu
                  // opened against the bottom of the screen has no room to grow downwards,
                  // and it is the row the "?" is ON that the re-clamp shifts.
                  const infoOpen = !m.infoOpen;
                  const layout = computeMenuLayout(m.sessions, m.stopwatchDisplay != null, infoOpen);
                  const d = dimsRef.current;
                  const upd: ContextMenuState = {
                    ...m, infoOpen,
                    row: Math.max(0, Math.min(m.row, d.rows - layout.height)),
                    topicRowOff: layout.topicRow,
                    sendRowOff: layout.sendRow,
                    muteRowOff: layout.muteRow,
                    captionsRowOff: layout.captionsRow,
                    replayRowOff: layout.replayRow,
                    sessionsRowOff: layout.sessionsRow,
                    stopwatchRowOff: layout.stopwatchRow,
                    launchRowOff: layout.launchRow,
                    exitRowOff: layout.exitRow,
                    helpRowOff: layout.helpRow,
                  };
                  ctxMenuRef.current = upd;
                  setCtxMenu(upd);
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 21) {
                  showTopicBarRef.current = !showTopicBarRef.current;
                  setShowTopicBar(showTopicBarRef.current);
                  const upd: ContextMenuState = { ...m, showTopicBar: showTopicBarRef.current };
                  ctxMenuRef.current = upd;
                  setCtxMenu(upd);
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 22) {
                  // Mute THIS TAB'S session -- m.currentSessionId, the same session the two
                  // rows under this one act on. Never the global flag: this row is one of
                  // three that say "this tab", and the one that reached `--all` silenced
                  // the dashboard, the phone and every other terminal from a menu that
                  // named none of them.
                  //
                  // Tick first, write through the `voice` CLI (the one place that also cuts
                  // the line already mid-sentence), and on a refusal put the tick back and
                  // say why on the row -- the bookmark's contract, because here too a
                  // silent no-op reads as a misclick.
                  const sessionId = m.currentSessionId;
                  if (!sessionId) {
                    // The row is only drawn for a tab that has hosted a session, so this is
                    // unreachable rather than a state worth a message -- but a mute with no
                    // session must never widen into a global one to have something to do.
                    closeMenu();
                    pos += sgrMatch[0].length; continue;
                  }
                  const next = !m.voiceMuted;
                  const noteMute = (muted: boolean, msg: string) => {
                    if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                    const u: ContextMenuState = { ...ctxMenuRef.current, voiceMuted: muted, muteMsg: msg };
                    ctxMenuRef.current = u;
                    setCtxMenu(u);
                    if (msg) setTimeout(() => {
                      const cur = ctxMenuRef.current;
                      if (cur?.kind === 'automateLinuxTerminalMenu' && cur.muteMsg === msg) noteMute(cur.voiceMuted, '');
                    }, 4000);
                  };
                  noteMute(next, '');
                  setVoiceMuted(next, sessionId).catch((err: Error) => {
                    noteMute(!next, `▸ ${err.message.length > 23 ? err.message.slice(0, 22) + '…' : err.message}`);
                  });
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'clipboard') {
                  if (onItem && itemIdx === 0 && m.hasSelection) copySelectionToClipboard();
                  else if (onItem && itemIdx === 1) pasteFromClipboard();
                  else if (onItem && itemIdx === 2) saySelection();
                }
                closeMenu();
              } else if (button === 2 && isPress) {
                closeMenu();
                openClipboardMenu(mRow, mCol);
              } else if (button === 64 || button === 65) {
                closeMenu();
              }
              pos += sgrMatch[0].length; continue;
            }
            // THE FIELD GETS FIRST REFUSAL ON EVERY ESCAPE SEQUENCE WHILE IT IS FOCUSED.
            //
            // An arrow, Home/End, Delete and their Ctrl/Alt word-wise forms are keys a text
            // field owns; here they used to fall straight through to the line below, so
            // pressing Left to fix a typo three characters back DELETED THE WHOLE EDIT (or,
            // on an untouched field, closed the menu). `topicKeyAt` answers null for
            // everything the field does not claim -- a function key, a mouse report that got
            // this far -- and those still dismiss, exactly as before.
            const editing = ctxMenuRef.current!;
            if (editing.editingTopic) {
              const key = topicKeyAt(rest);
              if (key) {
                const next = applyTopicAction({ buffer: editing.editBuffer, cursor: editing.editCursor }, key.action);
                const upd: ContextMenuState = { ...editing, editBuffer: next.buffer, editCursor: next.cursor };
                ctxMenuRef.current = upd;
                setCtxMenu(upd);
                pos += key.consumed; continue;
              }
            }
            // A sequence that is still ARRIVING is not a key that means anything yet. The
            // test covers a CSI's parameters too (`\x1b[1;5` on its way to a Ctrl+Left), not
            // just the mouse prefixes it was written for: a sequence split across two reads
            // would otherwise be read as a bare Escape and throw the edit away -- the exact
            // failure this whole block exists to stop, arriving by timing instead.
            if (/^\x1b(\[[\d;<]*|O)?$/.test(rest)) {
              inBuf = rest;
              flushTimer = setTimeout(() => {
                cancelTopicEditOrClose();
                inBuf = '';
              }, 50);
              return;
            }
            cancelTopicEditOrClose(); inBuf = ''; return;
          }
          if (ctxMenuRef.current!.editingTopic) {
            const ch = inBuf[pos];
            const m = ctxMenuRef.current!;
            if (ch === '\r' || ch === '\n') {
              const newTopic = m.editBuffer.trim();
              topicRef.current = newTopic; writeTopic(newTopic); writePidTopic(newTopic);
              propagateTopicToDashboard(newTopic);
              closeMenu();
              inBuf = ''; return;
            }
            // Backspace, and the readline control keys the field claims (Ctrl+A/E/B/F for
            // the ends and the caret, Ctrl+U/K/W for the three kills). They are checked
            // BEFORE the dismiss rule below, so they work on an untouched field too -- a
            // caret that only moves once you have typed something is a caret you cannot use
            // to fix the topic you came here to fix. Ctrl+C and Ctrl+D are deliberately not
            // among them (topicEdit.ts says why), so the way out of this menu is unchanged.
            const key = topicKeyAt(ch);
            if (key) {
              const next = applyTopicAction({ buffer: m.editBuffer, cursor: m.editCursor }, key.action);
              const upd: ContextMenuState = { ...m, editBuffer: next.buffer, editCursor: next.cursor };
              ctxMenuRef.current = upd;
              setCtxMenu(upd);
              pos += key.consumed; continue;
            }
            if (ch.charCodeAt(0) < 32 && m.editBuffer === m.topic) {
              // A control key at a field that is focused but has not been typed into means
              // what it meant before the field was focused at all: dismiss the menu. Same
              // rule as Escape's (cancelTopicEditOrClose), for the same reason — a Ctrl+C
              // aimed at getting out of a menu opened by accident must not be swallowed by
              // a field with nothing in it. Once something has been typed the field keeps
              // them, so a stray control key cannot silently drop an edit.
              closeMenu(); inBuf = ''; return;
            }
            if (ch.charCodeAt(0) >= 32) {
              // Typed AT the caret, not on the end. Bounded by what a topic sanely IS
              // (TOPIC_MAX_CHARS, in insertTopicText) rather than by what the menu row can
              // hold: an over-long topic scrolls in the row and in the bar, and the field
              // itself follows the caret while it is typed.
              const next = insertTopicText({ buffer: m.editBuffer, cursor: m.editCursor }, ch);
              const upd: ContextMenuState = { ...m, editBuffer: next.buffer, editCursor: next.cursor };
              ctxMenuRef.current = upd;
              setCtxMenu(upd);
            }
            pos++; continue;
          }
          closeMenu(); inBuf = ''; return;
        }
        inBuf = ''; return;
      }

      let pos = 0;
      while (pos < inBuf.length) {
        if (inBuf[pos] === '\x1b') {
          const rest = inBuf.slice(pos);

          if (rest.startsWith('\x1b[5;2~')) {
            term.scrollPages(-1);
            contentDirty.current = true;
            needsRefresh.current = true;
            pos += 6; continue;
          }
          if (rest.startsWith('\x1b[6;2~')) {
            term.scrollPages(1);
            contentDirty.current = true;
            needsRefresh.current = true;
            pos += 6; continue;
          }

          const sgrMatch = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (sgrMatch) {
            const button = parseInt(sgrMatch[1]);
            const mCol = parseInt(sgrMatch[2]) - 1;
            const mRow = parseInt(sgrMatch[3]) - 1;
            const isPress = sgrMatch[4] === 'M';

            if (button === 64) { term.scrollLines(-3); contentDirty.current = true; needsRefresh.current = true; }
            else if (button === 65) { term.scrollLines(3); contentDirty.current = true; needsRefresh.current = true; }
            else if (button === 2) {
              if (isPress) openClipboardMenu(mRow, mCol);
            }
            // The session menu opens on a LEFT press on the clock — the click people
            // already make at a thing they can see, where the right button was a
            // guess. It is tested HERE, above both the forward-to-child branch and
            // the selection branch, for the same reason the right button is: the
            // clock is drawn by this app over whatever the child paints, so a click
            // on it belongs to this app whether or not the child grabbed the mouse,
            // and it must not also start a selection under the menu it just opened.
            else if (button === 0 && isPress && isClockRegion(mRow, mCol)) {
              openSessionMenu(mRow, mCol);
            }
            else if (term.modes.mouseTrackingMode !== 'none') {
              shell.write(sgrMatch[0]);
            }
            else if (button === 0 && isPress) {
              const d = dimsRef.current;
              const r = Math.max(0, Math.min(mRow, d.rows - 1));
              const c = Math.max(0, Math.min(mCol, d.cols - 1));
              selection.current = { startRow: r, startCol: c, endRow: r, endCol: c };
              contentDirty.current = true;
              needsRefresh.current = true;
            }
            else if (button === 32 && isPress && selection.current) {
              const d = dimsRef.current;
              selection.current.endRow = Math.max(0, Math.min(mRow, d.rows - 1));
              selection.current.endCol = Math.max(0, Math.min(mCol, d.cols - 1));
              contentDirty.current = true;
              needsRefresh.current = true;
            }
            else if (button === 0 && !isPress && selection.current) {
              const sel = normalizeSelection(selection.current);
              if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) {
                selection.current = null;
                contentDirty.current = true;
                needsRefresh.current = true;
              }
            }
            pos += sgrMatch[0].length; continue;
          }

          let complete = false;
          if (rest.length === 1) {
            // just \x1b — could be incomplete
          } else if (rest[1] !== '[') {
            complete = true;
          } else {
            for (let i = 2; i < rest.length; i++) {
              const c = rest.charCodeAt(i);
              if (c >= 0x40 && c <= 0x7e) { complete = true; break; }
            }
          }

          if (!complete) {
            inBuf = rest;
            flushTimer = setTimeout(flushBuf, 50);
            return;
          }

          const escMatch = rest.match(/^\x1b(\[[\x20-\x3f]*[\x40-\x7e]|[^\[])/);
          if (escMatch) {
            shell.write(escMatch[0]);
            pos += escMatch[0].length; continue;
          }
          shell.write(inBuf[pos]);
          pos++; continue;
        }

        if (inBuf[pos] === '\x03' && selection.current) {
          const sel = normalizeSelection(selection.current);
          if (!(sel.startRow === sel.endRow && sel.startCol === sel.endCol)) {
            copySelectionToClipboard();
            pos++; continue;
          }
        }

        let end = pos + 1;
        while (end < inBuf.length && inBuf[end] !== '\x1b') end++;

        if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
          term.scrollToBottom();
          contentDirty.current = true;
          needsRefresh.current = true;
        }
        if (selection.current) { selection.current = null; contentDirty.current = true; needsRefresh.current = true; }
        shell.write(inBuf.slice(pos, end));
        pos = end;
      }
      inBuf = '';
    };

    const handleInput = (data: Buffer) => {
      inBuf += data.toString();
      processInput();
    };
    stdin?.on("data", handleInput);

    shell.onExit(() => {
      process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1003l');
      clearInterval(refreshId);
      clearInterval(blinkId);
      clearInterval(titleSyncId);
      clearInterval(topicSyncId);
      if (swTimerRef.current) clearInterval(swTimerRef.current);
      if (scriptLogWatchId) clearInterval(scriptLogWatchId);
      if (scriptLogStream) scriptLogStream.end();
      cleanupMetadata();
      notifySessionEnded();
      process.exit(0);
    });

    return () => {
      process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1003l');
      clearInterval(refreshId);
      clearInterval(blinkId);
      clearInterval(titleSyncId);
      clearInterval(topicSyncId);
      if (swTimerRef.current) clearInterval(swTimerRef.current);
      if (scriptLogWatchId) clearInterval(scriptLogWatchId);
      if (flushTimer) clearTimeout(flushTimer);
      // A microphone left open outlives nothing: the flow stops and discards it.
      sendFlowRef.current?.cancel();
      stdin?.off("data", handleInput);
      shell.kill();
      term.dispose();
      termRef.current = null;
      shellRef.current = null;
    };
  }, []);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((spans, i) => (
        <TerminalLine key={i} spans={spans} />
      ))}
      {ctxMenu && <ContextMenuOverlay menu={ctxMenu} />}
      {sendDialog && <SendDialogOverlay state={sendDialog} />}
      {showTopicBar && topicRef.current && <TopicSign text={topicRef.current} cols={cols} />}
    </Box>
  );
}

function AutomateLinuxTerminal() {
  const { stdout } = useStdout();
  const [dims, setDims] = useState(() => ({
    cols: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));

  useEffect(() => {
    const onResize = () => {
      setDims({
        cols: stdout?.columns || 80,
        rows: stdout?.rows || 24,
      });
    };
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  return (
    <Box width={dims.cols} height={dims.rows}>
      <TerminalEmulator rows={dims.rows} cols={dims.cols} />
      <Box position="absolute" marginLeft={dims.cols - 22} paddingRight={1}>
        <Clock />
      </Box>
    </Box>
  );
}

render(<AutomateLinuxTerminal />, { exitOnCtrlC: false, incrementalRendering: true });
