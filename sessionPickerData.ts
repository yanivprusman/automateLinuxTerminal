/**
 * Data source for the by-topic Claude session picker (sessionPicker.tsx).
 *
 * A "topic" is the label typed into this app's session menu (see writeTopic /
 * propagateTopicToDashboard in session.ts). It is stored durably by the
 * dashboard, keyed by the *claude session id* — the one id that survives a
 * resume — so a topic set weeks ago is still attached to the session today.
 * That store is the only place topics live, which is what makes a by-topic
 * resume list possible.
 *
 * We read the store's file rather than the dashboard's HTTP API on purpose:
 * the picker must work when the dashboard is down, and /api/claude-sessions/all
 * scans every transcript in full to summarize prompts, which this does not need.
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";

/** Dashboard's durable per-session metadata (lib/state-dir.ts → STATE_DIR). */
const META_FILE = "/opt/automateLinux/data/dashboard/claude-session-meta.json";
/**
 * The voice stack's caption log — every line spoken by either side, tagged with
 * the session it belongs to (see the claude-voice repo's `say`).
 *
 * This is the single best account of a session that exists. Each spoken line was
 * composed to lead with the outcome and be understood without context, so the log
 * is already a condensed narrative of what happened — where the transcript is raw
 * and 70MB, this is the distilled version, both sides, in under a megabyte.
 */
const VOICE_HISTORY = `${homedir()}/.claude/voice-history.jsonl`;
const PROJECTS_DIR = `${homedir()}/.claude/projects`;
/** cwd sits in the opening lines of a transcript — measured under 8KB in every sampled file. */
const HEAD_BYTES = 128 * 1024;

export interface TopicSession {
  sessionId: string;
  topic: string;
  /** Directory the session ran in. `claude --resume` only finds a session from there. */
  cwd: string;
  mtimeMs: number;
  /** Transcript path, kept so a digest can be read on demand without re-scanning. */
  file: string;
}

/** What a session was about, in the user's own words. See readSessionDigest. */
export interface SessionDigest {
  first: string;
  last: string;
  userTurns: number;
  /** Bounded sample of the user's turns, oldest first — the prompt fed to Claude. */
  sample: string[];
}

/**
 * How much of a session is handed to the summarizer.
 *
 * Transcripts reach 70MB, so "send the session" is never an option — the model
 * gets the user's own turns, head and tail, each clipped. Those two ends are
 * what identify a session: what it set out to do and where it ended up. The
 * caps bound the prompt to a few thousand tokens no matter how long the run was.
 */
const SAMPLE_HEAD = 30;
const SAMPLE_TAIL = 30;
const SAMPLE_TURN_CHARS = 400;
/** Spoken lines are longer than a typed prompt and worth more — clip less, keep the tail. */
const SPOKEN_MAX = 40;
const SPOKEN_CHARS = 1200;

/**
 * Clip on a sentence boundary, never mid-word.
 *
 * A ragged edge is not just ugly here: cutting a caption mid-sentence made the
 * summarizer end with "the analysis cut off mid-sentence, so it's unclear what
 * was finished" — it reported the damage instead of the session. Text handed to
 * a model should never look truncated, or the truncation becomes the story.
 */
function clipToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}.`;
}

/** One line from the voice log: what was said aloud, and by whom. */
export interface SpokenLine {
  role: string;
  text: string;
}

/**
 * The spoken account of one session, oldest first.
 *
 * Absent for plenty of sessions — silent runs, machines without the voice stack —
 * and that is a normal empty result, not an error: the summary is simply built
 * from the typed turns alone. Only an unreadable-but-present log is a real fault.
 */
export function readSpokenLines(sessionId: string): SpokenLine[] {
  let raw: string;
  try {
    raw = readFileSync(VOICE_HISTORY, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const lines: SpokenLine[] = [];
  for (const line of raw.split("\n")) {
    // The session id appears in every entry that matters; skip the JSON.parse
    // for the ~99% of the log belonging to other sessions.
    if (!line || !line.includes(sessionId)) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.session !== sessionId) continue;
    const text = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    lines.push({ role: entry.role === "user" ? "user" : "claude", text: clipToSentence(text, SPOKEN_CHARS) });
  }

  // The tail is what a session ended up doing; the opening is already in the typed turns.
  return lines.slice(-SPOKEN_MAX);
}

export interface PickerData {
  sessions: TopicSession[];
  /** Topics whose transcript isn't under this user's ~/.claude/projects — not resumable here. */
  unavailable: number;
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function matchCwd(text: string): string {
  const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return "";
  }
}

function readCwd(file: string): string {
  const head = matchCwd(readHead(file, HEAD_BYTES));
  if (head) return head;
  // Rare, but pay the full read rather than deriving the directory from the
  // project-dir name: that encoding is lossy ('/root/.openclaw' becomes
  // '-root--openclaw'), and a wrong directory makes `claude --resume` fail as
  // if the session didn't exist.
  return matchCwd(readFileSync(file, "utf8"));
}

/**
 * Strip the wrappers Claude Code and feedback-lib inject around user prompts,
 * so a digest shows what the user typed rather than the scaffolding.
 *
 * Deliberately a local copy of the dashboard's `cleanPromptText`: importing it
 * would tie the picker to a second repo whose location is per-peer configurable
 * (`d getAppRoots`), and the picker's whole point is to work on its own.
 */
function cleanPrompt(text: string): string {
  return text
    .replace(/^\[(?:Platform|Page):[^\]]*\]\s*/, "")
    .replace(/<\/?command-message>/g, "\n")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "\n")
    .replace(/<\/?command-args>/g, "\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * First and last thing the user actually said, plus how many turns they took.
 *
 * No model is involved: a session is recognizable from its own opening line far
 * more reliably than from generated prose, and this stays instant on keypress.
 * The whole file is read because the last turn is at the end by definition —
 * paid only when a row is opened, never for the list.
 */
export function readSessionDigest(file: string): SessionDigest {
  let firstRaw = "";
  let lastRaw = "";
  let userTurns = 0;
  const head: string[] = [];
  const tail: string[] = [];

  for (const line of readFileSync(file, "utf8").split("\n")) {
    // Cheap substring rejects before JSON.parse: tool results and meta entries
    // carry role "user" but are not the user speaking.
    if (!line || !line.includes('"type":"user"')) continue;
    if (line.includes('"tool_result"') || line.includes('"isMeta":true')) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.message?.role !== "user") continue;

    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content.find((b: any) => b.type === "text")?.text ?? "")
          : "";
    if (!text) continue;

    userTurns++;
    if (!firstRaw) firstRaw = text;
    lastRaw = text;

    // Keep the head outright and slide a fixed-size window over the tail, so a
    // 64-turn session costs the same memory as a 6-turn one.
    const turn = cleanPrompt(text).replace(/\s+/g, " ").slice(0, SAMPLE_TURN_CHARS);
    if (!turn) continue;
    if (head.length < SAMPLE_HEAD) head.push(turn);
    else {
      tail.push(turn);
      if (tail.length > SAMPLE_TAIL) tail.shift();
    }
  }

  return { first: cleanPrompt(firstRaw), last: cleanPrompt(lastRaw), userTurns, sample: [...head, ...tail] };
}

export function loadTopicSessions(): PickerData {
  let meta: Record<string, { customTitle?: string }>;
  try {
    meta = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, { customTitle?: string }>;
  } catch (err) {
    // The dashboard writes this store and `data/**` is gitignored, so on a fresh
    // machine it simply does not exist yet. That is the "no topics set" case the
    // caller already has a message for — not a crash. A corrupt or unreadable
    // store is a real fault and still throws.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { sessions: [], unavailable: 0 };
  }

  const topics = new Map<string, string>();
  for (const [sessionId, entry] of Object.entries(meta)) {
    const topic = entry?.customTitle?.trim();
    if (topic) topics.set(sessionId, topic);
  }

  const byId = new Map<string, TopicSession>();
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = `${PROJECTS_DIR}/${dir.name}`;
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      const topic = topics.get(sessionId);
      if (!topic) continue;

      const file = `${dirPath}/${entry}`;
      const mtimeMs = statSync(file).mtimeMs;
      // One id can appear under two project dirs when a session's directory was
      // renamed. The newest transcript is the one `claude --resume` will read.
      const prev = byId.get(sessionId);
      if (prev && prev.mtimeMs >= mtimeMs) continue;
      byId.set(sessionId, { sessionId, topic, cwd: readCwd(file), mtimeMs, file });
    }
  }

  const sessions = [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions, unavailable: topics.size - sessions.length };
}
