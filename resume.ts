import { readFileSync } from "fs";

// Bringing a finished session back, from the menu of the tab it died in.
//
// Every session in that menu is one THIS tab's shell hosted (the list is built by walking
// that shell's descendants), so "resume it" means "run it here again" -- and the honest way
// to run something in a shell is to type it into the shell. No second launcher, no
// re-implementation of what a resume is: `claudeResumeById` already finds the transcript,
// works out where the session started, cd's there and resumes with the same flags a normal
// launch uses. It is a shell function, so it is reachable exactly where we are typing.

/** The shell function that resumes a session by id (automateLinux terminal/functions/claude.sh). */
export const RESUME_FN = "claudeResumeById";

// A session id reaches us from a hook's file (`/tmp/claude-live-session-<pid>.json`) and is
// about to be part of a command line, so it is checked rather than trusted: anything but a
// plain id is refused outright instead of being quoted into safety. Claude Code writes
// UUIDs; nothing legitimate here needs a character a shell would look at twice.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Exactly what to write into the pty to resume `sessionId`, or null when the id is not one
 * we may type (no hook has fired yet, so it is still 'unknown', or it is not a plain id).
 *
 * The line is cleared first (kill to the start of the line, then to its end) because the
 * prompt may already hold something half-typed, and appending to it would run neither what
 * the user typed nor what they clicked. Both halves go to readline's kill ring, so `Ctrl+Y`
 * brings the abandoned line back.
 */
export function resumeKeystrokes(sessionId: string): string | null {
  if (!sessionId || sessionId === "unknown" || !SESSION_ID_RE.test(sessionId)) return null;
  return `\x15\x0b${RESUME_FN} ${sessionId}\r`;
}

export type ShellState = 'idle' | 'busy' | 'unknown';

/**
 * Whether the tab's shell is sitting at its prompt, and so can be typed into at all.
 *
 * A shell running something -- another claude in this same tab, a build, an editor -- has a
 * child process, and typing a command line into that child's stdin is not a resume: it is
 * keystrokes delivered to whatever is reading. So the state is checked and reported, never
 * assumed: `unknown` (no such pid, or a kernel without CONFIG_PROC_CHILDREN) is its own
 * answer and refuses too, rather than being folded into "idle" and typing blind.
 */
export function shellState(shellPid: number): ShellState {
  try {
    const kids = readFileSync(`/proc/${shellPid}/task/${shellPid}/children`, "utf-8").trim();
    return kids ? 'busy' : 'idle';
  } catch {
    return 'unknown';
  }
}
