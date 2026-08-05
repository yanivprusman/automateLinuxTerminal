// The menu's hit-testing must agree with what the menu actually draws.
//
// Every session occupies four or five consecutive rows (id, optional cwd, captions, replay, bookmark), and
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
import { computeMenuLayout, sessionRowAt, topicRowItem, TOPIC_PIN_CELLS, SESSION_MENU_INNER, SESSION_ID_LABEL, SESSION_CWD_LABEL, SESSION_RESUME_CELLS, SESSION_RESUME_LABEL, SESSION_COPY_SHORT_LABEL, sessionResumeHead } from "../menu.js";
import type { ContextMenuState, SessionHistoryEntry } from "../types.js";

// Mixed on purpose: a ticked and an unticked bookmark draw different text, and both have
// to map back to the row that drew them. Dead sessions with and without a cwd for the same
// reason -- their head row is the one row in the menu split by column, and the rows under
// it are not, so the block has to be walked with both shapes present.
const sessions: SessionHistoryEntry[] = [
  { sessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/opt/dev/claude-voice", pid: 1, startMs: Date.now() - 60_000, alive: true, bookmarked: true },
  { sessionId: "bbbbbbbb-5555-6666-7777-888888888888", cwd: null, pid: 2, startMs: Date.now() - 3_600_000, alive: false, bookmarked: false },
  { sessionId: "cccccccc-9999-0000-1111-222222222222", cwd: "/opt/automateLinux", pid: 3, startMs: Date.now(), alive: true, bookmarked: false },
  { sessionId: "dddddddd-3333-4444-5555-666666666666", cwd: "/opt/dev/monster", pid: 4, startMs: Date.now() - 45_000_000, alive: false, bookmarked: true },
];

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };

async function drawMenu(infoOpen: boolean, voiceMutedAll = false) {
  const layout = computeMenuLayout(sessions, true, infoOpen);
  const menu: ContextMenuState = {
    kind: "automateLinuxTerminalMenu", row: 0, col: 0, hasSelection: false, hoverItem: -1,
    sessions, stopwatchDisplay: "00:00", stopwatchAction: "start",
    stopwatchRowOff: layout.stopwatchRow, topic: "voice", editingTopic: false, editBuffer: "",
    topicRowOff: layout.topicRow, sessionsRowOff: layout.sessionsRow, helpRowOff: layout.helpRow, infoOpen,
    showTopicBar: true, copiedSessionIdx: -1,
    currentSessionId: sessions[0].sessionId, captionsRowOff: layout.captionsRow, replayRowOff: layout.replayRow,
    captionsMsg: "", replayMsg: "", bookmarkIdx: -1, bookmarkMsg: "", resumeIdx: -1, resumeMsg: "",
    voiceMuted: true, voiceMutedAll, muteRowOff: layout.muteRow, muteMsg: "",
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
  // Only ONE row in the menu is split by column (a dead session's head row, whose leading
  // cells resume it), so everything below asks about a row at its far end -- where every
  // row means what it has always meant. The split itself is pinned in its own block.
  const at = (rowOff: number, colOff = SESSION_MENU_INNER) => sessionRowAt(rowOff, sessions, layout.sessionsRow, colOff);
  console.log(`\ninfo ${infoOpen ? "open" : "closed"} — drawn rows: ${lines.length}, computeMenuLayout height: ${layout.height}`);
  if (lines.length !== layout.height) fail(`height mismatch — the menu draws ${lines.length} rows but the layout reserves ${layout.height}`);

  lines.forEach((line, rowOff) => {
    const hit = at(rowOff);
    const isReplayLine = line.includes("replay last caption");
    const isCaptionsLine = !isReplayLine && line.includes("▸ captions");
    // The topic's pin wears the same checkbox, so match the word, not the box.
    const isBookmarkLine = /\bbookmark(ed)?\b/.test(line);
    const shortIdOn = sessions.findIndex(s => line.includes(s.sessionId.slice(0, 8)));
    // The cwd row is a scrolling sign, so the path itself may be part-way out of view at
    // the moment the frame is taken -- its label is the part always on the row.
    const isCwdLine = line.includes(SESSION_CWD_LABEL);

    if (isCaptionsLine || isReplayLine) {
      // They belong to the voice segment above the list now, not to a block. Mapping to a
      // session again would mean a click on one of them copying an id or ticking a box.
      if (hit) fail(`row ${rowOff} draws a voice row but maps to a session: ${JSON.stringify(hit)}`);
    } else if (isBookmarkLine) {
      if (!hit || hit.action !== "bookmark") fail(`row ${rowOff} draws "bookmark" but maps to ${JSON.stringify(hit)}`);
    } else if (shortIdOn >= 0) {
      if (!hit || hit.action !== "copy" || hit.idx !== shortIdOn)
        fail(`row ${rowOff} draws session ${shortIdOn}'s id but maps to ${JSON.stringify(hit)}`);
    } else if (isCwdLine) {
      if (!hit || hit.action !== "copy")
        fail(`row ${rowOff} draws a "${SESSION_CWD_LABEL}" line but maps to ${JSON.stringify(hit)}`);
    } else if (hit) {
      fail(`row ${rowOff} is chrome ("${line.trim().slice(0, 30)}") but maps to ${JSON.stringify(hit)}`);
    }
  });

  // THE VOICE SEGMENT: mute, captions, replay — three consecutive rows, one of each, in
  // that order, with a rule under them and none of them belonging to a session block.
  // They were a pair inside every block before; grouping them is the whole point of this
  // shape, and "one captions row per session" reappearing is what would undo it.
  const captionsRows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("▸ captions")).map(([, i]) => i);
  const replayRows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("replay last caption")).map(([, i]) => i);
  console.log(`voice segment — mute: ${layout.muteRow}, captions: ${captionsRows.join(",")}, replay: ${replayRows.join(",")}`);
  if (captionsRows.length !== 1) fail(`expected exactly one captions row, drew ${captionsRows.length}`);
  if (replayRows.length !== 1) fail(`expected exactly one replay row, drew ${replayRows.length}`);
  if (captionsRows[0] !== layout.captionsRow) fail(`captions drawn at ${captionsRows[0]} but the layout says ${layout.captionsRow}`);
  if (replayRows[0] !== layout.replayRow) fail(`replay drawn at ${replayRows[0]} but the layout says ${layout.replayRow}`);
  if (layout.captionsRow !== layout.muteRow + 1)
    fail(`captions at ${layout.captionsRow} is not directly under the mute at ${layout.muteRow} — the voice rows are split up`);
  if (layout.replayRow !== layout.captionsRow + 1)
    fail(`replay at ${layout.replayRow} is not directly under captions at ${layout.captionsRow}`);
  if (at(layout.captionsRow) || at(layout.replayRow)) fail("a voice row maps to a session block");
  if (!(lines[layout.replayRow + 1] ?? "").startsWith("├"))
    fail(`the voice segment is not closed off by a rule: row ${layout.replayRow + 1} is "${(lines[layout.replayRow + 1] ?? "").trim()}"`);

  // The head row has to hold ALL of it: the label(s), the whole 8-character id, and the
  // elapsed time. This is what the menu's width is set from -- narrow it and the id (or
  // the timer) is silently sliced off the end of a row that still looks fine.
  const headRows = sessions.map(s => lines.findIndex(l => l.includes(s.sessionId.slice(0, 8))));
  if (headRows.some(r => r < 0)) fail(`a session draws no head row: ${JSON.stringify(headRows)}`);
  sessions.forEach((s, i) => {
    const line = lines[headRows[i]] ?? "";
    const short = s.sessionId.slice(0, 8);
    // A live session's row does one thing and says so. A dead one does two, and both are
    // named: the dot's own word first, the copy it shares the row with after.
    if (s.alive) {
      if (!line.includes(`${SESSION_ID_LABEL} ${short}`))
        fail(`live session ${i}'s head row does not draw "${SESSION_ID_LABEL} ${short}" uncut: "${line.trim()}"`);
      if (line.includes(SESSION_RESUME_LABEL))
        fail(`live session ${i}'s head row offers to resume a session that is still running: "${line.trim()}"`);
    } else {
      if (!line.includes(SESSION_RESUME_LABEL))
        fail(`dead session ${i}'s head row does not say it can be resumed: "${line.trim()}"`);
      if (!line.includes(`${SESSION_COPY_SHORT_LABEL} ${short}`))
        fail(`dead session ${i}'s head row does not draw "${SESSION_COPY_SHORT_LABEL} ${short}" uncut: "${line.trim()}"`);
    }
    if (!/\d+[smh]/.test(line.replace(short, "")))
      fail(`session ${i}'s head row lost its elapsed time to the label(s): "${line.trim()}"`);
  });

  // THE RESUME HALF — the one place in this menu where a session row's meaning depends on
  // the pointer's COLUMN, and the only new way a click can be mis-routed.
  //
  // The target is the cells the words occupy, so what is drawn and what is claimed are
  // pinned to each other: `sessionResumeHead` composes both. Drift here means either a
  // click on "resume" copying an id, or -- far worse -- a click meaning "copy" typing a
  // command into the shell.
  sessions.forEach((s, i) => {
    const rowOff = headRows[i];
    const head = sessionResumeHead("○");
    if (s.alive) {
      // Nothing to bring back, so the row stays undivided: its first cell copies, as the
      // whole row always has.
      if (at(rowOff, 1)?.action !== "copy")
        fail(`live session ${i}: a click on its dot maps to ${JSON.stringify(at(rowOff, 1))}, expected copy`);
      return;
    }
    const drawn = (lines[rowOff] ?? "").replace(/^│/, "").slice(0, SESSION_RESUME_CELLS);
    if (drawn !== head)
      fail(`dead session ${i} draws "${drawn}" in the ${SESSION_RESUME_CELLS} cells claimed as the resume target, expected "${head}"`);
    for (const col of [1, 2, SESSION_RESUME_CELLS]) {
      const hit = at(rowOff, col);
      if (hit?.action !== "resume" || hit.idx !== i)
        fail(`dead session ${i}: column ${col} maps to ${JSON.stringify(hit)}, expected resume of ${i}`);
    }
    for (const col of [SESSION_RESUME_CELLS + 1, SESSION_MENU_INNER]) {
      const hit = at(rowOff, col);
      if (hit?.action !== "copy" || hit.idx !== i)
        fail(`dead session ${i}: column ${col} maps to ${JSON.stringify(hit)}, expected copy of ${i}`);
    }
    // ...and only that row. The rows under it are undivided, so the same leading cells
    // there must not resume anything -- a bookmark click that types into the shell instead
    // is exactly the kind of off-by-one row this test exists for.
    for (let r = rowOff + 1; r <= rowOff + (s.cwd ? 2 : 1); r++) {
      if (at(r, 1)?.action === "resume")
        fail(`row ${r} (under dead session ${i}'s head) resumes at column 1`);
    }
  });

  // Every session that has one draws its cwd, labelled -- a bare path said nothing about
  // being a path, and both it and the row above it copy the id.
  const cwdRows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes(SESSION_CWD_LABEL)).map(([, i]) => i);
  const withCwd = sessions.filter(s => s.cwd).length;
  if (cwdRows.length !== withCwd) fail(`${withCwd} sessions have a cwd but ${cwdRows.length} rows draw one`);

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

  // The topic and its pin are ONE row, and the column decides which half a click hits.
  // Split them back into two rows and every column-based hit test below is wrong while
  // still looking right, so pin the shape: box and topic on the same line, a rule under
  // it, and no separate "pin topic" row anywhere.
  if (!topicLine.includes("☑")) fail(`topicRow ${layout.topicRow} does not draw the pin box (showTopicBar is true): "${topicLine.trim()}"`);
  if (lines.some(l => /pin topic/.test(l))) fail(`a separate "pin topic" row is still drawn`);
  const ruleLine = lines[layout.topicRow + 1] ?? "";
  if (!ruleLine.startsWith("├")) fail(`the row under the topic field is not a rule: "${ruleLine.trim()}"`);
  // Both halves of that one row: the box is the first TOPIC_PIN_CELLS cells (1-based from
  // the border), the field is everything after -- and mid-edit the whole row commits.
  if (topicRowItem(1, false) !== 21) fail("a click on the leading cell of the topic row does not hit the pin");
  if (topicRowItem(TOPIC_PIN_CELLS, false) !== 21) fail(`a click ${TOPIC_PIN_CELLS} cells in does not hit the pin`);
  if (topicRowItem(TOPIC_PIN_CELLS + 1, false) !== 20) fail("the cell after the pin box does not hit the topic field");
  if (topicRowItem(SESSION_MENU_INNER, false) !== 20) fail("a click at the far end of the topic row does not hit the topic field");
  if (topicRowItem(1, true) !== 20) fail("mid-edit, a click on the pin box does not commit the topic");
  const swLine = lines[layout.stopwatchRow] ?? "";
  if (!swLine.includes("timer")) fail(`stopwatchRow ${layout.stopwatchRow} does not draw the timer: "${swLine.trim()}"`);
  if (at(layout.topicRow)) fail("the topic row also maps to a session");
  if (at(layout.stopwatchRow)) fail("the timer row also maps to a session");

  // The mute row: drawn where the layout says, ticked as the state says (voiceMuted is
  // true above), above the session list, and owned by no session -- a mute click that
  // lands on a session's rows would bookmark or copy instead of silencing.
  const muteLine = lines[layout.muteRow] ?? "";
  if (!muteLine.includes("mute voice")) fail(`muteRow ${layout.muteRow} does not draw the mute toggle: "${muteLine.trim()}"`);
  if (!muteLine.includes("☑")) fail(`muteRow draws unticked while voiceMuted is true: "${muteLine.trim()}"`);
  if (at(layout.muteRow)) fail("the mute row also maps to a session");
  if (!(layout.muteRow < layout.sessionsRow)) fail(`mute row ${layout.muteRow} is not above the session list at ${layout.sessionsRow}`);
  // It says NOTHING about all sessions while only this one is muted. The row silences the
  // tab it is in; a global mute is someone else's setting and only appears when it is on.
  if (/\ball\b/.test(muteLine)) fail(`muteRow claims a global scope with voiceMutedAll false: "${muteLine.trim()}"`);
  // ...and it heads the voice segment: the captions and replay rows sit under it with no
  // rule between them (asserted in the voice-segment block above), and the session list
  // starts only after that segment is closed off.
  if (layout.sessionsRow !== layout.replayRow + 2)
    fail(`the session list starts at ${layout.sessionsRow}; expected the row after the voice segment's rule (${layout.replayRow + 2})`);

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

// THE MUTE'S SCOPE, as the row draws it.
//
// This checkbox is one of three rows that act on the tab's own session, and it is the only
// one that ever reached past it: it used to write the single global flag, so ticking it in
// one terminal silenced the dashboard, the phone and every other terminal, with nothing on
// the row admitting it. The layout now puts it INSIDE the voice segment -- with no session
// there is no session to mute, and "mute" must never widen into "mute everyone" just to
// have something to do.
{
  const none = computeMenuLayout([], true, false);
  if (none.muteRow !== -1) fail(`with no sessions the mute row is still laid out at ${none.muteRow}`);
  if (none.captionsRow !== -1 || none.replayRow !== -1) fail("the rest of the voice segment is drawn with no sessions");

  // A global mute is DISCLOSED, not absorbed. The box keeps reporting this session's own
  // flag -- ticking it for someone else's setting makes the next click a silent no-op --
  // and the row says why the voice is quiet anyway.
  const { layout, lines } = await drawMenu(false, true);
  const line = lines[layout.muteRow] ?? "";
  console.log(`mute row under a global mute: "${line.trim()}"`);
  if (!/all muted/.test(line)) fail(`a global mute is not disclosed on the row: "${line.trim()}"`);
  if (!line.includes("mute voice")) fail(`the row stopped being the session's own mute: "${line.trim()}"`);
}

// Opening the info must cost exactly the one row it draws — anything else means the layout
// and the overlay disagree about what unfolding the "?" does. Now that the "?" is last it
// unfolds DOWNWARDS into the border, so nothing above it may shift: that is the point of
// having moved it, and a row that moves under the pointer is what this pins.
const shut = computeMenuLayout(sessions, true, false);
const open = computeMenuLayout(sessions, true, true);
if (open.height !== shut.height + 1) fail(`opening the info changed the height by ${open.height - shut.height}, expected 1`);
for (const k of ["topicRow", "muteRow", "sessionsRow", "stopwatchRow", "helpRow"] as const) {
  if (open[k] !== shut[k]) fail(`opening the info moved ${k} by ${open[k] - shut[k]}, expected 0`);
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
