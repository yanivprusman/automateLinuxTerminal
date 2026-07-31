import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import type { ClaudeSessionInfo } from "./types.js";

export const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || '';
// CLAUDE_SESSION_ID alone is NOT trustworthy: the first ptyxis window after boot
// forks ptyxis-agent, which keeps that window's environment forever — so every
// manually-opened tab inherits a stale CLAUDE_SESSION_ID from a long-dead
// session, and all tabs would overwrite that one session's metadata file and
// keep a ghost entry alive in the dashboard. Managed launches (dashboard
// launch/resume wrappers, feedback tmux) always set CLAUDE_TMUX_SESSION next to
// it, so only trust the id when both are present.
export const SESSION_ID = TMUX_SESSION ? (process.env.CLAUDE_SESSION_ID || '') : '';
// CLAUDE_TMUX_SESSION is the launch KEY every managed launch carries — it is NOT
// evidence that a tmux server is involved (the dashboard's `terminal` launches set
// it too). Readers treat the metadata `tmuxSession` field as a LIVE tmux target:
// the dashboard DELETES metadata whose tmux session doesn't exist, which silently
// erased every dashboard-launched terminal session's metadata file a few seconds
// after startup — and with it this host's window claim. `$TMUX` is set by tmux for
// everything inside a pane, so it answers the question honestly.
export const IN_TMUX = !!process.env.TMUX;
export const APP_NAME = process.env.CLAUDE_APP_NAME || '';
export const LAUNCH_DIR = process.env.CLAUDE_LAUNCH_DIR || process.cwd();
export const SCRIPT_LOG_FILE = process.env.CLAUDE_SCRIPT_LOG_FILE || '';
export const DASHBOARD_PORT = process.env.CLAUDE_DASHBOARD_PORT || '3007';

export const METADATA_FILE = SESSION_ID ? `/tmp/automateLinuxTerminal-${SESSION_ID}.json` : '';

// The claude ACTUALLY running in this tab's shell, refreshed by the title poll
// (which already walks the process tree every 5s, so this costs nothing extra).
//
// SESSION_ID above is empty for any manually-opened tab — deliberately, see the
// ghost-session comment — and stale after a `cl` re-run inside the same tab. The
// write path already knew this (propagateTopicToDashboard resolves the live id
// before pushing a topic); the READ path did not, so a tab with no launcher env
// could never see a topic set from outside it. Anything keyed by "the session in
// this tab" must resolve through here rather than trusting the environment.
let liveSessionId = '';

export function noteLiveSessionId(id: string | undefined | null): void {
  liveSessionId = id && id !== 'unknown' ? id : '';
}

/** The claude session id this tab is FOR, live process first, launcher env second. */
export function currentSessionId(): string {
  return liveSessionId || SESSION_ID;
}

export const APP_VERSION = (() => {
  try {
    return `v${execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf-8', cwd: import.meta.dirname, timeout: 1000 }).trim()}`;
  } catch { return ''; }
})();

export function writeMetadata(shellPid: number): void {
  if (!METADATA_FILE) return;
  const meta = {
    claudeSessionId: SESSION_ID,
    tmuxSession: IN_TMUX ? TMUX_SESSION : '',
    appName: APP_NAME,
    launchDir: LAUNCH_DIR,
    pid: process.pid,
    shellPid,
    startedAt: new Date().toISOString(),
    scriptLogFile: SCRIPT_LOG_FILE,
  };
  writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2));
}

// ── Which host window is this? ────────────────────────────────────────────────
// "Focus this session's terminal" used to be answered by matching the window
// title `claude-<sessionId>`. A Ptyxis window OUTLIVES a session that was killed
// rather than exited (the dashboard's kill, a crash) and keeps that title
// frozen, so after a resume TWO windows carry it -- and the daemon lists windows
// in most-recently-used order, so whichever the user touched last won. Focus
// then landed in a dead terminal.
//
// Only the live host can answer without guessing: it briefly titles its window
// with a nonce nobody else can be showing, asks the daemon which window carries
// it, and publishes that id. A dead host publishes nothing, so it can never be
// mistaken for this one.

/**
 * Ask the daemon for the id of the window whose title is exactly one of `titles`.
 * Returns '' unless EXACTLY ONE window matches — two windows wearing the same
 * title is the ambiguity this whole mechanism exists to remove, so a tie claims
 * nothing rather than claiming wrong.
 */
function windowIdByTitle(titles: string[]): string {
  try {
    const raw = execFileSync('daemon', ['send', 'listWindows'], { encoding: 'utf-8', timeout: 3000 });
    const wins = JSON.parse(raw) as { id: number; title?: string }[];
    const hits = wins.filter(w => w.title && titles.includes(w.title));
    return hits.length === 1 ? String(hits[0].id) : '';
  } catch { return ''; }
}

// The claim is filed under the session the tab is showing RIGHT NOW, in its own
// file, because the metadata file cannot carry it: that one exists only when the
// launcher preset CLAUDE_SESSION_ID + CLAUDE_TMUX_SESSION, which no ordinary tab
// has — so every session started by hand went back to being identified by window
// title alone, the guess this mechanism exists to remove. Keying it on
// currentSessionId() also means a `/resume` (which mints a new id without
// restarting anything) re-files the claim under the id every other surface will
// now be using.
const claimFile = (sessionId: string) => `/tmp/claudeWindowClaim-${sessionId}.json`;

let claimedWindowId = '';
let claimedUnder = '';

/** Publish (or re-file) this window's claim for the session the tab now shows. */
export function publishWindowClaim(windowId?: string): void {
  if (windowId) claimedWindowId = windowId;
  const sid = currentSessionId();
  if (!claimedWindowId || !sid || sid === claimedUnder) return;
  try {
    writeFileSync(claimFile(sid), JSON.stringify({
      sessionId: sid, windowId: claimedWindowId, hostPid: process.pid,
    }));
    // One claim per host: the id we were filed under a moment ago names a session
    // this tab is no longer showing, and leaving it would let a resumed session's
    // dead id keep pointing at a live window.
    if (claimedUnder) { try { unlinkSync(claimFile(claimedUnder)); } catch {} }
    claimedUnder = sid;
  } catch {}
}

function removeWindowClaim(): void {
  if (!claimedUnder) return;
  try { unlinkSync(claimFile(claimedUnder)); } catch {}
  claimedUnder = '';
}

/**
 * Work out WHICH window this terminal is running in. `setTitle` writes an OSC 2
 * title to the hosting terminal; `restoreTitle` puts the session's real title
 * back. Resolves to the window id, or '' when the daemon or the window extension
 * can't answer — the caller then publishes nothing rather than a guess.
 */
export async function claimHostWindow(
  setTitle: (t: string) => void,
  restoreTitle: () => void,
): Promise<string> {
  const nonce = `claude-starting-${process.pid}`;   // unique: one host per pid
  setTitle(nonce);
  try {
    // GNOME sees the new title a frame or two later; poll rather than sleep long.
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 100));
      const id = windowIdByTitle([nonce]);
      if (id) return id;
    }
  } finally {
    restoreTitle();
  }

  // The nonce never appeared, so this window's title is not ours to set: a window
  // opened with `ptyxis --new-window -T <title>` (how the dashboard launches and
  // resumes sessions) keeps that title and ignores the OSC titles we write. Those
  // titles carry a freshly minted session id, so at STARTUP — before any resume can
  // leave a same-titled twin behind — matching one is still an identification, not
  // a guess. windowIdByTitle insists on a unique match either way.
  const given = [SESSION_ID && `claude-${SESSION_ID}`, TMUX_SESSION].filter(Boolean) as string[];
  if (!given.length) return '';
  for (let i = 0; i < 10; i++) {
    const id = windowIdByTitle(given);
    if (id) return id;
    await new Promise(r => setTimeout(r, 200));
  }
  return '';
}

// Also keyed by THIS terminal's own pid, not the Claude session id. The session-id file
// only exists when the terminal was launched with CLAUDE_SESSION_ID preset; a tab started
// manually has none, so its topic was invisible. The Claude Voice `say` command finds this
// file by walking up its own process tree to the owning terminal, which is robust to
// session-id changes on resume and to how the tab was launched.
const PID_TOPIC_FILE = `/tmp/automateLinuxTerminal-topic-${process.pid}.json`;

export function writePidTopic(topic: string): void {
  try {
    writeFileSync(PID_TOPIC_FILE, JSON.stringify({ topic, pid: process.pid, claudeSessionId: currentSessionId() }));
  } catch {}
}

export function cleanupMetadata(): void {
  try { if (METADATA_FILE) unlinkSync(METADATA_FILE); } catch {}
  try { unlinkSync(PID_TOPIC_FILE); } catch {}
  removeWindowClaim();
}

// Persist the tab's topic into the session metadata so external tools (the Claude Voice
// stack) can label and per-session-mute this session by its human name rather than a UUID.
// Merges into the existing metadata file rather than rewriting the whole thing.
export function writeTopic(topic: string): void {
  if (!METADATA_FILE) return;
  try {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(readFileSync(METADATA_FILE, 'utf-8')); } catch {}
    meta.topic = topic;
    writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2));
  } catch {}
}

// Push the topic to the dashboard registry as the session's custom title so
// every session UI (dashboard web, dashboardAndroid) shows it. The dashboard
// PATCH accepts a Claude session id as well as its own key, so send the id of
// the claude actually running in this tab's shell — the SAME id the read path
// resolves, which is what makes a topic set here readable back here.
export function propagateTopicToDashboard(topic: string): void {
  const sid = currentSessionId();
  if (!sid) return;
  fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${sid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customTitle: topic }),
  }).catch(() => {});
}

// Restore this session's topic from the dashboard's durable store (keyed by the
// claude session id, which is stable across resumes). Called at startup so a
// topic set before a resume/reboot reappears in the topic bar instead of dying
// with the previous terminal process.
// Read the durable topic. `null` means "could not read it" (no session id, the
// dashboard is down, a bad response); `''` means the store answered and this
// session has no topic. A caller that would otherwise CLEAR a live topic has to
// tell those apart — collapsing them is how a dashboard restart would wipe a
// topic the user typed.
export async function readStoredTopic(): Promise<string | null> {
  const sid = currentSessionId();
  if (!sid) return null;
  try {
    const res = await fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${sid}`);
    if (!res.ok) return null;
    const data = await res.json();
    // A session the store has never heard of answers 200 with customTitle:null.
    // That is "no answer for this session", NOT "this session has no topic" —
    // only a STRING is an answer, and '' is the answer meaning cleared. Treating
    // null as '' would let an unregistered tab (every manually-opened one) wipe
    // the topic its user typed on the very first poll.
    return typeof data.customTitle === 'string' ? data.customTitle : null;
  } catch {
    return null;
  }
}

export async function fetchStoredTopic(): Promise<string> {
  return (await readStoredTopic()) ?? '';
}

export function registerWithDashboard(shellPid: number): void {
  if (!SESSION_ID) return;
  const body = JSON.stringify({
    sessionId: TMUX_SESSION || `alt-${SESSION_ID.slice(0, 8)}`,
    claudeSessionId: SESSION_ID,
    appName: APP_NAME,
    workDir: LAUNCH_DIR,
    scriptFile: SCRIPT_LOG_FILE,
    termTitle: TMUX_SESSION,
    launchMethod: IN_TMUX ? 'tmux' : 'terminal',
    source: 'terminal',
    pid: shellPid,
  });
  let attempts = 0;
  const tryRegister = () => {
    attempts++;
    fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {
      if (attempts < 10) setTimeout(tryRegister, Math.min(1000 * Math.pow(2, attempts - 1), 30000));
    });
  };
  tryRegister();
}

export function notifySessionEnded(): void {
  if (!SESSION_ID) return;
  const sid = TMUX_SESSION || `alt-${SESSION_ID.slice(0, 8)}`;
  fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${sid}/ended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}

/**
 * The session a claude process is running RIGHT NOW, published per-pid by the
 * `notify-dashboard` hook on every event.
 *
 * This used to be read off the process's own command line (`--session-id`), which
 * is only the id it was LAUNCHED with. `/resume` swaps the running session without
 * rewriting the command line or the environment, so from the first resume onward
 * the flag named a session with no transcript: the tab filed its topic under the
 * live id and read it back under the dead one, and the bar stayed empty while
 * every other surface showed the name. A hook fires under the live id, so it is
 * the only witness that survives a resume.
 *
 * 'unknown' means the process has not fired a hook yet (a second at startup, or
 * hooks disabled) — never a guess at some other session's id.
 */
function liveSessionOf(claudePid: number): string {
  try {
    const raw = readFileSync(`/tmp/claude-live-session-${claudePid}.json`, 'utf-8');
    const sid = (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
    return typeof sid === 'string' && sid ? sid : 'unknown';
  } catch { return 'unknown'; }
}

export function detectClaudeSession(shellPid: number): ClaudeSessionInfo | null {
  let pids: number[];
  try {
    const output = execFileSync('pgrep', ['-x', 'claude'], { encoding: 'utf-8', timeout: 1000 });
    pids = output.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return null;
  }
  for (const pid of pids) {
    let current = pid;
    for (let i = 0; i < 10; i++) {
      try {
        const stat = readFileSync(`/proc/${current}/stat`, 'utf-8');
        const ppid = parseInt(stat.split(') ')[1]?.split(' ')[1] || '0');
        if (ppid === shellPid) {
          const sessionId = liveSessionOf(pid);
          let cwd: string | null = null;
          try {
            cwd = readFileSync(`/proc/${pid}/cwd`, 'utf-8').replace(/\0/g, '');
          } catch {
            try {
              cwd = execFileSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf-8', timeout: 500 }).trim();
            } catch {}
          }
          return { sessionId, cwd, pid };
        }
        if (ppid <= 1) break;
        current = ppid;
      } catch { break; }
    }
  }
  return null;
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Always registered (not just for managed sessions): manual tabs still write a
// pid-keyed topic file that must not outlive the process.
const onSignal = () => { cleanupMetadata(); process.exit(0); };
process.on('SIGTERM', onSignal);
process.on('SIGHUP', onSignal);
