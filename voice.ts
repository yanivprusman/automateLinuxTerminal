import { existsSync } from "fs";
import { execFile } from "child_process";

/** The claude-voice mute, as the menu's checkbox reads and writes it.
 *
 *  SCOPED TO ONE SESSION, like the two rows under it: the box silences the claude in THIS
 *  TAB, not the machine. It used to write `voice off --all`, the single global flag, so
 *  ticking it here went quiet on the dashboard, on the phone and in every other terminal at
 *  once — and nothing on the row said so. `--all` belongs to the phone's "Mute all" button,
 *  a deliberate surface of its own; a checkbox sitting directly above "this tab's captions"
 *  must mean the same "this" they do.
 *
 *  Read and write take different routes on purpose, same contract as the bookmark: the
 *  STATE is the flag file itself (`voice off --session <id>` is `: > muted.<id>`), so the
 *  checkbox is right even with the voice stack half-installed — but the WRITE goes through
 *  the `voice` CLI, because muting is more than the flag: it also cuts the line already on
 *  the speakers, and that behaviour lives in exactly one place so the caption button, the
 *  phone and this menu can never drift apart. */
const VOICE_DIR = "/root/.claude/voice";
const MUTE_FLAG_ALL = `${VOICE_DIR}/muted`;
const VOICE_CMD = "/root/bin/voice";

export function isVoiceMuted(sessionId: string): boolean {
  return existsSync(`${VOICE_DIR}/muted.${sessionId}`);
}

/** Whether EVERY session is muted (`voice off --all`, what the phone's "Mute all" writes).
 *  Not what this checkbox toggles — only what the row says beside it: a session with its own
 *  flag clear is still silent under a global mute, and an unticked box would be the only
 *  explanation on offer for a voice that never arrives. */
export function isVoiceMutedGlobally(): boolean {
  return existsSync(MUTE_FLAG_ALL);
}

/** The `voice` invocation for a scoped mute — split out so a test can pin the SCOPE without
 *  spawning anything. The scope is the whole of what made this row global, and `--all`
 *  creeping back in is invisible from here: it shows up as someone else's terminal going
 *  quiet, hours later, with nothing to connect it to.
 *
 *  `--session` is passed explicitly even though the CLI's default is "this session": that
 *  default resolves the CALLER's session id, and the caller is the terminal app itself, not
 *  the claude running inside the tab. */
export function voiceArgs(muted: boolean, sessionId: string): string[] {
  return [muted ? "off" : "on", "--session", sessionId];
}

/** Resolves once the CLI has done it; rejects with its refusal. No fallback to writing
 *  the flag ourselves — a missing `voice` means no claude-voice on this machine, and a
 *  checkbox that half-works there is worse than one that says so. */
export function setVoiceMuted(muted: boolean, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(VOICE_CMD, voiceArgs(muted, sessionId), (err, _out, stderr) => {
      if (!err) return resolve();
      const line = (stderr || err.message).split("\n").find(l => l.trim())?.trim();
      reject(new Error(line || "voice failed"));
    });
  });
}
