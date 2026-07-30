// The topic bar must show a topic set from OUTSIDE the tab — the set-topic
// skill, the dashboard card, the phone.
//
// The regression this pins: the write path resolved the live claude session id
// while the read path used the launcher's env id, so the tab filed its topic
// under one key and looked for it under another. And since that env id is
// deliberately empty unless a managed launch set CLAUDE_TMUX_SESSION beside it —
// which no ordinary `terminal` tab has — the read path was dead code in every
// real tab. `/conclude-issues-and-close-session-skill` wrote "integ conc" into
// the store, every other reader showed it, and the bar above kept saying "integ".
//
//   npx tsx tests/testTopicSync.ts
import { readFileSync } from "fs";
import { SESSION_ID, DASHBOARD_PORT, noteLiveSessionId, currentSessionId, readStoredTopic } from "../session.js";

const META = "/opt/automateLinux/data/dashboard/claude-session-meta.json";
let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

// This test must run the way a real tab does: no launcher env.
check("precondition: SESSION_ID empty, as in a manually-opened tab", SESSION_ID, "");

// 1. An idle tab resolves nothing. It must NOT fall through to some other
//    session's id and adopt a topic that isn't its own.
noteLiveSessionId(undefined);
check("no claude running -> no session id", currentSessionId(), "");

// 2. THE REGRESSION. A live claude identifies the tab even with no launcher env.
const FAKE = "11111111-2222-3333-4444-555555555555";
noteLiveSessionId(FAKE);
check("live claude id wins over an empty SESSION_ID", currentSessionId(), FAKE);

// 3. detectClaudeSession says 'unknown' when no hook has published an id for the
//    process yet (the first second of a session, or hooks disabled).
//    Filing a topic under the literal string "unknown" would pool every such
//    tab's topic into one shared bucket.
noteLiveSessionId("unknown");
check("'unknown' is not an id", currentSessionId(), "");

// 4. A session nobody has titled answers 200 with customTitle:null. That is "no
//    answer", not "the topic is empty" — collapsing them lets the first poll
//    wipe a topic the user typed into this tab.
noteLiveSessionId(FAKE);
check("untitled session reads as null, never ''", await readStoredTopic(), null);

// 5. End-to-end against the real dashboard: whatever the durable store holds for
//    a live session is what the read path returns for it.
const running: { claudeSessionId?: string }[] = await fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions`)
  .then(r => r.json())
  .catch(() => []);
const meta = JSON.parse(readFileSync(META, "utf-8")) as Record<string, { customTitle?: string }>;
const titled = running.find(s => s.claudeSessionId && typeof meta[s.claudeSessionId]?.customTitle === "string");

if (!titled?.claudeSessionId) {
  console.log("SKIP — no running session with a stored topic to read back");
} else {
  noteLiveSessionId(titled.claudeSessionId);
  check(
    `reads back the stored topic for a live session (${titled.claudeSessionId.slice(0, 8)})`,
    await readStoredTopic(),
    meta[titled.claudeSessionId].customTitle,
  );
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
