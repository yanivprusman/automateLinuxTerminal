// Starting a claude from the menu types a command into the tab's own shell — the second row
// in this menu that puts characters where the user's keyboard puts them (the resume row is
// the first), and the only one that starts an agent which will not ask before it acts. So
// both halves of it are pinned here:
//
//   - WHAT is typed: a command that exists in the shell it lands in, with the flag the row
//     names, and a cleared line in front of it so it cannot be glued onto something
//     half-written.
//   - WHETHER it may be typed at all: a shell running something is reading its stdin for
//     that program. `unknown` refuses too; it is not "probably fine".
//
//   npx tsx tests/testLaunch.ts
import { execFileSync } from "child_process";
import { LAUNCH_FN, LAUNCH_FLAG, LAUNCH_CMD, LAUNCH_KEYS, launchRefusal } from "../launch.js";
import { CLEAR_LINE } from "../exit.js";
import { LAUNCH_LABEL, launchLabel, SESSION_MENU_INNER } from "../menu.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

// 1. WHAT GETS TYPED.
//
// The line is cleared first, for the reason the resume clears it: the prompt may hold
// something half-typed, and appending to it would run neither what was typed nor what was
// clicked. Both kills go to readline's kill ring, so the abandoned line is one Ctrl+Y away.
check("clears the line, runs the launch, presses enter",
      LAUNCH_KEYS, `${CLEAR_LINE}${LAUNCH_CMD}\r`);
check("ends with a carriage return", LAUNCH_KEYS.endsWith("\r"), true);
check("is the flag the row is for", LAUNCH_CMD, `${LAUNCH_FN} ${LAUNCH_FLAG}`);
check("the flag is the dangerous one, spelled in full", LAUNCH_FLAG, "--dangerously-skip-permissions");

// Nothing from disk, a hook, or a session reaches this line — every character of it is
// written in launch.ts — so there is nothing here to quote or refuse. That is the property
// worth pinning: a launch line that ever grew an interpolated argument would need the
// resume's whole validation story, and this check is where that would be noticed.
check("no shell metacharacters in what is typed", /[;&|`$<>(){}\[\]'"\\*?~\n]/.test(LAUNCH_CMD), false);

// 2. THE ROW SAYS WHAT IT STARTS.
//
// A click that starts an agent which will not ask before it acts has to say so on the row.
// "start claude" alone would be true and misleading.
check("the row names the permission skip", /skip permissions/.test(LAUNCH_LABEL), true);
check("the label fits the menu", launchLabel().length <= SESSION_MENU_INNER, true);

// 3. THE COMMAND EXISTS WHERE IT IS TYPED.
//
// `cl` is a shell function from automateLinux's terminal environment, and the app types into
// a login shell that sources it. A rename there would leave this row typing "command not
// found" at the user's prompt — nothing in this repo would notice, so the check crosses the
// boundary on purpose, exactly as testResume.ts does for `claudeResumeById`.
let fnKind = "";
try {
  fnKind = execFileSync("bash", ["-lic", `type -t ${LAUNCH_FN}`],
                        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
} catch { fnKind = "<not found>"; }
check(`${LAUNCH_FN} is defined in a login shell`, fnKind, "function");

// ...and it takes the flag rather than swallowing it. `cl` forwards "$@" to claude, and a
// wrapper that ever stopped doing so would turn this row into a plain launch with no sign on
// screen that the flag went nowhere.
let body = "";
try {
  body = execFileSync("bash", ["-lic", `declare -f ${LAUNCH_FN}`],
                      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
} catch { body = ""; }
check(`${LAUNCH_FN} forwards its arguments`, /"\$@"/.test(body), true);

// 4. WHETHER THE SHELL MAY BE TYPED INTO.
//
// Same three answers as the resume row, with the busy one split by what is busy: "start
// claude here" has an exact answer when the thing in the way is a claude, and a generic
// "busy" would send the user hunting for a build that isn't running.
check("an idle shell takes the launch", launchRefusal('idle', () => false), null);
check("a shell running a claude says so", launchRefusal('busy', () => true), "claude already running here");
check("a shell running anything else says that", launchRefusal('busy', () => false), "shell is busy here");
check("an unreadable shell refuses", launchRefusal('unknown', () => false), "cannot read shell state");
check("an unreadable shell refuses even with a claude in it", launchRefusal('unknown', () => true), "cannot read shell state");

// An idle shell is running nothing, so asking /proc WHAT it is running is a question with a
// known answer — paid for on every click, and on the commonest path of all.
let asked = false;
launchRefusal('idle', () => { asked = true; return false; });
check("an idle shell is not asked what it is running", asked, false);

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
