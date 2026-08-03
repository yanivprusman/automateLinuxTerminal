export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

export type Line = Span[];

export interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface SessionHistoryEntry {
  sessionId: string;
  cwd: string | null;
  pid: number;
  startMs: number;
  alive: boolean;
  /** Kept in the dashboard's durable store, so it is the same flag the dashboard's
   *  "Bookmarked" filter reads. Re-read from disk every time the menu opens. */
  bookmarked: boolean;
}

export interface ContextMenuState {
  kind: 'clipboard' | 'automateLinuxTerminalMenu';
  row: number;
  col: number;
  hasSelection: boolean;
  hoverItem: number;
  sessions: SessionHistoryEntry[];
  stopwatchDisplay: string | null;
  stopwatchAction: string | null;
  stopwatchRowOff: number;
  topic: string;
  editingTopic: boolean;
  editBuffer: string;
  topicRowOff: number;
  // Where the first session line is drawn, -1 when there are none. The list no longer
  // starts at a fixed offset -- the topic section above it, and the info line the "?"
  // opens, both move it -- so the row-mapper is told rather than left to count.
  sessionsRowOff: number;
  // Where the "?" is drawn. It sits on the LAST row of the menu, so its offset depends on
  // everything above it (the session list, the timer) -- it is no longer the constant row
  // 1 the click-mapper used to assume.
  helpRowOff: number;
  // Whether the "?" has its info line open. What the menu is and which version of it you
  // are looking at is worth one keystroke to see, not a permanent row.
  infoOpen: boolean;
  showTopicBar: boolean;
  copiedSessionIdx: number;
  // The voice segment -- the mute, the captions and the replay -- acts on THIS TAB'S
  // session: the live one, or the last one the tab hosted (menu.ts::currentSessionId).
  // Null when it has never hosted one, and then those rows are not drawn.
  currentSessionId: string | null;
  captionsRowOff: number;
  replayRowOff: number;
  // What the captions/replay rows are reporting, if anything ("opening…", "replaying…",
  // or the reason it did not happen). A launcher that fails must say so on the row that
  // was clicked -- a menu item that silently does nothing is indistinguishable from a
  // misclick, and doubly so when the thing you asked for is a sound. Non-empty IS the
  // "this row is reporting" state; there is one of each row, so no index is needed.
  captionsMsg: string;
  replayMsg: string;
  // Same contract for the bookmark line: the flag lives in the dashboard's store, so a
  // click can fail (dashboard down, session with no id yet) and the row has to say why
  // instead of quietly flipping back.
  bookmarkIdx: number;
  bookmarkMsg: string;
  // The claude-voice GLOBAL mute — the same flag the caption's button, the phone and
  // `voice off --all` flip, re-read from the flag file every time the menu opens. The
  // row reports failure in place (muteMsg), same contract as the bookmark row.
  voiceMuted: boolean;
  muteRowOff: number;
  muteMsg: string;
}

export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string | null;
  pid: number;
}

export interface ColorCell {
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  isFgDefault(): boolean;
  getFgColor(): number;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  isBgDefault(): boolean;
  getBgColor(): number;
}
