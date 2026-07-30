// The menu's hit-testing must agree with what the menu actually draws.
//
// Every session occupies two or three consecutive rows (id, optional cwd, captions), and
// two separate pieces of code walk that shape: computeMenuLayout/sessionRowAt decide what a
// click at row N means, while ContextMenuOverlay decides what row N looks like. Nothing
// links them but arithmetic, and when they drift the failure is silent and awful -- a click
// on "captions" copies an id, or a click on a session opens someone else's captions.
//
// So: render the real overlay, then assert that for every drawn row, the row-mapper says
// what the pixels say.
//
//   npx tsx tests/testMenuRows.ts
import React from "react";
import { render, Box } from "ink";
import { PassThrough } from "stream";
import { ContextMenuOverlay } from "../ContextMenuOverlay.js";
import { computeMenuLayout, sessionRowAt } from "../menu.js";
import type { ContextMenuState, SessionHistoryEntry } from "../types.js";

const sessions: SessionHistoryEntry[] = [
  { sessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/opt/dev/claude-voice", pid: 1, startMs: Date.now() - 60_000, alive: true },
  { sessionId: "bbbbbbbb-5555-6666-7777-888888888888", cwd: null, pid: 2, startMs: Date.now() - 3_600_000, alive: false },
  { sessionId: "cccccccc-9999-0000-1111-222222222222", cwd: "/opt/automateLinux", pid: 3, startMs: Date.now(), alive: true },
];

const layout = computeMenuLayout(sessions, true);
const menu: ContextMenuState = {
  kind: "automateLinuxTerminalMenu", row: 0, col: 0, hasSelection: false, hoverItem: -1,
  sessions, stopwatchDisplay: "00:00", stopwatchAction: "start",
  stopwatchRowOff: layout.stopwatchRow, topic: "voice", editingTopic: false, editBuffer: "",
  topicRowOff: layout.topicRow, showTopicBar: true, copiedSessionIdx: -1,
  captionsIdx: -1, captionsMsg: "",
};

const out = new PassThrough() as unknown as NodeJS.WriteStream;
(out as unknown as { columns: number }).columns = 120;
let frame = "";
out.on("data", (c: Buffer) => { frame += c.toString(); });   // Ink emits the frame in pieces

// The overlay positions itself absolutely, so it needs a sized parent to be laid out at
// all -- as a bare root it collapses to nothing (and the test would "pass" on an empty
// frame). In the app that parent is the terminal view.
const app = render(
  React.createElement(Box, { flexDirection: "column", height: layout.height, width: 60 },
                      React.createElement(ContextMenuOverlay, { menu })),
  { stdout: out, patchConsole: false });
await new Promise(r => setTimeout(r, 120));
app.unmount();

// Ink pads the absolute-positioned box with blank lines above it; the drawn menu is the
// run of lines carrying box-drawing characters.
const lines = frame.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
                   .filter(l => /[│╭╰├]/.test(l));

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };

console.log(`drawn rows: ${lines.length}, computeMenuLayout height: ${layout.height}`);
if (lines.length !== layout.height) fail(`height mismatch — the menu draws ${lines.length} rows but the layout reserves ${layout.height}`);

lines.forEach((line, rowOff) => {
  const hit = sessionRowAt(rowOff, sessions);
  const isCaptionsLine = line.includes("▸ captions");
  const shortIdOn = sessions.findIndex(s => line.includes(s.sessionId.slice(0, 8)));
  const cwdOn = sessions.findIndex(s => s.cwd && line.includes(s.cwd));

  if (isCaptionsLine) {
    if (!hit || hit.action !== "captions") fail(`row ${rowOff} draws "captions" but maps to ${JSON.stringify(hit)}`);
  } else if (shortIdOn >= 0) {
    if (!hit || hit.action !== "copy" || hit.idx !== shortIdOn)
      fail(`row ${rowOff} draws session ${shortIdOn}'s id but maps to ${JSON.stringify(hit)}`);
  } else if (cwdOn >= 0) {
    if (!hit || hit.action !== "copy" || hit.idx !== cwdOn)
      fail(`row ${rowOff} draws session ${cwdOn}'s cwd but maps to ${JSON.stringify(hit)}`);
  } else if (hit) {
    fail(`row ${rowOff} is chrome ("${line.trim().slice(0, 30)}") but maps to ${JSON.stringify(hit)}`);
  }
});

// Each session must own exactly one captions row, in its own block -- three sessions
// sharing one captions line would still pass the per-row checks above.
const captionsRows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("▸ captions")).map(([, i]) => i);
console.log(`captions rows: ${captionsRows.join(", ")}`);
if (captionsRows.length !== sessions.length) fail(`${sessions.length} sessions but ${captionsRows.length} captions rows`);
captionsRows.forEach((rowOff, i) => {
  const hit = sessionRowAt(rowOff, sessions);
  if (!hit || hit.idx !== i) fail(`captions row ${rowOff} belongs to session ${hit?.idx}, expected ${i}`);
});

// The rows the other items live on are computed the same way and are just as easy to slip.
const topicLine = lines[layout.topicRow] ?? "";
if (!topicLine.includes("voice")) fail(`topicRow ${layout.topicRow} does not draw the topic: "${topicLine.trim()}"`);
const swLine = lines[layout.stopwatchRow] ?? "";
if (!swLine.includes("timer")) fail(`stopwatchRow ${layout.stopwatchRow} does not draw the timer: "${swLine.trim()}"`);
if (sessionRowAt(layout.topicRow, sessions)) fail("the topic row also maps to a session");
if (sessionRowAt(layout.stopwatchRow, sessions)) fail("the timer row also maps to a session");

console.log(failures ? `FAILED (${failures})` : "PASS");
process.exit(failures ? 1 : 0);
