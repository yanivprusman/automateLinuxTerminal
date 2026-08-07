// What OPENS each menu, driven against the real app in a pty.
//
// testMenuRows.ts pins what a click at row N means once a menu is open; nothing pinned
// the click that opens one — and that click lives in a branch whose ORDER is the whole
// behaviour. The clock test sits above the forward-to-child branch and above the
// selection branch in app.tsx's mouse handler; moving it below either one silently
// turns the session menu into a menu that opens only when no child grabbed the mouse,
// or into one that opens with a selection dragging out from under it. Neither shows up
// in a type check, and both read as "the menu is broken" from the pointer.
//
//   npx tsx tests/testMenuTrigger.ts
//
// Takes ~15s: it boots a real login shell and waits for real frames.
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

  app.kill();
  await wait(500);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
