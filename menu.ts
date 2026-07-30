import type { SessionHistoryEntry } from "./types.js";

export const SESSION_MENU_INNER = 28;
export const sessionMenuPad = (s: string) => (s + " ".repeat(SESSION_MENU_INNER)).slice(0, SESSION_MENU_INNER);
export const sessionMenuBorder = "─".repeat(SESSION_MENU_INNER);

export function formatElapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function formatStopwatch(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function computeMenuLayout(sessions: SessionHistoryEntry[], hasStopwatch: boolean) {
  let row = 0;
  row++;                         // top border
  const titleRow = row; row++;   // title
  if (sessions.length > 0) {
    row++;                       // session separator
    for (const e of sessions) {
      row++;                     // session line
      if (e.cwd) row++;         // cwd line
      row++;                     // captions line
    }
  }
  row++;                         // topic separator
  const topicRow = row; row++;   // topic
  row++;                         // pin topic
  let stopwatchRow = -1;
  if (hasStopwatch) {
    row++;                       // stopwatch separator
    stopwatchRow = row; row++;   // stopwatch
  }
  row++;                         // bottom border
  return { titleRow, topicRow, stopwatchRow, height: row };
}

export type SessionRowAction = 'copy' | 'captions';

/** Which session a menu row belongs to, and what clicking it does. Every session occupies
 *  two or three consecutive rows -- the id line, an optional cwd line, and the captions
 *  line -- so the mapping is a walk, not arithmetic. Row 3 is the first session line:
 *  border, title, separator come first. */
export function sessionRowAt(
  rowOff: number,
  sessions: SessionHistoryEntry[],
): { idx: number; action: SessionRowAction } | null {
  if (sessions.length === 0) return null;
  let row = 3;
  for (let i = 0; i < sessions.length; i++) {
    if (rowOff === row) return { idx: i, action: 'copy' };
    row++;
    if (sessions[i].cwd) {
      if (rowOff === row) return { idx: i, action: 'copy' };
      row++;
    }
    if (rowOff === row) return { idx: i, action: 'captions' };
    row++;
  }
  return null;
}
