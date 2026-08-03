import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useStdin } from "ink";
import { createWriteStream } from "fs";
import type { WriteStream } from "fs";
import { spawn } from "child_process";
import pty from "node-pty";
import xterm from "@xterm/headless";
const { Terminal: XTerminal } = xterm;

import type { Span, Line, Selection, ContextMenuState, SessionHistoryEntry } from "./types.js";
import { SESSION_ID, LAUNCH_DIR, SCRIPT_LOG_FILE, writeMetadata, writeTopic, writePidTopic, propagateTopicToDashboard, fetchStoredTopic, readStoredTopic, cleanupMetadata, registerWithDashboard, notifySessionEnded, detectClaudeSession, noteLiveSessionId, isPidAlive, claimHostWindow, publishWindowClaim, readBookmarkedIds, setBookmarked } from "./session.js";
import { EMPTY_SPAN, spansEqual, normalizeSelection, readBufferRow, readBuffer } from "./buffer.js";
import { SESSION_MENU_INNER, formatStopwatch, computeMenuLayout, sessionRowAt, topicRowItem, TOPIC_MAX_CHARS, topicBarWidth, marqueeWindow } from "./menu.js";
import { useMarqueeTick } from "./marquee.js";
import { ContextMenuOverlay } from "./ContextMenuOverlay.js";
import { clipboardWrite, clipboardRead } from "./clipboard.js";
import { isVoiceMuted, setVoiceMuted } from "./voice.js";

// The Claude Voice history window, narrowed to one session. A script rather than a URL we
// open ourselves: it owns "raise the existing window instead of piling up duplicates", and
// being a script it is re-read on every run -- that behaviour can change without rebuilding
// this terminal.
const VOICE_HISTORY_CMD = "/root/bin/claude-voice-history";

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
    if (SESSION_ID) {
      writeMetadata(shell.pid); writePidTopic(topicRef.current);
      registerWithDashboard(shell.pid);
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
    if (SCRIPT_LOG_FILE) {
      scriptLogStream = createWriteStream(SCRIPT_LOG_FILE, { flags: 'a' });
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

    const refreshId = setInterval(() => {
      if (!needsRefresh.current) return;
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
    }, 50);

    process.stdout.write('\x1b[?1002h\x1b[?1006h');

    let inBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBuf = () => {
      if (inBuf) {
        shell.write(inBuf);
        inBuf = '';
      }
    };

    const copySelectionToClipboard = () => {
      if (!selection.current) return;
      const sel = normalizeSelection(selection.current);
      if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) return;
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
      const text = textLines.join('\n');
      if (text.trim()) {
        clipboardWrite(text);
      }
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

    const openMenu = (row: number, col: number) => {
      const d = dimsRef.current;
      const isClockRegion = row === 0 && col >= d.cols - 22;
      if (isClockRegion) {
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
        const sw = stopwatchRef.current;
        let swMs = sw.accumulatedMs;
        if (sw.running) swMs += Date.now() - sw.startMs;
        const layout = computeMenuLayout(history, true, false);
        const menuW = SESSION_MENU_INNER + 2;
        // One row below the click, never on it: this menu opens FROM the clock, and a
        // top border drawn on the clicked row sat exactly over the clock it came from.
        const r = Math.max(0, Math.min(row + 1, d.rows - layout.height));
        const c = Math.max(0, Math.min(col, d.cols - menuW));
        ctxMenuRef.current = { kind: 'automateLinuxTerminalMenu', row: r, col: c, hasSelection: false, hoverItem: -1, sessions: [...history], stopwatchDisplay: formatStopwatch(swMs), stopwatchAction: sw.running ? 'stop' : 'start', stopwatchRowOff: layout.stopwatchRow, topic: topicRef.current, editingTopic: false, editBuffer: '', topicRowOff: layout.topicRow, sessionsRowOff: layout.sessionsRow, helpRowOff: layout.helpRow, infoOpen: false, showTopicBar: showTopicBarRef.current, copiedSessionIdx: -1, captionsIdx: -1, captionsMsg: '', bookmarkIdx: -1, bookmarkMsg: '', voiceMuted: isVoiceMuted(), muteRowOff: layout.muteRow, muteMsg: '' };
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
      } else {
        const menuH = 4, menuW = 10;
        const r = Math.max(0, Math.min(row, d.rows - menuH));
        const c = Math.max(0, Math.min(col, d.cols - menuW));
        const hasSel = !!selection.current && (() => {
          const s = normalizeSelection(selection.current!);
          return !(s.startRow === s.endRow && s.startCol === s.endCol);
        })();
        ctxMenuRef.current = { kind: 'clipboard', row: r, col: c, hasSelection: hasSel, hoverItem: -1, sessions: [], stopwatchDisplay: null, stopwatchAction: null, stopwatchRowOff: 0, topic: '', editingTopic: false, editBuffer: '', topicRowOff: 0, sessionsRowOff: -1, helpRowOff: -1, infoOpen: false, showTopicBar: false, copiedSessionIdx: -1, captionsIdx: -1, captionsMsg: '', bookmarkIdx: -1, bookmarkMsg: '', voiceMuted: false, muteRowOff: -1, muteMsg: '' };
      }
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

    const processInput = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

      if (ctxMenuRef.current) {
        let pos = 0;
        while (pos < inBuf.length) {
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
                else if (rowOff === m.topicRowOff) itemIdx = topicRowItem(mCol - m.col, m.editingTopic);
                else if (rowOff === m.muteRowOff) itemIdx = 22;
                else if (rowOff === m.stopwatchRowOff) itemIdx = 10;
                else {
                  // 100 + i = the session itself (copy its id), 200 + i = its captions,
                  // 300 + i = its bookmark. Tested against what the overlay draws in
                  // tests/testMenuRows.ts -- a drift here silently mis-routes clicks.
                  const hit = sessionRowAt(rowOff, m.sessions, m.sessionsRowOff);
                  const base = hit ? { copy: 100, captions: 200, bookmark: 300 }[hit.action] : 0;
                  itemIdx = hit ? base + hit.idx : -1;
                }
                menuW = SESSION_MENU_INNER;
              } else {
                itemIdx = rowOff === 1 ? 0 : rowOff === 2 ? 1 : -1;
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
                // Ordered high band first: 300 is also >= 200, so a bookmark click would
                // otherwise be served by the captions branch below.
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
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx >= 200) {
                  const si = itemIdx - 200;
                  const sessEntry = m.sessions[si];
                  if (sessEntry) {
                    const note = (msg: string, closeAfter: number) => {
                      if (!ctxMenuRef.current || ctxMenuRef.current.kind !== 'automateLinuxTerminalMenu') return;
                      const u: ContextMenuState = { ...ctxMenuRef.current, captionsIdx: si, captionsMsg: msg };
                      ctxMenuRef.current = u;
                      setCtxMenu(u);
                      if (closeAfter) setTimeout(closeMenu, closeAfter);
                    };
                    // Detached so the history window outlives this menu -- but stderr is
                    // PIPED, not discarded. The launcher refuses loudly (no port from the
                    // daemon, unreachable voice server) and swallowing that would leave the
                    // row saying "opening…" while nothing ever opened.
                    const child = spawn(VOICE_HISTORY_CMD, ['--session', sessEntry.sessionId],
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
                    const upd: ContextMenuState = { ...m, topic: newTopic, editingTopic: false, editBuffer: '' };
                    ctxMenuRef.current = upd;
                    setCtxMenu(upd);
                  } else {
                    const upd: ContextMenuState = { ...m, editingTopic: true, editBuffer: m.topic };
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
                    muteRowOff: layout.muteRow,
                    sessionsRowOff: layout.sessionsRow,
                    stopwatchRowOff: layout.stopwatchRow,
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
                  // The claude-voice global mute. Tick first, write through the `voice`
                  // CLI (the one place that also cuts the line mid-sentence), and on a
                  // refusal put the tick back and say why on the row -- the bookmark's
                  // contract, because here too a silent no-op reads as a misclick.
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
                  setVoiceMuted(next).catch((err: Error) => {
                    noteMute(!next, `▸ ${err.message.length > 23 ? err.message.slice(0, 22) + '…' : err.message}`);
                  });
                  pos += sgrMatch[0].length; continue;
                }
                if (m.kind === 'clipboard') {
                  if (onItem && itemIdx === 0 && m.hasSelection) copySelectionToClipboard();
                  else if (onItem && itemIdx === 1) pasteFromClipboard();
                }
                closeMenu();
              } else if (button === 2 && isPress) {
                closeMenu();
                openMenu(mRow, mCol);
              } else if (button === 64 || button === 65) {
                closeMenu();
              }
              pos += sgrMatch[0].length; continue;
            }
            if (/^\x1b(\[(<([\d;]*)?)?)?$/.test(rest)) {
              inBuf = rest;
              flushTimer = setTimeout(() => {
                if (ctxMenuRef.current?.editingTopic) {
                  const upd: ContextMenuState = { ...ctxMenuRef.current, editingTopic: false, editBuffer: '' };
                  ctxMenuRef.current = upd;
                  setCtxMenu(upd);
                  inBuf = '';
                } else {
                  closeMenu(); inBuf = '';
                }
              }, 50);
              return;
            }
            if (ctxMenuRef.current!.editingTopic) {
              const upd: ContextMenuState = { ...ctxMenuRef.current!, editingTopic: false, editBuffer: '' };
              ctxMenuRef.current = upd;
              setCtxMenu(upd);
              inBuf = ''; return;
            }
            closeMenu(); inBuf = ''; return;
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
            } else if (ch === '\x7f' || ch === '\x08') {
              const upd: ContextMenuState = { ...m, editBuffer: m.editBuffer.slice(0, -1) };
              ctxMenuRef.current = upd;
              setCtxMenu(upd);
            } else if (ch.charCodeAt(0) >= 32) {
              // Bounded by what a topic sanely IS, not by what the menu row can hold:
              // an over-long topic scrolls in the row and in the bar, and the field
              // itself scrolls to the cursor while it is typed.
              if (m.editBuffer.length < TOPIC_MAX_CHARS) {
                const upd: ContextMenuState = { ...m, editBuffer: m.editBuffer + ch };
                ctxMenuRef.current = upd;
                setCtxMenu(upd);
              }
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
              if (isPress) openMenu(mRow, mCol);
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
      if (flushTimer) clearTimeout(flushTimer);
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
