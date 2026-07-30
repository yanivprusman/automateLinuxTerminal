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
import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { loadTopicSessions, readSessionDigest, type SessionDigest, type TopicSession } from "./sessionPickerData.js";

const TOPIC_W = 24;
const AGE_W = 5;
const ID_W = 8;
/** Rows the summary panel can occupy once the text wraps. */
const DIGEST_ROWS = 8;
const SAY = "/root/bin/say";
/**
 * The binary, by absolute path, and never the `claude` shell function: the
 * function re-enters itself in a non-interactive child (BASH_ENV re-defines it),
 * which forkbombed a past session into ~680 processes. spawn() with no shell
 * cannot hit that, and an absolute path survives a stripped PATH.
 */
const CLAUDE = "/root/.local/bin/claude";
/** Startup dominates a one-shot; haiku keeps the rest of it short. */
const SUMMARY_MODEL = "haiku";
/** A summary that takes this long has failed at being a glance. */
const SUMMARY_TIMEOUT_MS = 90_000;

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

/**
 * Ask a Claude session what this session was about.
 *
 * The transcript itself is never sent — they reach 70MB, past any context window
 * — so the model gets the user's own turns (see readSessionDigest's sample) and
 * summarizes those. Output is written for the ear as well as the screen, because
 * the same string is spoken: no paths, no identifiers, nothing unpronounceable.
 */
function summaryPrompt(session: TopicSession, digest: SessionDigest): string {
  return [
    `Below are the messages a user sent during one Claude Code session, oldest first.`,
    `The session is labelled "${session.topic}". Long sessions are abridged: you may be seeing`,
    `the opening and closing stretches with the middle omitted, and each message clipped.`,
    ``,
    `Write 2-3 sentences telling the user what this session was about, what came of it, and`,
    `anything left unfinished. Address them as "you". Lead with the outcome.`,
    ``,
    `It will be read aloud as well as displayed, so write it to be spoken: no file paths, no`,
    `code, no commit hashes, no identifiers, and round any numbers. Reply with the summary`,
    `text alone — no preamble, no heading, no bullet points, no closing question.`,
    ``,
    `--- messages ---`,
    ...digest.sample.map((t) => `- ${t}`),
  ].join("\n");
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

interface Summary {
  session: TopicSession;
  digest: SessionDigest;
  status: "thinking" | "ready" | "failed";
  startedAt: number;
  text: string;
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
  const [digest, setDigest] = useState<Summary | null>(null);
  const child = useRef<ReturnType<typeof spawn> | null>(null);
  // Re-render once a second while waiting so the elapsed counter moves — a
  // frozen "asking claude" is indistinguishable from a hung one.
  const [, tick] = useState(0);
  useEffect(() => {
    if (digest?.status !== "thinking") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [digest?.status]);
  // A summary nobody is waiting for is just a stray process holding the model.
  useEffect(
    () => () => {
      child.current?.kill();
    },
    [],
  );
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

  /** What was this session about? Ask a Claude session to read it back to you. */
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
    if (!data.sample.length) {
      setError(`${picked.sessionId.slice(0, 8)} has no user messages to summarize.`);
      return;
    }

    // Whatever was already running is now answering a question nobody asked.
    child.current?.kill();
    setDigest({ session: picked, digest: data, status: "thinking", startedAt: Date.now(), text: "" });

    // cwd is deliberately the picker's own directory, not the session's: claude
    // loads the CLAUDE.md of wherever it starts, and pulling a whole project's
    // instructions into a one-line summary costs seconds and tokens for nothing.
    const proc = spawn(CLAUDE, ["-p", "--model", SUMMARY_MODEL, summaryPrompt(picked, data)], {
      // stdin ignored on purpose: `claude -p` waits on it, and an inherited stdin
      // is this picker's keyboard — it would eat the keys and stall for seconds.
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.current = proc;

    let out = "";
    let err = "";
    proc.stdout?.on("data", (b) => (out += b.toString()));
    proc.stderr?.on("data", (b) => (err += b.toString()));

    const timer = setTimeout(() => proc.kill(), SUMMARY_TIMEOUT_MS);

    const settle = (status: "ready" | "failed", text: string) => {
      clearTimeout(timer);
      if (child.current !== proc) return; // superseded by a newer request
      child.current = null;
      setDigest((prev) => (prev && prev.session === picked ? { ...prev, status, text } : prev));
      if (status === "ready") speak(text);
    };

    proc.on("error", (e) => settle("failed", `Could not run claude: ${e.message}`));
    proc.on("close", (code) => {
      const text = out.trim();
      if (code === 0 && text) settle("ready", text);
      else settle("failed", err.trim().split("\n")[0] || `claude exited ${code} with no output.`);
    });
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
            <Text color="#666666">{`  ${digest.digest.userTurns} message${digest.digest.userTurns === 1 ? "" : "s"} · ${relTime(digest.session.mtimeMs)} old`}</Text>
          </Text>
          {digest.status === "thinking" ? (
            <Text color="#666666">
              {`asking claude (${SUMMARY_MODEL})… ${Math.round((Date.now() - digest.startedAt) / 1000)}s`}
            </Text>
          ) : (
            <Text color={digest.status === "failed" ? "#cc0000" : "#888888"} wrap="wrap">
              {digest.text}
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
