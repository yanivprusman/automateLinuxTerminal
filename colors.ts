import type { ColorCell } from "./types.js";

const ANSI_COLORS = [
  "#000000", "#cc0000", "#4e9a06", "#c4a000",
  "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f",
  "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

export function palette256(idx: number): string {
  if (idx < 16) return ANSI_COLORS[idx];
  if (idx < 232) {
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor(i / 6) % 6;
    const b = i % 6;
    const v = (n: number) => (n === 0 ? 0 : 55 + 40 * n);
    return "#" + [r, g, b].map((n) => v(n).toString(16).padStart(2, "0")).join("");
  }
  const v = 8 + 10 * (idx - 232);
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

export function fgColor(cell: ColorCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgPalette()) return palette256(cell.getFgColor());
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    return "#" + ((c >> 16) & 0xff).toString(16).padStart(2, "0")
      + ((c >> 8) & 0xff).toString(16).padStart(2, "0")
      + (c & 0xff).toString(16).padStart(2, "0");
  }
  return undefined;
}

export function bgColor(cell: ColorCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgPalette()) return palette256(cell.getBgColor());
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    return "#" + ((c >> 16) & 0xff).toString(16).padStart(2, "0")
      + ((c >> 8) & 0xff).toString(16).padStart(2, "0")
      + (c & 0xff).toString(16).padStart(2, "0");
  }
  return undefined;
}
