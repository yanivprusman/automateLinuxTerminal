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

/** ^U ^K -- kill to the start of the line, then to its end.
 *
 *  Required, not tidiness: Ctrl+D at a bash prompt is EOF only on an EMPTY line. With
 *  anything typed there it is delete-char instead, so the press would silently edit the
 *  user's half-written command rather than end the shell. Both kills go to readline's kill
 *  ring, so Ctrl+Y brings the abandoned line back. */
export const CLEAR_LINE = "\x15\x0b";

/** What ends the shell: the same key again, on a line cleared for it.
 *
 *  A third Ctrl+D, NOT a typed `exit`. This shipped typing the word, on the theory that EOF
 *  is conditional (empty line, `IGNOREEOF` unset) and refuses silently where `exit` refuses
 *  out loud. The second half is simply false -- measured in a pty on 2026-08-05, Ctrl+D
 *  with a stopped job prints the identical `logout` / `There are stopped jobs.`, and under
 *  `IGNOREEOF` it prints `Use "logout" to leave the shell.` Both refusals are equally
 *  visible and equally detectable (the shell stays alive, which is what this checks), so
 *  the argument for typing a word bought nothing and cost three things:
 *
 *  - **The keystroke is inert where the word is not.** These bytes go to whatever is reading
 *    the pty. A Ctrl+D that arrives a moment early -- claude taking the second press with it
 *    -- is just another EOF; `exit\r` arriving early is a line SUBMITTED to a model.
 *  - It is the press the user makes. This row automates three Ctrl+Ds; substituting a
 *    different mechanism for the last one is a second thing to reason about for no gain.
 *  - `exit` lands in shell history. EOF does not.
 *
 *  `IGNOREEOF` is left to fail rather than worked around: no fallback chain, the shell stays
 *  up, and the row says `shell did not exit`. */
export const SHELL_EXIT_KEYS = `${CLEAR_LINE}${EOT}`;

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
 * Ctrl+D, Ctrl+D, Ctrl+D -- with the state of the tab checked between each, and a reason on
 * the row for every way it can decline.
 *
 * The invariant worth stating outright: **the shell's press is never sent while claude is
 * still alive.** Not because the byte would do damage (it is the same EOF claude is already
 * being sent -- that inertness is exactly why it beats typing a word), but because sending
 * it would mean the sequence had stopped knowing what it was talking to. So every path to
 * the last press goes through the shell being back at its own prompt, and a claude that
 * would not leave ends the sequence rather than falling through to the next step.
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
      // both, where asking pgrep for claude again would cost a process per poll. The tab
      // vanishing counts too: claude can exit on the FIRST press, and then the second is an
      // EOF at a fresh prompt that takes the shell with it. Without that arm the poll waits
      // on a prompt no process is left to draw and the retry types into a dead tab.
      gone = await pollFor(io, () => !io.shellAlive() || io.shellState() === 'idle',
                           CLAUDE_EXIT_TIMEOUT_MS);
    }
    if (!io.shellAlive()) return { ok: true };
    // It stayed. Claude rebinds ctrl+d to half-page-down inside its transcript and settings
    // views, so the commonest cause is that the tab is not on the prompt the user thinks
    // it is -- and the honest answer to that is the one on the row, not a harder keystroke.
    if (!gone) return { ok: false, reason: 'claude did not exit' };
  }
  // A shell that is idle but has not drawn its prompt yet would swallow the press, so wait
  // for the state rather than for a guessed number of milliseconds.
  const settled = await pollFor(io, () => io.shellState() === 'idle' || !io.shellAlive(),
                                PROMPT_SETTLE_TIMEOUT_MS);
  // The tab can already be gone: claude may exit between the two presses, and then the
  // second one is an EOF at a fresh prompt -- which is precisely the last press this was
  // about to send. Done is done; sending another into nothing would be the fallback this
  // code does not write.
  if (!io.shellAlive()) return { ok: true };
  if (!settled) return { ok: false, reason: 'no prompt to exit from' };
  io.note?.('▸ closing terminal…');
  io.write(SHELL_EXIT_KEYS);
  // Success is the app dying under us (the shell's exit tears the terminal down), so this
  // resolves false only when the shell genuinely refused -- stopped jobs, most likely.
  const closed = await pollFor(io, () => !io.shellAlive(), SHELL_EXIT_TIMEOUT_MS);
  return closed ? { ok: true } : { ok: false, reason: 'shell did not exit' };
}
