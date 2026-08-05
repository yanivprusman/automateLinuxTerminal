// A session running in a tab the user opened BY HAND must be visible to the
// dashboard, the phone and the session picker.
//
// The regression this pins: the metadata file — the dashboard's only way to
// discover a session it did not launch itself (`lib/terminal-metadata.ts`
// scans /tmp for exactly these files) — was keyed on the launcher env, which is
// deliberately empty unless a managed launch set CLAUDE_TMUX_SESSION beside
// CLAUDE_SESSION_ID. So a tab opened by hand and given a `cl` published a topic
// and a window claim but never the one file that says "a session lives here",
// and the session simply did not exist for anything outside that window. Found
// 2026-08-05 with a live "diy-cad" session running for an hour and a half in a
// dashboard that listed one session, not two.
//
//   npx tsx tests/testSessionMetadata.ts
import { existsSync, readFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";

// session.ts reads the launcher env ONCE, at import. Run from inside a managed
// session (a Claude tab — where else would you run it?) it would inherit that
// session's CLAUDE_SESSION_ID and publish metadata for the REAL session running
// this test, then unlink it on the first re-key below. It did exactly that the
// first time. So the env is stripped BEFORE the module is evaluated, which a
// dynamic import is the only way to order.
for (const k of ["CLAUDE_SESSION_ID", "CLAUDE_TMUX_SESSION", "CLAUDE_LAUNCH_DIR",
                 "CLAUDE_APP_NAME", "CLAUDE_SCRIPT_LOG_FILE", "TMUX"]) {
  delete process.env[k];
}
const {
  SESSION_ID, noteLiveSessionId, currentSessionId, currentMetadataFile,
  publishSessionMetadata, writeTopic, cleanupMetadata, scriptLogOf,
} = await import("../session.js");

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const fileFor = (id: string) => `/tmp/automateLinuxTerminal-${id}.json`;
const SHELL_PID = process.pid;   // a pid that is certainly alive: our own
let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

function readMeta(id: string): Record<string, any> {
  try { return JSON.parse(readFileSync(fileFor(id), "utf-8")); } catch { return {}; }
}

// No claudePid is passed anywhere below, so no script log is discovered and
// registerWithDashboard declines — this test never writes to the real registry.

// This test must run the way a real tab does: no launcher env.
check("precondition: SESSION_ID empty, as in a manually-opened tab", SESSION_ID, "");

// 1. An idle tab publishes nothing. A file naming no session, or naming one that
//    isn't running here, is worse than none: readers only check that the HOST is
//    alive, so it would list a session that does not exist.
publishSessionMetadata(SHELL_PID);
check("no claude running -> no metadata file", currentMetadataFile(), "");

// 2. THE REGRESSION. A live claude is published even with no launcher env.
noteLiveSessionId(A);
check("live claude id identifies the tab", currentSessionId(), A);
publishSessionMetadata(SHELL_PID);
check("hand-opened tab publishes metadata", currentMetadataFile(), fileFor(A));
check("file exists on disk", existsSync(fileFor(A)), true);
check("keyed on the live session", readMeta(A).claudeSessionId, A);
check("carries the host pid readers check for liveness", readMeta(A).pid, process.pid);
check("carries the shell pid the dashboard shows", readMeta(A).shellPid, SHELL_PID);
// tmuxSession is read by the dashboard as a LIVE tmux target and it DELETES
// metadata whose session doesn't exist. A tab not inside tmux must claim none.
check("no tmux target claimed outside tmux", readMeta(A).tmuxSession, "");
// An empty appName leaves the card labelled with nothing; the tab's directory is
// what the managed launches name their app after.
check("app name derived from the launch dir", readMeta(A).appName, process.cwd().split("/").pop());

const startedAt = readMeta(A).startedAt;

// 3. A topic set in the tab reaches the file, and survives the re-key below.
writeTopic("diy-cad");
check("topic written into the metadata", readMeta(A).topic, "diy-cad");

// 4. Publishing again with nothing changed must not churn the file.
publishSessionMetadata(SHELL_PID);
check("re-publish is a no-op (topic not clobbered)", readMeta(A).topic, "diy-cad");

// 5. A /resume mints a new id. The file moves to it — leaving the old one behind
//    would keep a session that ended listed as live, since the host is still up.
noteLiveSessionId(B);
publishSessionMetadata(SHELL_PID);
check("re-keys to the resumed session", currentMetadataFile(), fileFor(B));
check("the old file is gone", existsSync(fileFor(A)), false);
check("the topic follows the session", readMeta(B).topic, "diy-cad");
// The card sorts on this and shows "running for"; a resume must not reset it.
check("host start time is not restated on re-key", readMeta(B).startedAt, startedAt);

// 6. Exit removes it, so a dead host publishes nothing.
cleanupMetadata();
check("cleanup removes the metadata file", existsSync(fileFor(B)), false);

// 7. End-to-end against the real process table: the script log a hand-opened
//    tab's `cl` created is named after ITS launch key, so the only place the
//    host can learn the path is claude's own ancestry. Without it the card has
//    no terminal preview and the register endpoint refuses the session.
const claudePids = (() => {
  try {
    return execFileSync("pgrep", ["-x", "claude"], { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean).map(Number);
  } catch { return [] as number[]; }
})();
const wrapped = claudePids.map(pid => ({ pid, log: scriptLogOf(pid) })).filter(x => x.log);
if (!wrapped.length) {
  console.log("SKIP — no claude running under a `script -qf` wrapper to walk");
} else {
  for (const { pid, log } of wrapped) {
    check(`script log found for the live claude ${pid}, and it exists`, existsSync(log), true);
  }
}

for (const id of [A, B]) { try { unlinkSync(fileFor(id)); } catch {} }
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
