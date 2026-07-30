/**
 * Name a Claude session after what it is actually about.
 *
 * A session without a topic is unfindable: the resume picker lists sessions BY
 * topic, and the dashboard and phone cards show a blank line. Naming was manual,
 * so most sessions never got one.
 *
 * This is a COMMAND, never a schedule. It runs when you ask and it always
 * overwrites — asking for a name is the whole signal, so there is no ledger of
 * "ours versus yours" and no rule about leaving an existing topic alone.
 * Nothing here ever runs on its own.
 *
 * The material is the same digest the resume picker's `e` key summarizes: the
 * user's own turns (head and tail, clipped) plus the spoken caption log when
 * there is one. A small model turns that into two to four words, stored durably
 * against the claude session id — the id that survives a resume.
 *
 *   tsx autoTopic.ts --session <id>   # name one session
 *   tsx autoTopic.ts --active         # name every session running right now
 *   tsx autoTopic.ts --active --dry-run
 */
import { spawnSync } from "child_process";
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
const DASHBOARD_PORT = process.env.CLAUDE_DASHBOARD_PORT || "3007";

/** Nothing to name in an empty session — say so rather than inventing one. */
const MIN_TURNS = 1;
const NAMING_TIMEOUT_MS = 90_000;
/** A topic has to fit a phone card at a glance. */
const MAX_TOPIC_CHARS = 40;
const MAX_TOPIC_WORDS = 6;

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
  // A headless `claude` is itself a Claude session: it fires the same hooks, and
  // the dashboard resolves those to a registry row from the environment. Run it
  // with ours inherited and the child CLAIMS this session's row — the row starts
  // reporting the throwaway naming run as the session it holds, and the real one
  // disappears from the list. Measured, not theorised: three ghost ids in
  // /opt/dev/automateLinuxTerminal's project dir before this scrub, and `--active`
  // dutifully named them. Same class as the ptyxis-agent env leak.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "AUTOMATE_LINUX_DASHBOARD_SESSION") continue; // the row-claiming one
    if (k.startsWith("CLAUDE_") || k === "CLAUDECODE") continue;
    env[k] = v;
  }

  const res = spawnSync(CLAUDE, ["-p", "--model", MODEL, prompt], {
    // `claude -p` waits on stdin; nothing here has any to give it.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: NAMING_TIMEOUT_MS,
    env,
    // Somewhere with no CLAUDE.md to load into a three-word naming call, and no
    // session working there for the dashboard to confuse this run with.
    cwd: "/tmp",
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

/**
 * The sessions running right now, straight from the dashboard registry — the
 * same list its cards show. Not "recently modified transcripts": a session that
 * ended is not a session you are working in, and naming the archive was never
 * the ask.
 *
 * Throws rather than returning an empty list if the dashboard cannot be reached.
 * "Nothing is running" and "I could not look" must not produce the same silence.
 */
function activeSessionIds(): string[] {
  const res = spawnSync("curl", ["-sS", "-m", "10", `http://localhost:${DASHBOARD_PORT}/api/claude-sessions`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`dashboard unreachable on port ${DASHBOARD_PORT}: ${(res.stderr || "").trim()}`);
  }
  const list = JSON.parse(res.stdout) as { claudeSessionId?: string }[];
  return [...new Set(list.map((s) => s.claudeSessionId).filter((id): id is string => !!id))];
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const active = args.includes("--active");
const onlyIdx = args.indexOf("--session");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

if (!only && !active) {
  console.error("usage: autoTopic.ts --session <id> | --active   [--dry-run]");
  process.exit(64);
}

const wanted = new Set(only ? [only] : activeSessionIds());
if (!wanted.size) {
  console.log("no sessions are running");
  process.exit(0);
}

// Every topic in the store, not just the ones being named: a name is only unique
// if it is unique against every session the picker can still list.
const allTopics = readTopics();
// Transcripts are matched by id, so the whole archive is in scope for the lookup
// even though only the wanted ids are named.
const sessions = loadAllSessions().filter((s) => wanted.has(s.sessionId));

for (const id of wanted) {
  if (!sessions.some((s) => s.sessionId === id)) {
    console.log(`${id.slice(0, 8)}: no transcript on this machine — skipped`);
  }
}

let named = 0;
let failed = 0;

for (const session of sessions) {
  const digest = readSessionDigest(session.file);
  if (digest.userTurns < MIN_TURNS) {
    console.log(`${session.sessionId.slice(0, 8)}: nothing said yet — nothing to name`);
    failed++;
    continue;
  }

  let spoken: SpokenLine[] = [];
  try {
    spoken = readSpokenLines(session.sessionId);
  } catch {
    spoken = [];
  }

  // Every name held by a DIFFERENT session, so the model can be told what not to
  // reuse — and so a collision it produces anyway can be caught here. A session's
  // own current name is not in the list: replacing a name with itself is fine.
  const taken = [...allTopics.entries()]
    .filter(([id, t]) => id !== session.sessionId && t)
    .map(([, t]) => t);
  const takenLower = new Set(taken.map((t) => t.toLowerCase()));

  let topic = askForTopic(namingPrompt(session, digest, spoken, taken));
  if (topic && takenLower.has(topic.toLowerCase())) {
    // One retry naming the clash outright. If it collides again the topic is left
    // as it was — a duplicate is worse than a stale name, because the picker then
    // lists two rows nobody can tell apart.
    topic = askForTopic(
      `${namingPrompt(session, digest, spoken, taken)}\n\nYou answered "${topic}", which is one of the taken names. Answer with a different one.`,
    );
    if (topic && takenLower.has(topic.toLowerCase())) topic = null;
  }
  if (!topic) {
    console.log(`${session.sessionId.slice(0, 8)}: no usable name — left as it was`);
    failed++;
    continue;
  }

  const was = session.topic && session.topic !== topic ? ` (was "${session.topic}")` : "";
  if (dryRun) {
    console.log(`${session.sessionId.slice(0, 8)}: would set "${topic}"${was}`);
    named++;
    continue;
  }

  if (!storeTopic(session.sessionId, topic)) {
    console.log(`${session.sessionId.slice(0, 8)}: store refused "${topic}" — left as it was`);
    failed++;
    continue;
  }
  allTopics.set(session.sessionId, topic);
  named++;
  console.log(`${session.sessionId.slice(0, 8)}: "${topic}"${was}`);
}

// A command that names nothing must not look like one that worked.
if (named === 0) process.exit(1);
if (failed) console.log(`${named} named, ${failed} left unnamed`);
