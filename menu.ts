import type { SessionHistoryEntry } from "./types.js";

/** Cells inside the menu's borders.
 *
 *  Wide enough that a session's head row holds ALL of what it says and does:
 *  `● copy session id 90cc2dc0` plus the elapsed time on the right. At 28 it did not, and
 *  the alternative — scrolling that row like the topic — hides the id for most of every
 *  pass, which is the one thing the row exists to show. A path can be any length and must
 *  scroll; a label plus eight hex characters is bounded, so it gets the room instead.
 *
 *  Widening this widens the topic's row AND the pinned bar with it (both are derived
 *  below), which is the point: they must start scrolling together. */
export const SESSION_MENU_INNER = 35;
export const sessionMenuPad = (s: string) => (s + " ".repeat(SESSION_MENU_INNER)).slice(0, SESSION_MENU_INNER);
export const sessionMenuBorder = "─".repeat(SESSION_MENU_INNER);

/** Cells at the head of the topic row that belong to the pin box (` ☐ `): the leading
 *  indent every row in this menu has, the box, and the space after it. All three are the
 *  box's hit target — a single character is too small a thing to ask a pointer to find. */
export const TOPIC_PIN_CELLS = 3;

/** Cells the topic gets inside its menu row: the row's width, less the pin box in front
 *  of it and one cell of padding at the end. */
export const TOPIC_VIEW_WIDTH = SESSION_MENU_INNER - TOPIC_PIN_CELLS - 1;

/** What a click at `colOff` cells into the topic row means: 21 = the pin box, 20 = the
 *  topic field. They are one row now, so the column decides, not the row.
 *
 *  While the field is being EDITED the whole row commits: a box that pins a topic you
 *  have not finished typing pins the old one, which reads as the click having done
 *  nothing. `colOff` is 1-based from the menu's left border, as the mouse handler
 *  measures it. */
export function topicRowItem(colOff: number, editing: boolean): 20 | 21 {
  if (editing) return 20;
  return colOff <= TOPIC_PIN_CELLS ? 21 : 20;
}

/** What the session's two head rows say. They are labels, not decoration: `● 90cc2dc0` and
 *  a bare path told you what the session IS, and nothing about what clicking them does —
 *  and both rows do the same thing (copy the id), which was invisible.
 *
 *  Exported so the tests can find the rows by the words the menu actually draws. */
export const SESSION_ID_LABEL = "copy session id";
export const SESSION_CWD_LABEL = "launched from";

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
 *  Its pin is not a row of its own -- the box sits IN the topic row, in front of the text
 *  it pins, and a rule closes the field off underneath. "pin topic" on its own line read
 *  as a second, unrelated setting; against the topic it is plainly a property OF it. The
 *  two rows the pair used to take are still two, so nothing below shifts.
 *
 *  The name and version are not a row -- they are behind the "?", which opens one info
 *  line in place. That "?" now sits LAST, under everything: it is the least-wanted thing
 *  in the menu, and holding the first row it pushed the topic — the most-wanted — one row
 *  further from the pointer on every single open. At the bottom it also costs nothing to
 *  unfold: the info line it opens grows the menu downwards, moving no row above it.
 *
 *  The three voice rows are ONE segment of their own: the mute, the captions, and the
 *  replay. What is said aloud is a subject, and it is now grouped as one — reading down
 *  the segment gives you the whole of it (silence it / read it / hear it again) without
 *  the eye having to collect three rows from three places.
 *
 *  They act on THIS TAB'S session (`currentSessionId`), which is why they can be one row
 *  each instead of one per session block: a tab hosts one live claude, and the captions
 *  you want are its. They are drawn only when this tab has hosted a session at all —
 *  rows that narrow a caption window to nothing are not worth their space. */
export function computeMenuLayout(sessions: SessionHistoryEntry[], hasStopwatch: boolean, infoOpen: boolean) {
  let row = 0;
  row++;                         // top border
  const topicRow = row; row++;   // topic + its pin box (one row, split by column)
  row++;                         // the rule under the topic field
  const muteRow = row; row++;    // mute voice (claude-voice global mute)
  let captionsRow = -1, replayRow = -1;
  if (sessions.length > 0) {
    captionsRow = row; row++;    // this tab's captions
    replayRow = row; row++;      // ...and the last of them, again
  }
  let sessionsRow = -1;
  if (sessions.length > 0) {
    row++;                       // rule closing the voice segment off
    sessionsRow = row;
    for (const e of sessions) {
      row++;                     // session line
      if (e.cwd) row++;         // cwd line
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
  return { helpRow, topicRow, muteRow, captionsRow, replayRow, sessionsRow, stopwatchRow, height: row };
}

export type SessionRowAction = 'copy' | 'bookmark';

/** Which session a menu row belongs to, and what clicking it does. Every session occupies
 *  two or three consecutive rows -- the id line, an optional cwd line and the bookmark
 *  line -- so the mapping is a walk, not arithmetic.
 *
 *  `startRow` is where the first session line is drawn, from computeMenuLayout. It is
 *  passed in rather than counted from the top because what sits above the list now varies:
 *  the "?" opens an info line, and the topic and voice sections above shift everything.
 *
 *  A new row goes on the END of the block -- any other placement shifts a row people
 *  already click by position. The captions and replay rows used to live here, one pair per
 *  block; they are one pair in the voice segment above now, so what is left in a block is
 *  what is true of a session rather than of its voice. */
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
    if (rowOff === row) return { idx: i, action: 'bookmark' };
    row++;
  }
  return null;
}
