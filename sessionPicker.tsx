/**
 * Pick a Claude session by its topic, for the `claudeResume` shell function.
 *
 * Keyboard only, by design: this runs inside the embedded shell of
 * automateLinuxTerminal, whose outer app claims the wheel (scrollback) and
 * right-click (clipboard menu) before they ever reach the pty — so a
 * mouse-driven list here would silently do nothing.
 *
 * The choice goes to the --out file, never to stdout: stdout is Ink's canvas.
 * No selection written means the user quit; the caller must treat it as such.
 */
import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { loadTopicSessions, readSessionDigest, type SessionDigest, type TopicSession } from "./sessionPickerData.js";

const TOPIC_W = 24;
const AGE_W = 5;
const ID_W = 8;
/** Longest prompt excerpt shown per line of the digest panel. */
const EXCERPT_W = 220;
/** Rows the digest panel can occupy once both excerpts wrap. */
const DIGEST_ROWS = 8;
const SAY = "/root/bin/say";

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/** Truncate from the left — the tail of a path is what identifies it. */
function padPathEnd(path: string, width: number): string {
  if (width <= 1) return "";
  return path.length > width ? `…${path.slice(-(width - 1))}` : path.padEnd(width);
}

function relTime(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}

/** Spell the age out — "3h" reads aloud as "three h". */
function spokenAge(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins} minutes old`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"} old`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"} old`;
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Compose the digest for the ear, separately from the panel: paths are unspeakable
 * (per the house rule) and a full prompt is far too long to listen to.
 */
function spokenDigest(session: TopicSession, digest: SessionDigest): string {
  const forEar = (t: string) => excerpt(t.replace(/(^|\s)\/\S+/g, " a path"), 150);
  const parts = [
    `${session.topic}. ${spokenAge(session.mtimeMs)}, ${digest.userTurns} message${digest.userTurns === 1 ? "" : "s"} from you.`,
  ];
  if (digest.first) parts.push(`It started with: ${forEar(digest.first)}.`);
  if (digest.last && digest.userTurns > 1) parts.push(`Most recently: ${forEar(digest.last)}.`);
  return parts.join(" ");
}

/**
 * Fire-and-forget, detached on purpose: pressing enter right after opening a
 * digest exits the picker, and the sentence should finish anyway. `say` mutes
 * itself when the session is muted, so there is nothing to check here.
 */
function speak(text: string): void {
  if (!existsSync(SAY)) return;
  try {
    spawn(SAY, [text], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // A failed voice must never take the picker down with it.
  }
}

interface AppProps {
  sessions: TopicSession[];
  unavailable: number;
  initialFilter: string;
  outFile: string;
}

function Picker({ sessions, unavailable, initialFilter, outFile }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [filter, setFilter] = useState(initialFilter);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState("");
  const [digest, setDigest] = useState<{ session: TopicSession; data: SessionDigest } | null>(null);
  // Typing filters only inside search mode. The picker used to filter on every
  // printable key, which made single-letter commands impossible — `e` would just
  // add "e" to the search box. `/` to search is the same trade less and vim make,
  // and it buys the whole alphabet for actions.
  const [searching, setSearching] = useState(false);
  // Render one empty frame before unmounting: Ink erases the previous frame on
  // every render, so this wipes the list off the terminal. Unmounting straight
  // from a drawn frame would leave it behind, above whatever runs next.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) exit();
  }, [done, exit]);

  const cols = Math.max(40, stdout?.columns ?? 80);
  // The digest panel is drawn below the list, so the list has to give up those
  // rows — otherwise the whole frame outgrows the terminal and the top scrolls away.
  const chrome = digest ? 6 + DIGEST_ROWS : 6;
  const pageSize = Math.max(3, Math.min(15, (stdout?.rows ?? 24) - chrome));
  const pathW = Math.max(8, cols - 2 - TOPIC_W - 1 - AGE_W - 1 - ID_W - 1);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (s) =>
        s.topic.toLowerCase().includes(needle) ||
        s.cwd.toLowerCase().includes(needle) ||
        s.sessionId.startsWith(needle),
    );
  }, [sessions, filter]);

  const index = Math.min(cursor, Math.max(0, visible.length - 1));
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), visible.length - pageSize));
  const window = visible.slice(Math.max(0, start), Math.max(0, start) + pageSize);

  // Moving or filtering leaves the open digest describing a row that is no longer
  // under the cursor, so both close it.
  const move = (delta: number) => {
    if (!visible.length) return;
    setError("");
    setDigest(null);
    setCursor(Math.max(0, Math.min(index + delta, visible.length - 1)));
  };

  const changeFilter = (next: string) => {
    setError("");
    setDigest(null);
    setFilter(next);
    setCursor(0);
  };

  /** What was this session about? Read its own opening and closing words. */
  const openDigest = () => {
    const picked = visible[index];
    if (!picked) return;
    setError("");
    let data: SessionDigest;
    try {
      data = readSessionDigest(picked.file);
    } catch {
      setError(`Could not read ${picked.sessionId.slice(0, 8)}'s transcript.`);
      return;
    }
    if (!data.userTurns) {
      setError(`${picked.sessionId.slice(0, 8)} has no user messages recorded.`);
      return;
    }
    setDigest({ session: picked, data });
    speak(spokenDigest(picked, data));
  };

  const choose = () => {
    const picked = visible[index];
    if (!picked) return;
    if (!picked.cwd) {
      // Refuse rather than guess a directory: `claude --resume` run from the
      // wrong one reports the session as missing, which reads like data loss.
      setError(`No working directory recorded in ${picked.sessionId.slice(0, 8)}'s transcript — cannot resume it.`);
      return;
    }
    writeFileSync(outFile, JSON.stringify({ sessionId: picked.sessionId, cwd: picked.cwd }));
    setDone(true);
  };

  useInput((input, key) => {
    // Keys that mean the same thing in both modes.
    if (key.ctrl && input === "c") {
      setDone(true);
      return;
    }
    if (key.return) {
      choose();
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      move(-1);
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      move(1);
      return;
    }
    if (key.pageUp) {
      move(-pageSize);
      return;
    }
    if (key.pageDown) {
      move(pageSize);
      return;
    }

    if (searching) {
      if (key.escape) {
        // Leave search with the text intact; a second esc clears it (below).
        setSearching(false);
      } else if (key.backspace || key.delete) {
        changeFilter(filter.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        changeFilter(filter + input);
      }
      return;
    }

    // A fast typist or a paste arrives as ONE multi-character `input`, so a
    // command is the FIRST character, never the whole string. Comparing the
    // whole string sent "/mon" down the unknown-command path instead of opening
    // the search — the remainder has to seed the search box, not be dropped.
    const command = input.slice(0, 1);
    const rest = input.slice(1);

    if (key.escape) {
      // Unwind one layer at a time: digest, then search text, then quit.
      if (digest) setDigest(null);
      else if (filter) changeFilter("");
      else setDone(true);
    } else if (command === "/") {
      setError("");
      setSearching(true);
      if (rest) changeFilter(filter + rest);
    } else if (command === "e" || key.rightArrow) {
      openDigest();
    } else if (command === "q") {
      setDone(true);
    } else if (key.leftArrow) {
      setDigest(null);
    } else if (command && !key.ctrl && !key.meta) {
      // Say so rather than silently swallowing the key — a letter that used to
      // filter now does nothing, and that needs to be visible, not guessed at.
      setError(`"${command}" is not a command — press / to search.`);
    }
  });

  if (done) return null;

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="#ad7fa8" bold>
          resume by topic
        </Text>
        <Text color="#666666">
          {`  ${visible.length}/${sessions.length} sessions`}
          {unavailable > 0 ? ` · ${unavailable} not on this machine` : ""}
        </Text>
      </Text>

      {visible.length === 0 && <Text color="#666666">{"  no topic matches this filter"}</Text>}

      {window.map((session) => {
        const selected = session === visible[index];
        return (
          <Text key={session.sessionId} backgroundColor={selected ? "#3465a4" : undefined}>
            <Text color={selected ? "#ffffff" : "#666666"}>{selected ? "❯ " : "  "}</Text>
            <Text color={selected ? "#ffffff" : "#ad7fa8"}>{pad(session.topic, TOPIC_W)}</Text>
            <Text color={selected ? "#ffffff" : "#666666"}>{` ${relTime(session.mtimeMs).padStart(AGE_W)}`}</Text>
            <Text color={selected ? "#ffffff" : "#888888"}>{` ${padPathEnd(session.cwd, pathW)}`}</Text>
            <Text color={selected ? "#ffffff" : "#666666"}>{` ${session.sessionId.slice(0, ID_W)}`}</Text>
          </Text>
        );
      })}

      {digest && (
        <Box flexDirection="column" marginTop={1} marginLeft={2} width={cols - 4}>
          <Text>
            <Text color="#ad7fa8" bold>
              {digest.session.topic}
            </Text>
            <Text color="#666666">{`  ${digest.data.userTurns} message${digest.data.userTurns === 1 ? "" : "s"} · ${relTime(digest.session.mtimeMs)} old`}</Text>
          </Text>
          <Text color="#888888" wrap="wrap">
            <Text color="#666666">{"started  "}</Text>
            {excerpt(digest.data.first, EXCERPT_W)}
          </Text>
          {digest.data.userTurns > 1 && (
            <Text color="#888888" wrap="wrap">
              <Text color="#666666">{"latest   "}</Text>
              {excerpt(digest.data.last, EXCERPT_W)}
            </Text>
          )}
        </Box>
      )}

      {error ? (
        <Text color="#cc0000">{`  ${error}`}</Text>
      ) : (
        <Text color="#666666">
          {searching
            ? "  typing searches · ↑↓ move · enter resume · esc leave search"
            : digest
              ? "  ↑↓ move · e again for another · ← close · enter resume · esc quit"
              : "  ↑↓ move · e what was it about · / search · enter resume · q quit"}
        </Text>
      )}

      <Text>
        {/* The prompt names the mode: a "/" cursor means keys are going into the
            search, a "›" means they are commands. Without it, a picker that
            sometimes filters and sometimes doesn't is indistinguishable from broken. */}
        <Text color={searching ? "#ad7fa8" : "#666666"}>{searching ? "  /" : "  ›"}</Text>
        <Text color="#ffffff">{` ${filter}`}</Text>
        {searching && <Text color="#ad7fa8">▏</Text>}
        {!searching && filter && <Text color="#666666">{"  (filtered)"}</Text>}
      </Text>
    </Box>
  );
}

function argValue(flag: string): string {
  const at = process.argv.indexOf(flag);
  return at === -1 ? "" : process.argv[at + 1] ?? "";
}

const outFile = argValue("--out");
if (!outFile) {
  console.error("sessionPicker: --out <file> is required");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error("sessionPicker: needs an interactive terminal");
  process.exit(2);
}

const { sessions, unavailable } = loadTopicSessions();
if (sessions.length === 0) {
  console.error(
    unavailable > 0
      ? `sessionPicker: none of the ${unavailable} topics have a transcript on this machine`
      : "sessionPicker: no sessions have a topic yet — set one from the session menu (right-click the clock)",
  );
  process.exit(2);
}

const instance = render(
  <Picker sessions={sessions} unavailable={unavailable} initialFilter={argValue("--filter")} outFile={outFile} />,
  { exitOnCtrlC: false },
);
await instance.waitUntilExit();
