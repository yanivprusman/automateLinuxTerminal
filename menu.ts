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

/** What a DEAD session's head row says instead, and how much of it is the resume target.
 *
 *  The ●/○ was the one thing on the row that already said whether the session is still
 *  running, so it is the thing that brings it back — but a bare glyph says nothing about
 *  being clickable, and this menu's rule is that a row says what clicking it DOES. So the
 *  dot wears the word: ` ○ resume · copy 90cc2dc0`, and the first `SESSION_RESUME_CELLS`
 *  cells (the indent, the dot and the word) are the target, for the same reason the topic's
 *  pin box claims three — a single character is too small a thing to ask a pointer to find.
 *
 *  The rest of the row still copies the id, as the whole row did before and as a live
 *  session's row still does. `copy session id` does not fit next to `resume` inside 35
 *  cells with the elapsed time on the right, and the id is what a copy copies, so the short
 *  label carries it.
 *
 *  Derived, not written twice: the overlay draws `sessionResumeHead(dot)` and the hit-test
 *  claims exactly its length, so the words and the target cannot drift apart. */
export const SESSION_RESUME_LABEL = "resume";
export const SESSION_COPY_SHORT_LABEL = "copy";
export const sessionResumeHead = (dot: string) => ` ${dot} ${SESSION_RESUME_LABEL}`;
export const SESSION_RESUME_CELLS = sessionResumeHead("○").length;

/** THE MARK EACH ACTION ROW WEARS. No two of them may share one.
 *
 *  All three used to wear `▸`, in one blue, and they read as three of the same thing --
 *  which the exit row very much is not. Two separate reasons they had to be told apart:
 *
 *  `▸` is this app's MESSAGE marker, not a verb: every transient line the menu reports in
 *  place (`▸ exiting…`, `▸ opening…`, `▸ shell is busy here`) wears it, and so does every
 *  `note()` outside the menu. A resting label wearing the same mark says "something is
 *  happening here" while nothing is. So `▸` is now reserved for the messages, and each row
 *  gets a mark for what it DOES: a pane of lines to read, a turn back to hear the last one
 *  again, and a cross for the one row that ends the tab.
 *
 *  Colour then carries the grouping the marks no longer can: the two voice rows keep the
 *  segment's blue (they are one subject, and reading down them is the point -- see
 *  computeMenuLayout), and the exit row is the only warm thing in the menu. It is not red:
 *  red on this row already means the exit FAILED, and a row that rests in its own failure
 *  colour cannot report one.
 *
 *  Every mark here is one cell wide (`string-width` 1). The rows are padded by counting
 *  characters, so a two-cell glyph -- `☰` is one -- would shift a row's right edge off the
 *  border while looking perfectly fine in the source.
 *
 *  Exported so the tests can find each row by the words the menu actually draws. */
export const CAPTIONS_LABEL = "captions";
export const REPLAY_LABEL = "replay last caption";
export const captionsLabel = () => ` ▤ ${CAPTIONS_LABEL}`;
export const replayLabel = () => ` ↻ ${REPLAY_LABEL}`;

/** What the launch row says: the thing it starts, and the flag it starts it with.
 *
 *  The flag is on the row rather than folded into a friendly verb. `cl` on its own is what
 *  most of this menu's rows are about, but a claude started with
 *  `--dangerously-skip-permissions` will not ask before it acts, and a one-click row that
 *  quietly picks that is a row lying about what it does. It does not fit in full inside 35
 *  cells with a verb in front of it, so the row carries the short form everyone already
 *  says out loud and `launch.ts` holds the flag itself.
 *
 *  `+` is its mark -- one cell, guaranteed (it is ASCII, where every other candidate for
 *  "new" is a geometric glyph of ambiguous East-Asian width that string-width scores 1 and
 *  a terminal may still draw as two), and the universal sign for the thing this row is: one
 *  more of something. Not `▸`, which is reserved for the messages this row also reports. */
export const LAUNCH_LABEL = "start claude · skip permissions";
export const launchLabel = () => ` + ${LAUNCH_LABEL}`;

/** What the exit row says, and therefore what it does. Two labels because it is two
 *  different amounts of work: with a claude running here it is Ctrl+D, Ctrl+D, `exit` --
 *  the three presses this row exists to stop anyone having to remember -- and with none it
 *  is just the last one. A row that promised to exit claude when there is no claude would
 *  be describing a step it is about to skip. */
export const EXIT_LABEL_WITH_CLAUDE = "exit claude and this terminal";
export const EXIT_LABEL_BARE = "exit this terminal";
export const exitLabel = (liveClaude: boolean) =>
  ` ✕ ${liveClaude ? EXIT_LABEL_WITH_CLAUDE : EXIT_LABEL_BARE}`;

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
 *  All three act on THIS TAB'S session (`currentSessionId`), which is why they can be one
 *  row each instead of one per session block: a tab hosts one live claude, and the captions
 *  you want are its. They are drawn only when this tab has hosted a session at all — rows
 *  that narrow a caption window to nothing are not worth their space, and a mute with no
 *  session to name has nothing it could silence but everyone else's.
 *
 *  The mute is IN the segment for that last reason. It used to sit above it, drawn always,
 *  because it flipped the global flag and needed no session — which is exactly how it came
 *  to silence every terminal on the machine from a row that reads like a tab's own.
 *
 *  The launch row is a segment of its own too, directly above the exit's. The two are this
 *  tab's whole claude lifecycle -- start one here, end the one here -- so they belong at the
 *  same end of the menu, and reading them as a pair is the point. They are NOT one segment:
 *  a rule between them is what keeps the exit row from reading as the second, equally
 *  harmless half of a "claude" block, which is the exact failure the exit's own mark and
 *  colour were introduced to fix. It also puts a whole row between the click that starts a
 *  session and the click that ends one.
 *
 *  The exit row is a segment of its own, and it sits directly ABOVE the "?" rather than
 *  under it — the last row anyone reaches for, but never the last row. Two reasons, both
 *  about the pointer: this menu opens downwards from the clock, so the far end of it is
 *  the furthest thing from where the click that opened it landed, which is where an action
 *  that ends the session belongs; and the "?" unfolds its info line DOWNWARDS, so anything
 *  below the "?" would slide out from under the pointer the moment someone opened it. A
 *  row that ends the tab is the last row in the menu that may move. */
export function computeMenuLayout(sessions: SessionHistoryEntry[], hasStopwatch: boolean, infoOpen: boolean) {
  let row = 0;
  row++;                         // top border
  const topicRow = row; row++;   // topic + its pin box (one row, split by column)
  row++;                         // the rule under the topic field
  let muteRow = -1, captionsRow = -1, replayRow = -1;
  if (sessions.length > 0) {
    muteRow = row; row++;        // silence this tab's session
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
  row++;                         // launch separator
  const launchRow = row; row++;  // start a claude here
  row++;                         // exit separator
  const exitRow = row; row++;    // end the claude here, then this terminal
  row++;                         // help separator
  const helpRow = row; row++;    // the "?"
  if (infoOpen) row++;           // the info line it opens
  row++;                         // bottom border
  return { helpRow, launchRow, exitRow, topicRow, muteRow, captionsRow, replayRow, sessionsRow, stopwatchRow, height: row };
}

export type SessionRowAction = 'copy' | 'bookmark' | 'resume';

/** Which session a menu row belongs to, and what clicking it does. Every session occupies
 *  two or three consecutive rows -- the id line, an optional cwd line and the bookmark
 *  line -- so the mapping is a walk, not arithmetic.
 *
 *  `startRow` is where the first session line is drawn, from computeMenuLayout. It is
 *  passed in rather than counted from the top because what sits above the list now varies:
 *  the "?" opens an info line, and the topic and voice sections above shift everything.
 *
 *  `colOff` (1-based from the menu's left border, as the mouse handler measures it) matters
 *  on ONE row: a dead session's head row, whose leading cells resume it instead of copying
 *  its id. A live session's row is undivided -- there is nothing to bring back -- so the
 *  column is read only where the overlay actually draws two halves, and this function is
 *  the single place that decides which rows those are.
 *
 *  A new row goes on the END of the block -- any other placement shifts a row people
 *  already click by position. The captions and replay rows used to live here, one pair per
 *  block; they are one pair in the voice segment above now, so what is left in a block is
 *  what is true of a session rather than of its voice. */
export function sessionRowAt(
  rowOff: number,
  sessions: SessionHistoryEntry[],
  startRow: number,
  colOff: number,
): { idx: number; action: SessionRowAction } | null {
  if (sessions.length === 0 || startRow < 0) return null;
  let row = startRow;
  for (let i = 0; i < sessions.length; i++) {
    if (rowOff === row) {
      const onResume = !sessions[i].alive && colOff <= SESSION_RESUME_CELLS;
      return { idx: i, action: onResume ? 'resume' : 'copy' };
    }
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
