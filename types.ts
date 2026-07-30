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
  showTopicBar: boolean;
  copiedSessionIdx: number;
  // Which session's captions line is reporting something, and what it says ("opening…",
  // or the reason it did not open). A launcher that fails must say so on the row that was
  // clicked -- a menu item that silently does nothing is indistinguishable from a misclick.
  captionsIdx: number;
  captionsMsg: string;
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
