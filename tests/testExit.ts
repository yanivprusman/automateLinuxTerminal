// The exit row's sequence: what it types, in what order, and — above all — what it refuses
// to type.
//
// Driving it for real would mean a pty, a claude, and the better part of ten seconds per
// case, so the sequence takes its world as an interface (ExitIo) and this fakes it with a
// virtual clock. That buys the case that matters most and cannot be produced on demand
// otherwise: a claude that will NOT leave. All three presses are the same byte, so nothing
// about the LAST one is visible in what is written -- only in when it is written, and only
// the ordering asserted below says the sequence still knew what it was talking to.
//
//   npx tsx tests/testExit.ts
import { runExitSequence, EOT, SHELL_EXIT_KEYS, EOT_GAP_MS, CLAUDE_DOUBLE_PRESS_WINDOW_MS,
         CLAUDE_EXIT_TIMEOUT_MS, MAX_EXIT_ATTEMPTS, type ExitIo } from "../exit.js";
import type { ShellState } from "../resume.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg: string) => console.log("  ok   " + msg);

/** The tab, as the sequence can see it: a clock that costs nothing to advance, a shell that
 *  is busy until whatever it is running gives up, and a log of every keystroke with the
 *  virtual time it was written at (the two Ctrl+Ds are only an exit if they are close
 *  enough together, so WHEN matters as much as WHAT). */
class FakeTab implements ExitIo {
  clock = 0;
  writes: { keys: string; at: number }[] = [];
  notes: string[] = [];
  presses = 0;

  constructor(private opts: {
    claude: boolean;
    /** Presses after which claude leaves; Infinity = it never does. */
    exitsAfterPresses: number;
    /** A shell with a child that is not a claude. */
    busyWithoutClaude?: boolean;
    unreadable?: boolean;
    /** A shell that refuses to leave (stopped jobs). */
    shellRefusesExit?: boolean;
    /** The shell goes with claude: its second press lands at a fresh prompt as an EOF. */
    shellDiesWithClaude?: boolean;
  }) {}

  private shellGone = false;

  write(keys: string) {
    this.writes.push({ keys, at: this.clock });
    if (keys === EOT) this.presses++;
    if (keys === SHELL_EXIT_KEYS && !this.opts.shellRefusesExit) this.shellGone = true;
  }
  shellState(): ShellState {
    if (!this.shellAlive()) return 'unknown';        // /proc goes with the process
    if (this.opts.unreadable) return 'unknown';
    if (this.opts.busyWithoutClaude) return 'busy';
    const running = this.opts.claude && this.presses < this.opts.exitsAfterPresses;
    return running ? 'busy' : 'idle';
  }
  hasClaude() { return this.opts.claude; }
  shellAlive() {
    return !this.shellGone
        && !(this.opts.shellDiesWithClaude && this.presses >= this.opts.exitsAfterPresses);
  }
  async wait(ms: number) { this.clock += ms; }
  note(msg: string) { this.notes.push(msg); }

  get typed() { return this.writes.map(w => w.keys); }
}

// 1. THE ORDINARY CASE: a claude that takes the pair, then the shell.
{
  const tab = new FakeTab({ claude: true, exitsAfterPresses: 2 });
  const res = await runExitSequence(tab);
  if (!res.ok) fail(`a claude that exits reported "${(res as { reason: string }).reason}"`);
  if (JSON.stringify(tab.typed) !== JSON.stringify([EOT, EOT, SHELL_EXIT_KEYS]))
    fail(`typed ${JSON.stringify(tab.typed)}, expected two Ctrl+Ds then the shell's own`);
  else ok("Ctrl+D, Ctrl+D, Ctrl+D");
  // The pair is only an exit inside claude's own 800ms window; a "wait a second between
  // presses" version of this loop would re-arm forever instead of leaving.
  const [first, second] = tab.writes.filter(w => w.keys === EOT);
  const gap = second.at - first.at;
  if (gap >= CLAUDE_DOUBLE_PRESS_WINDOW_MS)
    fail(`${gap}ms between the presses — claude's confirmation lapses after ${CLAUDE_DOUBLE_PRESS_WINDOW_MS}ms`);
  else ok(`${gap}ms apart, inside claude's ${CLAUDE_DOUBLE_PRESS_WINDOW_MS}ms window`);
  if (!tab.notes.some(n => /claude/.test(n)) || !tab.notes.some(n => /terminal/.test(n)))
    fail(`the row reported ${JSON.stringify(tab.notes)}, expected a phase for each half`);
}

// 2. THE CASE THIS FILE EXISTS FOR: a claude that will not leave (its transcript view
//    rebinds ctrl+d to half-page-down, so this is reachable by simply being on the wrong
//    screen). It must NEVER fall through to the shell's press: that press is only correct
//    once the shell owns the pty again, and sending it into a live claude would mean the
//    sequence had stopped knowing what it was talking to (it would also read as success).
{
  const tab = new FakeTab({ claude: true, exitsAfterPresses: Infinity });
  const res = await runExitSequence(tab);
  if (res.ok) fail("a claude that never exits reported success");
  else if (!/claude did not exit/.test(res.reason)) fail(`reported "${res.reason}"`);
  else ok(`refused with "${res.reason}"`);
  if (tab.typed.includes(SHELL_EXIT_KEYS))
    fail("sent the shell's press while claude was still alive");
  else ok("never sent the shell's press into a live claude");
  if (tab.presses !== MAX_EXIT_ATTEMPTS * 2)
    fail(`sent ${tab.presses} presses, expected ${MAX_EXIT_ATTEMPTS} pairs`);
  // A retry is a retry of BOTH presses: a lone late Ctrl+D only re-arms the confirmation.
  const gaps = tab.writes.filter(w => w.keys === EOT).map(w => w.at);
  for (let i = 0; i < gaps.length; i += 2) {
    if (gaps[i + 1] - gaps[i] !== EOT_GAP_MS) fail(`attempt ${i / 2} is not a pair: ${gaps[i]} → ${gaps[i + 1]}`);
  }
  if (tab.clock > MAX_EXIT_ATTEMPTS * (CLAUDE_EXIT_TIMEOUT_MS + EOT_GAP_MS) + 1000)
    fail(`gave up after ${tab.clock}ms — too long to leave a row saying "exiting…"`);
}

// 3. NO CLAUDE, PROMPT FREE: just the last of the three presses.
{
  const tab = new FakeTab({ claude: false, exitsAfterPresses: 0 });
  const res = await runExitSequence(tab);
  if (!res.ok) fail(`an idle shell reported "${(res as { reason: string }).reason}"`);
  if (JSON.stringify(tab.typed) !== JSON.stringify([SHELL_EXIT_KEYS]))
    fail(`typed ${JSON.stringify(tab.typed)}, expected the shell's press alone`);
  else ok("no claude: one press, on a cleared line");
}

// 4. BUSY WITH SOMETHING ELSE — a build, an editor, another terminal app. Keystrokes go to
//    whatever is reading stdin, so this row must decline rather than deliver them.
{
  const tab = new FakeTab({ claude: false, exitsAfterPresses: 0, busyWithoutClaude: true });
  const res = await runExitSequence(tab);
  if (res.ok || !/busy/.test((res as { reason: string }).reason)) fail(`a busy shell reported ${JSON.stringify(res)}`);
  else ok(`refused with "${(res as { reason: string }).reason}"`);
  if (tab.writes.length) fail(`typed ${JSON.stringify(tab.typed)} into a shell running something else`);
}

// 5. UNREADABLE STATE is its own answer, not "probably idle" — same contract as the resume
//    row, and for the same reason: the next thing this does is type.
{
  const tab = new FakeTab({ claude: false, exitsAfterPresses: 0, unreadable: true });
  const res = await runExitSequence(tab);
  if (res.ok || !/cannot read shell state/.test((res as { reason: string }).reason)) fail(`reported ${JSON.stringify(res)}`);
  else ok(`refused with "${(res as { reason: string }).reason}"`);
  if (tab.writes.length) fail("typed into a shell whose state could not be read");
}

// 6. A SHELL THAT REFUSES (`There are stopped jobs.`). The window stays open, so the row is
//    the only place that can say why.
{
  const tab = new FakeTab({ claude: false, exitsAfterPresses: 0, shellRefusesExit: true });
  const res = await runExitSequence(tab);
  if (res.ok || !/shell did not exit/.test((res as { reason: string }).reason)) fail(`reported ${JSON.stringify(res)}`);
  else ok(`refused with "${(res as { reason: string }).reason}"`);
}

// 7. THE RACE THE THIRD PRESS CREATES, now that it is the same key: claude can exit between
//    the pair, so the SECOND press lands at a fresh shell prompt and takes the shell with it.
//    Done is done — the sequence must report success, not send another press into nothing.
{
  const tab = new FakeTab({ claude: true, exitsAfterPresses: 2, shellDiesWithClaude: true });
  const res = await runExitSequence(tab);
  if (!res.ok) fail(`the shell going with claude reported "${(res as { reason: string }).reason}"`);
  else ok("shell exited on claude's own second press — reported success");
  if (tab.typed.length !== 2) fail(`typed ${JSON.stringify(tab.typed)} — a third press went into a dead tab`);
}

// Every reason has to fit the row it is drawn on (35 cells, less the "▸ " the app prepends).
for (const reason of ['cannot read shell state', 'shell is busy here', 'claude did not exit',
                      'no prompt to exit from', 'shell did not exit']) {
  if (reason.length > 31) fail(`"${reason}" is too long for the menu row`);
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
