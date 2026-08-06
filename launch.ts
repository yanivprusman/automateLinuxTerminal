import type { ShellState } from "./resume.js";
import { CLEAR_LINE } from "./exit.js";

// Starting a claude here, from the menu of the tab it will run in.
//
// The counterpart to the resume row above it and the exit row below it, and built the same
// way: it TYPES into this tab's own shell. `cl --dangerously-skip-permissions` is the line
// the user types by hand a dozen times a day, and the honest way to run something in a shell
// is to send the characters they would send -- so the command lands in shell history, wears
// the same environment, and the session it starts is this tab's, visible to the session list
// two rules up. No second launcher, nothing spawned beside the shell.

/** The shell function that starts a claude (automateLinux terminal/functions/claude.sh). */
export const LAUNCH_FN = "cl";

/** The flag this row starts it with. Named in the row's own label rather than hidden behind
 *  a friendly verb: a click that starts an agent which will not ask before it acts has to
 *  say so on the row that was clicked. */
export const LAUNCH_FLAG = "--dangerously-skip-permissions";

export const LAUNCH_CMD = `${LAUNCH_FN} ${LAUNCH_FLAG}`;

/** Exactly what to write into the pty to start it.
 *
 *  A constant, not a builder: unlike the resume there is no id to check, because nothing
 *  from disk reaches this line. Every character of it is written here.
 *
 *  The line is cleared first for the reason resume.ts clears it -- the prompt may already
 *  hold something half-typed and appending would run neither what was typed nor what was
 *  clicked. Both kills go to readline's kill ring, so `Ctrl+Y` brings the abandoned line
 *  back. */
export const LAUNCH_KEYS = `${CLEAR_LINE}${LAUNCH_CMD}\r`;

/**
 * Why this may not be typed right now, or null when it may.
 *
 * Same contract as the resume row, and for the same reason: a shell running something is
 * reading its stdin for that program, so a command line delivered there is not a launch --
 * it is keystrokes for whatever is on top. `unknown` (no such pid, or a kernel without
 * CONFIG_PROC_CHILDREN) refuses too; it is not "probably fine".
 *
 * A busy shell gets its reason split by WHAT is busy, because the commonest cause here is
 * the one the row can name exactly: a claude is already running in this tab, and the answer
 * to "start claude here" is that there is one. `shell is busy here` -- a build, an editor,
 * another terminal app -- is the same words the exit row uses for the same state.
 *
 * `hasClaude` is a thunk, as it is in `ExitIo`, and it is consulted ONLY in that branch: an
 * idle shell is running nothing, so walking /proc to ask what it is running would be a
 * question with a known answer paid for on every click.
 */
export function launchRefusal(state: ShellState, hasClaude: () => boolean): string | null {
  if (state === 'unknown') return 'cannot read shell state';
  if (state === 'busy') return hasClaude() ? 'claude already running here' : 'shell is busy here';
  return null;
}
