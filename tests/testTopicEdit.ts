// THE TOPIC FIELD'S KEYBOARD.
//
// The field shipped append-only: Backspace took the last character, everything else printable
// went on the end, and every escape sequence — an arrow, Home, Delete — fell through to the
// branch that dismisses the menu. So Left, pressed to fix a typo three characters back, threw
// the whole edit away. What breaks if this drifts is exactly that again, silently: a key that
// looks like it does nothing, or one that loses what you typed.
//
// Everything here is pure, so every key and every action is checked without a terminal, a
// render or a clock. tests/testMenuRows.ts checks what the row DRAWS; this checks what the
// keys MEAN.
//
//   npx tsx tests/testTopicEdit.ts
import { topicKeyAt, applyTopicAction, insertTopicText, editView } from "../topicEdit.js";
import type { TopicField, TopicAction } from "../topicEdit.js";
import { TOPIC_MAX_CHARS, TOPIC_VIEW_WIDTH } from "../menu.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };
const eq = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fail(`${what}: got ${g}, want ${w}`);
};

/** A field written the way it reads on screen: the caret is the `|`. */
const field = (s: string): TopicField => ({ buffer: s.replace("|", ""), cursor: s.indexOf("|") });
const show = (f: TopicField) => f.buffer.slice(0, f.cursor) + "|" + f.buffer.slice(f.cursor);
const after = (s: string, action: TopicAction) => show(applyTopicAction(field(s), action));

// ── MOTION ──────────────────────────────────────────────────────────────────────────────
eq(after("peer|sync", 'left'), "pee|rsync", "left moves one character");
eq(after("peer|sync", 'right'), "peers|ync", "right moves one character");
// Both ends are walls, not errors: a caret that wrapped, or a keypress that threw, in a menu
// drawn over a live terminal.
eq(after("|peer", 'left'), "|peer", "left at the head stays put");
eq(after("peer|", 'right'), "peer|", "right at the end stays put");
eq(after("peer sy|nc", 'home'), "|peer sync", "home goes to the head");
eq(after("pe|er sync", 'end'), "peer sync|", "end goes to the tail");
// Word motion skips the spaces on the way, so it lands on a word rather than in the gap
// before one -- the shell's rule, which is the one these fingers already have.
eq(after("peer heartbeat sync|", 'wordLeft'), "peer heartbeat |sync", "word-left to the start of this word");
eq(after("peer heartbeat |sync", 'wordLeft'), "peer |heartbeat sync", "word-left again clears the space");
eq(after("|peer sync", 'wordLeft'), "|peer sync", "word-left at the head stays put");
eq(after("|peer heartbeat sync", 'wordRight'), "peer| heartbeat sync", "word-right to the end of this word");
eq(after("peer| heartbeat sync", 'wordRight'), "peer heartbeat| sync", "word-right again clears the space");
eq(after("peer sync|", 'wordRight'), "peer sync|", "word-right at the end stays put");

// ── DELETION ────────────────────────────────────────────────────────────────────────────
eq(after("peer|sync", 'deleteBack'), "pee|sync", "backspace takes the character BEFORE the caret");
eq(after("|peersync", 'deleteBack'), "|peersync", "backspace at the head is a no-op, not a wrap");
eq(after("peer|sync", 'deleteForward'), "peer|ync", "delete takes the character UNDER the caret");
eq(after("peersync|", 'deleteForward'), "peersync|", "delete at the end is a no-op");
eq(after("peer heartbeat |sync", 'deleteWordBack'), "peer |sync", "ctrl+w takes the word before the caret");
eq(after("peer |heartbeat sync", 'deleteWordForward'), "peer | sync", "ctrl+delete takes the word after it");
eq(after("peer |heartbeat", 'killToStart'), "|heartbeat", "ctrl+u kills back to the head");
eq(after("peer |heartbeat", 'killToEnd'), "peer |", "ctrl+k kills to the tail");

// ── TYPING ──────────────────────────────────────────────────────────────────────────────
eq(show(insertTopicText(field("peer|sync"), "-")), "peer-|sync", "a character goes in AT the caret");
eq(show(insertTopicText(field("|"), "p")), "p|", "the first character of an empty field");
{
  // The cap bounds what a topic sanely IS (it becomes a window title and a spoken label), and
  // it is applied to the text rather than to the keystroke: a paste that would overflow puts
  // in what fits instead of nothing at all.
  const full = { buffer: "x".repeat(TOPIC_MAX_CHARS), cursor: TOPIC_MAX_CHARS };
  eq(insertTopicText(full, "y").buffer.length, TOPIC_MAX_CHARS, "a full field takes no more");
  const nearly = { buffer: "x".repeat(TOPIC_MAX_CHARS - 2), cursor: 0 };
  eq(insertTopicText(nearly, "abcdef").buffer.length, TOPIC_MAX_CHARS, "an overflowing insert puts in what fits");
}

// ── WHICH KEY IS WHICH ──────────────────────────────────────────────────────────────────
//
// Both encodings of every cursor key: a terminal in "application cursor" mode sends SS3
// (\x1bO...) where one in normal mode sends CSI (\x1b[...), and this app's stdin sees
// whichever mode the outer terminal happens to be in.
const key = (s: string) => topicKeyAt(s);
eq(key("\x1b[D"), { action: 'left', consumed: 3 }, "CSI left");
eq(key("\x1bOD"), { action: 'left', consumed: 3 }, "SS3 left");
eq(key("\x1b[C"), { action: 'right', consumed: 3 }, "CSI right");
eq(key("\x1bOC"), { action: 'right', consumed: 3 }, "SS3 right");
// A one-line field has no line above or below, so up and down go to its two ends -- the
// alternative is a key that does nothing, and "nothing" in this menu used to mean "the edit
// is gone", which is the habit this is being fixed out of.
eq(key("\x1b[A"), { action: 'home', consumed: 3 }, "up goes to the head");
eq(key("\x1b[B"), { action: 'end', consumed: 3 }, "down goes to the tail");
eq(key("\x1b[H"), { action: 'home', consumed: 3 }, "Home");
eq(key("\x1b[F"), { action: 'end', consumed: 3 }, "End");
eq(key("\x1b[1~"), { action: 'home', consumed: 4 }, "Home, the ~ encoding");
eq(key("\x1b[4~"), { action: 'end', consumed: 4 }, "End, the ~ encoding");
eq(key("\x1b[3~"), { action: 'deleteForward', consumed: 4 }, "Delete");
// Ctrl and Alt make a motion or a delete word-wise; Shift does not (there is no selection
// here for it to extend, so it stays a plain step).
eq(key("\x1b[1;5D"), { action: 'wordLeft', consumed: 6 }, "Ctrl+Left");
eq(key("\x1b[1;3C"), { action: 'wordRight', consumed: 6 }, "Alt+Right");
eq(key("\x1b[1;2D"), { action: 'left', consumed: 6 }, "Shift+Left is still one character");
eq(key("\x1b[3;5~"), { action: 'deleteWordForward', consumed: 6 }, "Ctrl+Delete");
eq(key("\x1b[1;5H"), { action: 'home', consumed: 6 }, "modified Home is still Home");
eq(key("\x1bb"), { action: 'wordLeft', consumed: 2 }, "Alt+B");
eq(key("\x1bf"), { action: 'wordRight', consumed: 2 }, "Alt+F");
eq(key("\x1b\x7f"), { action: 'deleteWordBack', consumed: 2 }, "Alt+Backspace");
eq(key("\x7f"), { action: 'deleteBack', consumed: 1 }, "Backspace");
eq(key("\x01"), { action: 'home', consumed: 1 }, "Ctrl+A");
eq(key("\x05"), { action: 'end', consumed: 1 }, "Ctrl+E");
eq(key("\x02"), { action: 'left', consumed: 1 }, "Ctrl+B");
eq(key("\x06"), { action: 'right', consumed: 1 }, "Ctrl+F");
eq(key("\x15"), { action: 'killToStart', consumed: 1 }, "Ctrl+U");
eq(key("\x0b"), { action: 'killToEnd', consumed: 1 }, "Ctrl+K");
eq(key("\x17"), { action: 'deleteWordBack', consumed: 1 }, "Ctrl+W");

// THE WAY OUT OF THE MENU IS NOT CLAIMED BY THE FIELD.
//
// A bare Escape cancels the edit (or closes an untouched menu), and Ctrl+C / Ctrl+D still
// dismiss it -- app.tsx does that only for the keys this returns null for. Ctrl+D is also the
// key this app TYPES to end a claude and a shell (exit.ts); a forward-delete hiding under it
// in one row of one menu is not worth the collision, which is why Delete does that job.
for (const [seq, what] of [["\x1b", "a bare Escape"], ["\x03", "Ctrl+C"], ["\x04", "Ctrl+D"],
                           ["\x1b[15~", "F5"], ["\x1b[<0;10;3M", "a mouse report"]] as const) {
  if (key(seq)) fail(`${what} is claimed by the field: ${JSON.stringify(key(seq))}`);
}
// A printable character is not an editing key -- it is typed. (Null here is what routes it to
// insertTopicText, so claiming one would make that letter unenterable.)
for (const ch of ["a", "Z", " ", "-", "ש"]) {
  if (key(ch)) fail(`"${ch}" is claimed as an editing key and could never be typed`);
}
// Every sequence consumed is exactly as long as the sequence: consuming one character short
// leaves a stray `[` to be typed INTO the topic, one too many eats the next keystroke.
for (const seq of ["\x1b[D", "\x1bOD", "\x1b[3~", "\x1b[1;5D", "\x1bb", "\x1b\x7f", "\x7f"]) {
  const hit = key(seq)!;
  if (hit.consumed !== seq.length) fail(`${JSON.stringify(seq)} consumed ${hit.consumed} of ${seq.length}`);
}

// ── WHAT THE FIELD SHOWS ────────────────────────────────────────────────────────────────
const W = TOPIC_VIEW_WIDTH;
{
  // A topic that fits is drawn whole, caret included -- the field never scrolls when it has
  // nothing to hide.
  eq(editView("voice", 5, W), { text: "voice", caret: 5 }, "a short topic is drawn whole");
  eq(editView("voice", 2, W), { text: "voice", caret: 2 }, "...with the caret wherever it is");
  eq(editView("", 0, W), { text: "", caret: 0 }, "an empty field is a caret and nothing else");
  // The caret's own cell past the last character has to fit too, so a topic exactly as wide
  // as the row is already scrolling.
  const exact = "x".repeat(W);
  const view = editView(exact, W, W);
  eq(view.text.length, W, "a topic exactly filling the row still draws one row");
  if (view.caret > W - 1) fail(`the caret is drawn off the row: ${view.caret}`);
}
{
  const long = "rewriting the peer heartbeat so a worker survives a leader restart";
  // Typed at the tail: the END is what is in view, with the clipped head marked.
  const tail = editView(long, long.length, W);
  eq(tail.text.length, W, "the field is exactly one row wide at the tail");
  if (!tail.text.startsWith("…")) fail(`no marker on the clipped head: ${JSON.stringify(tail.text)}`);
  if (!tail.text.includes("restart")) fail(`the tail is not in view while typing at it: ${JSON.stringify(tail.text)}`);
  eq(tail.caret, W - 1, "the caret is the last cell when typing at the end");
  // At the head: the head is in view and the marker moves to the other end.
  const head = editView(long, 0, W);
  eq(head.caret, 0, "the caret is the first cell at the head");
  if (!head.text.startsWith("rewriting")) fail(`the head is not in view: ${JSON.stringify(head.text)}`);
  if (!head.text.endsWith("…")) fail(`no marker on the clipped tail: ${JSON.stringify(head.text)}`);
  // THE CARET IS NEVER THE CELL A MARKER TOOK -- a caret drawn as "…" is a caret you cannot
  // find, and finding it is the whole job of the field. Walk every position of a topic that
  // overflows both ways and check it, since the window is chosen by arithmetic that has no
  // other alarm when it is off by one.
  for (let at = 0; at <= long.length; at++) {
    const v = editView(long, at, W);
    if (v.text.length !== W) { fail(`caret ${at} drew ${v.text.length} cells, want ${W}`); break; }
    if (v.caret < 0 || v.caret > W - 1) { fail(`caret ${at} landed at cell ${v.caret}, off a ${W}-cell row`); break; }
    if (v.text[v.caret] === "…") { fail(`caret ${at} landed on a marker: ${JSON.stringify(v.text)}`); break; }
    // ...and it is the character actually under it, so what you delete is what you see.
    if (at < long.length && v.text[v.caret] !== long[at]) {
      fail(`caret ${at} sits on ${JSON.stringify(v.text[v.caret])}, want ${JSON.stringify(long[at])}`);
      break;
    }
  }
}
// Degenerate widths are what a 1-column terminal hands us; they must not throw or overflow.
eq(editView("peer", 2, 0), { text: "", caret: 0 }, "zero width draws nothing");
eq(editView("peer", 2, -3), { text: "", caret: 0 }, "negative width draws nothing");
for (const w of [1, 2, 3]) {
  const v = editView("peer heartbeat", 7, w);
  if (v.text.length !== w) fail(`width ${w} drew ${v.text.length} cells`);
  if (v.caret >= w) fail(`width ${w} put the caret at cell ${v.caret}`);
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
