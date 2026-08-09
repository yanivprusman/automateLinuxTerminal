// What OPENS each menu, and what the keyboard does to the one row that has one — driven
// against the real app in a pty.
//
// testMenuRows.ts pins what a click at row N means once a menu is open; nothing pinned
// the click that opens one — and that click lives in a branch whose ORDER is the whole
// behaviour. The clock test sits above the forward-to-child branch and above the
// selection branch in app.tsx's mouse handler; moving it below either one silently
// turns the session menu into a menu that opens only when no child grabbed the mouse,
// or into one that opens with a selection dragging out from under it. Neither shows up
// in a type check, and both read as "the menu is broken" from the pointer.
//
// The topic field's keys are here for the same reason and share the boot: testTopicEdit.ts
// proves `\x1b[D` MEANS "left", but what shipped broken was the ROUTING — every escape
// sequence reached the branch that dismisses the menu, so Left threw the edit away. That is
// a fact about app.tsx's input loop, not about either pure function, and only a real app
// with a real menu open can be asked.
//
//   npx tsx tests/testMenuTrigger.ts
//
// Takes ~25s: it boots a real login shell and waits for real frames.
import pty from "node-pty";

const COLS = 120, ROWS = 40;
const app = pty.spawn("npx", ["tsx", "app.tsx"], {
  name: "xterm-256color", cols: COLS, rows: ROWS,
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
});

let out = "";
app.onData(d => { out += d; });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** One click, as the terminal reports it: SGR press then release (1-based cells). */
const click = (button: number, col: number, row: number) => {
  app.write(`\x1b[<${button};${col};${row}M`);
  app.write(`\x1b[<${button};${col};${row}m`);
};

const LEFT = 0, RIGHT = 2;
// Rows only the session menu draws, and only the clipboard menu draws. Read off the
// overlay rather than off box-drawing characters, which both menus share.
const SESSION_ROWS = ["mute voice", "start claude", "exit this terminal"];
const CLIPBOARD_ROWS = ["Copy", "Paste"];
const seen = (rows: string[], text: string) => rows.filter(r => text.includes(r));

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

(async () => {
  await wait(9000);   // login shell + first frames

  // The clock is the last ~22 cells of row 0 (isClockRegion in app.tsx).
  out = ""; click(LEFT, COLS - 10, 1); await wait(1500);
  check("left click on the clock opens the session menu",
        seen(SESSION_ROWS, out).length >= 2, `drew ${JSON.stringify(seen(SESSION_ROWS, out))}`);

  // Clicking it again dismisses, like any click landing on no row.
  out = ""; click(LEFT, COLS - 10, 1); await wait(1500);
  check("left click on the clock again closes it",
        !out.includes("mute voice"), "menu still drawn");

  // Everywhere else the left button still belongs to the selection / to the child.
  out = ""; click(LEFT, 20, 20); await wait(1200);
  check("left click in the body opens no menu",
        seen(SESSION_ROWS, out).length === 0 && seen(CLIPBOARD_ROWS, out).length === 0,
        `drew ${JSON.stringify([...seen(SESSION_ROWS, out), ...seen(CLIPBOARD_ROWS, out)])}`);

  out = ""; click(RIGHT, 20, 20); await wait(1500);
  check("right click still opens the clipboard menu",
        seen(CLIPBOARD_ROWS, out).length === 2, `drew ${JSON.stringify(seen(CLIPBOARD_ROWS, out))}`);
  out = ""; click(LEFT, 20, 20); await wait(1000);   // dismiss it

  // THE TOPIC FIELD TAKES THE KEYS A TEXT FIELD OWNS.
  //
  // The menu opens with this field focused, so every one of these is typed straight at it.
  // The frame is read with its colours stripped: the caret is drawn as a span of its own, so
  // the text around it is only contiguous once the SGR between the spans is gone.
  const frame = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  const typed = (s: string) => { app.write(s); };
  // The row that says the menu is there. NOT one of the voice rows — this tab hosts no
  // claude, so the whole voice segment is (correctly) undrawn here; the launch row is drawn
  // for every tab, which is exactly why it is the one to ask about.
  const MENU_MARK = "start claude";
  out = ""; click(LEFT, COLS - 10, 1); await wait(1500);
  check("the menu opens for the field tests", out.includes(MENU_MARK), "menu did not open");

  out = ""; typed("abc"); await wait(700);
  check("typing reaches the field", frame().includes("abc█"), "the typed characters are not on the row");

  // Ctrl+U empties it — whatever topic this tab already carried is gone with it, so the
  // checks below start from a known field. An empty field says what it is for again, which
  // is how the kill is visible at all. (Asking this BEFORE typing would prove nothing on a
  // tab whose topic is already empty: the state would not change, and Ink writes no frame
  // for a frame that is identical.)
  out = ""; typed("\x15"); await wait(700);
  check("ctrl+u empties the field", frame().includes("set topic"), `row: ${JSON.stringify(frame().match(/☐[^│]*/)?.[0] ?? "")}`);
  out = ""; typed("abc"); await wait(700);

  // THE REGRESSION ITSELF: Left used to be read as "dismiss", taking the edit with it.
  //
  // Ink repaints only the rows that changed, so a still-standing menu does not re-emit the
  // rows below this one — the evidence is the topic row itself: it is redrawn, it still holds
  // what was typed, and the block caret has left the end (it is now ON the "c", drawn as a
  // reversed cell). A menu that had closed would repaint the terminal underneath instead, and
  // carry none of that.
  out = ""; typed("\x1b[D"); await wait(700);
  check("left arrow keeps the menu and the edit",
        frame().includes("abc") && !frame().includes("abc█"), `row: ${JSON.stringify(frame().match(/☐[^│]*/)?.[0] ?? "")}`);
  out = ""; typed("X"); await wait(700);
  check("left arrow moved the caret", frame().includes("abXc"), "the character went to the end, not the caret");

  out = ""; typed("\x1b[H"); await wait(500); typed("Z"); await wait(700);
  check("home goes to the head of the field", frame().includes("ZabXc"), "the character did not land at the head");

  out = ""; typed("\x1b[3~"); await wait(700);
  check("delete takes the character under the caret", frame().includes("ZbXc") && !frame().includes("ZabXc"),
        "delete did not remove the character ahead of the caret");

  // Escape still drops an unfinished edit and leaves the menu standing — the rule the field
  // has always had, which none of the above may have quietly taken over.
  out = ""; typed("\x1b"); await wait(900);
  check("escape drops the edit and keeps the menu",
        frame().includes("set topic") && !frame().includes("ZbXc"),
        `row: ${JSON.stringify(frame().match(/☐[^│]*/)?.[0] ?? "")}`);
  click(LEFT, COLS - 10, 1); await wait(800);

  app.kill();
  await wait(500);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
