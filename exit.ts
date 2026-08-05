import type { ShellState } from "./resume.js";

// Ending the tab from its own menu, the way it is ended by hand: Ctrl+D twice into the
// claude running here, then out of the shell that was running it. Three presses, of which
// the first two are on a deadline and the third only works from a prompt -- which is
// exactly why it is worth a row rather than a thing to get right by hand each time.
//
// It TYPES, as the resume row types (resume.ts): the claude and the shell are this tab's,
// and the honest way to end something a shell is running is to send the keys you would
// press. Nothing here kills a pid. A claude that is asked to leave writes its transcript
// out and leaves a session the menu above can resume; a killed one leaves what a crash
// leaves.

/** Ctrl+D: end-of-transmission. What ends a claude (twice, see below) and, historically,
 *  what ends the shell after it. */
export const EOT = "\x04";

/** ^U ^K -- kill to the start of the line, then to its end. The prompt may hold something
 *  half-typed, and `exit` appended to it runs neither. Both kills go to readline's kill
 *  ring, so Ctrl+Y brings the abandoned line back. */
export const CLEAR_LINE = "\x15\x0b";

/** The line that ends the shell.
 *
 *  `exit` rather than a third Ctrl+D. EOF ends a shell only when the line is empty AND
 *  `IGNOREEOF` is unset -- neither is ours to assume about a login shell we did not write
 *  the rc for, and a Ctrl+D that is merely ignored leaves the tab open with no clue why.
 *  `exit` is a builtin: it means the same thing to bash, zsh and fish, and it fails loudly
 *  (`There are stopped jobs.`) instead of silently, which the row can then report. */
export const SHELL_EXIT_LINE = `${CLEAR_LINE}exit\r`;

/** How long claude's exit stays armed, in ms.
 *
 *  Claude Code binds `ctrl+d` to `app:exit` in its **Global** context and confirms it with
 *  a DOUBLE press: the first arms "Press Ctrl-D again to exit", the second within this
 *  window leaves. Read out of the CLI itself (2.1.222: `iqy=800`, the debounce window the
 *  exit and interrupt handlers share) -- a second press that arrives late does not exit,
 *  it re-arms, so a naive "press, wait a second, press again" loop never terminates.
 *
 *  Global is also why nothing here clears claude's input first: its Chat context binds no
 *  ctrl+d, so a half-typed prompt does not swallow the press (and a stray ^U would be
 *  typed INTO that prompt if the binding ever moved). */
export const CLAUDE_DOUBLE_PRESS_WINDOW_MS = 800;

/** Between the two presses: long enough for the first to be rendered and armed, well
 *  inside the window above. */
export const EOT_GAP_MS = 250;

/** How long claude gets to be gone after a pair. It flushes its transcript and releases
 *  its lock on the way out, so this is not instant. */
export const CLAUDE_EXIT_TIMEOUT_MS = 4000;

/** Pairs to send before giving up. A pair, never a single press: a lone Ctrl+D after the
 *  window has lapsed only re-arms, so a retry is a retry of BOTH. */
export const MAX_EXIT_ATTEMPTS = 2;

/** How long the shell gets to come back to its prompt once claude is gone. */
export const PROMPT_SETTLE_TIMEOUT_MS = 3000;

/** How long the shell gets to be gone after `exit`. It refuses with stopped jobs, and
 *  that refusal is the one the row has to show. */
export const SHELL_EXIT_TIMEOUT_MS = 2500;

/** Between liveness checks. Every one is a /proc read, so this is cheap. */
export const POLL_MS = 100;

export type ExitOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Everything this sequence does to the world, so the sequence itself is testable without a
 * pty, a claude, or eight seconds of real waiting (`tests/testExit.ts`).
 *
 * `shellState` is the single authority on "is this shell running something" and `hasClaude`
 * on "is that something a claude" -- deliberately two questions with one answer each, so
 * nothing here has to guess what a busy shell is busy with.
 */
export interface ExitIo {
  /** Keystrokes into the tab's shell. */
  write(keys: string): void;
  /** Whether the shell is at its prompt, running something, or unreadable. */
  shellState(): ShellState;
  /** Whether the thing it is running is a claude of this tab's. */
  hasClaude(): boolean;
  /** Whether the shell process is still there at all. */
  shellAlive(): boolean;
  wait(ms: number): Promise<void>;
  /** What to put on the menu row while this runs. Phases, not a spinner: the whole thing
   *  can take several seconds and a row that says nothing reads as a dead click. */
  note?(msg: string): void;
}

async function pollFor(io: ExitIo, done: () => boolean, timeoutMs: number): Promise<boolean> {
  const steps = Math.ceil(timeoutMs / POLL_MS);
  for (let i = 0; i < steps; i++) {
    await io.wait(POLL_MS);
    if (done()) return true;
  }
  return done();
}

/**
 * Ctrl+D, Ctrl+D, `exit` -- with the state of the tab checked between each, and a reason on
 * the row for every way it can decline.
 *
 * The one invariant worth stating outright: **the shell exit line is never written while
 * claude is still alive.** `exit` typed into a claude is not a refusal that goes nowhere --
 * it is a prompt submitted to a model. So every path to it goes through the shell being
 * back at its own prompt, and a claude that would not leave ends the sequence rather than
 * falling through to the next step.
 */
export async function runExitSequence(io: ExitIo): Promise<ExitOutcome> {
  const state = io.shellState();
  // A shell whose children cannot be read is not "probably idle" -- resume.ts refuses on
  // the same answer, for the same reason: the next thing we do is type.
  if (state === 'unknown') return { ok: false, reason: 'cannot read shell state' };
  if (state === 'busy') {
    // Something is running here, and only a claude of this tab's is something this row
    // knows how to end. A build, an editor, another terminal app: say so and touch nothing.
    if (!io.hasClaude()) return { ok: false, reason: 'shell is busy here' };
    io.note?.('▸ exiting claude…');
    let gone = false;
    for (let attempt = 0; attempt < MAX_EXIT_ATTEMPTS && !gone; attempt++) {
      io.write(EOT);
      await io.wait(EOT_GAP_MS);
      io.write(EOT);
      // Claude leaving IS the shell coming back to its prompt -- one /proc read answers
      // both, where asking pgrep for claude again would cost a process per poll.
      gone = await pollFor(io, () => io.shellState() === 'idle', CLAUDE_EXIT_TIMEOUT_MS);
    }
    // It stayed. Claude rebinds ctrl+d to half-page-down inside its transcript and settings
    // views, so the commonest cause is that the tab is not on the prompt the user thinks
    // it is -- and the honest answer to that is the one on the row, not a harder keystroke.
    if (!gone) return { ok: false, reason: 'claude did not exit' };
  }
  // A shell that is idle but has not drawn its prompt yet would swallow the line, so wait
  // for the state rather than for a guessed number of milliseconds.
  if (!await pollFor(io, () => io.shellState() === 'idle', PROMPT_SETTLE_TIMEOUT_MS)) {
    return { ok: false, reason: 'no prompt to exit from' };
  }
  io.note?.('▸ closing terminal…');
  io.write(SHELL_EXIT_LINE);
  // Success is the app dying under us (the shell's exit tears the terminal down), so this
  // resolves false only when the shell genuinely refused -- stopped jobs, most likely.
  const closed = await pollFor(io, () => !io.shellAlive(), SHELL_EXIT_TIMEOUT_MS);
  return closed ? { ok: true } : { ok: false, reason: 'shell did not exit' };
}
