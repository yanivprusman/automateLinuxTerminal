import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useStdin } from "ink";
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import type { WriteStream } from "fs";
import pty from "node-pty";
import xterm from "@xterm/headless";
const { Terminal: XTerminal } = xterm;

import type { Span, Line, Selection, ContextMenuState, SessionHistoryEntry } from "./types.js";
import { SESSION_ID, LAUNCH_DIR, SCRIPT_LOG_FILE, writeMetadata, cleanupMetadata, registerWithDashboard, notifySessionEnded, detectClaudeSession, isPidAlive } from "./session.js";
import { EMPTY_SPAN, spansEqual, normalizeSelection, readBufferRow, readBuffer } from "./buffer.js";
import { SESSION_MENU_INNER, formatStopwatch, computeMenuLayout, sessionIdxFromRowOff } from "./menu.js";
import { ContextMenuOverlay } from "./ContextMenuOverlay.js";

// Clipboard tooling. This app runs on a GNOME *Wayland* session (often as root),
// where xclip can't reach XWayland unless XAUTHORITY is exported into the env —
// which it isn't in the terminal's environment. That made xclip exit 1
// ("Invalid MIT-MAGIC-COOKIE-1 / Can't open display :0") and silently broke BOTH
// copy and paste. Use the native Wayland tools (wl-copy/wl-paste) when on Wayland;
// they need only WAYLAND_DISPLAY + XDG_RUNTIME_DIR, no X auth. Fall back to xclip
// only on a real X11 session, where XAUTHORITY is present.
const ON_WAYLAND = !!process.env.WAYLAND_DISPLAY;
const CLIPBOARD_WRITE_CMD: string[] = ON_WAYLAND
  ? ["wl-copy"]
  : ["xclip", "-selection", "clipboard"];
const CLIPBOARD_READ_CMD: string[] = ON_WAYLAND
  ? ["wl-paste", "-n"]
  : ["xclip", "-selection", "clipboard", "-o"];

// Spawn the clipboard writer and feed it `text`. Best-effort: clipboard failures
// must never crash the terminal.
function clipboardWrite(text: string): void {
  const [cmd, ...args] = CLIPBOARD_WRITE_CMD;
  const clip = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  clip.on("error", () => {});
  clip.stdin.on("error", () => {});
  clip.stdin.end(text);
}

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
      writeMetadata(shell.pid);
      registerWithDashboard(shell.pid);
    }
    if (SCRIPT_LOG_FILE) {
      scriptLogStream = createWriteStream(SCRIPT_LOG_FILE, { flags: 'a' });
    }

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
      const [cmd, ...args] = CLIPBOARD_READ_CMD;
      const clip = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      clip.on('error', () => {});
      let data = '';
      clip.stdout.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      clip.on('close', () => {
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
            history.push({ sessionId: info.sessionId, cwd: info.cwd, pid: info.pid, startMs: Date.now(), alive: true });
          }
        }
        for (const entry of history) {
          if (entry.alive && !isPidAlive(entry.pid)) entry.alive = false;
        }
        const sw = stopwatchRef.current;
        let swMs = sw.accumulatedMs;
        if (sw.running) swMs += Date.now() - sw.startMs;
        const layout = computeMenuLayout(history, true);
        const menuW = SESSION_MENU_INNER + 2;
        const r = Math.max(0, Math.min(row, d.rows - layout.height));
        const c = Math.max(0, Math.min(col, d.cols - menuW));
        ctxMenuRef.current = { kind: 'automateLinuxTerminalMenu', row: r, col: c, hasSelection: false, hoverItem: -1, sessions: [...history], stopwatchDisplay: formatStopwatch(swMs), stopwatchAction: sw.running ? 'stop' : 'start', stopwatchRowOff: layout.stopwatchRow, topic: topicRef.current, editingTopic: false, editBuffer: '', topicRowOff: layout.topicRow, showTopicBar: showTopicBarRef.current, copiedSessionIdx: -1 };
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
        ctxMenuRef.current = { kind: 'clipboard', row: r, col: c, hasSelection: hasSel, hoverItem: -1, sessions: [], stopwatchDisplay: null, stopwatchAction: null, stopwatchRowOff: 0, topic: '', editingTopic: false, editBuffer: '', topicRowOff: 0, showTopicBar: false, copiedSessionIdx: -1 };
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
                if (rowOff === 1) itemIdx = 0;
                else if (rowOff === m.topicRowOff) itemIdx = 20;
                else if (rowOff === m.topicRowOff + 1) itemIdx = 21;
                else if (rowOff === m.stopwatchRowOff) itemIdx = 10;
                else {
                  const si = sessionIdxFromRowOff(rowOff, m.sessions);
                  itemIdx = si >= 0 ? 100 + si : -1;
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
                    topicRef.current = newTopic;
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
                if (m.kind === 'automateLinuxTerminalMenu' && onItem && itemIdx === 21) {
                  showTopicBarRef.current = !showTopicBarRef.current;
                  setShowTopicBar(showTopicBarRef.current);
                  const upd: ContextMenuState = { ...m, showTopicBar: showTopicBarRef.current };
                  ctxMenuRef.current = upd;
                  setCtxMenu(upd);
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
              topicRef.current = newTopic;
              closeMenu();
              inBuf = ''; return;
            } else if (ch === '\x7f' || ch === '\x08') {
              const upd: ContextMenuState = { ...m, editBuffer: m.editBuffer.slice(0, -1) };
              ctxMenuRef.current = upd;
              setCtxMenu(upd);
            } else if (ch.charCodeAt(0) >= 32) {
              if (m.editBuffer.length < SESSION_MENU_INNER - 3) {
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
      {showTopicBar && topicRef.current && (
        <Box position="absolute" marginTop={1} marginLeft={Math.max(0, cols - topicRef.current.length - 2)}>
          <Text backgroundColor="#1c1c1c" color="#ad7fa8">{` ${topicRef.current} `}</Text>
        </Box>
      )}
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
