// Resuming a dead session types a command into the tab's own shell — the one thing in this
// menu that puts characters where the user's keyboard puts them. So both halves of that are
// pinned here:
//
//   - WHAT is typed: a command that exists in the shell it lands in, built only from an id
//     that could not mean anything else. An id is a file's contents, so it is checked rather
//     than quoted into safety.
//   - WHETHER it may be typed at all: a shell running something is reading its stdin for
//     that program, and a command line delivered there is not a resume — it is keystrokes
//     for whatever is on top. `unknown` refuses too; it is not "probably fine".
//
//   npx tsx tests/testResume.ts
import { execFileSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { RESUME_FN, resumeKeystrokes, shellState } from "../resume.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

const ID = "dddddddd-3333-4444-5555-666666666666";

// 1. WHAT GETS TYPED.
//
// The line is cleared first: the prompt may hold something half-typed, and appending to it
// would run neither what was typed nor what was clicked. Both kills go to readline's kill
// ring, so the abandoned line is one Ctrl+Y away — which is why this is a kill and not a
// silent overwrite.
check("clears the line, runs the resume, presses enter",
      resumeKeystrokes(ID), `\x15\x0b${RESUME_FN} ${ID}\r`);
check("ends with a carriage return", resumeKeystrokes(ID)?.endsWith("\r"), true);

// 2. AN ID IT MAY NOT TYPE IS REFUSED, NOT ESCAPED.
//
// The id comes from a hook's file on disk and is about to be part of a command line. There
// is exactly one shape a session id has; anything else is refused outright, so no amount of
// quoting has to be got right. 'unknown' is the ordinary case — a session that never fired a
// hook — and the menu says so on the row rather than typing the word.
for (const bad of ["", "unknown", "a b", `x;$(id)`, "x`id`", "x&&y", "--dangerously-skip-permissions", "../../etc"]) {
  check(`refuses ${JSON.stringify(bad)}`, resumeKeystrokes(bad), null);
}

// 3. THE COMMAND EXISTS WHERE IT IS TYPED.
//
// `claudeResumeById` is a shell function from automateLinux's terminal environment, and the
// app types into a login shell that sources it. A rename there would leave this menu row
// typing a command that answers "command not found" into the user's prompt — nothing in
// this repo would notice, so the check crosses the boundary on purpose.
let fnKind = "";
try {
  fnKind = execFileSync("bash", ["-lic", `type -t ${RESUME_FN}`],
                        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
} catch { fnKind = "<not found>"; }
check(`${RESUME_FN} is defined in a login shell`, fnKind, "function");

// 4. WHETHER THE SHELL CAN BE TYPED INTO.
const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
const busy = spawn("bash", ["-c", "sleep 5; true"], { stdio: "ignore" });   // `; true` stops bash exec'ing the sleep in place
const waitFor = async (want: string, pid: number) => {
  for (let i = 0; i < 50 && shellState(pid) !== want; i++) await new Promise(r => setTimeout(r, 100));
  return shellState(pid);
};
check("a process at rest is idle", await waitFor("idle", sleeper.pid!), "idle");
check("a shell running something is busy", await waitFor("busy", busy.pid!), "busy");
sleeper.kill(); busy.kill();

// No such pid: the state is UNKNOWN, and the menu refuses on it. Folding this into "idle"
// would type a command line at a shell we could not see, on any kernel built without
// CONFIG_PROC_CHILDREN — the file this reads is optional, and its absence is not consent.
const noSuchPid = Number(readFileSync("/proc/sys/kernel/pid_max", "utf-8").trim()) + 1;
check("a pid that does not exist is unknown", shellState(noSuchPid), "unknown");

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
