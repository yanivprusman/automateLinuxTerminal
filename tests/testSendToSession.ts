// The "send to session" flow: what each step does to the message, and what it refuses to
// do to it.
//
// The flow is the dashboard-android popup's (TalkViewModel), and the contract worth pinning
// is the phone's: the words in the box survive everything -- a mic that will not open, a
// whisper that is down, a delivery that fails, a mis-pressed key next to Done -- and the
// dialog closes ONLY when the message has landed or the user said not to bother. Driving it
// for real would need a microphone, whisper and a claude; the flow takes its world as an
// interface (SendIo) and this fakes it, exactly as testExit.ts fakes the tab.
//
// The geometry is pinned here too (the field's wrap, the button cells, the hit-test),
// pure, with no render; tests/testSendDialogRows.ts checks the overlay draws the same.
//
//   npx tsx tests/testSendToSession.ts
import {
  SendFlow, openTyping, heard, appending, failedToDictate, skipToType, edited, fixApplied, undoFix,
  micOpened, deliveryRefusal, wrapField, cursorAtCell, computeSendLayout, sendHitTest, buttonCells,
  writeRowButtons, actionRowButtons, sendTitle, sendHint, sendErrorLine, SEND_ITEM, FIELD_WIDTH,
  FIELD_MIN_ROWS, FIELD_MAX_ROWS, SEND_DIALOG_INNER, MESSAGE_MAX_CHARS,
} from "../sendToSession.js";
import type { SendDialogState, SendIo, Recording } from "../sendToSession.js";
import { SEND_LABEL } from "../menu.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg: string) => console.log("  ok   " + msg);
const eq = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fail(`${what}: got ${g}, want ${w}`); else ok(what);
};
const flush = () => new Promise(r => setTimeout(r, 0));

const fresh = (): SendDialogState => openTyping("aaaaaaaa-1111-2222-3333-444444444444", "voice", 0, 0);
const withWords = (words: string): SendDialogState => ({ ...fresh(), transcript: words, cursor: words.length, typed: false });

// ── THE TRANSITIONS ─────────────────────────────────────────────────────────────────────
console.log("\n# transitions");
eq(appending("", "hello"), "hello", "a first breath is the message");
eq(appending("hello", "world"), "hello world", "a second breath is joined with one space");
eq(appending("hello ", "world"), "hello world", "a space the user left at the end is not doubled");

{
  const s = heard(fresh(), "  hello there  ");
  eq([s.phase, s.transcript, s.cursor, s.typed], ["confirm", "hello there", 11, false], "heard: words land trimmed, caret at the end, no longer 'typed'");
  const more = heard(withWords("hello"), "again");
  eq(more.transcript, "hello again", "heard on top of words appends");
  const nothing = heard(fresh(), "   ");
  eq([nothing.phase, nothing.error], ["failed", "Heard nothing — try again"], "nothing heard into an empty box ends the flow, saying why");
  const kept = heard(withWords("hello"), "");
  eq([kept.phase, kept.transcript, kept.error, kept.dictationFailed], ["confirm", "hello", "Heard nothing", true], "nothing heard on top of words keeps them and notes it");
}
{
  const s = failedToDictate(withWords("hello"), "Recording failed: no mic");
  eq([s.phase, s.transcript, s.dictationFailed], ["confirm", "hello", true], "a dead mic with words in hand is a note, not a dead end");
  const e = failedToDictate(fresh(), "Recording failed: no mic");
  eq([e.phase, e.error], ["failed", "Recording failed: no mic — try again"], "a dead mic with an empty box ends the flow");
}
{
  const s = skipToType(micOpened(fresh()), true);
  eq([s.phase, s.typed, s.droppedAudio], ["confirm", true, true], "skip from an empty box lands on the confirm step, typed, with the breath kept");
  const w = skipToType(micOpened(withWords("hello")), false);
  eq([w.phase, w.typed, w.transcript], ["confirm", false, "hello"], "back from a 'say more' keeps the words and their wording");
}
{
  const fixed = fixApplied(withWords("teh cat"), "teh cat", { text: "the cat", changes: "teh → the" });
  eq([fixed.transcript, fixed.fixNote, fixed.beforeFix, fixed.fixing, fixed.cursor], ["the cat", "teh → the", "teh cat", false, 7], "a fix lands with its note and its way back");
  eq(fixApplied(withWords("the cat"), "the cat", { text: "the cat", changes: "" }).fixNote, "Nothing to fix", "an unchanged message says so");
  eq(fixApplied(withWords("the cat"), "the cat", { text: "The cat.", changes: "" }).fixNote, "Fixed", "a change with no summary is still called a fix");
  const stale = fixApplied(withWords("teh cat!"), "teh cat", { text: "the cat", changes: "teh → the" });
  eq([stale.transcript, stale.fixNote, stale.fixing], ["teh cat!", null, false], "a fix for a message that no longer exists is dropped -- typing wins");
  eq(undoFix(fixed).transcript, "teh cat", "undo puts the words back exactly");
  eq(undoFix(fixed).beforeFix, null, "undo is a one-shot");
  const typedAfter = edited(fixed, { buffer: "the cats", cursor: 8 });
  eq([typedAfter.fixNote, typedAfter.beforeFix], [null, null], "typing ends the fix's afterlife");
  const moved = edited(fixed, { buffer: "the cat", cursor: 0 });
  eq([moved.fixNote, moved.beforeFix, moved.cursor], ["teh → the", "teh cat", 0], "moving the caret does not");
}
{
  eq(deliveryRefusal("unknown", () => true), "cannot read shell state", "an unreadable shell is refused");
  eq(deliveryRefusal("idle", () => true), "no claude running here", "an idle shell would run the message as a command line: refused");
  eq(deliveryRefusal("busy", () => false), "no claude running here", "a busy shell that is not a claude: refused");
  eq(deliveryRefusal("busy", () => true), null, "a claude reading the pty may be typed into");
}

// ── WHAT IT SAYS ────────────────────────────────────────────────────────────────────────
console.log("\n# words");
eq(sendTitle(fresh()), SEND_LABEL, "the title is the menu row's words");
eq(sendTitle(micOpened(fresh())), "listening…", "listening");
eq(sendTitle(micOpened(withWords("x"))), "still listening…", "still listening on top of words");
eq(sendTitle({ ...fresh(), phase: "sending" }), "sending…", "sending");
eq(sendHint(fresh()), "Type what you want to send.", "an empty typed box says type");
eq(sendHint(withWords("x")), "Fix anything the transcription got wrong, then send.", "a transcribed box says fix then send");
eq(sendHint({ ...withWords("x"), error: "no claude running here" }), "Nothing was lost — send it again to retry.", "after a failed send the words are still here");
eq(sendErrorLine({ ...withWords("x"), error: "no claude running here" }), "Didn't reach the session: no claude running here", "a failed delivery is named as such");
eq(sendErrorLine({ ...withWords("x"), error: "Heard nothing", dictationFailed: true }), "Didn't add anything: Heard nothing", "a failed breath is named as such");
eq(actionRowButtons(fresh()).map(b => b.enabled), [false, false, true], "nothing to send until there are words");
eq(actionRowButtons(withWords("x")).map(b => b.enabled), [true, true, true], "words make send and insert live");
eq(writeRowButtons(fresh()).map(b => b.item), [SEND_ITEM.speak, SEND_ITEM.fix], "an empty box offers speak and fix");
eq(writeRowButtons({ ...withWords("x"), droppedAudio: true }).map(b => b.item)[0], SEND_ITEM.useDropped, "a kept breath is offered first");
eq(writeRowButtons(fresh())[1].enabled, false, "nothing to fix in an empty box");
eq(actionRowButtons(micOpened(fresh())).find(b => b.item === SEND_ITEM.skip)?.text, "esc type", "skip from an empty box is 'type'");
eq(actionRowButtons(micOpened(withWords("x"))).find(b => b.item === SEND_ITEM.skip)?.text, "esc back", "skip from a 'say more' is 'back'");
eq(actionRowButtons({ ...fresh(), phase: "sending" }), [], "no way out mid-flight");

// Every button row fits the dialog, in its widest dress.
{
  const widest = { ...withWords("x"), droppedAudio: true };
  for (const [name, buttons] of [["write", writeRowButtons(widest)], ["action", actionRowButtons(widest)], ["recording", actionRowButtons(micOpened(widest))]] as const) {
    const cells = buttonCells(buttons);
    const end = cells[cells.length - 1].end;
    if (end > SEND_DIALOG_INNER) fail(`the ${name} row overruns the dialog: ${end} > ${SEND_DIALOG_INNER}`); else ok(`the ${name} row fits (${end} of ${SEND_DIALOG_INNER})`);
  }
}

// ── THE FIELD'S WRAP ────────────────────────────────────────────────────────────────────
console.log("\n# wrap");
{
  const W = 10;
  const w = wrapField("hello", 5, W, 2, 6);
  eq([w.rows, w.caretRow, w.caretCol, w.visible], [["hello", ""], 0, 5, 2], "a short message: the minimum rows, caret after it");
  const full = wrapField("0123456789", 10, W, 2, 6);
  eq([full.rows, full.caretRow, full.caretCol], [["0123456789", ""], 1, 0], "a message that fills its row puts the caret on the next");
  const three = "a".repeat(25);
  eq(wrapField(three, 25, W, 2, 6).rows, ["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"], "wraps at the width");
  const long = "b".repeat(95);           // 10 rows
  const tail = wrapField(long, 95, W, 2, 6);
  eq([tail.visible, tail.top, tail.caretRow, tail.total], [6, 4, 5, 10], "an overflowing message shows its last rows with the caret on the last");
  const head = wrapField(long, 0, W, 2, 6);
  eq([head.top, head.caretRow], [0, 0], "the caret at the head shows the first rows");
  const mid = wrapField(long, 55, W, 2, 6);
  eq([mid.top, mid.caretRow], [0, 5], "a caret on row 5 is the last visible row of the first window");
  eq(cursorAtCell("hello world", 0, W, 0, 3), 3, "a click maps to the character under it");
  eq(cursorAtCell("hello world", 0, W, 0, 50), 10, "past the end of a full row is its end");
  eq(cursorAtCell("hello world", 0, W, 1, 50), 11, "past the end of the text is the end");
  eq(cursorAtCell("hello world", 0, W, 4, 0), 11, "below the text is its end");
  eq(cursorAtCell(long, 4, W, 1, 2), 52, "a click is offset by the rows scrolled off the top");
}

// ── THE HIT-TEST AGREES WITH THE LAYOUT ─────────────────────────────────────────────────
console.log("\n# hit-test");
{
  const s = { ...withWords("teh cat"), fixNote: "teh → the", beforeFix: "the cat", droppedAudio: true, error: "no claude running here" };
  const layout = computeSendLayout(s);
  eq(layout.height, 1 + 1 + 1 + 1 + 1 + FIELD_MIN_ROWS + 1 + 1 + 1 + 1, "confirm with everything: border, title, label, error, hint, field, note, write, action, border");
  const at = (row: number, col: number) => sendHitTest(s, layout, row, col);
  // The buttons own exactly their words; the gaps between are dead.
  for (const [rowName, row, buttons] of [["write", layout.writeRow, writeRowButtons(s)], ["action", layout.actionRow, actionRowButtons(s)]] as const) {
    buttonCells(buttons).forEach((c, i) => {
      eq(at(row, c.start + 1)?.item, buttons[i].item, `${rowName} row: the first cell of "${buttons[i].text}"`);
      eq(at(row, c.end)?.item, buttons[i].item, `${rowName} row: the last cell of "${buttons[i].text}"`);
      eq(at(row, c.end + 1)?.item, undefined, `${rowName} row: the cell after "${buttons[i].text}" is dead`);
    });
  }
  eq(at(layout.fieldRow, 2), { item: SEND_ITEM.field, cursor: 0 }, "the field's first cell is character 0");
  eq(at(layout.fieldRow, 5), { item: SEND_ITEM.field, cursor: 3 }, "a field cell is its character");
  eq(at(layout.fieldRow + 1, 5)?.cursor, 7, "the empty second row is the end of the text");
  eq(at(layout.noteRow, SEND_DIALOG_INNER - 1)?.item, SEND_ITEM.undo, "the undo sits at the right end of the note row");
  eq(at(layout.noteRow, 2), null, "the note itself is not a control");
  eq(at(layout.titleRow, 2), null, "the title is not a control");
  eq(at(layout.errorRow, 2), null, "the error line is not a control");
  eq(at(layout.writeRow, 0), null, "the left border is outside");
  eq(at(layout.writeRow, SEND_DIALOG_INNER + 1), null, "the right border is outside");
  // Without a way back, the note row has no undo to hit.
  const noUndo = { ...s, beforeFix: null };
  eq(sendHitTest(noUndo, computeSendLayout(noUndo), layout.noteRow, SEND_DIALOG_INNER - 1), null, "no undo cells without a fix to undo");
  // The field grows with the message and the rows under it move with it.
  const tall = withWords("x".repeat(FIELD_WIDTH * 4));
  const tallLayout = computeSendLayout(tall);
  eq(tallLayout.fieldRows, 5, "four full rows and the caret's own make five");
  eq(tallLayout.writeRow, tallLayout.fieldRow + 5, "the write row follows the field");
  eq(computeSendLayout(withWords("x".repeat(FIELD_WIDTH * 20))).fieldRows, FIELD_MAX_ROWS, "the field never grows past its cap");
  // The other phases.
  eq(computeSendLayout(micOpened(fresh())).height, 6, "recording: border, title, label, hint, action, border");
  eq(computeSendLayout(micOpened(withWords("x"))).height, 7, "still listening: one echo row of the words so far");
  eq(computeSendLayout({ ...fresh(), phase: "transcribing" }).height, 6, "transcribing: hint and a cancel");
  eq(computeSendLayout({ ...fresh(), phase: "sending" }).height, 5, "sending: no buttons at all");
  eq(computeSendLayout({ ...fresh(), phase: "failed", error: "x" }).height, 6, "failed: the reason and a close");
}

// ── THE FLOW ────────────────────────────────────────────────────────────────────────────
console.log("\n# flow");

class FakeRecording implements Recording {
  stopped = false; discarded = false; private ended: (() => void)[] = [];
  constructor(public path: string, public enough = true) {}
  stop() { this.stopped = true; return Promise.resolve(this.enough); }
  discard() { this.discarded = true; }
  onEnded(cb: () => void) { this.ended.push(cb); }
  /** The backstop, or a mic that died. */
  endOnItsOwn() { for (const cb of this.ended) cb(); }
}

/** The world: a mic that opens (or not), a whisper with answers queued, a fixer likewise,
 *  and a session that takes deliveries (or not). Every effect is recorded. */
class FakeWorld implements SendIo {
  recordings: FakeRecording[] = [];
  micFails: string | null = null;
  shortBreath = false;
  transcripts: (string | Error)[] = [];
  transcribed: string[] = [];
  fixes: ({ text: string; changes: string } | Error)[] = [];
  fixHold: (() => void) | null = null;   // set to hold the fixer until released
  delivered: { text: string; submit: boolean }[] = [];
  deliverFails: string | null = null;
  record() {
    if (this.micFails) return Promise.reject(new Error(this.micFails));
    const r = new FakeRecording(`/fake/${this.recordings.length}.wav`, !this.shortBreath);
    this.recordings.push(r);
    return Promise.resolve(r);
  }
  transcribe(rec: Recording) {
    this.transcribed.push(rec.path);
    const t = this.transcripts.shift();
    return t instanceof Error ? Promise.reject(t) : Promise.resolve(t ?? "");
  }
  fixSpelling(_text: string) {
    const f = this.fixes.shift();
    const answer = () => f instanceof Error ? Promise.reject(f) : Promise.resolve(f ?? { text: _text, changes: "" });
    if (!this.fixHold) return answer();
    return new Promise<{ text: string; changes: string }>((res, rej) => { this.fixHold = () => answer().then(res, rej); });
  }
  deliver(text: string, submit: boolean) {
    if (this.deliverFails) return Promise.reject(new Error(this.deliverFails));
    this.delivered.push({ text, submit });
    return Promise.resolve();
  }
}

function start(world: FakeWorld) {
  const states: (SendDialogState | null)[] = [];
  const flow = new SendFlow(world, fresh(), s => states.push(s));
  const closed = () => states[states.length - 1] === null;
  return { flow, states, closed };
}

{
  const world = new FakeWorld();
  const { flow, closed } = start(world);
  await flow.send(true);
  eq([world.delivered.length, closed()], [0, false], "an empty box sends nothing and stays");
  flow.edit({ buffer: "hello", cursor: 5 });
  await flow.send(true);
  eq(world.delivered, [{ text: "hello", submit: true }], "send delivers the words and presses Enter");
  eq(closed(), true, "...and only then does the dialog close");
}
{
  const world = new FakeWorld();
  const { flow, closed } = start(world);
  flow.edit({ buffer: "hello", cursor: 5 });
  await flow.send(false);
  eq(world.delivered, [{ text: "hello", submit: false }], "insert delivers the words without Enter");
  eq(closed(), true, "insert closes too -- the terminal has the keyboard from here");
}
{
  const world = new FakeWorld();
  world.deliverFails = "no claude running here";
  const { flow, closed } = start(world);
  flow.edit({ buffer: "hello", cursor: 5 });
  await flow.send(true);
  eq([flow.state.phase, flow.state.transcript, flow.state.error, closed()], ["confirm", "hello", "no claude running here", false], "a refused delivery comes back with the words and the reason");
  world.deliverFails = null;
  await flow.send(true);
  eq([world.delivered.length, closed()], [1, true], "send again is a retry");
}
{
  const world = new FakeWorld();
  const { flow } = start(world);
  flow.edit({ buffer: "hello", cursor: 5 });
  const a = flow.send(true); const b = flow.send(true);
  await Promise.all([a, b]);
  eq(world.delivered.length, 1, "a double press delivers once -- the second finds 'sending'");
}
{
  const world = new FakeWorld();
  world.transcripts = ["hello there"];
  const { flow } = start(world);
  await flow.speak();
  eq(flow.state.phase, "recording", "speak opens the mic");
  eq(world.recordings.length, 1, "one recorder");
  await flow.done();
  eq([flow.state.phase, flow.state.transcript, flow.state.cursor, flow.state.typed], ["confirm", "hello there", 11, false], "done transcribes and lands the words");
  eq(world.recordings[0].discarded, true, "the audio does not outlive the attempt");
  world.transcripts = ["again"];
  await flow.speak();
  eq(sendTitle(flow.state), "still listening…", "say more is still listening");
  await flow.done();
  eq(flow.state.transcript, "hello there again", "a second breath is appended");
}
{
  const world = new FakeWorld();
  world.micFails = "no audio server";
  const { flow, closed } = start(world);
  await flow.speak();
  eq([flow.state.phase, flow.state.error, closed()], ["failed", "Recording failed: no audio server — try again", false], "a mic that will not open, empty box: the flow ends saying why");
  flow.cancel();
  eq(closed(), true, "close on the failed step closes");
  const w2 = new FakeWorld(); w2.micFails = "no audio server";
  const second = start(w2);
  second.flow.edit({ buffer: "hello", cursor: 5 });
  await second.flow.speak();
  eq([second.flow.state.phase, second.flow.state.transcript, second.flow.state.dictationFailed], ["confirm", "hello", true], "a mic that will not open, words in hand: a note, the words stay");
}
{
  const world = new FakeWorld();
  world.transcripts = [new Error("whisperd is down")];
  const { flow } = start(world);
  flow.edit({ buffer: "hello", cursor: 5 });
  await flow.speak(); await flow.done();
  eq([flow.state.phase, flow.state.transcript, flow.state.error], ["confirm", "hello", "Transcription failed: whisperd is down"], "a dead whisper is named, never 'nothing heard'");
  world.transcripts = [""];
  await flow.speak(); await flow.done();
  eq([flow.state.error, flow.state.dictationFailed], ["Heard nothing", true], "an empty transcript is 'heard nothing'");
  world.shortBreath = true;
  await flow.speak(); await flow.done();
  eq([flow.state.error, flow.state.transcript], ["Heard nothing", "hello"], "a breath too short to hold audio is 'heard nothing', words intact");
  eq(world.transcribed.length, 2, "...and whisper was not asked about it");
}
{
  const world = new FakeWorld();
  world.transcripts = ["kept words"];
  const { flow } = start(world);
  await flow.speak();
  flow.skip();
  eq([flow.state.phase, flow.state.typed, flow.state.droppedAudio], ["confirm", true, false], "skip lands on the confirm step at once");
  await flush();
  eq([flow.state.droppedAudio, world.recordings[0].stopped, world.recordings[0].discarded], [true, true, false], "the breath is stopped, kept, and offered");
  await flow.useDropped();
  eq([flow.state.transcript, flow.state.droppedAudio, world.recordings[0].discarded], ["kept words", false, true], "use what I said transcribes it after all, then lets it go");
}
{
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.speak(); flow.skip(); await flush();
  eq(flow.state.droppedAudio, true, "a breath is kept...");
  await flow.speak();
  eq([flow.state.droppedAudio, world.recordings[0].discarded], [false, true], "...until the next speak, which replaces it");
  flow.skip(); await flush();
  flow.edit({ buffer: "typed", cursor: 5 });
  await flow.send(true);
  eq(world.recordings[1].discarded, true, "a kept breath dies with the flow it belonged to");
}
{
  const world = new FakeWorld();
  world.shortBreath = true;
  const { flow } = start(world);
  await flow.speak(); flow.skip(); await flush();
  eq([flow.state.droppedAudio, world.recordings[0].discarded], [false, true], "a breath too short to keep is not offered");
}
{
  const world = new FakeWorld();
  world.transcripts = ["from the backstop"];
  const { flow } = start(world);
  await flow.speak();
  world.recordings[0].endOnItsOwn();
  await flush(); await flush();
  eq(flow.state.transcript, "from the backstop", "a recorder that ends on its own is transcribed, not lost");
}
{
  const world = new FakeWorld();
  const { flow, closed } = start(world);
  await flow.speak();
  flow.cancel();
  await flush();
  eq([closed(), world.recordings[0].stopped, world.recordings[0].discarded], [true, true, true], "cancel mid-recording stops the mic and throws the audio away");
}
{
  const world = new FakeWorld();
  let release: () => void = () => {};
  world.deliverFails = null;
  const slow: SendIo = { ...world, record: world.record.bind(world), transcribe: world.transcribe.bind(world), fixSpelling: world.fixSpelling.bind(world),
    deliver: () => new Promise<void>(res => { release = res; }) };
  const states: (SendDialogState | null)[] = [];
  const flow = new SendFlow(slow, withWords("hello"), s => states.push(s));
  const sending = flow.send(true);
  eq(flow.state.phase, "sending", "sending…");
  flow.cancel();
  eq(states[states.length - 1] !== null, true, "nothing dismisses the dialog while the text is in flight");
  release(); await sending;
  eq(states[states.length - 1], null, "it closes when the delivery lands");
}
{
  const world = new FakeWorld();
  world.fixes = [{ text: "the cat", changes: "teh → the" }];
  const { flow } = start(world);
  flow.edit({ buffer: "teh cat", cursor: 7 });
  await flow.fix();
  eq([flow.state.transcript, flow.state.fixNote, flow.state.beforeFix, flow.state.fixing], ["the cat", "teh → the", "teh cat", false], "fix typos corrects in place and says what it did");
  flow.undo();
  eq([flow.state.transcript, flow.state.fixNote], ["teh cat", null], "undo puts the words back");
  world.fixes = [new Error("spelling fixer is down — start it")];
  await flow.fix();
  eq([flow.state.transcript, flow.state.fixNote, flow.state.fixFailed], ["teh cat", "spelling fixer is down — start it", true], "a fixer that refuses says so, words untouched");
  await flow.fix(); // empty queue → unchanged
  eq(flow.state.fixNote, "Nothing to fix", "an unchanged answer says so");
}
{
  const world = new FakeWorld();
  world.fixHold = () => {};
  world.fixes = [{ text: "the cat", changes: "teh → the" }];
  const { flow } = start(world);
  flow.edit({ buffer: "teh cat", cursor: 7 });
  const fixing = flow.fix();
  eq(flow.state.fixing, true, "the fixer has the message");
  flow.edit({ buffer: "teh cats", cursor: 8 });
  world.fixHold!(); await fixing;
  eq([flow.state.transcript, flow.state.fixNote, flow.state.fixing], ["teh cats", null, false], "typing while it thinks wins -- the stale fix is dropped");
}
{
  const world = new FakeWorld();
  const { flow } = start(world);
  const big = "x".repeat(MESSAGE_MAX_CHARS + 10);
  flow.edit({ buffer: big, cursor: big.length });
  eq(flow.state.transcript.length, big.length, "the flow itself does not cap -- the host's insert does (insertFieldText)");
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
