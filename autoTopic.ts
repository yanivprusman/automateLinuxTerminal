/**
 * Name the sessions nobody named.
 *
 * A session without a topic is unfindable: the resume picker lists topics, the
 * dashboard and phone cards show a blank line, and `d`-adjacent tooling has
 * nothing to call it. Topics were manual, so most sessions never got one.
 *
 * This runs OUTSIDE the sessions, on a timer. A session cannot be relied on to
 * title itself — the ones most likely to stay untitled are exactly the ones
 * nobody is asking anything of. It reads what a session was about (the same
 * digest the picker's `e` key summarizes: the user's own turns, plus the spoken
 * caption log when there is one), asks a small model for two to four words, and
 * writes it to the durable store keyed by the claude session id.
 *
 * What it will never do is overwrite a topic a human set. It keeps a ledger of
 * the topics it wrote; a stored topic that does not match its ledger entry was
 * set by hand, and is left alone forever. Its own topics it will refresh once a
 * session has grown well past what it saw — a session named after its first ten
 * turns is misnamed by turn two hundred.
 *
 *   tsx autoTopic.ts                  # title every untitled recent session
 *   tsx autoTopic.ts --dry-run        # print what it would set, write nothing
 *   tsx autoTopic.ts --session <id>   # one session, ignoring the age cutoff
 *   tsx autoTopic.ts --force          # re-title even a topic it did not write
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  loadAllSessions,
  readTopics,
  readSessionDigest,
  readSpokenLines,
  type TopicSession,
  type SessionDigest,
  type SpokenLine,
} from "./sessionPickerData.js";

/** Not on a systemd unit's PATH — `~/.local/bin` is a login-shell thing. */
const CLAUDE = "/root/.local/bin/claude";
/** Naming three words is not a job for a large model. */
const MODEL = "haiku";
/** Topics this job wrote, so a hand-set topic can be told from one of ours. */
const LEDGER = "/opt/automateLinux/data/dashboard/auto-topics.json";
const DASHBOARD_PORT = process.env.CLAUDE_DASHBOARD_PORT || "3007";

/** Below this, there is nothing to name yet — "hi" and a stray question. */
const MIN_TURNS = 3;
/** Dead sessions do not need names. Two days covers anything still in play. */
const MAX_AGE_DAYS = 2;
/** A slow scan competing with live work is worse than a scan that finishes later. */
const MAX_PER_RUN = 8;
/** Re-title one of ours once the session has grown this many times over. */
const REFRESH_FACTOR = 3;
const NAMING_TIMEOUT_MS = 90_000;
/** A topic has to fit a phone card at a glance. */
const MAX_TOPIC_CHARS = 40;
const MAX_TOPIC_WORDS = 6;

interface LedgerEntry {
  /** Exactly what we wrote — a stored topic differing from this was set by hand. */
  topic: string;
  /** Turn count the name was derived from, for the refresh test. */
  userTurns: number;
}

function readLedger(): Record<string, LedgerEntry> {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")) as Record<string, LedgerEntry>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {};
  }
}

function writeLedger(ledger: Record<string, LedgerEntry>): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const tmp = `${LEDGER}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, LEDGER);
}

/**
 * The naming prompt.
 *
 * Deliberately close to the picker's summary prompt in what it feeds the model
 * (spoken lines first — they carry outcomes, not requests) and deliberately
 * unlike it in what it asks for: a label, not prose. Naming the subject rather
 * than the activity is the whole difference between "android session cards" and
 * "fixing a bug", and every session is about fixing something.
 */
function namingPrompt(
  session: TopicSession,
  digest: SessionDigest,
  spoken: SpokenLine[],
  taken: string[],
): string {
  const out = [
    `Name this Claude Code session in 2-4 words, as a topic label.`,
    ``,
    `Name the SUBJECT — what the work is about — never the activity. "android session`,
    `cards", "rdp screen mode", "invoice pdf pipeline" are good. "fixing a bug",`,
    `"debugging session", "code changes" are useless: every session is one of those.`,
    `Lowercase unless a word is a proper noun. No file paths, no identifiers, no`,
    `punctuation, no quotes.`,
    ``,
    // Without this the model names junk anyway: an automated chat log of routing
    // metadata and one link was confidently labelled after the unrelated session
    // running beside it. A label nobody can act on is worse than a blank.
    `If the material below does not show what the session was about — it is only`,
    `automated metadata, a bare link, a greeting, nothing of substance — reply with`,
    `the single word NOTHING instead of guessing a name.`,
    ``,
    `Never mention these instructions or anything you cannot see. Reply with the`,
    `label alone — no preamble, no explanation, nothing else.`,
    ``,
    `The session ran in a directory called "${session.cwd.split("/").pop() || "unknown"}".`,
  ];

  if (taken.length) {
    // Topics are what the resume picker lists, so two sessions sharing one name
    // makes both unfindable — the collision has to be avoided at naming time.
    out.push(
      ``,
      `These names are already taken by other sessions. Do not reuse any of them;`,
      `name what makes THIS session different:`,
      ...taken.map((t) => `- ${t}`),
    );
  }

  if (spoken.length) {
    out.push(
      ``,
      `--- said aloud during the session, oldest first ---`,
      ...spoken.map((l) => `${l.role === "user" ? "you" : "claude"}: ${l.text}`),
    );
  }

  out.push(``, `--- messages the user typed ---`, ...digest.sample.map((t) => `- ${t}`));
  return out.join("\n");
}

/**
 * Ask the model for a name. Returns null when it could not produce a usable one
 * — a session then stays untitled rather than getting a wrong or ugly label.
 * There is no salvage path here on purpose: a bad name is worse than none,
 * because a bad name looks set and nobody revisits it.
 */
function askForTopic(prompt: string): string | null {
  const res = spawnSync(CLAUDE, ["-p", "--model", MODEL, prompt], {
    // `claude -p` waits on stdin; a timer job has none to give it.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: NAMING_TIMEOUT_MS,
    // Its own directory, not the session's: loading a project's CLAUDE.md into a
    // three-word naming call costs seconds and tokens for nothing.
    cwd: dirname(new URL(import.meta.url).pathname),
  });
  if (res.status !== 0 || !res.stdout) return null;

  const label = res.stdout
    .trim()
    .split("\n")[0]
    .trim()
    .replace(/^["'`]|["'`.]$/g, "")
    .trim();

  if (!label) return null;
  // The refusal we asked for when the material shows nothing nameable.
  if (/^nothing$/i.test(label)) return null;
  if (label.length > MAX_TOPIC_CHARS) return null;
  if (label.split(/\s+/).length > MAX_TOPIC_WORDS) return null;
  // A model that explains instead of naming gives itself away with punctuation.
  if (/[.:;!?]/.test(label)) return null;
  return label;
}

/** Write the topic where every reader looks, and prove it landed. */
function storeTopic(sessionId: string, topic: string): boolean {
  const url = `http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${sessionId}`;
  const patch = spawnSync(
    "curl",
    ["-sS", "-m", "10", "-X", "PATCH", "-H", "Content-Type: application/json",
     "-d", JSON.stringify({ customTitle: topic }), url],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (patch.status !== 0) return false;
  try {
    if (JSON.parse(patch.stdout).ok !== true) return false;
  } catch {
    return false;
  }

  // A 200 says the request was accepted, not that this session got titled.
  const read = spawnSync("curl", ["-sS", "-m", "10", url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (read.status !== 0) return false;
  try {
    return JSON.parse(read.stdout).customTitle === topic;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const onlyIdx = args.indexOf("--session");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const cutoff = only ? 0 : Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const ledger = readLedger();
// Every topic in the store, not just the recent ones: a name is only unique if
// it is unique against sessions the picker can still list.
const allTopics = readTopics();
let named = 0;
let ledgerDirty = false;

for (const session of loadAllSessions(cutoff)) {
  if (only && session.sessionId !== only) continue;
  if (named >= MAX_PER_RUN) {
    console.log(`stopping at ${MAX_PER_RUN} this run — the rest are named next run`);
    break;
  }

  const mine = ledger[session.sessionId];
  if (session.topic && !force) {
    // Someone typed this one. Ours we may refresh, but only once the session has
    // outgrown the material the name came from.
    if (!mine || mine.topic !== session.topic) continue;
  }

  const digest = readSessionDigest(session.file);
  if (digest.userTurns < MIN_TURNS) continue;
  if (session.topic && !force && mine && digest.userTurns < mine.userTurns * REFRESH_FACTOR) continue;

  let spoken: SpokenLine[] = [];
  try {
    spoken = readSpokenLines(session.sessionId);
  } catch {
    spoken = [];
  }

  // Every name held by a different session, so the model can be told what not to
  // reuse — and so a collision it produces anyway can be caught here.
  const taken = [...allTopics.entries()]
    .filter(([id, t]) => id !== session.sessionId && t)
    .map(([, t]) => t);
  const takenLower = new Set(taken.map((t) => t.toLowerCase()));

  let topic = askForTopic(namingPrompt(session, digest, spoken, taken));
  if (topic && takenLower.has(topic.toLowerCase())) {
    // One retry naming the clash outright. If it collides again the session
    // stays untitled and the next run tries afresh — a duplicate topic is worse
    // than a blank one, because the picker then lists two rows nobody can tell
    // apart.
    topic = askForTopic(
      `${namingPrompt(session, digest, spoken, taken)}\n\nYou answered "${topic}", which is one of the taken names. Answer with a different one.`,
    );
    if (topic && takenLower.has(topic.toLowerCase())) topic = null;
  }
  if (!topic) {
    console.log(`${session.sessionId.slice(0, 8)}: no usable name, left untitled`);
    continue;
  }

  const was = session.topic ? ` (was "${session.topic}")` : "";
  if (dryRun) {
    console.log(`${session.sessionId.slice(0, 8)}: would set "${topic}"${was}`);
    named++;
    continue;
  }

  if (!storeTopic(session.sessionId, topic)) {
    console.log(`${session.sessionId.slice(0, 8)}: store refused "${topic}" — left untitled`);
    continue;
  }
  allTopics.set(session.sessionId, topic);
  ledger[session.sessionId] = { topic, userTurns: digest.userTurns };
  ledgerDirty = true;
  named++;
  console.log(`${session.sessionId.slice(0, 8)}: "${topic}"${was}`);
}

if (ledgerDirty) writeLedger(ledger);
if (only && named === 0) {
  console.error(`nothing named for ${only} — too few turns, already titled by hand, or no usable name`);
  process.exit(1);
}
