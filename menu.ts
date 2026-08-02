import type { SessionHistoryEntry } from "./types.js";

export const SESSION_MENU_INNER = 28;
export const sessionMenuPad = (s: string) => (s + " ".repeat(SESSION_MENU_INNER)).slice(0, SESSION_MENU_INNER);
export const sessionMenuBorder = "─".repeat(SESSION_MENU_INNER);

/** Cells the topic gets inside its menu row: the row's width less the space of padding
 *  at each end. */
export const TOPIC_VIEW_WIDTH = SESSION_MENU_INNER - 2;

/** Longest topic the menu accepts. The row no longer has to HOLD the topic — one that
 *  overflows scrolls — so this is only a sanity bound on a string that also becomes a
 *  window title and a spoken label, not a layout constraint. */
export const TOPIC_MAX_CHARS = 120;

/** Widest the pinned topic bar may grow before it, too, becomes a scrolling sign. That
 *  bar is drawn OVER the terminal's own output, so a long topic must not be allowed to
 *  eat the line (or to push its left edge off the screen).
 *
 *  Deliberately the SAME width as the menu row: one topic must be a sign in both places
 *  or in neither. At 40 the two disagreed for every topic between 27 and 40 characters —
 *  the menu row slid while the bar an inch away sat still, which reads as the bar being
 *  broken rather than as it having nothing to hide. */
export const TOPIC_BAR_MAX_WIDTH = TOPIC_VIEW_WIDTH;

export const topicBarWidth = (cols: number) => Math.max(8, Math.min(TOPIC_BAR_MAX_WIDTH, cols - 4));

/** Milliseconds between single-cell steps of a scrolling sign. */
export const MARQUEE_STEP_MS = 200;

/** Steps the head of the text is held still at the start of every pass. A topic you
 *  glance at should read from its beginning, not from wherever the loop happens to be. */
export const MARQUEE_HOLD_STEPS = 6;

/** Blank cells between the tail and the head coming round again, so the two ends of a
 *  wrapped topic are never read as one phrase. */
const MARQUEE_GAP = "   ";

/** The `width` cells of `text` visible at step `tick` of a scrolling sign.
 *
 *  Pure on purpose: the clock that advances `tick` lives in the component (marquee.ts),
 *  so what is drawn at a given step is testable without rendering or waiting. Text that
 *  fits is returned untouched and never moves — only an overflowing topic scrolls. */
export function marqueeWindow(text: string, width: number, tick: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  const cycle = text + MARQUEE_GAP;
  const period = cycle.length + MARQUEE_HOLD_STEPS;
  const phase = ((tick % period) + period) % period;
  const start = Math.max(0, phase - MARQUEE_HOLD_STEPS);
  return (cycle + cycle).slice(start, start + width);
}

/** What an over-long topic looks like while it is being TYPED: the tail, so the cursor
 *  stays in view, with a leading ellipsis marking the part scrolled off.
 *
 *  Editing deliberately does NOT marquee — a field that slides out from under the cursor
 *  cannot be typed into. */
export function editWindow(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return "…" + text.slice(-(width - 1));
}

export function formatElapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function formatStopwatch(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Where every row of the session menu lands, as offsets from its top border.
 *
 *  The topic comes FIRST, on the row directly under the top border: it is the one row
 *  people open this menu to reach, and a menu that grows a row per running session kept
 *  pushing it further down the screen. Everything below it is reference (which sessions
 *  exist) or occasional (the timer), so it can move.
 *
 *  The name and version are not a row -- they are behind the "?", which opens one info
 *  line in place. That "?" now sits LAST, under everything: it is the least-wanted thing
 *  in the menu, and holding the first row it pushed the topic — the most-wanted — one row
 *  further from the pointer on every single open. At the bottom it also costs nothing to
 *  unfold: the info line it opens grows the menu downwards, moving no row above it. */
export function computeMenuLayout(sessions: SessionHistoryEntry[], hasStopwatch: boolean, infoOpen: boolean) {
  let row = 0;
  row++;                         // top border
  const topicRow = row; row++;   // topic
  row++;                         // pin topic
  const muteRow = row; row++;    // mute voice (claude-voice global mute)
  let sessionsRow = -1;
  if (sessions.length > 0) {
    row++;                       // session separator
    sessionsRow = row;
    for (const e of sessions) {
      row++;                     // session line
      if (e.cwd) row++;         // cwd line
      row++;                     // captions line
      row++;                     // bookmark line
    }
  }
  let stopwatchRow = -1;
  if (hasStopwatch) {
    row++;                       // stopwatch separator
    stopwatchRow = row; row++;   // stopwatch
  }
  row++;                         // help separator
  const helpRow = row; row++;    // the "?"
  if (infoOpen) row++;           // the info line it opens
  row++;                         // bottom border
  return { helpRow, topicRow, muteRow, sessionsRow, stopwatchRow, height: row };
}

export type SessionRowAction = 'copy' | 'captions' | 'bookmark';

/** Which session a menu row belongs to, and what clicking it does. Every session occupies
 *  three or four consecutive rows -- the id line, an optional cwd line, the captions line
 *  and the bookmark line -- so the mapping is a walk, not arithmetic.
 *
 *  `startRow` is where the first session line is drawn, from computeMenuLayout. It is
 *  passed in rather than counted from the top because what sits above the list now varies:
 *  the "?" opens an info line, and the topic section above shifts everything with it.
 *
 *  The bookmark line is APPENDED rather than slotted in next to the id: every other
 *  placement would shift the captions row that people already click by position. */
export function sessionRowAt(
  rowOff: number,
  sessions: SessionHistoryEntry[],
  startRow: number,
): { idx: number; action: SessionRowAction } | null {
  if (sessions.length === 0 || startRow < 0) return null;
  let row = startRow;
  for (let i = 0; i < sessions.length; i++) {
    if (rowOff === row) return { idx: i, action: 'copy' };
    row++;
    if (sessions[i].cwd) {
      if (rowOff === row) return { idx: i, action: 'copy' };
      row++;
    }
    if (rowOff === row) return { idx: i, action: 'captions' };
    row++;
    if (rowOff === row) return { idx: i, action: 'bookmark' };
    row++;
  }
  return null;
}
