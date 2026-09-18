/**
 * Name a Claude session after what it is actually about.
 *
 * A session without a topic is unfindable: the resume picker lists sessions BY
 * topic, and the dashboard and phone cards show a blank line. Naming was manual,
 * so most sessions never got one.
 *
 * This is a COMMAND, never a schedule. It runs when you ask and it always
 * overwrites — asking for a name is the whole signal, so there is no ledger of
 * "ours versus yours" and no rule about leaving an existing topic alone. The
 * existing name is still SHOWN to the model (topicNaming.ts, point 3): replacing
 * a name is not the same as ignoring it. A concluded session stays concluded.
 *
 * The material is the same digest the resume picker's `e` key summarizes: the
 * user's own turns (head and tail, clipped) plus the spoken caption log when
 * there is one — and, when the session names itself, its own account of what it
 * is about (`--brief`). A model turns that into two or three words, stored
 * durably against the claude session id — the id that survives a resume.
 *
 *   tsx autoTopic.ts --session <id> [--brief "<what it is about>"]   # name one session
 *   tsx autoTopic.ts --active                                        # name every session running now
 *   tsx autoTopic.ts --recent [N]                                    # list the latest sessions, to find one
 *   ... --dry-run                                                    # show the name, write nothing
 */
import { spawnSync } from "child_process";
import {
  loadAllSessions,
  readTopics,
  readSessionDigest,
  readSpokenLines,
  readEntrypoint,
  type TopicSession,
  type SpokenLine,
} from "./sessionPickerData.js";
import {
  judgeReply,
  namingPrompt,
  retryPrompt,
  splitMarker,
  takenNames,
  withMarker,
} from "./topicNaming.js";

/** Not on a systemd unit's PATH — `~/.local/bin` is a login-shell thing. */
const CLAUDE = "/root/.local/bin/claude";
/**
 * Sonnet, not haiku — for speed as much as for the names. Measured 2026-09-18
 * with the same prompt on five sessions: haiku took 16–45 s a call, sonnet 3–5 s,
 * and sonnet's labels were as good or better. Naming runs only when someone asks
 * and is waiting on the answer, so the wait is the cost that matters.
 */
const MODEL = "sonnet";
const DASHBOARD_PORT = process.env.CLAUDE_DASHBOARD_PORT || "3007";

/** Nothing to name in an empty session — say so rather than inventing one. */
const MIN_TURNS = 1;
const NAMING_TIMEOUT_MS = 90_000;
/** A brief is a few sentences. A page of it means the caller pasted the wrong thing. */
const MAX_BRIEF_CHARS = 1500;
const RECENT_DEFAULT = 10;

/**
 * Ask the model once. Returns its raw reply, or why there was none — a crash, a
 * timeout, a refusal to start — which is never the same thing as "no name".
 */
function askModel(prompt: string): { reply: string } | { error: string } {
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

  const res = spawnSync(
    CLAUDE,
    [
      "-p",
      "--model",
      MODEL,
      // No tools at all. Left with tools the namer USES them — a session whose
      // transcript mentioned this very script sent it off to run it, through
      // twelve turns and a permission wall. `--tools ""` replaces a deny-list
      // that named nineteen tools and had to grow with every release; the init
      // event of a run with it reports `"tools":[]`.
      "--tools",
      "",
      // A naming call is not a session. Each one used to leave a transcript in
      // ~/.claude/projects/-tmp — 56 of them by 2026-09-18 — for the picker and
      // every "recent sessions" list to wade through.
      "--no-session-persistence",
      // Naming three words must not wait on this peer's MCP servers starting.
      "--strict-mcp-config",
      // An empty cwd is not enough — the USER-global CLAUDE.md still loads, and
      // its speak-every-reply rule made the namer answer "please approve the say
      // command" instead of a name, every call. No settings sources means no
      // CLAUDE.md and no memory: the prompt is the whole world.
      "--setting-sources",
      "",
    ],
    {
      // Via stdin, not argv: `--tools` is variadic and would swallow a trailing
      // prompt, and a transcript digest has no business near ARG_MAX.
      input: prompt,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: NAMING_TIMEOUT_MS,
      env,
      // Somewhere no session works, so the dashboard's cwd match can't bind this
      // run to one.
      cwd: "/tmp",
    },
  );
  if (res.error) return { error: `the model call failed: ${res.error.message}` };
  if (res.status !== 0) {
    const why = (res.stderr || res.stdout || "").trim().split("\n")[0].slice(0, 200);
    return { error: `the model call exited ${res.status}${why ? `: ${why}` : ""}` };
  }
  return { reply: res.stdout || "" };
}

/**
 * Write the topic where every reader looks, and prove it landed. Returns null on
 * success, or what went wrong — "store refused" alone could not tell an
 * unreachable dashboard from a rejected write from a readback that disagreed.
 */
function storeTopic(sessionId: string, topic: string): string | null {
  const url = `http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${sessionId}`;
  const patch = spawnSync(
    "curl",
    ["-sS", "-m", "10", "-X", "PATCH", "-H", "Content-Type: application/json",
     "-d", JSON.stringify({ customTitle: topic }), url],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (patch.status !== 0) return `dashboard unreachable: ${(patch.stderr || "").trim().slice(0, 160)}`;
  try {
    if (JSON.parse(patch.stdout).ok !== true) return `dashboard refused the write: ${patch.stdout.trim().slice(0, 160)}`;
  } catch {
    return `dashboard answered the write with non-JSON: ${patch.stdout.trim().slice(0, 160)}`;
  }

  // A 200 says the request was accepted, not that this session got titled.
  const read = spawnSync("curl", ["-sS", "-m", "10", url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (read.status !== 0) return `readback unreachable: ${(read.stderr || "").trim().slice(0, 160)}`;
  try {
    const got = JSON.parse(read.stdout).customTitle;
    return got === topic ? null : `readback has ${JSON.stringify(got ?? "")}`;
  } catch {
    return `readback was non-JSON: ${read.stdout.trim().slice(0, 160)}`;
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

function spokenFor(sessionId: string): SpokenLine[] {
  try {
    return readSpokenLines(sessionId);
  } catch {
    return [];
  }
}

/** Name one session. Prints one line saying what happened; true when a name was written (or would be). */
function nameOne(session: TopicSession, brief: string, allTopics: Map<string, string>, dryRun: boolean): boolean {
  const id8 = session.sessionId.slice(0, 8);
  const digest = readSessionDigest(session.file);
  if (digest.userTurns < MIN_TURNS) {
    console.log(`${id8}: nothing said yet — nothing to name`);
    return false;
  }

  const current = splitMarker(session.topic);
  const taken = takenNames(allTopics, session.sessionId);
  const takenLower = new Set(taken.map((t) => t.toLowerCase()));
  const prompt = namingPrompt({
    dir: session.cwd.split("/").pop() || "",
    digest,
    spoken: spokenFor(session.sessionId),
    current: current.name,
    brief,
    taken,
  });

  let answer = askModel(prompt);
  if ("error" in answer) {
    console.log(`${id8}: ${answer.error} — left as it was`);
    return false;
  }
  let verdict = judgeReply(answer.reply, takenLower);
  if (!verdict.ok && !verdict.nothing) {
    // One retry, naming the rule each label broke. If they break one again the
    // topic is left as it was: a duplicate or a clipped name is worse than a
    // stale one, because it looks settled and nobody revisits it.
    answer = askModel(retryPrompt(prompt, verdict.why));
    if ("error" in answer) {
      console.log(`${id8}: ${answer.error} — left as it was`);
      return false;
    }
    verdict = judgeReply(answer.reply, takenLower);
  }
  if (!verdict.ok) {
    console.log(
      verdict.nothing
        ? `${id8}: the model found nothing in it to name — left as it was`
        : `${id8}: no usable name (${verdict.why}) — left as it was`,
    );
    return false;
  }

  const topic = withMarker(verdict.name, current.concluded);
  const was = session.topic && session.topic !== topic ? ` (was "${session.topic}")` : "";
  if (dryRun) {
    console.log(`${id8}: would set "${topic}"${was}`);
    return true;
  }
  const stored = storeTopic(session.sessionId, topic);
  if (stored) {
    console.log(`${id8}: could not store "${topic}" (${stored}) — left as it was`);
    return false;
  }
  allTopics.set(session.sessionId, topic);
  console.log(`${id8}: "${topic}"${was}`);
  return true;
}

/** "3m", "5h", "2d" — how long since the transcript was last written. */
function age(mtimeMs: number): string {
  const min = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000));
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (24 * 60))}d`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * The latest interactive sessions, newest first, each with what it opened with
 * and where it ended — enough to pick out "the session I just closed" by what it
 * was doing. 2026-09-05: asked to name a session that had just been closed, and
 * with nothing but ids and times to go on, the wrong one was named first. The
 * user knew it by its last act ("it asked me a multiple-choice question about
 * OpenClaw"), so that is the line printed: the last thing said aloud, which is
 * where a session's final question lands, or the last thing typed.
 */
function listRecent(count: number): void {
  const running = new Set(activeSessionIds());
  const self = process.env.CLAUDE_CODE_SESSION_ID || "";
  let shown = 0;
  for (const s of loadAllSessions()) {
    if (shown >= count) break;
    if (readEntrypoint(s.file) !== "cli") continue;
    const digest = readSessionDigest(s.file);
    if (!digest.userTurns) continue;
    const spoken = spokenFor(s.sessionId);
    const lastSaid = spoken.length ? `${spoken[spoken.length - 1].role}: ${spoken[spoken.length - 1].text}` : digest.last;
    const state = s.sessionId === self ? "this" : running.has(s.sessionId) ? "running" : "ended";
    const dir = s.cwd.split("/").pop() || "?";
    console.log(`${s.sessionId}  ${state.padEnd(7)} ${age(s.mtimeMs).padStart(4)}  ${dir}  ${s.topic ? `"${s.topic}"` : "(no topic)"}`);
    console.log(`    first: ${clip(digest.first, 110)}`);
    console.log(`    last:  ${clip(lastSaid, 110)}`);
    shown++;
  }
  if (!shown) console.log("no interactive sessions on this machine");
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const active = args.includes("--active");
const flagValue = (flag: string): string | null => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const value = args[i + 1] ?? "";
  // `--brief --dry-run` would otherwise name the session after the words "--dry-run".
  if (value.startsWith("--")) {
    console.error(`autoTopic: ${flag} needs a value`);
    process.exit(64);
  }
  return value;
};
const only = flagValue("--session");
const brief = (flagValue("--brief") ?? "").trim();
const recentIdx = args.indexOf("--recent");

// Checked first and alone: it only reads. `nameSessions --recent` arrives here as
// `--active --recent`, and must list, not name every running session.
if (recentIdx >= 0) {
  const n = Number(args[recentIdx + 1]);
  listRecent(Number.isInteger(n) && n > 0 ? n : RECENT_DEFAULT);
  process.exit(0);
}

if (!only && !active) {
  console.error("usage: autoTopic.ts --session <id> [--brief <text>] | --active | --recent [N]   [--dry-run]");
  process.exit(64);
}
if (brief && !only) {
  // A brief describes ONE session, written from inside it. Handed to --active it
  // would be read as the account of every session being named.
  console.error("autoTopic: --brief names one session — use it with --session");
  process.exit(64);
}
if (brief.length > MAX_BRIEF_CHARS) {
  console.error(`autoTopic: --brief is ${brief.length} characters; a few sentences (under ${MAX_BRIEF_CHARS}) is the whole job`);
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
  if (nameOne(session, brief, allTopics, dryRun)) named++;
  else failed++;
}

// A command that names nothing must not look like one that worked.
if (named === 0) process.exit(1);
if (failed) console.log(`${named} named, ${failed} left unnamed`);
