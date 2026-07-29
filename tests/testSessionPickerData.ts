// Sanity test for the by-topic session index behind sessionPicker.tsx.
// Asserts the three things the picker cannot work without: topics come out of
// the dashboard's durable store, every listed session has a resolvable working
// directory, and the list is newest-first.
//
//   npx tsx tests/testSessionPickerData.ts
import { loadTopicSessions } from "../sessionPickerData.js";

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

console.log(`newest: "${sessions[0]!.topic}" in ${sessions[0]!.cwd}`);
console.log("PASS");
