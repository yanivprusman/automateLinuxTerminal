// Bookmarking a session from the menu must reach the SAME flag the dashboard's
// "Bookmarked" filter reads — a private copy would tick a box here and nowhere else.
//
// So this pins the two halves of that contract:
//   - the read agrees with the store file the dashboard writes;
//   - the write is a POST the dashboard's bookmark route actually accepts, and it
//     REJECTS loudly when the dashboard is down or refuses. A silent failure would
//     leave the row ticked over a flag that was never set.
//
//   npx tsx tests/testBookmark.ts
import { readFileSync } from "fs";
import { createServer } from "http";
import type { AddressInfo } from "net";

const META = "/opt/automateLinux/data/dashboard/claude-session-meta.json";
let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

// A stub dashboard, so the write path can be checked without touching the real
// store. session.ts reads the port once, at import — hence the dynamic import below.
interface Seen { method: string; url: string; body: string }
let seen: Seen | null = null;
let status = 200;
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen = { method: req.method || "", url: req.url || "", body };
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200 }));
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = (stub.address() as AddressInfo).port;

process.env.CLAUDE_DASHBOARD_PORT = String(stubPort);
const { readBookmarkedIds, setBookmarked, DASHBOARD_PORT } = await import("../session.js");
check("test drives the stub, not the real dashboard", DASHBOARD_PORT, String(stubPort));

const ID = "11111111-2222-3333-4444-555555555555";

// 1. The wire format the dashboard's route requires: POST, boolean `bookmarked`,
//    addressed by claude session id. It answers 400 to anything else.
await setBookmarked(ID, true);
check("posts to the session's bookmark route", seen?.url, `/api/claude-sessions/${ID}/bookmark`);
check("posts", seen?.method, "POST");
check("sends bookmarked:true", seen?.body, JSON.stringify({ bookmarked: true }));
await setBookmarked(ID, false);
check("unbookmarks with the same call", seen?.body, JSON.stringify({ bookmarked: false }));

// 2. A refusal must reject — the menu puts the tick back and shows the reason.
status = 500;
const refused = await setBookmarked(ID, true).then(() => "", (e: Error) => e.message);
check("a refusing dashboard rejects", refused, "dashboard said 500");

// 3. Dashboard down is the common case (it restarts often), and must read as that
//    rather than as a mysterious network error.
await new Promise<void>((r) => stub.close(() => r()));
const down = await setBookmarked(ID, true).then(() => "", (e: Error) => e.message);
check("an absent dashboard rejects", down, "dashboard unreachable");

// 4. The read side: exactly the ids the store flags, no more.
const meta = JSON.parse(readFileSync(META, "utf-8")) as Record<string, { bookmarked?: unknown }>;
const fromFile = Object.entries(meta).filter(([, m]) => m?.bookmarked === true).map(([id]) => id).sort();
const fromApi = [...readBookmarkedIds()].sort();
check(`reads back all ${fromFile.length} bookmarked ids`, fromApi.join(","), fromFile.join(","));
check("a session nobody bookmarked is not bookmarked", readBookmarkedIds().has(ID), false);

// 5. And the real route accepts that shape. Re-bookmarking an already-bookmarked
//    session is idempotent, so this proves the endpoint without changing anything.
const live = fromFile.find((id) => /^[0-9a-f-]{36}$/.test(id));
const realPort = process.env.CLAUDE_DASHBOARD_PORT_REAL || "3007";
if (!live) {
  console.log("SKIP — no bookmarked session to re-assert against the real dashboard");
} else {
  const res = await fetch(`http://localhost:${realPort}/api/claude-sessions/${live}/bookmark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookmarked: true }),
  }).catch(() => null);
  if (!res) console.log("SKIP — dashboard not running on " + realPort);
  else check(`the real bookmark route accepts it (${live.slice(0, 8)})`, res.status, 200);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
