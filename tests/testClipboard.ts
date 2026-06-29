// Round-trip test for the real clipboard module. Writes a unique marker via
// clipboardWrite, reads it back via clipboardRead, and asserts they match.
//
// Run it the way the app is actually launched on a box where WAYLAND_DISPLAY is
// NOT exported (e.g. the NUC's root GNOME session):
//   env -u WAYLAND_DISPLAY npx tsx tests/testClipboard.ts
// It must still detect Wayland (via the socket) and round-trip cleanly.
import { clipboardWrite, clipboardRead, ON_WAYLAND, WAYLAND_SOCKET } from "../clipboard.js";

const marker = `clip-roundtrip-${process.pid}-${Math.floor(Math.random() * 1e9)}`;

console.log(`backend: ${ON_WAYLAND ? "wayland (wl-copy/wl-paste)" : "x11 (xclip)"}`);
console.log(`WAYLAND_DISPLAY env: ${process.env.WAYLAND_DISPLAY ?? "(unset)"}`);
console.log(`detected wayland socket: ${WAYLAND_SOCKET ?? "(none)"}`);
console.log(`writing marker: ${marker}`);

clipboardWrite(marker);

// Give the writer a beat to land, then read back.
setTimeout(async () => {
  const got = (await clipboardRead()).replace(/\n$/, "");
  if (got === marker) {
    console.log(`PASS — read back exactly: ${got}`);
    process.exit(0);
  } else {
    console.error(`FAIL — wrote "${marker}" but read "${got}"`);
    process.exit(1);
  }
}, 300);
