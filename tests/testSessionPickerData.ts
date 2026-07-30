// Sanity test for the by-topic session index behind sessionPicker.tsx.
// Asserts the things the picker cannot work without: topics come out of the
// dashboard's durable store, every listed session has a resolvable working
// directory, the list is newest-first, and a row can produce a digest (what
// the `→` key shows and speaks).
//
//   npx tsx tests/testSessionPickerData.ts
import { loadTopicSessions, readSessionDigest } from "../sessionPickerData.js";

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

console.log(`newest: "${newest.topic}" in ${newest.cwd}`);
console.log(`digest: ${digest.userTurns} user turns, starts "${digest.first.replace(/\s+/g, " ").slice(0, 60)}…"`);
console.log("PASS");
