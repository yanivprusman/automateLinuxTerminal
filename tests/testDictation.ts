// The dialog's world exists, and is the same world the desktop's push-to-talk and the
// phone's popup live in.
//
// dictation.ts records with `talk`'s microphone and `talk`'s parecord flags, and reaches
// whisper and the spelling fixer through spokenView's `/transcribe` and `/fixspelling` --
// the phone's route. None of that is checked by a type: a mic renamed in `talk`, a route
// renamed in spokenView, a binary moved, and the dialog records silence or says "voice
// server unreachable" for a server that is right there. So this crosses the repo boundary
// on purpose, as testLaunch.ts and testResume.ts do for the shell functions they type.
//
//   npx tsx tests/testDictation.ts
import { readFileSync, accessSync, constants } from "fs";
import {
  DEFAULT_MIC, recordArgs, MAX_RECORD_SECS, MIN_AUDIO_BYTES, PARECORD, TIMEOUT, ENSURE_AUDIO, SAY_CTL, DAEMON,
  voiceServerPort,
} from "../dictation.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}
const read = (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return ""; } };

// 1. THE MICROPHONE IS `talk`'s.
const talk = read("/root/bin/talk");
check("talk is readable (claude-voice is installed)", talk.length > 0, true);
const talkMic = talk.match(/^MIC=\$\{TALK_MIC:-(.+?)\}/m)?.[1] ?? "<none>";
check("the dialog records from the mic talk records from", DEFAULT_MIC, talkMic);
check("the override is the same variable", /TALK_MIC/.test(talk), true);

// 2. THE SAME RECORDING.
const args = recordArgs("mic", "/x.wav").join(" ");
for (const flag of ["--file-format=wav", "--latency-msec=20", "--rate=16000", "--channels=1"]) {
  check(`talk records with ${flag}`, talk.includes(flag), true);
  check(`so does the dialog`, args.includes(flag), true);
}
check("the backstop is talk's", String(MAX_RECORD_SECS), talk.match(/MAX_SECS=\$\{TALK_MAX_SECS:-(\d+)\}/)?.[1] ?? "<none>");
check("'too short' is talk's", String(MIN_AUDIO_BYTES), talk.match(/-lt (\d+) \]/)?.[1] ?? "<none>");

// 3. THE ROUTES ARE THE PHONE'S.
const server = read("/opt/dev/spokenView/server.py");
check("spokenView is readable", server.length > 0, true);
check("spokenView serves /transcribe", server.includes('self.path == "/transcribe"'), true);
check("spokenView serves /fixspelling", server.includes('self.path == "/fixspelling"'), true);
check("/transcribe answers 503 for a dead whisperd (the dialog names it)", /503, b"transcription service unavailable"/.test(server), true);
check("/fixspelling answers refusals in plain text (the dialog shows them)", /502, msg\.encode\(\)/.test(server), true);

// 4. THE PROGRAMS ARE WHERE THE DIALOG RUNS THEM.
for (const [name, path] of [["parecord", PARECORD], ["timeout", TIMEOUT], ["ensure-audio", ENSURE_AUDIO], ["say-ctl", SAY_CTL], ["daemon", DAEMON]] as const) {
  let runnable = false;
  try { accessSync(path, constants.X_OK); runnable = true; } catch {}
  check(`${name} is executable at ${path}`, runnable, true);
}

// 5. THE VOICE SERVER IS FOUND WHERE `say` FINDS IT, AND ANSWERS.
const port = await voiceServerPort();
check("a port is resolved", Number.isInteger(port) && port > 0, true);
let status = 0;
try {
  const res = await fetch(`http://127.0.0.1:${port}/recent?limit=1`, { signal: AbortSignal.timeout(3000) });
  status = res.status;
} catch {}
check(`spokenView answers on ${port}`, status, 200);

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
