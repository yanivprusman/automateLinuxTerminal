// The tab must report the Claude session it is HOSTING, never one that session
// started underneath itself.
//
// The regression this pins (2026-08-08): detectClaudeSession walked up to ten
// parents looking for our shell and returned the FIRST `claude` that matched.
// A headless `claude -p` launched from inside the session — the session namer,
// an improver, any script that shells out to Claude — is also a descendant of
// our shell, just deeper. `pgrep` lists by ascending pid, so whichever started
// first won, and a nested run that starts first wins outright.
//
// The cost was a duplicate: the tab filed the throwaway run under its own
// dashboard key, the dashboard had no row carrying that brand-new claude id to
// dedup against, and it created a SECOND row — the same session twice on the
// phone, one card wearing an id that existed for two seconds and a pid that
// would never die, so nothing ever pruned it.
//
// The fix is depth: anything spawned from within the session is strictly below
// the session's own claude, which the shell started itself. So the shallowest
// wins. This test builds that exact tree with the nested claude started FIRST,
// so it fails against the old "first match" implementation.
//
//   npx tsx tests/testDetectClaudeDepth.ts
import { spawn } from "child_process";
import { mkdtempSync, symlinkSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { detectClaudeSession } = await import("../session.js");

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Parent pid of `pid`, or 0. Same field 4 read session.ts uses. */
function ppidOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return parseInt(stat.split(") ")[1]?.split(" ")[1] || "0", 10);
  } catch { return 0; }
}

// A process named `claude` that does nothing: pgrep -x matches on comm, which
// comes from the name it was exec'd under, so a symlink is enough. Nothing here
// runs Claude — this test is about process topology, not about Claude at all.
//
// The symlink points at bash, NOT at sleep: /bin/sleep here is a symlink into a
// coreutils MULTI-CALL binary, which dispatches on argv[0] and exits with
// "unknown program 'claude'" the moment you invoke it under another name. The
// `& wait` inside keeps bash from exec'ing sleep over itself, which would put
// `sleep` in comm and hide the process from pgrep.
const dir = mkdtempSync(join(tmpdir(), "detect-claude-depth-"));
symlinkSync("/bin/bash", join(dir, "claude"));
const CLAUDE = join(dir, "claude");
/** Keep bash-as-claude alive without exec'ing anything over itself. */
const IDLE = `-c "sleep 60 & wait"`;

// The tab's shell, with two claudes under it:
//   nested FIRST  — claude <- sh <- shell   (depth 1) : the `claude -p` a tool ran
//   direct SECOND — claude <- shell         (depth 0) : the session itself
// Starting the nested one first gives it the lower pid, so `pgrep` lists it
// first and the old implementation returns it. `& wait` keeps the inner sh alive
// as a real parent — bash exec's a lone simple command and would collapse the
// level we are trying to build.
// The inner layer takes the path as $1 so its script can be single-quoted while
// IDLE keeps its double quotes — nesting the same quote character silently
// produced a tree with no nested claude in it at all, and preconditions that
// pass vacuously are worse than no test.
const shell = spawn("bash", ["-c",
  `sh -c '"$1" ${IDLE} & wait' sh "${CLAUDE}" & sleep 0.4; "${CLAUDE}" ${IDLE} & wait`,
], { stdio: "ignore" });
const shellPid = shell.pid!;

try {
  await sleep(1500);

  // Work out which pid is which from /proc rather than trusting spawn order.
  const { execFileSync } = await import("child_process");
  const all = execFileSync("pgrep", ["-x", "claude"], { encoding: "utf-8" })
    .trim().split("\n").filter(Boolean).map(Number);
  const mine = all.filter(p => {
    let cur = p;
    for (let i = 0; i < 10; i++) {
      const pp = ppidOf(cur);
      if (pp === shellPid) return true;
      if (pp <= 1) return false;
      cur = pp;
    }
    return false;
  });
  const direct = mine.filter(p => ppidOf(p) === shellPid);
  const nested = mine.filter(p => ppidOf(p) !== shellPid);

  check("precondition: the tree has one direct claude", direct.length, 1);
  check("precondition: the tree has one nested claude", nested.length, 1);
  // If this fails the test proves nothing: the old code would have picked the
  // direct one by luck rather than by rule.
  check("precondition: the nested claude sorts first (lower pid)",
        nested[0] !== undefined && direct[0] !== undefined && nested[0] < direct[0], true);

  // THE REGRESSION.
  const info = detectClaudeSession(shellPid);
  check("picks the session's own claude, not the one it spawned", info?.pid, direct[0]);

  // A shell with no claude under it must resolve nothing rather than adopt
  // another tab's. Probed with a pid that cannot exist — NOT with 1, which is an
  // ancestor of every orphaned process and so matches the walk by construction.
  const maxPid = Number(readFileSync("/proc/sys/kernel/pid_max", "utf-8").trim());
  check("a shell with no claude under it resolves nothing",
        detectClaudeSession(maxPid + 1), null);
} finally {
  try { process.kill(-shellPid, "SIGKILL"); } catch {}
  try { shell.kill("SIGKILL"); } catch {}
  // The inner `sh` and the two sleeps are not in our process group when bash
  // did not create one, so sweep by name under this temp dir to be sure.
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("pkill", ["-f", CLAUDE], { stdio: "ignore" });
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
