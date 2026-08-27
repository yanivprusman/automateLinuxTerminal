// The "send to session" dialog, driven against the real app in a pty: the row appears only
// once a claude runs in the tab, a click on it opens the dialog in the menu's place, the
// keyboard reaches the box, Enter is a LINE BREAK there (as it is in the phone's box),
// Ctrl+S puts the words INTO THE CLAUDE (and nowhere else) with an Enter after them, Ctrl+O
// without one, and Escape puts nothing anywhere.
//
// testSendToSession.ts proves what the flow does and testSendDialogRows.ts what the dialog
// draws; neither can be asked about the ROUTING in app.tsx's input loop -- which byte goes
// to the dialog, which to the menu, which to the shell -- and that routing is the whole
// feature from the keyboard's side. Only a real app with a real menu open can answer, so
// this boots one (as testMenuTrigger.ts does) with a stand-in claude in its shell.
//
// The stand-in is a symlink to bash named `claude` (comm is the exec'd name, and that is
// what detectClaudeSession matches), running a loop that echoes every line it reads with a
// `GOT:` prefix. So "the words reached the claude" is a string in the pty's output, and
// "nothing reached it" is that string's absence. It writes no session file, so the tab's
// session id is `unknown` -- which is a real state (the second before the first hook
// fires) and one the dialog has to work in.
//
//   npx tsx tests/testSendDialog.ts
//
// Takes ~30s: it boots a real login shell and waits for real frames.
import pty from "node-pty";
import { mkdtempSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SEND_LABEL } from "../menu.js";
import { SESSION_MENU_INNER, computeMenuLayout } from "../menu.js";

const COLS = 120, ROWS = 40;
const app = pty.spawn("npx", ["tsx", "app.tsx"], {
  name: "xterm-256color", cols: COLS, rows: ROWS,
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
});

let out = "";
app.onData(d => { out += d; });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const click = (button: number, col: number, row: number) => {
  app.write(`\x1b[<${button};${col};${row}M`);
  app.write(`\x1b[<${button};${col};${row}m`);
};
const LEFT = 0;
const frame = () => out.replace(/\x1b\[[0-9;]*m/g, "");

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// Where the menu lands when the clock is clicked at (COLS - 10, row 1): one row below the
// click, and pushed left so it fits (app.tsx openSessionMenu). Its rows are then the
// layout's offsets from that top border; the send row's offset is computeMenuLayout's,
// for a menu with exactly one live session and no cwd... whose exact shape does not
// matter here, because the offset is the same for every shape that has a live session.
const MENU_TOP = 1;                                  // 0-based screen row of the top border
const MENU_LEFT = COLS - (SESSION_MENU_INNER + 2);   // 0-based screen col of the left border
const sendRowOff = computeMenuLayout([{ sessionId: "unknown", cwd: null, pid: 1, startMs: 0, alive: true, bookmarked: false }], true, false).sendRow;
const clickMenuRow = (rowOff: number) => click(LEFT, MENU_LEFT + 5 + 1, MENU_TOP + rowOff + 1);   // 1-based for SGR

const dir = mkdtempSync(join(tmpdir(), "send-dialog-"));
symlinkSync("/bin/bash", join(dir, "claude"));

(async () => {
  try {
    await wait(9000);   // login shell + first frames

    // 1. NO CLAUDE HERE, NO ROW. The menu opens (the launch row proves it) without the send row.
    out = ""; click(LEFT, COLS - 10, 1); await wait(1500);
    check("the menu opens", frame().includes("start claude"), "menu did not open");
    check("with no claude in the tab there is no send row", !frame().includes(SEND_LABEL), "the send row is drawn for a tab with nothing to send to");
    click(LEFT, COLS - 10, 1); await wait(800);   // close it

    // 2. A CLAUDE (stand-in) IN THE TAB. It echoes what it is sent, line by line.
    // The marker is split in the typed command ("GO""T:") on purpose: the row that command
    // sits on is repainted whenever the dialog over it changes, so a marker written out in
    // full would turn up in `out` from the repaint alone, echo or no echo.
    app.write(`${join(dir, "claude")} -c 'while IFS= read -r l; do echo "GO""T:$l"; done'\r`);
    await wait(2500);
    out = ""; click(LEFT, COLS - 10, 1); await wait(1500);
    check("with a claude in the tab the menu draws the send row", frame().includes(SEND_LABEL), "no send row");

    // 3. THE ROW OPENS THE DIALOG, in the menu's place, focused on an empty box.
    out = ""; clickMenuRow(sendRowOff); await wait(1500);
    check("clicking the row opens the dialog", frame().includes("Type what you want to send"), "no dialog hint on screen");
    check("the dialog names the session's state honestly", frame().includes("unknown"), "the label does not carry the (unknown) id");
    check("the menu is gone", !frame().includes("start claude"), "the menu is still drawn under the dialog");

    // 4. THE KEYBOARD REACHES THE BOX -- and not the claude under it.
    out = ""; app.write("hello"); await wait(800);
    check("typing lands in the box", frame().includes("hello█"), `box: ${JSON.stringify(frame().match(/hello[^\n]{0,3}/)?.[0])}`);
    check("...and not in the claude", !out.includes("GOT:hello"), "the claude echoed the words");
    // The field's keys are the topic field's.
    out = ""; app.write("\x1b[D\x1b[D"); app.write("X"); await wait(800);
    check("left arrow moves the caret in the box", frame().includes("helXlo"), "the character went to the end");
    out = ""; app.write("\x1b[F"); app.write("\x7f\x7f\x7f"); await wait(800);   // End, then three backspaces
    // `out` holds every frame since the reset -- End alone redraws "helXlo█" before the
    // backspaces take it down -- so the box's LAST state is what is asked about.
    check("end then backspace deletes from the end of the box", frame().lastIndexOf("hel█") > frame().lastIndexOf("helXlo"),
          `box: ${JSON.stringify(frame().match(/hel[Xlo█]{1,4}/g))}`);
    out = ""; app.write("lo"); await wait(600);

    // 5. ENTER IS A LINE BREAK, as in the phone's box -- and nothing reaches the claude for it.
    out = ""; app.write("\r"); await wait(700); app.write("world"); await wait(800);
    check("enter breaks the line in the box", frame().includes("world█") && !frame().includes("helloworld") && !frame().includes("hello world"),
          `box: ${JSON.stringify(frame().match(/hello[^│]{0,12}/g))}`);
    check("...and sends nothing", !out.includes("GOT:hello"), "the claude got the first line");
    // The stand-in reads the pty line by line, so a two-line message delivered with its
    // break and then an Enter comes back as TWO echoes, in order.
    // 6. CTRL+S SENDS: the words reach the claude with their break and an Enter after them.
    out = ""; app.write("\x13"); await wait(1800);
    check("ctrl+s delivers the words to the claude", out.includes("GOT:hello") && out.includes("GOT:world"), `claude saw: ${JSON.stringify(out.match(/GOT:[^\r\n]*/g))}`);
    check("the dialog closes once the words have landed", !frame().includes("Type what you want to send"), "the dialog is still up");

    // 7. ESCAPE CANCELS: nothing reaches the claude.
    out = ""; click(LEFT, COLS - 10, 1); await wait(1200); clickMenuRow(sendRowOff); await wait(1200);
    check("the dialog opens again", frame().includes("Type what you want to send"), "no dialog");
    out = ""; app.write("dropped"); await wait(600); app.write("\x1b"); await wait(900);
    check("escape closes the dialog", !frame().includes("Type what you want to send"), "the dialog is still up");
    app.write("\r"); await wait(1000);   // an Enter at the claude: would submit anything that leaked
    check("...and nothing leaked into the claude", !out.includes("GOT:dropped"), `claude saw: ${JSON.stringify(out.match(/GOT:[^\r\n]*/g))}`);

    // 8. CTRL+O INSERTS: the words reach the claude WITHOUT an Enter.
    out = ""; click(LEFT, COLS - 10, 1); await wait(1200); clickMenuRow(sendRowOff); await wait(1200);
    out = ""; app.write("inserted"); await wait(600); app.write("\x0f"); await wait(1200);
    check("ctrl+o closes the dialog", !frame().includes("Type what you want to send"), "the dialog is still up");
    check("...without submitting", !out.includes("GOT:inserted"), "the claude got an Enter it was not sent");
    app.write("\r"); await wait(1000);
    check("...the words were typed, waiting at the prompt", out.includes("GOT:inserted"), `claude saw: ${JSON.stringify(out.match(/GOT:[^\r\n]*/g))}`);

    // 9. A CLICK OUTSIDE DISMISSES, as a tap outside the phone's popup does.
    out = ""; click(LEFT, COLS - 10, 1); await wait(1200); clickMenuRow(sendRowOff); await wait(1200);
    out = ""; app.write("outside"); await wait(500); click(LEFT, 5, 30); await wait(900);
    check("a click outside the dialog dismisses it", !frame().includes("Type what you want to send"), "the dialog is still up");
    app.write("\r"); await wait(800);
    check("...and drops the words", !out.includes("GOT:outside"), "the words leaked");
  } finally {
    app.write("\x04");   // end the stand-in claude's read loop
    await wait(300);
    app.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
