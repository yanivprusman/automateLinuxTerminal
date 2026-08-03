import React from "react";
import { Box, Text } from "ink";
import type { ContextMenuState } from "./types.js";
import { APP_VERSION } from "./session.js";
import { SESSION_MENU_INNER, sessionMenuPad, sessionMenuBorder, formatElapsed, TOPIC_VIEW_WIDTH, TOPIC_PIN_CELLS, SESSION_ID_LABEL, SESSION_CWD_LABEL, marqueeWindow, editWindow } from "./menu.js";
import { useMarqueeTick } from "./marquee.js";

/** The topic field: the pin box and the topic itself, on ONE row, closed off by a rule.
 *
 *  Setting a topic and pinning it are one thing done in two steps, and as two rows the
 *  checkbox read as a separate setting that happened to sit nearby. Here the box is in
 *  front of the text it pins, so what it pins needs no label — and what it does is visible
 *  the moment it is clicked, in the sign that appears on (or leaves) the terminal.
 *
 *  A topic wider than the row is not cut off with an ellipsis — it scrolls, like a sign,
 *  so the whole of it can be read from a menu that stays 30 columns wide.
 *
 *  It is its own component because it owns the scroll clock: only this row re-renders at
 *  5 Hz, and only while there is something out of view. The rest of the menu stays a still
 *  frame, and a topic that fits redraws exactly as rarely as it did before. */
function TopicRow({ menu }: { menu: ContextMenuState }) {
  const scrolls = !menu.editingTopic && menu.topic.length > TOPIC_VIEW_WIDTH;
  const tick = useMarqueeTick(scrolls, menu.topic);
  // While typing, the tail is what matters (the cursor is there), so the field scrolls to
  // the cursor instead of marqueeing; the block cursor takes the last cell.
  const field = menu.editingTopic
    ? `${editWindow(menu.editBuffer, TOPIC_VIEW_WIDTH - 1)}█`
    : menu.topic
      ? marqueeWindow(menu.topic, TOPIC_VIEW_WIDTH, tick)
      : "set topic…";
  const fieldWidth = SESSION_MENU_INNER - TOPIC_PIN_CELLS;
  // The two halves highlight separately: they do different things, and this is the only
  // row in the menu where the pointer's column decides which. Mid-edit the whole row
  // commits, so the whole row lights up as one.
  const pinHover = menu.hoverItem === 21 || (menu.editingTopic && menu.hoverItem === 20);
  return (
    <Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      <Text
        backgroundColor={pinHover ? "#3465a4" : "#2d2d2d"}
        color={menu.showTopicBar ? "#ad7fa8" : "#888888"}
      >
        {` ${menu.showTopicBar ? "☑" : "☐"} `}
      </Text>
      <Text
        backgroundColor={menu.hoverItem === 20 ? "#3465a4" : "#2d2d2d"}
        color={menu.editingTopic ? "#ffffff" : (menu.topic ? "#ad7fa8" : "#666666")}
      >
        {(field + " ".repeat(fieldWidth)).slice(0, fieldWidth)}
      </Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
    </Text>
  );
}

/** Where a session was launched from, as a scrolling sign.
 *
 *  A path is unbounded, the menu is not, and the old row cut the head off with a leading
 *  "…" — which threw away exactly the part that distinguishes `/opt/dev/x` from
 *  `/opt/prod/x`. It scrolls now, on the same clock and with the same hold-at-the-head as
 *  the topic, so the whole of it can be read from a row that stays put.
 *
 *  Its own component for the same reason TopicRow is: only a row with something out of
 *  view may run a timer, because every tick repaints a frame over a live terminal. */
function CwdRow({ cwd, bg }: { cwd: string; bg: string }) {
  const text = `${SESSION_CWD_LABEL} ${cwd}`;
  const width = SESSION_MENU_INNER - 2;      // one space in from each border
  const tick = useMarqueeTick(text.length > width, text);
  return (
    <Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      <Text backgroundColor={bg} color="#c4a000">{sessionMenuPad(` ${marqueeWindow(text, width, tick)}`)}</Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
    </Text>
  );
}

export function ContextMenuOverlay({ menu }: { menu: ContextMenuState }) {
  if (menu.kind === 'automateLinuxTerminalMenu') {
    const titleLeft = ' automateLinuxTerminal';
    const titleRight = APP_VERSION ? APP_VERSION + ' ' : '';
    const titleGap = SESSION_MENU_INNER - titleLeft.length - titleRight.length;
    const titleStr = titleLeft + ' '.repeat(Math.max(1, titleGap)) + titleRight;
    return (
      <Box position="absolute" marginTop={menu.row} marginLeft={menu.col} flexDirection="column">
        <Text backgroundColor="#2d2d2d" color="#888888">{`╭${sessionMenuBorder}╮`}</Text>
        <TopicRow menu={menu} />
        {/* The rule that closes the topic field off. Everything under it is about
            sessions and the app; above it there is one thing, and it now ends somewhere
            visible instead of running into the next checkbox. */}
        <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
        {/* The claude-voice global mute — the same flag as the caption button and the
            phone, so this box shows whatever surface last flipped it. Red when ticked:
            a silenced voice should be visible at a glance, not discovered by waiting
            for a sentence that never comes. */}
        <Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          <Text
            backgroundColor={menu.hoverItem === 22 ? "#3465a4" : "#2d2d2d"}
            color={menu.muteMsg ? "#cc0000" : menu.voiceMuted ? "#cc0000" : "#888888"}
          >
            {sessionMenuPad(menu.muteMsg ? ` ${menu.muteMsg}` : menu.voiceMuted ? " ☑ mute voice" : " ☐ mute voice")}
          </Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        </Text>
        {/* No rule here: the mute above and everything below it are one segment. What is
            said aloud is one subject, and a line across it read as a change of subject. */}
        {menu.sessions.length > 0 && (
          <>
            {menu.sessions.map((entry, i) => {
              const isCopied = menu.copiedSessionIdx === i;
              const dot = entry.alive ? '●' : '○';
              const id = entry.sessionId.slice(0, 8);
              const elapsed = formatElapsed(entry.startMs);
              // The row says what clicking it DOES, not just which session it is: both this
              // row and the cwd under it copy the id, and nothing said so.
              const left = ` ${dot} ${SESSION_ID_LABEL} ${id}`;
              const right = `${elapsed} `;
              const gap = SESSION_MENU_INNER - left.length - right.length;
              const normalText = left + ' '.repeat(Math.max(1, gap)) + right;
              const copiedLabel = ' copied!';
              const copiedText = copiedLabel + ' '.repeat(Math.max(0, SESSION_MENU_INNER - copiedLabel.length));
              const color = isCopied ? '#34e2e2' : entry.alive ? '#8ae234' : '#888888';
              const isHovered = menu.hoverItem === 100 + i;
              const rowBg = isCopied ? "#1a3a1a" : isHovered ? "#3465a4" : "#2d2d2d";
              return (
                <React.Fragment key={entry.sessionId}>
                  <Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                    <Text backgroundColor={rowBg} color={color}>{(isCopied ? copiedText : (normalText + ' '.repeat(SESSION_MENU_INNER))).slice(0, SESSION_MENU_INNER)}</Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                  </Text>
                  {entry.cwd && <CwdRow cwd={entry.cwd} bg={rowBg} />}
                  {/* Everything this session has said aloud, in the Claude Voice history
                      window, narrowed to this session alone. */}
                  <Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                    <Text
                      backgroundColor={menu.hoverItem === 200 + i ? "#3465a4" : "#2d2d2d"}
                      color={menu.captionsIdx === i ? "#34e2e2" : "#729fcf"}
                    >
                      {sessionMenuPad(menu.captionsIdx === i ? ` ${menu.captionsMsg}` : " ▸ captions")}
                    </Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                  </Text>
                  {/* Say the last thing THIS session said, again — under the captions row
                      because they are one subject read two ways: what was said, and the
                      last of it once more. It plays even when the voice is muted (the
                      checkbox two rows up): an explicit click is not a line arriving on
                      its own, and refusing it silently would read as a dead row. */}
                  <Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                    <Text
                      backgroundColor={menu.hoverItem === 400 + i ? "#3465a4" : "#2d2d2d"}
                      color={menu.replayIdx === i ? "#34e2e2" : "#729fcf"}
                    >
                      {sessionMenuPad(menu.replayIdx === i ? ` ${menu.replayMsg}` : " ▸ replay last caption")}
                    </Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                  </Text>
                  {/* Keep this session — the dashboard's own bookmark flag, so a session
                      ticked here is the one its "Bookmarked" filter lists. Drawn with the
                      same checkbox as "pin topic" below: both are state, not actions —
                      and in the same column as it, so the two boxes line up. Every row in
                      this menu starts one space in; the session's ●/○ head, not an indent,
                      is what marks where one session's block begins. */}
                  <Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                    <Text
                      backgroundColor={menu.hoverItem === 300 + i ? "#3465a4" : "#2d2d2d"}
                      color={menu.bookmarkIdx === i ? "#cc0000" : entry.bookmarked ? "#edd400" : "#888888"}
                    >
                      {sessionMenuPad(menu.bookmarkIdx === i
                        ? ` ${menu.bookmarkMsg}`
                        : entry.bookmarked ? " ☑ bookmarked" : " ☐ bookmark")}
                    </Text>
                    <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                  </Text>
                </React.Fragment>
              );
            })}
          </>
        )}
        {menu.stopwatchDisplay != null && (
          <>
            <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
            <Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
              <Text backgroundColor={menu.hoverItem === 10 ? "#3465a4" : "#2d2d2d"} color={menu.stopwatchAction === 'stop' ? "#8ae234" : "#c4a000"}>{(() => {
                const left = ` timer: ${menu.stopwatchDisplay}`;
                const right = `${menu.stopwatchAction} `;
                const gap = SESSION_MENU_INNER - left.length - right.length;
                return left + ' '.repeat(Math.max(1, gap)) + right;
              })()}</Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
            </Text>
          </>
        )}
        {/* What this menu is, and which version of it, used to hold the top row of every
            open. It is reference, not something anyone came here to click, so it sits
            behind this "?" and unfolds in place — and it sits LAST, so the row people do
            come here for is the one under the pointer, not one pushed down by this. */}
        <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
        <Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          <Text
            backgroundColor={menu.hoverItem === 30 ? "#3465a4" : "#2d2d2d"}
            color={menu.infoOpen ? "#8ae234" : "#888888"}
          >
            {sessionMenuPad(" ?")}
          </Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        </Text>
        {menu.infoOpen && (
          <Text>
            <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
            <Text backgroundColor={menu.hoverItem === 31 ? "#3465a4" : "#2d2d2d"} color="#8ae234">{titleStr}</Text>
            <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          </Text>
        )}
        <Text backgroundColor="#2d2d2d" color="#888888">{`╰${sessionMenuBorder}╯`}</Text>
      </Box>
    );
  }
  const copyColor = menu.hasSelection ? "#ffffff" : "#666666";
  return (
    <Box position="absolute" marginTop={menu.row} marginLeft={menu.col} flexDirection="column">
      <Text backgroundColor="#2d2d2d" color="#888888">{"╭────────╮"}</Text>
      <Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        <Text backgroundColor={menu.hoverItem === 0 ? "#3465a4" : "#2d2d2d"} color={copyColor}>{" Copy   "}</Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      </Text>
      <Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        <Text backgroundColor={menu.hoverItem === 1 ? "#3465a4" : "#2d2d2d"} color="#ffffff">{" Paste  "}</Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      </Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"╰────────╯"}</Text>
    </Box>
  );
}
