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
export const APP_NAME = process.env.CLAUDE_APP_NAME || '';
export const LAUNCH_DIR = process.env.CLAUDE_LAUNCH_DIR || process.cwd();
export const SCRIPT_LOG_FILE = process.env.CLAUDE_SCRIPT_LOG_FILE || '';
export const DASHBOARD_PORT = process.env.CLAUDE_DASHBOARD_PORT || '3007';

export const METADATA_FILE = SESSION_ID ? `/tmp/automateLinuxTerminal-${SESSION_ID}.json` : '';

export const APP_VERSION = (() => {
  try {
    return `v${execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf-8', cwd: import.meta.dirname, timeout: 1000 }).trim()}`;
  } catch { return ''; }
})();

export function writeMetadata(shellPid: number): void {
  if (!METADATA_FILE) return;
  const meta = {
    claudeSessionId: SESSION_ID,
    tmuxSession: TMUX_SESSION,
    appName: APP_NAME,
    launchDir: LAUNCH_DIR,
    pid: process.pid,
    shellPid,
    startedAt: new Date().toISOString(),
    scriptLogFile: SCRIPT_LOG_FILE,
  };
  writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2));
}

// Also keyed by THIS terminal's own pid, not the Claude session id. The session-id file
// only exists when the terminal was launched with CLAUDE_SESSION_ID preset; a tab started
// manually has none, so its topic was invisible. The Claude Voice `say` command finds this
// file by walking up its own process tree to the owning terminal, which is robust to
// session-id changes on resume and to how the tab was launched.
const PID_TOPIC_FILE = `/tmp/automateLinuxTerminal-topic-${process.pid}.json`;

export function writePidTopic(topic: string): void {
  try {
    writeFileSync(PID_TOPIC_FILE, JSON.stringify({ topic, pid: process.pid, claudeSessionId: SESSION_ID }));
  } catch {}
}

export function cleanupMetadata(): void {
  try { if (METADATA_FILE) unlinkSync(METADATA_FILE); } catch {}
  try { unlinkSync(PID_TOPIC_FILE); } catch {}
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
// the claude actually running in this tab's shell — the env-inherited
// SESSION_ID is absent for manual tabs and stale after a `cl` re-run.
export function propagateTopicToDashboard(topic: string, shellPid: number): void {
  const live = detectClaudeSession(shellPid);
  const sid = (live && live.sessionId !== 'unknown' ? live.sessionId : '') || SESSION_ID;
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
export async function fetchStoredTopic(): Promise<string> {
  if (!SESSION_ID) return '';
  try {
    const res = await fetch(`http://localhost:${DASHBOARD_PORT}/api/claude-sessions/${SESSION_ID}`);
    if (!res.ok) return '';
    const data = await res.json();
    return typeof data.customTitle === 'string' ? data.customTitle : '';
  } catch {
    return '';
  }
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
    launchMethod: 'tmux',
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
          let sessionId = 'unknown';
          let cwd: string | null = null;
          try {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
            const args = cmdline.split('\0').filter(Boolean);
            for (let j = 0; j < args.length; j++) {
              if ((args[j] === '--session-id' || args[j] === '-r') && args[j + 1]) {
                sessionId = args[j + 1];
                break;
              }
            }
          } catch {}
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
