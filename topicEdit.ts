import { TOPIC_MAX_CHARS } from "./menu.js";

/** THE TOPIC FIELD'S KEYBOARD, as pure functions: what a key does to (buffer, caret), and
 *  what the field looks like with the caret where it is.
 *
 *  The topic row is the ONE row in this menu that has a keyboard handed to it — every other
 *  row acts on a click. It shipped as an append-only field: the only editing key it took was
 *  Backspace-at-the-end, and every escape sequence (an arrow, Home, Delete) fell through to
 *  the branch that dismisses the menu. So pressing Left to fix a typo three characters back
 *  threw the whole edit away, which reads as the field being broken rather than as the key
 *  meaning something else.
 *
 *  It lives in its own file, and pure, for the reason `marqueeWindow` does: what a keystroke
 *  does to a text field is a table of small decisions that must be checked exhaustively, and
 *  none of it needs a terminal, a render or a clock to be true. `tests/testTopicEdit.ts`
 *  drives every action and every sequence in the tables below. `app.tsx` only decodes the
 *  bytes and stores what comes back. */

export interface TopicField {
  buffer: string;
  /** Characters to the LEFT of the caret; `buffer.length` means "past the last character". */
  cursor: number;
}

export type TopicAction =
  | 'left' | 'right' | 'wordLeft' | 'wordRight' | 'home' | 'end'
  | 'deleteBack' | 'deleteForward' | 'deleteWordBack' | 'deleteWordForward'
  | 'killToStart' | 'killToEnd';

/** Control keys the field CLAIMS. Everything else under 32 still dismisses an untouched
 *  field (`app.tsx`), which is what keeps a Ctrl+C aimed at getting out of a menu opened by
 *  accident from being swallowed by a field with nothing in it.
 *
 *  These are readline's, not invented: the fingers that type a topic have typed at a bash
 *  prompt all day, and a field that answers Ctrl+A with "menu closed" is a field that
 *  punishes exactly that habit. Ctrl+C and Ctrl+D are deliberately NOT here — Ctrl+D is the
 *  key this app types to end things (see `exit.ts`), and a forward-delete hiding under it in
 *  one row of one menu is not worth the collision. The Delete key does that job. */
const CONTROL_KEYS: Record<string, TopicAction> = {
  "\x7f": 'deleteBack',        // Backspace (what a terminal actually sends)
  "\x08": 'deleteBack',        // Ctrl+H / Backspace on the terminals that send BS
  "\x01": 'home',              // Ctrl+A
  "\x05": 'end',               // Ctrl+E
  "\x02": 'left',              // Ctrl+B
  "\x06": 'right',             // Ctrl+F
  "\x0b": 'killToEnd',         // Ctrl+K
  "\x15": 'killToStart',       // Ctrl+U
  "\x17": 'deleteWordBack',    // Ctrl+W
};

/** ESC + one character: what Alt sends. */
const ALT_KEYS: Record<string, TopicAction> = {
  b: 'wordLeft',
  f: 'wordRight',
  B: 'wordLeft',
  F: 'wordRight',
  "\x7f": 'deleteWordBack',    // Alt+Backspace
  "\x08": 'deleteWordBack',
};

/** The letter a cursor-key sequence ends with, unmodified.
 *
 *  Up and Down go to the two ENDS of the field. A one-line field has no line above it to
 *  walk to, so the alternative is a key that does nothing — and "nothing" in this menu used
 *  to mean "the edit is gone", which is the habit this is being fixed out of. Every
 *  single-line text field on this desktop already answers Up with "the start". */
const CSI_FINAL: Record<string, TopicAction> = {
  D: 'left', C: 'right', A: 'home', B: 'end', H: 'home', F: 'end',
};

/** The number in a `\x1b[<n>~` sequence. */
const CSI_TILDE: Record<string, TopicAction> = {
  '1': 'home', '7': 'home',    // Home, on the two encodings terminals disagree over
  '4': 'end', '8': 'end',      // End, likewise
  '3': 'deleteForward',        // Delete
};

/** Whether a CSI modifier parameter carries Ctrl or Alt — the two that make a motion or a
 *  delete word-wise. The parameter is `1 + shift(1) + alt(2) + ctrl(4)`, so Shift+Left stays
 *  a plain Left (there is no selection here for it to extend). */
const isWordModifier = (mod: number) => ((mod - 1) & 6) !== 0;

/** Which editing action the input at the head of `s` is, and how many characters of it that
 *  takes. `null` means the field does not claim this key — the caller then does what it did
 *  before the field existed (dismiss the menu, or type a printable character into it).
 *
 *  Returning the length consumed rather than assuming one keypress per read is what lets the
 *  caller keep walking a buffer that holds a held-down arrow's worth of sequences. */
export function topicKeyAt(s: string): { action: TopicAction; consumed: number } | null {
  if (!s) return null;
  if (s[0] !== '\x1b') {
    const action = CONTROL_KEYS[s[0]];
    return action ? { action, consumed: 1 } : null;
  }
  // SS3 — what the arrow keys send in "application cursor" mode, which is the mode a lot of
  // full-screen programs leave the terminal in.
  const ss3 = s.match(/^\x1bO([A-Z])/);
  if (ss3) {
    const action = CSI_FINAL[ss3[1]];
    return action ? { action, consumed: ss3[0].length } : null;
  }
  const csi = s.match(/^\x1b\[([\d;]*)([A-Z~])/);
  if (csi) {
    const params = csi[1].split(';');
    const wordy = isWordModifier(Number(params[1] || '1'));
    if (csi[2] === '~') {
      const action = CSI_TILDE[params[0]];
      if (!action) return null;
      return { action: action === 'deleteForward' && wordy ? 'deleteWordForward' : action, consumed: csi[0].length };
    }
    const action = CSI_FINAL[csi[2]];
    if (!action) return null;
    const wordWise: Partial<Record<TopicAction, TopicAction>> = { left: 'wordLeft', right: 'wordRight' };
    return { action: (wordy && wordWise[action]) || action, consumed: csi[0].length };
  }
  const alt = ALT_KEYS[s[1]];
  return alt ? { action: alt, consumed: 2 } : null;
}

/** Where the word to the left of `i` starts: back over any spaces, then back over the run of
 *  non-spaces. Readline's rule, and the one Ctrl+W in every shell on this machine follows. */
function wordStart(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1])) j--;
  while (j > 0 && !/\s/.test(s[j - 1])) j--;
  return j;
}

/** Where the word to the right of `i` ends — the mirror of `wordStart`. */
function wordEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  while (j < s.length && !/\s/.test(s[j])) j++;
  return j;
}

/** One editing action applied to the field. Always returns a NEW field with the caret inside
 *  the buffer, so nothing downstream has to defend against a caret that has walked off. */
export function applyTopicAction(field: TopicField, action: TopicAction): TopicField {
  const buf = field.buffer;
  const at = Math.max(0, Math.min(field.cursor, buf.length));
  switch (action) {
    case 'left': return { buffer: buf, cursor: Math.max(0, at - 1) };
    case 'right': return { buffer: buf, cursor: Math.min(buf.length, at + 1) };
    case 'wordLeft': return { buffer: buf, cursor: wordStart(buf, at) };
    case 'wordRight': return { buffer: buf, cursor: wordEnd(buf, at) };
    case 'home': return { buffer: buf, cursor: 0 };
    case 'end': return { buffer: buf, cursor: buf.length };
    case 'deleteBack':
      if (at === 0) return { buffer: buf, cursor: 0 };
      return { buffer: buf.slice(0, at - 1) + buf.slice(at), cursor: at - 1 };
    case 'deleteForward':
      return { buffer: buf.slice(0, at) + buf.slice(at + 1), cursor: at };
    case 'deleteWordBack': {
      const j = wordStart(buf, at);
      return { buffer: buf.slice(0, j) + buf.slice(at), cursor: j };
    }
    case 'deleteWordForward': {
      const j = wordEnd(buf, at);
      return { buffer: buf.slice(0, at) + buf.slice(j), cursor: at };
    }
    case 'killToStart': return { buffer: buf.slice(at), cursor: 0 };
    case 'killToEnd': return { buffer: buf.slice(0, at), cursor: at };
  }
}

/** Typing: the characters go in AT the caret, not on the end.
 *
 *  Bounded by `TOPIC_MAX_CHARS` — what a topic sanely is, since it also becomes a window
 *  title and a spoken label — and the bound is applied to the text being inserted rather
 *  than by refusing the keystroke, so a paste that would overflow puts in what fits instead
 *  of nothing. */
export function insertTopicText(field: TopicField, text: string): TopicField {
  return insertFieldText(field, text, TOPIC_MAX_CHARS);
}

/** The same insertion with the bound as a parameter -- the topic's cap is what a topic
 *  sanely is, and the "send to session" message box (sendToSession.ts) is the same field
 *  with a different idea of sane. One function, so the two boxes cannot drift on where a
 *  character goes or what an overflowing paste does. */
export function insertFieldText(field: TopicField, text: string, max: number): TopicField {
  const buf = field.buffer;
  const at = Math.max(0, Math.min(field.cursor, buf.length));
  const add = text.slice(0, Math.max(0, max - buf.length));
  if (!add) return { buffer: buf, cursor: at };
  return { buffer: buf.slice(0, at) + add + buf.slice(at), cursor: at + add.length };
}

/** What an over-long topic looks like while it is being TYPED: the `width` cells around the
 *  caret, and which of them the caret is on.
 *
 *  Editing deliberately does NOT marquee — a field that slides out from under the caret
 *  cannot be typed into — so the window is anchored to the caret instead of to a clock. A
 *  `…` marks each end that has text beyond it (the old version could only ever scroll to the
 *  tail, so it needed one marker; a caret that can sit anywhere needs both).
 *
 *  **The caret never lands on a marker.** The window is chosen to keep it one cell in from
 *  whichever edge is showing a `…`, because a caret drawn as `…` is a caret you cannot find
 *  — and the field's whole job is showing you where the next character goes. */
export function editView(text: string, cursor: number, width: number): { text: string; caret: number } {
  if (width <= 0) return { text: "", caret: 0 };
  const at = Math.max(0, Math.min(cursor, text.length));
  // Every character, plus the caret's own cell past the last one: a field whose text exactly
  // fills the row still has to show you that the caret is at the end of it.
  const total = text.length + 1;
  if (total <= width) return { text, caret: at };
  // Too narrow for markers at all (never happens in this menu — TOPIC_VIEW_WIDTH is 31 — but
  // the function is pure and someone will call it with a narrow row one day).
  if (width < 3) return { text: (text.slice(at, at + width) + " ".repeat(width)).slice(0, width), caret: 0 };
  const last = width - 1;
  const start = Math.min(at <= last - 1 ? 0 : at - (last - 1), total - width);
  let cells = (text.slice(start, start + width) + " ".repeat(width)).slice(0, width);
  if (start > 0) cells = "…" + cells.slice(1);
  if (start + width < total) cells = cells.slice(0, last) + "…";
  return { text: cells, caret: at - start };
}
