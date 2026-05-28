import xterm from "@xterm/headless";
const { Terminal: XTerminal } = xterm;
import { fgColor, bgColor } from "./colors.js";
import type { Span, Line, Selection } from "./types.js";

export const EMPTY_SPAN: Span = { text: " ", bold: false, dim: false, italic: false, underline: false, strikethrough: false };

export function spansEqual(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text ||
        a[i].fg !== b[i].fg || a[i].bg !== b[i].bg ||
        a[i].bold !== b[i].bold || a[i].dim !== b[i].dim ||
        a[i].italic !== b[i].italic || a[i].underline !== b[i].underline ||
        a[i].strikethrough !== b[i].strikethrough) return false;
  }
  return true;
}

export function normalizeSelection(sel: Selection): Selection {
  if (sel.startRow < sel.endRow || (sel.startRow === sel.endRow && sel.startCol <= sel.endCol))
    return sel;
  return { startRow: sel.endRow, startCol: sel.endCol, endRow: sel.startRow, endCol: sel.startCol };
}

function isCellSelected(row: number, col: number, sel: Selection): boolean {
  const n = normalizeSelection(sel);
  if (row < n.startRow || row > n.endRow) return false;
  if (row === n.startRow && row === n.endRow) return col >= n.startCol && col <= n.endCol;
  if (row === n.startRow) return col >= n.startCol;
  if (row === n.endRow) return col <= n.endCol;
  return true;
}

export function readBufferRow(
  term: InstanceType<typeof XTerminal>,
  absY: number,
  cols: number,
  cursorVisible: boolean,
  cursorRow: number,
  cursorCol: number,
  viewportRow: number,
  selection?: Selection | null,
): Span[] {
  const bufLine = term.buffer.active.getLine(absY);
  if (!bufLine) return [EMPTY_SPAN];

  const spans: Span[] = [];
  let cur: Span | null = null;

  for (let x = 0; x < cols; x++) {
    const cell = bufLine.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || " ";
    const inverse = cell.isInverse() !== 0;
    const rawFg = fgColor(cell);
    const rawBg = bgColor(cell);
    let fg = inverse ? rawBg : rawFg;
    let bg = inverse ? rawFg : rawBg;

    if (cursorVisible && viewportRow === cursorRow && x === cursorCol) {
      const t = fg;
      fg = bg || "#000000";
      bg = t || "#d3d7cf";
    }
    if (selection && isCellSelected(viewportRow, x, selection)) {
      fg = "#ffffff";
      bg = "#3465a4";
    }
    const bold = cell.isBold() !== 0;
    const dim = cell.isDim() !== 0;
    const italic = cell.isItalic() !== 0;
    const underline = cell.isUnderline() !== 0;
    const strikethrough = cell.isStrikethrough() !== 0;

    if (
      cur &&
      cur.fg === fg && cur.bg === bg &&
      cur.bold === bold && cur.dim === dim &&
      cur.italic === italic && cur.underline === underline &&
      cur.strikethrough === strikethrough
    ) {
      cur.text += chars;
    } else {
      cur = { text: chars, fg, bg, bold, dim, italic, underline, strikethrough };
      spans.push(cur);
    }
  }

  if (spans.length === 0) return [EMPTY_SPAN];
  return spans;
}

export function readBuffer(term: InstanceType<typeof XTerminal>, rows: number, cols: number, cache: Line[], selection?: Selection | null, cursorVisible = true): Line[] {
  const buf = term.buffer.active;
  const startY = buf.viewportY;
  const cursorRow = buf.cursorY + buf.baseY - startY;
  const cursorCol = buf.cursorX;
  const lines: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const row = readBufferRow(term, startY + y, cols, cursorVisible, cursorRow, cursorCol, y, selection);
    if (cache[y] && spansEqual(cache[y], row)) {
      lines.push(cache[y]);
    } else {
      lines.push(row);
    }
  }
  return lines;
}
