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
import { writeFileSync } from "fs";
import { loadTopicSessions, type TopicSession } from "./sessionPickerData.js";

const TOPIC_W = 24;
const AGE_W = 5;
const ID_W = 8;

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
  // Render one empty frame before unmounting: Ink erases the previous frame on
  // every render, so this wipes the list off the terminal. Unmounting straight
  // from a drawn frame would leave it behind, above whatever runs next.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) exit();
  }, [done, exit]);

  const cols = Math.max(40, stdout?.columns ?? 80);
  const pageSize = Math.max(5, Math.min(15, (stdout?.rows ?? 24) - 6));
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

  const move = (delta: number) => {
    if (!visible.length) return;
    setError("");
    setCursor(Math.max(0, Math.min(index + delta, visible.length - 1)));
  };

  const changeFilter = (next: string) => {
    setError("");
    setFilter(next);
    setCursor(0);
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
    if (key.ctrl && input === "c") {
      setDone(true);
    } else if (key.escape) {
      if (filter) changeFilter("");
      else setDone(true);
    } else if (key.return) {
      choose();
    } else if (key.upArrow || (key.ctrl && input === "p")) {
      move(-1);
    } else if (key.downArrow || (key.ctrl && input === "n")) {
      move(1);
    } else if (key.pageUp) {
      move(-pageSize);
    } else if (key.pageDown) {
      move(pageSize);
    } else if (key.backspace || key.delete) {
      changeFilter(filter.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && !key.tab) {
      changeFilter(filter + input);
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

      {error ? (
        <Text color="#cc0000">{`  ${error}`}</Text>
      ) : (
        <Text color="#666666">{"  ↑↓ move · type to filter · enter resume · esc clear/quit"}</Text>
      )}

      <Text>
        <Text color="#666666">{"  filter: "}</Text>
        <Text color="#ffffff">{filter}</Text>
        <Text color="#ad7fa8">▏</Text>
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
