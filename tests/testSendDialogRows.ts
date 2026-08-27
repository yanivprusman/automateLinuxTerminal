// The dialog's hit-testing must agree with what the dialog actually draws.
//
// computeSendLayout / sendHitTest decide what a click at (row, col) means; SendDialogOverlay
// decides what (row, col) looks like. Nothing links them but arithmetic -- the same pair of
// facts testMenuRows.ts pins for the menu, and the same silent, awful failure when they
// drift: a click on "send" that inserts, a click on "cancel" that fixes typos, a click in
// the box that lands on the wrong character. So: render the real overlay in every phase,
// and assert that for every drawn row the layout says what the pixels say, and that every
// button's words sit exactly on the cells the hit-test claims for it.
//
//   npx tsx tests/testSendDialogRows.ts
import React from "react";
import { render, Box } from "ink";
import { PassThrough } from "stream";
import stringWidth from "string-width";
import { SendDialogOverlay } from "../SendDialogOverlay.js";
import {
  openTyping, micOpened, computeSendLayout, sendHitTest, buttonCells, writeRowButtons, actionRowButtons,
  sendTitle, sendHint, sendErrorLine, UNDO_BUTTON, SEND_DIALOG_INNER, FIELD_WIDTH, wrapField,
  FIELD_MIN_ROWS, FIELD_MAX_ROWS,
} from "../sendToSession.js";
import type { SendDialogState } from "../sendToSession.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };

const base = (): SendDialogState => openTyping("aaaaaaaa-1111-2222-3333-444444444444", "rewriting the peer heartbeat", 0, 0);
const words = (t: string): SendDialogState => ({ ...base(), transcript: t, cursor: t.length, typed: false });

async function draw(s: SendDialogState) {
  const layout = computeSendLayout(s);
  const out = new PassThrough() as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 120;
  let frame = "";
  out.on("data", (c: Buffer) => { frame += c.toString(); });
  const app = render(
    React.createElement(Box, { flexDirection: "column", height: layout.height, width: 80 },
                        React.createElement(SendDialogOverlay, { state: s })),
    { stdout: out, patchConsole: false });
  await new Promise(r => setTimeout(r, 120));
  app.unmount();
  const lines = frame.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(l => /[│╭╰]/.test(l));
  return { layout, lines };
}

/** The inner cells of a drawn row: what is between its two borders. */
const inner = (line: string) => line.replace(/^│/, "").replace(/│\s*$/, "").replace(/^╭/, "").replace(/╮\s*$/, "").replace(/^╰/, "").replace(/╯\s*$/, "");

async function check(name: string, s: SendDialogState) {
  const { layout, lines } = await draw(s);
  console.log(`\n${name} — drawn rows: ${lines.length}, layout height: ${layout.height}`);
  if (lines.length !== layout.height) fail(`${name}: draws ${lines.length} rows but the layout reserves ${layout.height}`);
  // Every row is exactly the dialog's width. A cell gained or lost walks the right border
  // off the box, and the marks on the buttons are the likeliest place to lose one.
  lines.forEach((l, i) => {
    const w = stringWidth(l.trimEnd());
    if (w !== SEND_DIALOG_INNER + 2) fail(`${name}: row ${i} is ${w} cells wide, expected ${SEND_DIALOG_INNER + 2}: "${l.trimEnd()}"`);
  });
  const at = (row: number, col: number) => sendHitTest(s, layout, row, col);

  // The words the layout says are on a row are on it.
  const row = (i: number) => inner(lines[i] ?? "");
  if (!row(layout.titleRow).includes(sendTitle(s))) fail(`${name}: titleRow ${layout.titleRow} does not draw "${sendTitle(s)}": "${row(layout.titleRow)}"`);
  if (!row(layout.labelRow).includes(s.sessionId.slice(0, 8))) fail(`${name}: labelRow does not name the session: "${row(layout.labelRow)}"`);
  if (s.topic && !row(layout.labelRow).includes(s.topic.slice(0, 10))) fail(`${name}: labelRow does not draw the topic: "${row(layout.labelRow)}"`);
  if (layout.hintRow >= 0 && !row(layout.hintRow).includes(sendHint(s).slice(0, 20))) fail(`${name}: hintRow does not draw the hint: "${row(layout.hintRow)}"`);
  const err = sendErrorLine(s);
  if (err && !row(layout.errorRow).includes(err.slice(0, 30))) fail(`${name}: errorRow does not draw the error: "${row(layout.errorRow)}"`);
  if (layout.noteRow >= 0 && !row(layout.noteRow).includes(s.fixNote ?? "")) fail(`${name}: noteRow does not draw the note: "${row(layout.noteRow)}"`);

  // Every button's words sit exactly on the cells the hit-test claims for it -- the
  // whole point: the cells are computed from the labels, the pixels are drawn from the
  // labels, and this is the only thing that says they were the same labels.
  for (const [rowName, r, buttons] of [["write", layout.writeRow, writeRowButtons(s)], ["action", layout.actionRow, actionRowButtons(s)]] as const) {
    if (r < 0) continue;
    const text = row(r);
    buttonCells(buttons).forEach((c, i) => {
      const drawn = text.slice(c.start, c.end);
      if (drawn !== buttons[i].text) fail(`${name}: ${rowName} row draws "${drawn}" in the cells claimed for "${buttons[i].text}"`);
      if (at(r, c.start + 1)?.item !== buttons[i].item) fail(`${name}: ${rowName} row: a click on "${buttons[i].text}" maps to ${JSON.stringify(at(r, c.start + 1))}`);
    });
    // Nothing else on the row is a control.
    const last = buttonCells(buttons).pop()!;
    if (at(r, last.end + 2)) fail(`${name}: ${rowName} row: a click past the last button maps to ${JSON.stringify(at(r, last.end + 2))}`);
  }
  if (layout.noteRow >= 0 && s.beforeFix !== null) {
    const text = row(layout.noteRow);
    const start = SEND_DIALOG_INNER - 1 - UNDO_BUTTON.text.length;
    if (text.slice(start, start + UNDO_BUTTON.text.length) !== UNDO_BUTTON.text)
      fail(`${name}: the undo is not drawn on the cells claimed for it: "${text.slice(start)}"`);
    if (at(layout.noteRow, start + 1)?.item !== UNDO_BUTTON.item) fail(`${name}: a click on the undo maps to ${JSON.stringify(at(layout.noteRow, start + 1))}`);
  }

  // The field draws the message where the wrap says, with the caret where the caret is.
  if (layout.fieldRow >= 0) {
    const w = wrapField(s.transcript, s.cursor, FIELD_WIDTH, FIELD_MIN_ROWS, FIELD_MAX_ROWS);
    if (layout.fieldRows !== w.visible) fail(`${name}: the layout reserves ${layout.fieldRows} field rows, the wrap shows ${w.visible}`);
    w.rows.forEach((rowText, i) => {
      const drawn = row(layout.fieldRow + i).slice(1, 1 + FIELD_WIDTH);
      // The caret's cell is drawn as the block (past the end) or as the character reversed,
      // and a `…` may replace a corner cell -- everything else is the text.
      const expect = rowText;
      for (let x = 0; x < expect.length; x++) {
        if (i === w.caretRow && x === w.caretCol) continue;
        if ((i === 0 && x === 0 && w.top > 0) || (i === w.visible - 1 && x === FIELD_WIDTH - 1)) continue;
        if (drawn[x] !== expect[x]) { fail(`${name}: field row ${i} cell ${x} draws "${drawn[x]}", expected "${expect[x]}"`); break; }
      }
      if (i === w.caretRow && s.cursor >= s.transcript.length && drawn[w.caretCol] !== "█")
        fail(`${name}: the caret past the end is not the block: "${drawn}"`);
    });
    // A click in the box lands on the character under it: the box starts one cell in from
    // the border (colOff 2 is character 0 of the first visible row), and a scrolled box
    // counts from the rows above the window.
    const hit = at(layout.fieldRow, 4);
    const want = Math.min(s.transcript.length, w.top * FIELD_WIDTH + 2);
    if (hit?.item !== 1 || hit.cursor !== want) fail(`${name}: a click on the third field cell maps to ${JSON.stringify(hit)}, expected cursor ${want}`);
  }
  // Chrome is not a control.
  if (at(layout.titleRow, 2) || at(layout.labelRow, 2) || (layout.hintRow >= 0 && at(layout.hintRow, 2)))
    fail(`${name}: a click on the title, label or hint maps to a control`);
  if (at(0, 2) || at(layout.height - 1, 2)) fail(`${name}: a click on a border maps to a control`);
}

await check("confirm, empty", base());
await check("confirm, words", words("fix the peer heartbeat so a worker survives a leader restart"));
await check("confirm, everything", {
  ...words("teh cat sat"), fixNote: "teh → the", beforeFix: "the cat sat", droppedAudio: true, error: "no claude running here",
});
await check("confirm, dictation failed", { ...words("hello"), error: "Heard nothing", dictationFailed: true });
await check("confirm, fixing", { ...words("hello"), fixing: true });
await check("confirm, fix refused", { ...words("hello"), fixNote: "spelling fixer is down — start it", fixFailed: true });
await check("confirm, overflowing", words("w".repeat(FIELD_WIDTH * 9 + 3)));
await check("confirm, caret mid-text", { ...words("hello world"), cursor: 4 });
await check("confirm, no topic", { ...words("hello"), topic: "" });
await check("confirm, long topic", { ...words("hello"), topic: "t".repeat(120) });
await check("recording", micOpened(base()));
await check("still listening", micOpened(words("the first half of the message that is being dictated in two breaths, this being the first of them and rather long")));
await check("transcribing", { ...words("x"), phase: "transcribing" });
await check("sending", { ...words("x"), phase: "sending" });
await check("failed", { ...base(), phase: "failed", error: "Recording failed: no audio server — try again" });

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
