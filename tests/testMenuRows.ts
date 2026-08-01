// The menu's hit-testing must agree with what the menu actually draws.
//
// Every session occupies three or four consecutive rows (id, optional cwd, captions, bookmark), and
// two separate pieces of code walk that shape: computeMenuLayout/sessionRowAt decide what a
// click at row N means, while ContextMenuOverlay decides what row N looks like. Nothing
// links them but arithmetic, and when they drift the failure is silent and awful -- a click
// on "captions" copies an id, or a click on a session opens someone else's captions.
//
// So: render the real overlay, then assert that for every drawn row, the row-mapper says
// what the pixels say. Run BOTH ways round the "?": opening its info line pushes every row
// below it down one, which is exactly the kind of shift this test exists to catch.
//
//   npx tsx tests/testMenuRows.ts
import React from "react";
import { render, Box } from "ink";
import { PassThrough } from "stream";
import { ContextMenuOverlay } from "../ContextMenuOverlay.js";
import { computeMenuLayout, sessionRowAt } from "../menu.js";
import type { ContextMenuState, SessionHistoryEntry } from "../types.js";

// Mixed on purpose: a ticked and an unticked bookmark draw different text, and both have
// to map back to the row that drew them.
const sessions: SessionHistoryEntry[] = [
  { sessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/opt/dev/claude-voice", pid: 1, startMs: Date.now() - 60_000, alive: true, bookmarked: true },
  { sessionId: "bbbbbbbb-5555-6666-7777-888888888888", cwd: null, pid: 2, startMs: Date.now() - 3_600_000, alive: false, bookmarked: false },
  { sessionId: "cccccccc-9999-0000-1111-222222222222", cwd: "/opt/automateLinux", pid: 3, startMs: Date.now(), alive: true, bookmarked: false },
];

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };

async function drawMenu(infoOpen: boolean) {
  const layout = computeMenuLayout(sessions, true, infoOpen);
  const menu: ContextMenuState = {
    kind: "automateLinuxTerminalMenu", row: 0, col: 0, hasSelection: false, hoverItem: -1,
    sessions, stopwatchDisplay: "00:00", stopwatchAction: "start",
    stopwatchRowOff: layout.stopwatchRow, topic: "voice", editingTopic: false, editBuffer: "",
    topicRowOff: layout.topicRow, sessionsRowOff: layout.sessionsRow, helpRowOff: layout.helpRow, infoOpen,
    showTopicBar: true, copiedSessionIdx: -1,
    captionsIdx: -1, captionsMsg: "", bookmarkIdx: -1, bookmarkMsg: "",
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
  return { layout, lines };
}

async function check(infoOpen: boolean) {
  const { layout, lines } = await drawMenu(infoOpen);
  const at = (rowOff: number) => sessionRowAt(rowOff, sessions, layout.sessionsRow);
  console.log(`\ninfo ${infoOpen ? "open" : "closed"} — drawn rows: ${lines.length}, computeMenuLayout height: ${layout.height}`);
  if (lines.length !== layout.height) fail(`height mismatch — the menu draws ${lines.length} rows but the layout reserves ${layout.height}`);

  lines.forEach((line, rowOff) => {
    const hit = at(rowOff);
    const isCaptionsLine = line.includes("▸ captions");
    // "pin topic" wears the same checkbox, so match the word, not the box.
    const isBookmarkLine = /\bbookmark(ed)?\b/.test(line);
    const shortIdOn = sessions.findIndex(s => line.includes(s.sessionId.slice(0, 8)));
    const cwdOn = sessions.findIndex(s => s.cwd && line.includes(s.cwd));

    if (isCaptionsLine) {
      if (!hit || hit.action !== "captions") fail(`row ${rowOff} draws "captions" but maps to ${JSON.stringify(hit)}`);
    } else if (isBookmarkLine) {
      if (!hit || hit.action !== "bookmark") fail(`row ${rowOff} draws "bookmark" but maps to ${JSON.stringify(hit)}`);
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
    const hit = at(rowOff);
    if (!hit || hit.idx !== i) fail(`captions row ${rowOff} belongs to session ${hit?.idx}, expected ${i}`);
  });

  // Same for the bookmark row, and the tick has to be drawn on the session that carries it —
  // a checkbox that ticks the wrong row is worse than none.
  const bookmarkRows = lines.map((l, i) => [l, i] as const).filter(([l]) => /\bbookmark(ed)?\b/.test(l)).map(([, i]) => i);
  console.log(`bookmark rows: ${bookmarkRows.join(", ")}`);
  if (bookmarkRows.length !== sessions.length) fail(`${sessions.length} sessions but ${bookmarkRows.length} bookmark rows`);
  bookmarkRows.forEach((rowOff, i) => {
    const hit = at(rowOff);
    if (!hit || hit.idx !== i || hit.action !== "bookmark") fail(`bookmark row ${rowOff} maps to ${JSON.stringify(hit)}, expected session ${i}`);
    const ticked = lines[rowOff].includes("☑");
    if (ticked !== sessions[i].bookmarked) fail(`bookmark row ${rowOff} draws ${ticked ? "ticked" : "unticked"} for session ${i} (bookmarked: ${sessions[i].bookmarked})`);
  });

  // The rows the other items live on are computed the same way and are just as easy to slip.
  const topicLine = lines[layout.topicRow] ?? "";
  if (!topicLine.includes("voice")) fail(`topicRow ${layout.topicRow} does not draw the topic: "${topicLine.trim()}"`);
  const swLine = lines[layout.stopwatchRow] ?? "";
  if (!swLine.includes("timer")) fail(`stopwatchRow ${layout.stopwatchRow} does not draw the timer: "${swLine.trim()}"`);
  if (at(layout.topicRow)) fail("the topic row also maps to a session");
  if (at(layout.stopwatchRow)) fail("the timer row also maps to a session");

  // The topic is the reason the menu gets opened, so it stays above a session list that
  // grows a block per running session. Reversing them would draw perfectly well and only
  // be noticed by whoever has to hunt for the topic on a busy day.
  console.log(`topic row: ${layout.topicRow}, first session row: ${layout.sessionsRow}`);
  if (!(layout.topicRow < layout.sessionsRow)) fail(`topic row ${layout.topicRow} is not above the session list at ${layout.sessionsRow}`);
  if (at(layout.sessionsRow)?.idx !== 0) fail(`sessionsRow ${layout.sessionsRow} is not the first session's line`);

  // The "?" holds the name and version: shown only when it is open, and never where the
  // old title row was (a permanent row is the thing this replaced).
  const helpLine = lines[layout.helpRow] ?? "";
  if (!helpLine.includes("?")) fail(`helpRow ${layout.helpRow} does not draw the "?": "${helpLine.trim()}"`);
  // And it is LAST: the topic is what the menu is opened for, so it owns the first row and
  // the "?" owns the bottom. Off by one here and clicking the "?" hits the timer.
  if (layout.topicRow !== 1) fail(`topic row is ${layout.topicRow}, expected 1 (directly under the top border)`);
  const lastItemRow = layout.height - 2 - (infoOpen ? 1 : 0);
  if (layout.helpRow !== lastItemRow) fail(`helpRow ${layout.helpRow} is not the menu's last item row (${lastItemRow})`);
  if (layout.helpRow < layout.stopwatchRow) fail(`the "?" at ${layout.helpRow} is above the timer at ${layout.stopwatchRow}`);
  const infoRows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("automateLinuxTerminal")).map(([, i]) => i);
  if (infoOpen) {
    if (infoRows.length !== 1) fail(`info open: expected one name/version line, drew ${infoRows.length}`);
    else if (infoRows[0] !== layout.helpRow + 1) fail(`the info line is at row ${infoRows[0]}, expected just under the "?" at ${layout.helpRow + 1}`);
  } else if (infoRows.length) {
    fail(`info closed but the name/version is still drawn at row ${infoRows[0]}`);
  }
}

await check(false);
await check(true);

// Opening the info must cost exactly the one row it draws — anything else means the layout
// and the overlay disagree about what unfolding the "?" does. Now that the "?" is last it
// unfolds DOWNWARDS into the border, so nothing above it may shift: that is the point of
// having moved it, and a row that moves under the pointer is what this pins.
const shut = computeMenuLayout(sessions, true, false);
const open = computeMenuLayout(sessions, true, true);
if (open.height !== shut.height + 1) fail(`opening the info changed the height by ${open.height - shut.height}, expected 1`);
for (const k of ["topicRow", "sessionsRow", "stopwatchRow", "helpRow"] as const) {
  if (open[k] !== shut[k]) fail(`opening the info moved ${k} by ${open[k] - shut[k]}, expected 0`);
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
