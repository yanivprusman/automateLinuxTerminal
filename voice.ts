import { existsSync } from "fs";
import { execFile } from "child_process";

/** The claude-voice global mute, as the menu's checkbox reads and writes it.
 *
 *  Read and write take different routes on purpose, same contract as the bookmark:
 *  the STATE is the flag file itself (`voice off --all` is `: > muted`), so the checkbox
 *  is right even with the voice stack half-installed — but the WRITE goes through the
 *  `voice` CLI, because muting is more than the flag: it also cuts the line already on
 *  the speakers, and that behaviour lives in exactly one place so the caption button,
 *  the phone and this menu can never drift apart. */
const MUTE_FLAG = "/root/.claude/voice/muted";
const VOICE_CMD = "/root/bin/voice";

export function isVoiceMuted(): boolean {
  return existsSync(MUTE_FLAG);
}

/** Resolves once the CLI has done it; rejects with its refusal. No fallback to writing
 *  the flag ourselves — a missing `voice` means no claude-voice on this machine, and a
 *  checkbox that half-works there is worse than one that says so. */
export function setVoiceMuted(muted: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(VOICE_CMD, [muted ? "off" : "on", "--all"], (err, _out, stderr) => {
      if (!err) return resolve();
      const line = (stderr || err.message).split("\n").find(l => l.trim())?.trim();
      reject(new Error(line || "voice failed"));
    });
  });
}
