import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";

// Clipboard tooling. This app runs on a GNOME *Wayland* session (often as root),
// where xclip can't reach XWayland unless XAUTHORITY is exported into the env —
// which it isn't in the terminal's environment. That made xclip exit 1
// ("Invalid MIT-MAGIC-COOKIE-1 / Can't open display :0") and silently broke BOTH
// copy and paste. Use the native Wayland tools (wl-copy/wl-paste) when on Wayland;
// they need only a wayland socket + XDG_RUNTIME_DIR, no X auth. Fall back to xclip
// only on a real X11 session, where XAUTHORITY is present.
//
// Detect Wayland by the SOCKET, not just $WAYLAND_DISPLAY. On some sessions the
// var is never exported into the terminal's environment (e.g. the NUC's root
// GNOME session — it's absent from `systemctl --user show-environment` and from
// gnome-shell's own env). Keying off the var alone made those boxes fall back to
// xclip → silent failure. So we look for a live `wayland-*` socket in
// XDG_RUNTIME_DIR, and when the var is unset we pass the discovered socket name
// to the spawned tools explicitly (rather than leaning on libwayland's
// wayland-0 default). See memory reference_wayland_clipboard_no_xauthority.
const XDG_RUNTIME_DIR =
  process.env.XDG_RUNTIME_DIR ||
  (process.getuid ? `/run/user/${process.getuid()}` : "");

function detectWaylandSocket(): string | null {
  const fromEnv = process.env.WAYLAND_DISPLAY;
  if (fromEnv) {
    // May be an absolute path or a name relative to XDG_RUNTIME_DIR.
    if (fromEnv.startsWith("/")) return existsSync(fromEnv) ? fromEnv : null;
    return existsSync(`${XDG_RUNTIME_DIR}/${fromEnv}`) ? fromEnv : null;
  }
  if (!XDG_RUNTIME_DIR) return null;
  try {
    return (
      readdirSync(XDG_RUNTIME_DIR).find(
        (f) => f.startsWith("wayland-") && !f.endsWith(".lock"),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export const WAYLAND_SOCKET = detectWaylandSocket();
export const ON_WAYLAND = WAYLAND_SOCKET !== null;

const CLIPBOARD_WRITE_CMD: string[] = ON_WAYLAND
  ? ["wl-copy"]
  : ["xclip", "-selection", "clipboard"];
const CLIPBOARD_READ_CMD: string[] = ON_WAYLAND
  ? ["wl-paste", "-n"]
  : ["xclip", "-selection", "clipboard", "-o"];

// Env for clipboard spawns: guarantee wl-copy/wl-paste can reach the compositor
// even when WAYLAND_DISPLAY wasn't exported into our own environment.
const CLIPBOARD_ENV: NodeJS.ProcessEnv = ON_WAYLAND
  ? { ...process.env, XDG_RUNTIME_DIR, WAYLAND_DISPLAY: WAYLAND_SOCKET! }
  : process.env;

// Spawn the clipboard writer and feed it `text`. Best-effort: clipboard failures
// must never crash the terminal.
export function clipboardWrite(text: string): void {
  const [cmd, ...args] = CLIPBOARD_WRITE_CMD;
  const clip = spawn(cmd, args, {
    stdio: ["pipe", "ignore", "ignore"],
    env: CLIPBOARD_ENV,
  });
  clip.on("error", () => {});
  clip.stdin.on("error", () => {});
  clip.stdin.end(text);
}

// Read the clipboard. Resolves to its contents ("" on any failure). Best-effort:
// a missing/failing tool never rejects, so callers can't crash the terminal.
export function clipboardRead(): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, ...args] = CLIPBOARD_READ_CMD;
    const clip = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: CLIPBOARD_ENV,
    });
    clip.on("error", () => resolve(""));
    let data = "";
    clip.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    clip.on("close", () => resolve(data));
  });
}
