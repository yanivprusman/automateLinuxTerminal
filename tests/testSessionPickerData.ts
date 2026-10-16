// Sanity test for the by-topic session index behind sessionPicker.tsx.
// Asserts the things the picker cannot work without: topics come out of the
// dashboard's durable store, every listed session has a resolvable working
// directory, the list is newest-first, and a row can produce a digest (what
// the `→` key shows and speaks).
//
//   npx tsx tests/testSessionPickerData.ts
import {
  inheritForkTopics,
  loadAllSessions,
  loadTopicSessions,
  readSessionDigest,
  readSpokenLines,
  type TopicSession,
} from "../sessionPickerData.js";

// A fork is a copy of a transcript under a new id, so it has no stored topic and
// used to be missing from the picker — the one place you go to resume it. These
// pin the rules it inherits its original's topic by; they need no real data.
{
  const row = (sessionId: string, topic: string, rootUuid: string, bornMs: number): TopicSession =>
    ({ sessionId, topic, rootUuid, bornMs, cwd: "/x", mtimeMs: bornMs, file: "" });
  const topicOf = (rows: TopicSession[], id: string) => rows.find((r) => r.sessionId === id)!.topic;
  const fail = (why: string) => {
    console.error(`FAIL (forks): ${why}`);
    process.exit(1);
  };

  const r = inheritForkTopics([
    row("orig", "התראה דודו בסיס conc", "root-a", 1),
    row("fork", "", "root-a", 2),
    row("fork2", "", "root-a", 3),
    row("named", "my own name", "root-a", 4),
    row("loner", "", "root-b", 5),
    row("noroot", "", "", 6),
  ]);
  if (topicOf(r, "fork") !== "התראה דודו בסיס ⑂") fail(`fork got "${topicOf(r, "fork")}" — want the original's topic, conc dropped, marked`);
  if (topicOf(r, "fork2") !== "התראה דודו בסיס ⑂") fail("a second fork must point at the same original");
  if (topicOf(r, "named") !== "my own name") fail("a fork's own stored topic must win over the inherited one");
  if (topicOf(r, "orig") !== "התראה דודו בסיס conc") fail("the original's topic must be left as stored");
  if (topicOf(r, "loner") !== "") fail("a session sharing no root with a titled one must stay untitled");
  if (topicOf(r, "noroot") !== "") fail("an empty root must never match another empty root");

  // The older transcript is the original, whichever one the scan meets first.
  const order = inheritForkTopics([
    row("later", "named later", "root-c", 9),
    row("earlier", "named first", "root-c", 1),
    row("fork", "", "root-c", 10),
  ]);
  if (topicOf(order, "fork") !== "named first ⑂") fail(`fork inherited "${topicOf(order, "fork")}" — want the oldest titled session's`);

  // Real transcripts: the root has to be readable, or nothing above ever applies.
  const recent = loadAllSessions(Date.now() - 7 * 24 * 3600 * 1000);
  const rooted = recent.filter((s) => s.rootUuid).length;
  if (recent.length > 0 && rooted === 0) fail(`none of ${recent.length} recent transcripts yielded a root uuid — the transcript format changed`);
  console.log(`forks: rules hold; ${rooted}/${recent.length} recent transcripts carry a root uuid`);
}

const { sessions, unavailable } = loadTopicSessions();

console.log(`sessions with a topic and a transcript here: ${sessions.length}`);
console.log(`topics whose transcript is not on this machine: ${unavailable}`);

if (sessions.length === 0) {
  console.log("SKIP: no topics stored yet — set one from the session menu and re-run");
  process.exit(0);
}

const noCwd = sessions.filter((s) => !s.cwd);
if (noCwd.length > 0) {
  // Not fatal for the picker (it refuses those rows) but it means transcripts
  // stopped carrying "cwd", which would eventually empty the list.
  console.error(`FAIL: ${noCwd.length} session(s) have no cwd, e.g. ${noCwd[0]!.sessionId}`);
  process.exit(1);
}

const unsorted = sessions.findIndex((s, i) => i > 0 && sessions[i - 1]!.mtimeMs < s.mtimeMs);
if (unsorted !== -1) {
  console.error(`FAIL: not newest-first at index ${unsorted}`);
  process.exit(1);
}

const empty = sessions.find((s) => !s.topic.trim());
if (empty) {
  console.error(`FAIL: empty topic on ${empty.sessionId}`);
  process.exit(1);
}

const noFile = sessions.filter((s) => !s.file);
if (noFile.length > 0) {
  console.error(`FAIL: ${noFile.length} session(s) carry no transcript path — → cannot open a digest`);
  process.exit(1);
}

// The sample is the prompt `e` sends to claude. Empty means the user-message
// filter stopped matching the transcript format, and every summary would be
// generated from nothing.
const newest = sessions[0]!;
const digest = readSessionDigest(newest.file);
if (!digest.userTurns || !digest.first || !digest.sample.length) {
  console.error(`FAIL: no user messages parsed from ${newest.sessionId}'s transcript`);
  process.exit(1);
}

// The caps are what keep a 70MB session's prompt the same size as a small one.
if (digest.sample.length > 60 || digest.sample.some((t) => t.length > 400)) {
  console.error(`FAIL: sample exceeds its caps (${digest.sample.length} turns) — prompt size is unbounded`);
  process.exit(1);
}

// Captions are the only source carrying outcomes rather than requests, so a
// silent join (schema drift in the voice log, a changed session key) would
// quietly return summaries to the request-only quality the user rejected.
const spokenCounts = sessions.slice(0, 20).map((s) => readSpokenLines(s.sessionId).length);
const withSpoken = spokenCounts.filter((n) => n > 0).length;
if (withSpoken === 0) {
  console.error("FAIL: not one of the 20 newest sessions joined to a caption — the voice-log join is broken");
  process.exit(1);
}
if (spokenCounts.some((n) => n > 40)) {
  console.error("FAIL: caption sample exceeds its cap — prompt size is unbounded");
  process.exit(1);
}

console.log(`captions: ${withSpoken}/20 newest sessions have spoken lines`);
console.log(`newest: "${newest.topic}" in ${newest.cwd}`);
console.log(`digest: ${digest.userTurns} user turns, starts "${digest.first.replace(/\s+/g, " ").slice(0, 60)}…"`);
console.log("PASS");
