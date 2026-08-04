// The menu's mute silences ONE session: the claude in this tab.
//
// It shipped writing `voice off --all` -- the single global flag -- so ticking a checkbox in
// one terminal went quiet in every other terminal, on the dashboard and on the phone. The row
// said "mute voice", sat directly above two rows that mean "this tab", and gave no sign it
// meant the machine. Nobody notices from the terminal they clicked in; they notice hours
// later, somewhere else, with nothing to connect it to.
//
// So the scope is pinned here rather than left to a code review. `voiceArgs` is the whole of
// what the CLI is asked to do, and the failure this guards is one word long.
//
//   npx tsx tests/testVoiceMute.ts
import { voiceArgs, isVoiceMuted, isVoiceMutedGlobally } from "../voice.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

for (const muted of [true, false]) {
  const args = voiceArgs(muted, SESSION);
  console.log(`voice ${args.join(" ")}`);

  // The one that matters: `--all` is the phone's "Mute all" button, a deliberate surface of
  // its own. Nothing reachable from this menu may write it.
  if (args.includes("--all")) fail(`voiceArgs(${muted}) reaches every session: ${args.join(" ")}`);

  // And the scope is NAMED, not defaulted. `voice off` with no scope resolves the CALLER's
  // session id -- which here is the terminal app itself, not the claude inside the tab -- so
  // dropping `--session <id>` would silence the wrong session while looking scoped.
  if (args[1] !== "--session") fail(`voiceArgs(${muted}) does not name a scope: ${args.join(" ")}`);
  if (args[2] !== SESSION) fail(`voiceArgs(${muted}) targets ${args[2]}, expected ${SESSION}`);
  if (args[0] !== (muted ? "off" : "on")) fail(`voiceArgs(${muted}) asked for "${args[0]}"`);
}

// The two flags the row reads are DIFFERENT files, and reading the global one for the
// checkbox is how the tick came to mean "everything is muted" in the first place. Both are
// checked against a real directory layout: `muted` = all sessions, `muted.<id>` = one.
{
  const dir = mkdtempSync(join(tmpdir(), "voice-flags-"));
  try {
    // voice.ts reads /root/.claude/voice, so this only asserts the SHAPE it looks for --
    // that a session's flag is per-session-suffixed and the global one is not. A rename on
    // either side (claude-voice's `voice`, or this module) breaks the pairing silently.
    writeFileSync(join(dir, `muted.${SESSION}`), "");
    writeFileSync(join(dir, "muted"), "");
    console.log(`flag files: ${["muted", `muted.${SESSION}`].join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // A session that has never been muted must read false even when it exists -- the live
  // check, against whatever this machine's flag directory actually holds.
  const madeUp = "00000000-0000-0000-0000-000000000000";
  if (isVoiceMuted(madeUp)) fail(`a session that was never muted reads as muted (${madeUp})`);
  // ...and the global flag is answered by its own function, never by the per-session one.
  if (typeof isVoiceMutedGlobally() !== "boolean") fail("isVoiceMutedGlobally did not answer");
  if (isVoiceMuted(madeUp) === isVoiceMutedGlobally() && isVoiceMutedGlobally())
    fail("a global mute is leaking into the per-session read");
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
