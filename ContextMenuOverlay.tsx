import React from "react";
import { Box, Text } from "ink";
import type { ContextMenuState, SessionHistoryEntry } from "./types.js";
import { APP_VERSION } from "./session.js";
import { SESSION_MENU_INNER, sessionMenuPad, sessionMenuBorder, muteLabelParts, muteRowColors, formatElapsed, TOPIC_VIEW_WIDTH, TOPIC_PIN_CELLS, SESSION_ID_LABEL, SESSION_CWD_LABEL, SESSION_COPY_SHORT_LABEL, sessionResumeHead, marqueeWindow, captionsLabel, replayLabel, launchLabel, exitLabel, exitProgressLabel, EXIT_SPINNER_STEP_MS, sendLabel } from "./menu.js";
import { editView } from "./topicEdit.js";
import { useMarqueeTick } from "./marquee.js";

/** What an empty topic row says it is for -- as the resting label of a tab with no topic,
 *  and as the hint beside the cursor while the field is empty and focused. One constant
 *  because the two are the same words in the same dim, and a field that invited you in
 *  with different words than the row rested under would read as two different rows. */
const TOPIC_PLACEHOLDER = "set topic…";

/** The exit row's label cell. Its own component for the same reason TopicRow is: it owns
 *  a clock (the spinner while a phase is showing), and only this cell should redraw at that
 *  rate -- the rest of the menu stays a still frame, and a resting exit row runs no timer. */
function ExitRow({ menu }: { menu: ContextMenuState }) {
  const working = !!menu.exitMsg && !menu.exitFailed;
  const tick = useMarqueeTick(working, "", EXIT_SPINNER_STEP_MS);
  const label = !menu.exitMsg ? exitLabel(menu.sessions.some(s => s.alive))
    : working ? exitProgressLabel(menu.exitMsg, tick)
    : ` ${menu.exitMsg}`;
  return (
    <Text
      backgroundColor={menu.hoverItem === 40 ? "#3465a4" : "#2d2d2d"}
      color={menu.exitFailed ? "#cc0000" : menu.exitMsg ? "#34e2e2" : "#f57900"}
    >
      {sessionMenuPad(label)}
    </Text>
  );
}

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
  // While typing, the field is anchored to the CARET rather than marqueed -- a field that
  // slides out from under the caret cannot be typed into -- and shows the cells around
  // wherever the next character will go, with a `…` on each end that still has text beyond
  // it. `editView` (topicEdit.ts) owns that window, and guarantees the caret is never the
  // cell a marker took.
  const view = menu.editingTopic ? editView(menu.editBuffer, menu.editCursor, TOPIC_VIEW_WIDTH) : null;
  const fieldWidth = SESSION_MENU_INNER - TOPIC_PIN_CELLS;
  const fieldBg = menu.hoverItem === 20 ? "#3465a4" : "#2d2d2d";
  // The row is padded to exactly `fieldWidth` however many spans it takes -- they are all
  // whitespace on the same background, so where the pad ends up draws identically. A cell
  // gained or lost here walks this row's right border off the menu.
  const spans: React.ReactNode[] = [];
  if (view) {
    // The caret is one cell. PAST the last character there is nothing to reverse, so it is
    // the block glyph this field has always drawn; OVER a character it reverses that cell,
    // which is the only way the character stays readable underneath it.
    const atEnd = menu.editCursor >= menu.editBuffer.length;
    const before = view.text.slice(0, view.caret);
    const under = view.text.slice(view.caret, view.caret + 1) || " ";
    const after = view.text.slice(view.caret + 1);
    // The words stay next to the caret while the field is empty. The menu opens with the
    // caret already in this field, so on a tab that has no topic yet -- the tab that most
    // needs telling what the row is for -- the row would otherwise be a lone block cursor
    // against 31 blank cells, and the one label that said "set topic…" would be visible only
    // AFTER you dismissed the field it was inviting you into. Drawn in the same dim as the
    // resting placeholder and after the caret, so it reads as an invitation and not as text
    // already typed: the first character replaces it.
    const rest = (menu.editBuffer === "" ? TOPIC_PLACEHOLDER : "") + " ".repeat(fieldWidth);
    spans.push(
      <Text key="before" backgroundColor={fieldBg} color="#ffffff">{before}</Text>,
      atEnd
        ? <Text key="caret" backgroundColor={fieldBg} color="#ffffff">{"█"}</Text>
        : <Text key="caret" backgroundColor="#ffffff" color="#2d2d2d">{under}</Text>,
      <Text key="after" backgroundColor={fieldBg} color="#ffffff">{after}</Text>,
      <Text key="rest" backgroundColor={fieldBg} color="#666666">
        {rest.slice(0, Math.max(0, fieldWidth - before.length - 1 - after.length))}
      </Text>,
    );
  } else {
    const resting = menu.topic ? marqueeWindow(menu.topic, TOPIC_VIEW_WIDTH, tick) : TOPIC_PLACEHOLDER;
    spans.push(
      <Text key="resting" backgroundColor={fieldBg} color={menu.topic ? "#ad7fa8" : "#666666"}>
        {(resting + " ".repeat(fieldWidth)).slice(0, fieldWidth)}
      </Text>,
    );
  }
  // The two halves highlight separately: they do different things, and this is the only
  // row in the menu where the pointer's column decides which. With unfinished typing in
  // the field the whole row commits, so the whole row lights up as one -- keyed off the
  // same pair of facts `topicRowItem` routes the click by, since the field is focused from
  // the moment the menu opens and focus alone no longer claims the row.
  const pinHover = menu.hoverItem === 21
    || (menu.editingTopic && menu.editBuffer !== menu.topic && menu.hoverItem === 20);
  return (
    <Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      <Text
        backgroundColor={pinHover ? "#3465a4" : "#2d2d2d"}
        color={menu.showTopicBar ? "#ad7fa8" : "#888888"}
      >
        {` ${menu.showTopicBar ? "☑" : "☐"} `}
      </Text>
      {spans}
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

/** A session's head row: what the session IS, and what the two things you can do to it are.
 *
 *  A LIVE session is one undivided row that copies its id, as it always was. A session that
 *  has ENDED is two halves split by the pointer's column — ` ○ resume` brings it back in
 *  this tab, `· copy 90cc2dc0` still copies the id — and they highlight separately, which
 *  is the only thing on the row that teaches the split. The topic row does exactly this
 *  with its pin box; `sessionRowAt` owns the column arithmetic for both halves so what is
 *  drawn here and what a click means cannot drift (`tests/testMenuRows.ts` pins them).
 *
 *  The dot is the resume target rather than a new row because it is already the thing that
 *  says the session is gone — and a block that grows a row per session would push the timer
 *  and the "?" further down on every open. */
function SessionHeadRow({ menu, entry, i }: { menu: ContextMenuState; entry: SessionHistoryEntry; i: number }) {
  const isCopied = menu.copiedSessionIdx === i;
  const dot = entry.alive ? '●' : '○';
  const id = entry.sessionId.slice(0, 8);
  const right = `${formatElapsed(entry.startMs)} `;
  const isHovered = menu.hoverItem === 100 + i;
  const rowBg = isCopied ? "#1a3a1a" : isHovered ? "#3465a4" : "#2d2d2d";
  const color = isCopied ? '#34e2e2' : entry.alive ? '#8ae234' : '#888888';
  const border = <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>;
  const fill = (s: string, w: number) => (s + ' '.repeat(w)).slice(0, w);
  // A refused resume reports in place, like the bookmark row two below: the state it
  // refused over (a busy shell, a session with no id yet) is the user's to clear, and a row
  // that just does nothing reads as a misclick.
  if (menu.resumeIdx === i && menu.resumeMsg) {
    return (
      <Text>{border}
        <Text backgroundColor={rowBg} color="#cc0000">{sessionMenuPad(` ${menu.resumeMsg}`)}</Text>
        {border}</Text>
    );
  }
  if (isCopied) {
    return (
      <Text>{border}
        <Text backgroundColor={rowBg} color={color}>{fill(' copied!', SESSION_MENU_INNER)}</Text>
        {border}</Text>
    );
  }
  if (entry.alive) {
    // The row says what clicking it DOES, not just which session it is: both this row and
    // the cwd under it copy the id, and nothing said so.
    const left = ` ${dot} ${SESSION_ID_LABEL} ${id}`;
    const gap = SESSION_MENU_INNER - left.length - right.length;
    return (
      <Text>{border}
        <Text backgroundColor={rowBg} color={color}>{fill(left + ' '.repeat(Math.max(1, gap)) + right, SESSION_MENU_INNER)}</Text>
        {border}</Text>
    );
  }
  const head = sessionResumeHead(dot);
  const rest = ` · ${SESSION_COPY_SHORT_LABEL} ${id}`;
  const gap = SESSION_MENU_INNER - head.length - rest.length - right.length;
  return (
    <Text>{border}
      {/* The two halves highlight SEPARATELY, as the topic row's pin and field do: it is
          the only thing on the row that shows a click here does not mean a click an inch
          to the right. So this half never borrows the copy half's hover. */}
      <Text
        backgroundColor={menu.hoverItem === 400 + i ? "#3465a4" : "#2d2d2d"}
        color="#729fcf"
      >
        {head}
      </Text>
      <Text backgroundColor={rowBg} color={color}>
        {fill(rest + ' '.repeat(Math.max(1, gap)) + right, SESSION_MENU_INNER - head.length)}
      </Text>
      {border}</Text>
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
        {/* A message INTO the claude running here: the dashboard-android "Send to session"
            popup, opened from this row (SendDialogOverlay). Its own segment, directly under
            the topic and above the voice rows: after naming the session it is what a menu
            about the session is most opened for, and everything below it only listens.
            Drawn only while a claude is running in this tab -- the one thing it can
            deliver to -- so its absence says "no claude here", and the row that starts
            one is a few rows down. White, the one plain-action colour this menu had left:
            it begins nothing (green), ends nothing (amber) and is not the voice (blue). */}
        {menu.sendRowOff >= 0 && (
          <>
            <Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
              <Text backgroundColor={menu.hoverItem === 25 ? "#3465a4" : "#2d2d2d"} color="#ffffff">
                {sessionMenuPad(sendLabel())}
              </Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
            </Text>
            <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
          </>
        )}
        {/* The voice segment: silence this tab's session, hear the last thing it said
            again, and read everything it has said aloud (the Claude Voice history window,
            narrowed to it). One row each, not one per session block — a tab hosts one live
            claude, and its voice is the voice this menu is about.

            Replay sits above captions: it is the light one — it speaks in place and the
            menu stays — and it is what someone who missed a line came here for. The row
            order is `computeMenuLayout`'s (replayRow then captionsRow); these two blocks
            are drawn in that order and nothing but that agreement keeps a click on one
            from doing the other, which is what tests/testMenuRows.ts renders and checks.

            Replay plays even when the box above is ticked: an explicit click is not a
            line arriving on its own, and refusing it silently would read as a dead row.

            The two share the segment's blue because they are one subject; they do NOT
            share a mark. ▤ is a pane of lines to read, ↻ is hearing the last one again,
            and `▸` — which both used to wear — is reserved for the messages they report
            in place. See `menu.ts` for the whole rule. */}
        {menu.sessions.length > 0 && (
          <>
            {/* The mute is THIS SESSION'S — the same per-session flag the caption's own
                button writes, so the two agree by construction. Red when ticked: a
                silenced voice should be visible at a glance, not discovered by waiting
                for a sentence that never comes.

                A global mute ("Mute all", from the phone) is disclosed on the row rather
                than folded into the box. Ticking the box for someone else's setting would
                make the click that follows a no-op, and leaving the row silent about it
                makes a working voice look broken — so the box keeps saying what THIS
                session's flag is, and the suffix says why you still hear nothing. */}
            {(() => {
              // Drawn as two spans so the two flags keep their own colour. The box is red
              // for THIS session's mute only; the suffix carries the global one. As one
              // span they shared a colour, and a global mute someone set on the phone made
              // the box red whether it was ticked or not -- the row then looked the same
              // before and after every click, which reads as a control that does nothing.
              const [box, note] = muteLabelParts(menu.voiceMuted, menu.voiceMutedAll, menu.muteMsg);
              const [boxColor, noteColor] = muteRowColors(menu.voiceMuted, menu.voiceMutedAll, menu.muteMsg);
              const padded = sessionMenuPad(box + note);   // pad ACROSS both, then re-split
              const bg = menu.hoverItem === 22 ? "#3465a4" : "#2d2d2d";
              return (
                <Text>
                  <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                  <Text backgroundColor={bg} color={boxColor}>{padded.slice(0, box.length)}</Text>
                  <Text backgroundColor={bg} color={noteColor}>{padded.slice(box.length)}</Text>
                  <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
                </Text>
              );
            })()}
            <Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
              <Text
                backgroundColor={menu.hoverItem === 24 ? "#3465a4" : "#2d2d2d"}
                color={menu.replayMsg ? "#34e2e2" : "#729fcf"}
              >
                {sessionMenuPad(menu.replayMsg ? ` ${menu.replayMsg}` : replayLabel())}
              </Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
            </Text>
            <Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
              <Text
                backgroundColor={menu.hoverItem === 23 ? "#3465a4" : "#2d2d2d"}
                color={menu.captionsMsg ? "#34e2e2" : "#729fcf"}
              >
                {sessionMenuPad(menu.captionsMsg ? ` ${menu.captionsMsg}` : captionsLabel())}
              </Text>
              <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
            </Text>
          </>
        )}
        {menu.sessions.length > 0 && (
          <>
            {/* The rule that closes the voice segment off. Below it a block per session:
                what a session IS, not what it says. */}
            <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
            {menu.sessions.map((entry, i) => {
              const isCopied = menu.copiedSessionIdx === i;
              const isHovered = menu.hoverItem === 100 + i;
              const rowBg = isCopied ? "#1a3a1a" : isHovered ? "#3465a4" : "#2d2d2d";
              return (
                <React.Fragment key={entry.sessionId}>
                  <SessionHeadRow menu={menu} entry={entry} i={i} />
                  {entry.cwd && <CwdRow cwd={entry.cwd} bg={rowBg} />}
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
        {/* Starting a claude here: `cl --dangerously-skip-permissions` typed into this tab's
            own shell, the same line by hand as by click. Green, because it is the one row in
            this menu that BEGINS something — and next to the amber row below it that is the
            whole of what the pair says at a glance.

            Its own segment, a rule apart from the exit. They are the tab's claude lifecycle
            and belong together at this end of the menu, but sharing a segment would put the
            row that ends the session immediately under a harmless one and give the two the
            same reading — which is exactly what the exit's mark and colour exist to prevent.

            It says its flag. A claude started this way does not ask before it acts, and a
            one-click row that quietly chose that would be a row lying about what it does. */}
        <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
        <Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          <Text
            backgroundColor={menu.hoverItem === 41 ? "#3465a4" : "#2d2d2d"}
            color={menu.launchMsg ? "#cc0000" : "#8ae234"}
          >
            {sessionMenuPad(menu.launchMsg ? ` ${menu.launchMsg}` : launchLabel())}
          </Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        </Text>
        {/* Ending the tab: the three presses (Ctrl+D, Ctrl+D, then out of the shell) as one
            click. Its own segment, directly above the "?" — the far end of a menu that
            opens downwards from the clock, so it is the hardest row here to hit by
            accident, but never the LAST row, because the "?" unfolds downwards and a row
            that ends the session must not slide under the pointer.

            It says which of the two things it will do (there is only a claude to exit when
            one is running here), and while it runs it says which step it is on — this can
            take seconds, and a row that goes quiet reads as a click that missed.

            It is also the only WARM row in the menu, and wears the only ✕. A rule above it
            was never enough on its own: it sat in the same blue and under the same `▸` as
            the two voice rows a few lines up, so the row that ends the tab read as a third
            harmless thing to try. Amber rather than red — red on this row means the exit
            failed, and a row resting in its failure colour cannot report one. `menu.ts`
            owns the marks and says why no two rows may share one. */}
        <Text backgroundColor="#2d2d2d" color="#888888">{`├${sessionMenuBorder}┤`}</Text>
        <Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          <ExitRow menu={menu} />
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        </Text>
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
      <Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        <Text backgroundColor={menu.hoverItem === 2 ? "#3465a4" : "#2d2d2d"} color="#ffffff">{" Say    "}</Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      </Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"╰────────╯"}</Text>
    </Box>
  );
}
