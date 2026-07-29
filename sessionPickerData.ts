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
const PROJECTS_DIR = `${homedir()}/.claude/projects`;
/** cwd sits in the opening lines of a transcript — measured under 8KB in every sampled file. */
const HEAD_BYTES = 128 * 1024;

export interface TopicSession {
  sessionId: string;
  topic: string;
  /** Directory the session ran in. `claude --resume` only finds a session from there. */
  cwd: string;
  mtimeMs: number;
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

export function loadTopicSessions(): PickerData {
  const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, { customTitle?: string }>;

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
      byId.set(sessionId, { sessionId, topic, cwd: readCwd(file), mtimeMs });
    }
  }

  const sessions = [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions, unavailable: topics.size - sessions.length };
}
