import React from "react";
import { Box, Text } from "ink";
import type { SendDialogState, SendButton } from "./sendToSession.js";
import {
  computeSendLayout, sendTitle, sendHint, sendErrorLine, writeRowButtons, actionRowButtons,
  buttonCells, UNDO_BUTTON, SEND_ITEM, SEND_DIALOG_INNER, sendPad, sendBorder,
  FIELD_WIDTH, FIELD_MIN_ROWS, FIELD_MAX_ROWS, wrapField, visualRows, addingOn,
} from "./sendToSession.js";

// The "send to session" dialog, drawn. What each row IS lives in sendToSession.ts
// (computeSendLayout, the button rows, the field's wrap); this only paints what that says,
// row by row, so the hit-test and the pixels cannot disagree (tests/testSendDialogRows.ts
// renders this and asserts they don't).
//
// The menu's palette, on purpose -- it opens from that menu and should read as the same
// surface: its grey, its hover blue, its dim, its red for "something went wrong", its cyan
// for "something is happening", its green for the one thing that dispatches.

const BG = "#2d2d2d", BORDER = "#888888", HOVER = "#3465a4", DIM = "#888888", DISABLED = "#555753";
const WHITE = "#ffffff", RED = "#cc0000", MIC = "#ef2929", GREEN = "#8ae234", PURPLE = "#ad7fa8";
const BLUE = "#729fcf", CYAN = "#34e2e2", FIELD_BG = "#1c1c1c";

/** A string cut to `width` cells with a `…` where it was cut. Every row here is a fixed
 *  width, and an error from a server can be any length. */
export function fit(s: string, width: number): string {
  if (s.length <= width) return s;
  return width <= 0 ? "" : s.slice(0, Math.max(0, width - 1)) + "…";
}

const Border = () => <Text backgroundColor={BG} color={BORDER}>{"│"}</Text>;

function Row({ children }: { children: React.ReactNode }) {
  return <Text><Border />{children}<Border /></Text>;
}

/** One row of one colour, padded to the dialog's width. */
function Plain({ text, color, bold = false }: { text: string; color: string; bold?: boolean }) {
  return <Row><Text backgroundColor={BG} color={color} bold={bold}>{sendPad(fit(text, SEND_DIALOG_INNER))}</Text></Row>;
}

const buttonColor = (b: SendButton): string => {
  if (!b.enabled) return DISABLED;
  switch (b.item) {
    case SEND_ITEM.send: case SEND_ITEM.done: return GREEN;
    case SEND_ITEM.insert: return WHITE;
    case SEND_ITEM.cancel: case SEND_ITEM.skip: case SEND_ITEM.close: return DIM;
    default: return BLUE;    // the write row: one subject, one colour
  }
};

/** A row of buttons, each on the cells `buttonCells` says it owns, each lit on its own
 *  when the pointer is over it. The gaps between are dead cells, and drawn as such. */
function ButtonRow({ buttons, hover }: { buttons: SendButton[]; hover: number }) {
  const cells = buttonCells(buttons);
  const spans: React.ReactNode[] = [];
  let x = 0;
  cells.forEach((c, i) => {
    if (c.start > x) spans.push(<Text key={`g${i}`} backgroundColor={BG}>{" ".repeat(c.start - x)}</Text>);
    const b = buttons[i];
    spans.push(
      <Text key={`b${i}`} backgroundColor={hover === b.item && b.enabled ? HOVER : BG} color={buttonColor(b)}>
        {b.text}
      </Text>,
    );
    x = c.end;
  });
  spans.push(<Text key="pad" backgroundColor={BG}>{" ".repeat(Math.max(0, SEND_DIALOG_INNER - x))}</Text>);
  return <Row>{spans}</Row>;
}

/** Which session this is for: the dot the session rows wear, the topic in the topic's own
 *  purple, and the id it is filed under. The dialog is only ever opened for a running
 *  session, so the dot is the live one. */
function LabelRow({ s }: { s: SendDialogState }) {
  const id = s.sessionId.slice(0, 8);
  const tail = s.topic ? ` · ${id}` : id;
  const topic = s.topic ? fit(s.topic, SEND_DIALOG_INNER - 3 - tail.length) : "";
  const used = 3 + topic.length + tail.length;
  return (
    <Row>
      <Text backgroundColor={BG} color={GREEN}>{" ● "}</Text>
      <Text backgroundColor={BG} color={PURPLE}>{topic}</Text>
      <Text backgroundColor={BG} color={DIM}>{tail + " ".repeat(Math.max(0, SEND_DIALOG_INNER - used))}</Text>
    </Row>
  );
}

/** The message box: the wrapped rows `wrapField` chose, the caret drawn the way the topic
 *  field draws it (a block past the last character, a reversed cell over one), and a `…`
 *  in the corner of a row that has more of the message beyond it -- never on the caret's
 *  cell, for the reason editView gives: a caret drawn as `…` is a caret you cannot find. */
function FieldRows({ s }: { s: SendDialogState }) {
  const w = wrapField(s.transcript, s.cursor, FIELD_WIDTH, FIELD_MIN_ROWS, FIELD_MAX_ROWS);
  const atEnd = s.cursor >= s.transcript.length;
  return (
    <>
      {w.rows.map((rowText, i) => {
        const caretHere = i === w.caretRow;
        let cells = (rowText + " ".repeat(FIELD_WIDTH)).slice(0, FIELD_WIDTH);
        if (i === 0 && w.top > 0 && !(caretHere && w.caretCol === 0)) cells = "…" + cells.slice(1);
        if (i === w.visible - 1 && w.top + w.visible < w.total && !(caretHere && w.caretCol === FIELD_WIDTH - 1))
          cells = cells.slice(0, FIELD_WIDTH - 1) + "…";
        const spans: React.ReactNode[] = [];
        if (caretHere) {
          const before = cells.slice(0, w.caretCol);
          const under = cells.slice(w.caretCol, w.caretCol + 1) || " ";
          const after = cells.slice(w.caretCol + 1);
          spans.push(
            <Text key="b" backgroundColor={FIELD_BG} color={WHITE}>{before}</Text>,
            atEnd
              ? <Text key="c" backgroundColor={FIELD_BG} color={WHITE}>{"█"}</Text>
              : <Text key="c" backgroundColor={WHITE} color={FIELD_BG}>{under}</Text>,
            <Text key="a" backgroundColor={FIELD_BG} color={WHITE}>{after}</Text>,
          );
        } else {
          spans.push(<Text key="t" backgroundColor={FIELD_BG} color={WHITE}>{cells}</Text>);
        }
        return (
          <Row key={i}>
            <Text backgroundColor={BG}>{" "}</Text>
            {spans}
            <Text backgroundColor={BG}>{" "}</Text>
          </Row>
        );
      })}
    </>
  );
}

/** What the spelling fixer just did, under the words it did it to -- and, while the
 *  message is still exactly as it left it, the way back out at the row's right end. */
function NoteRow({ s }: { s: SendDialogState }) {
  const undo = s.beforeFix !== null;
  const room = SEND_DIALOG_INNER - 1 - (undo ? UNDO_BUTTON.text.length + 2 : 0);
  const note = " " + fit(s.fixNote ?? "", room - 1);
  const gap = SEND_DIALOG_INNER - note.length - (undo ? UNDO_BUTTON.text.length + 1 : 0);
  return (
    <Row>
      <Text backgroundColor={BG} color={s.fixFailed ? RED : DIM}>{note + " ".repeat(Math.max(0, gap))}</Text>
      {undo && (
        <>
          <Text backgroundColor={s.hoverItem === SEND_ITEM.undo ? HOVER : BG} color={BLUE}>{UNDO_BUTTON.text}</Text>
          <Text backgroundColor={BG}>{" "}</Text>
        </>
      )}
    </Row>
  );
}

/** The last rows of the message, dim, while more of it is being dictated. */
function EchoRows({ s, rows }: { s: SendDialogState; rows: number }) {
  const chunks = visualRows(s.transcript, FIELD_WIDTH).map(r => s.transcript.slice(r.start, r.end));
  const shown = chunks.slice(-rows);
  return (
    <>
      {shown.map((c, i) => (
        <Row key={i}>
          <Text backgroundColor={BG} color={DIM}>{sendPad(" " + (i === 0 && chunks.length > rows ? "…" + c.slice(1) : c))}</Text>
        </Row>
      ))}
    </>
  );
}

export function SendDialogOverlay({ state: s }: { state: SendDialogState }) {
  const layout = computeSendLayout(s);
  const rule = <Text backgroundColor={BG} color={BORDER}>{`${sendBorder}`}</Text>;
  const error = sendErrorLine(s);
  // The body line under the label: what to do now, or what is happening -- the menu's
  // language for the latter (`▸`, cyan), a live mic in the mic's own red, a failure in red.
  const hint = sendHint(s);
  const hintRow = s.phase === 'recording'
    ? <Plain text={` ◉ ${hint}`} color={MIC} />
    : s.phase === 'transcribing' || s.phase === 'sending'
      ? <Plain text={` ▸ ${hint}`} color={CYAN} />
      : s.phase === 'failed'
        ? <Plain text={` ${hint}`} color={RED} />
        : <Plain text={` ${hint}`} color={DIM} />;
  return (
    <Box position="absolute" marginTop={s.row} marginLeft={s.col} flexDirection="column">
      <Text backgroundColor={BG} color={BORDER}>{"╭"}{rule}{"╮"}</Text>
      <Plain text={` ${sendTitle(s)}`} color={WHITE} bold />
      <LabelRow s={s} />
      {error !== null && <Plain text={` ${error}`} color={RED} />}
      {layout.hintRow >= 0 && hintRow}
      {layout.fieldRow >= 0 && <FieldRows s={s} />}
      {layout.echoRow >= 0 && <EchoRows s={s} rows={layout.echoRows} />}
      {layout.noteRow >= 0 && <NoteRow s={s} />}
      {layout.writeRow >= 0 && <ButtonRow buttons={writeRowButtons(s)} hover={s.hoverItem} />}
      {layout.actionRow >= 0 && <ButtonRow buttons={actionRowButtons(s)} hover={s.hoverItem} />}
      <Text backgroundColor={BG} color={BORDER}>{"╰"}{rule}{"╯"}</Text>
    </Box>
  );
}

// `addingOn` is part of what the recording rows say; re-exported so a host that renders
// this dialog can ask the same question the overlay does.
export { addingOn };
