import type { ShellState } from "./resume.js";
import type { TopicField } from "./topicEdit.js";
import { SEND_LABEL } from "./menu.js";

// The "send to session" dialog: the dashboard-android popup (TalkSessionDialog, driven by
// TalkViewModel), on this surface. A message is composed -- typed, dictated through whisper,
// or both -- corrected in place if wanted, and then put into the claude running in THIS
// TAB, either typed and submitted (send) or typed and left at the prompt (insert).
//
// Same flow, same words, same guarantees as the phone, on purpose: a Send that behaves
// differently depending on which surface it was pressed on is the bug the phone's dialog
// was written to end. Every transition below is the phone's, translated -- and the
// controller at the bottom (SendFlow) takes its world as an interface so the whole flow
// can be driven in a test without a microphone, whisper, or a claude (tests/testSendToSession.ts),
// exactly as the exit sequence does (exit.ts / testExit.ts).
//
// What is deliberately NOT here: "Type in terminal". The phone offers it because its popup
// sits over a terminal the keyboard cannot otherwise reach; here the terminal is under the
// dialog and gets the keyboard the moment the dialog closes. Cancel with an empty box IS
// "type in terminal", and Insert IS "continue in terminal" -- the words go in unsent and
// the caret is at the end of them.

export type SendPhase = 'confirm' | 'recording' | 'transcribing' | 'sending' | 'failed';

export interface SendDialogState {
  /** The session the message is for -- the tab's own (menu.ts currentSessionId). */
  sessionId: string;
  /** Its topic, for the label under the title. '' when it has none. */
  topic: string;
  phase: SendPhase;
  /** The message: transcribed, typed, or both. */
  transcript: string;
  /** Characters to the LEFT of the caret (the same field as the topic's, topicEdit.ts). */
  cursor: number;
  /** What went wrong, read with `phase`: on 'failed' the mic or the transcription, with
   *  no words to keep; on 'confirm' the delivery -- the words are still here and Send is a
   *  retry -- unless `dictationFailed` says it was a reopened mic that added nothing. */
  error: string | null;
  dictationFailed: boolean;
  /** Reached the confirm step without a word from the mic: the hint says "type". Sticky
   *  for the whole step -- the first character typed would otherwise flip the wording. */
  typed: boolean;
  /** The spelling fixer has the message right now. */
  fixing: boolean;
  /** What the fixer did, in its own words ("lables → labels", "Nothing to fix", or why it
   *  refused -- see `fixFailed`). Dies with the next edit: it describes a message that no
   *  longer exists. */
  fixNote: string | null;
  fixFailed: boolean;
  /** The message exactly as it was before the fix, while taking it back still means
   *  something. Null once the user edits -- an undo would take their typing with it. */
  beforeFix: string | null;
  /** A breath that "type"/"back" dropped from the flow is still on disk, and the confirm
   *  step offers to transcribe it after all. This is what makes a mis-press on the key next
   *  to Done survivable. */
  droppedAudio: boolean;
  // Where the dialog is drawn and what the pointer is over. Placement is re-clamped by the
  // host on every change (the dialog grows with its field) -- nothing in the transitions
  // below touches these three.
  row: number;
  col: number;
  hoverItem: number;
}

/** Recording (or transcribing) on top of words already in the box. */
export const addingOn = (s: SendDialogState) =>
  s.transcript.length > 0 && (s.phase === 'recording' || s.phase === 'transcribing');

// ── TRANSITIONS ─────────────────────────────────────────────────────────────────────────
// Pure: each is the phone's ViewModel method with the state as an argument. Nothing here
// records, transcribes, fixes or sends -- SendFlow does that and calls these with what
// came back.

/** Open on the confirm step with an empty box: the door the menu row uses (the phone's
 *  `startTyping`, the one a card's own tap opens). Writing is the ordinary way in; the mic
 *  is a button INSIDE the step, not the only way to reach it. */
export function openTyping(sessionId: string, topic: string, row: number, col: number): SendDialogState {
  return {
    sessionId, topic, phase: 'confirm', transcript: '', cursor: 0,
    error: null, dictationFailed: false, typed: true,
    fixing: false, fixNote: null, fixFailed: false, beforeFix: null, droppedAudio: false,
    row, col, hoverItem: -1,
  };
}

/** The mic is live. Everything about the last fix and the last breath is cleared: a new
 *  breath is about to change the message, so the fix's note would describe words the user
 *  is no longer looking at, and the mic records into a new file, so a breath kept by
 *  `skipToType` does not survive this -- the offer must not outlive its audio. */
export function micOpened(s: SendDialogState): SendDialogState {
  return {
    ...s, phase: 'recording', error: null, dictationFailed: false,
    fixNote: null, fixFailed: false, beforeFix: null, droppedAudio: false,
  };
}

export function recordingStopped(s: SendDialogState): SendDialogState {
  return { ...s, phase: 'transcribing' };
}

/** The mic produced nothing usable. With a message in hand that is a note on the confirm
 *  step, not a dead end -- the words stay, Send still means Send. With an empty box there
 *  is nothing to go back to, so the flow ends saying why. */
export function failedToDictate(s: SendDialogState, message: string): SendDialogState {
  if (!s.transcript) return { ...s, phase: 'failed', error: `${message} — try again`, dictationFailed: false };
  return { ...s, phase: 'confirm', error: message, dictationFailed: true };
}

/** Join a dictated fragment onto the message so far, without doubling the space the user
 *  may have left (or typed) at the end of it. */
export function appending(sofar: string, heard: string): string {
  if (!sofar) return heard;
  if (/\s$/.test(sofar)) return sofar + heard;
  return `${sofar} ${heard}`;
}

/** Whisper answered. Its words land APPENDED to what is already in the box -- one message
 *  dictated in as many breaths as it takes, not one send per thought. */
export function heard(s: SendDialogState, text: string): SendDialogState {
  const words = text.trim();
  if (!words) return failedToDictate(s, 'Heard nothing');
  const transcript = appending(s.transcript, words);
  return {
    ...s, phase: 'confirm', transcript, cursor: transcript.length,
    error: null, dictationFailed: false, typed: false,
    fixNote: null, fixFailed: false, beforeFix: null,
  };
}

/** Drop the open recording and land on the confirm step. From an empty box that is
 *  skipping the voice half (the mic opened by mistake, or you cannot speak right now);
 *  from a "say more" it is the way back out, keeping every word the message had.
 *  `kept` says whether the breath is still on disk to be transcribed after all. */
export function skipToType(s: SendDialogState, kept: boolean): SendDialogState {
  return {
    ...s, phase: 'confirm', error: null, dictationFailed: false,
    typed: s.typed || s.transcript.length === 0,
    droppedAudio: kept,
  };
}

/** The user typed. Ends the fix's afterlife: the note describes words that are no longer
 *  there, and an undo would now take the user's own edit with it. */
export function edited(s: SendDialogState, field: TopicField): SendDialogState {
  if (field.buffer === s.transcript) return { ...s, cursor: field.cursor };
  return { ...s, transcript: field.buffer, cursor: field.cursor, fixNote: null, fixFailed: false, beforeFix: null };
}

export function fixStarted(s: SendDialogState): SendDialogState {
  return { ...s, fixing: true, fixNote: null, fixFailed: false };
}

/** The fixer answered for the message it was given (`before`). Whatever was typed WHILE it
 *  was thinking wins: a correction of a message that no longer exists must not land on the
 *  one that does -- the box is never edited out from under the person typing into it. */
export function fixApplied(s: SendDialogState, before: string, fix: { text: string; changes: string }): SendDialogState {
  if (s.transcript !== before || s.phase !== 'confirm') return { ...s, fixing: false };
  const changed = fix.text !== before;
  return {
    ...s, fixing: false,
    transcript: changed ? fix.text : s.transcript,
    cursor: changed ? fix.text.length : s.cursor,
    fixNote: changed ? (fix.changes || 'Fixed') : 'Nothing to fix',
    fixFailed: false,
    beforeFix: changed ? before : null,
  };
}

/** Said, not swallowed: a fixer that is down looks exactly like a message with no typos if
 *  the failure is silent, and the difference matters. */
export function fixRefused(s: SendDialogState, message: string): SendDialogState {
  return { ...s, fixing: false, fixNote: message, fixFailed: true, beforeFix: null };
}

/** Put back the words the last fix replaced, exactly as they were. */
export function undoFix(s: SendDialogState): SendDialogState {
  if (s.beforeFix === null) return s;
  return { ...s, transcript: s.beforeFix, cursor: s.beforeFix.length, beforeFix: null, fixNote: null, fixFailed: false };
}

export function sendStarted(s: SendDialogState): SendDialogState {
  return { ...s, phase: 'sending', error: null, dictationFailed: false };
}

/** Back on the confirm step carrying the message, so Send is a retry, not a re-record. */
export function sendFailed(s: SendDialogState, message: string): SendDialogState {
  return { ...s, phase: 'confirm', error: message };
}

// ── DELIVERY ────────────────────────────────────────────────────────────────────────────

/** Between typing the text and pressing Enter, in ms. The phone's number and the phone's
 *  reason (ClaudeRepository.sendPrompt): everything one write carries reaches the terminal
 *  as a single read, and Claude Code's input layer can absorb a carriage return with the
 *  text it arrived with -- a slash command's menu owns the keystroke that lands with it, a
 *  fast paste swallows it -- and the words then sit in the prompt, unsent. Typing first and
 *  pressing Enter a beat later is what a person does. */
export const SUBMIT_DELAY_MS = 150;

/**
 * Why the message may not be written into the tab right now, or null when it may.
 *
 * The bytes go to whatever is reading the pty, so the thing reading it has to BE a claude:
 * an idle shell would run the message as a command line, and a build or an editor would
 * take it as keystrokes for itself. `unknown` refuses too -- resume.ts and launch.ts
 * refuse on the same answer for the same reason. The id the dialog was opened for is NOT
 * compared against the claude found: a `/resume` inside the tab mints a new id for what is
 * still the same conversation in the same window, and a session that has not fired a hook
 * yet has no id to compare at all.
 */
export function deliveryRefusal(state: ShellState, hasClaude: () => boolean): string | null {
  if (state === 'unknown') return 'cannot read shell state';
  if (state === 'idle' || !hasClaude()) return 'no claude running here';
  return null;
}

// ── THE FLOW ────────────────────────────────────────────────────────────────────────────

/** An open (or finished) recording, as the flow sees it. */
export interface Recording {
  /** Where the audio is. */
  readonly path: string;
  /** Stop the mic. Resolves once the file is complete, with whether it holds enough audio
   *  to be worth transcribing. Safe to call after the recorder ended on its own. */
  stop(): Promise<boolean>;
  /** Throw the audio away. Idempotent. */
  discard(): void;
  /** Fires if the recorder ends on its own -- the backstop timeout, or a mic that died. */
  onEnded(cb: () => void): void;
}

/** Everything the flow does to the world, so the flow itself is testable without any of it. */
export interface SendIo {
  /** Open the mic. Rejects with why it could not. */
  record(): Promise<Recording>;
  /** Whisper: the words in that recording. Rejects when whisper is unreachable -- which
   *  must never be reported as "nothing heard"; one of the two means a service is down. */
  transcribe(rec: Recording): Promise<string>;
  /** The spelling fixer: the message with its typos corrected, and what it changed.
   *  Rejects with the fixer's own reason when it refused. */
  fixSpelling(text: string): Promise<{ text: string; changes: string }>;
  /** Put the text into the session; when `submit`, press Enter a beat later. Rejects with
   *  why it could not, and the flow puts that on the dialog with the words intact. */
  deliver(text: string, submit: boolean): Promise<void>;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'failed';

/**
 * The phone's TalkViewModel, owning the effects: one live recording at most, one dropped
 * breath kept on disk at most, and the state every surface renders from.
 *
 * `emit` is told every new state, and `null` once when the dialog is over -- delivered, or
 * cancelled. Only success or cancel closes it: "the dialog went away" MEANS the message
 * arrived (or that you said not to bother), never that something failed quietly.
 */
export class SendFlow {
  private live: Recording | null = null;
  private kept: Recording | null = null;
  private closed = false;

  constructor(private io: SendIo, public state: SendDialogState, private emit: (s: SendDialogState | null) => void) {}

  private set(next: SendDialogState): void {
    if (this.closed) return;
    this.state = next;
    this.emit(next);
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit(null);
  }

  /** What the pointer is over. UI-only; never changes what the flow will do. */
  hover(item: number): void {
    if (this.state.hoverItem !== item) this.set({ ...this.state, hoverItem: item });
  }

  /** Speak / say more: open the mic from the confirm step. What it hears is APPENDED. A
   *  mic that will not open lands back where the words are (`failedToDictate`). */
  async speak(): Promise<void> {
    if (this.state.phase !== 'confirm') return;
    // The new breath replaces any kept one -- the offer must not outlive its audio.
    this.kept?.discard(); this.kept = null;
    const held = this.state;
    let rec: Recording;
    try {
      rec = await this.io.record();
    } catch (e) {
      this.set(failedToDictate(held, `Recording failed: ${reason(e)}`));
      return;
    }
    // The dialog may have moved on while the mic was opening (cancelled, or sent); a
    // recording nobody is on the step for is stopped and thrown away. Anything typed or
    // hovered meanwhile is kept -- the state NOW is what the mic is added to.
    if (this.closed || this.state.phase !== 'confirm') { rec.stop().then(() => rec.discard(), () => rec.discard()); return; }
    this.live = rec;
    // The backstop (a recording must never run forever) and a mic that dies both end the
    // recorder without a keypress; either way the words so far are transcribed, not lost.
    rec.onEnded(() => { if (this.live === rec) this.done(); });
    this.set(micOpened(this.state));
  }

  /** Done: stop the mic and transcribe. Everything the flow already holds -- the target,
   *  the words this breath is being added to -- survives whatever happens next. */
  async done(): Promise<void> {
    const rec = this.live;
    if (!rec || this.state.phase !== 'recording') return;
    this.live = null;
    const held = this.state;
    let enough = false;
    try { enough = await rec.stop(); } catch { enough = false; }
    if (this.closed) { rec.discard(); return; }
    if (!enough) {
      rec.discard();
      this.set(failedToDictate(held, 'Heard nothing'));
      return;
    }
    await this.transcribe(rec, held);
  }

  private async transcribe(rec: Recording, held: SendDialogState): Promise<void> {
    this.set(recordingStopped(held));
    // Nothing but the pointer can change while whisper works (every edit is guarded on
    // the confirm step), so what it lands on is `held` with the pointer where it is now.
    const now = () => ({ ...held, hoverItem: this.state.hoverItem });
    try {
      const text = await this.io.transcribe(rec);
      if (this.closed) return;
      this.set(heard(now(), text));
    } catch (e) {
      if (this.closed) return;
      this.set(failedToDictate(now(), `Transcription failed: ${reason(e)}`));
    } finally {
      // The audio does not outlive the attempt, success or not.
      rec.discard();
    }
  }

  /** Type / back: drop the breath from the flow -- but not from disk. The key sits next to
   *  Done, and a mis-press must not cost a message that was just dictated: the confirm step
   *  offers `useDropped` while the audio lasts. */
  skip(): void {
    const rec = this.live;
    if (!rec || this.state.phase !== 'recording') return;
    this.live = null;
    this.set(skipToType(this.state, false));
    rec.stop().then(enough => {
      if (this.closed || !enough) { rec.discard(); return; }
      if (this.state.phase !== 'confirm' || this.kept) { rec.discard(); return; }
      this.kept = rec;
      this.set({ ...this.state, droppedAudio: true });
    }, () => rec.discard());
  }

  /** Use what I said: transcribe the breath `skip` kept, its words landing exactly as
   *  Done's would have -- appended to whatever is in the box. */
  async useDropped(): Promise<void> {
    const rec = this.kept;
    if (!rec || this.state.phase !== 'confirm' || !this.state.droppedAudio) return;
    this.kept = null;
    await this.transcribe(rec, { ...this.state, droppedAudio: false });
  }

  edit(field: TopicField): void {
    if (this.state.phase !== 'confirm') return;
    this.set(edited(this.state, field));
  }

  /** Fix typos: the desktop's Shift+Pause, inside the box. The SAME corrector the phone
   *  and the hotkey use (spokenView /fixspelling → fixTyping's spellfix), which proposes
   *  word-level edits and verifies each one, so it can never answer the message instead of
   *  fixing it. Nothing is sent; `undo` takes it back while the words are still exactly as
   *  the fix left them. */
  async fix(): Promise<void> {
    const current = this.state;
    if (current.phase !== 'confirm' || current.fixing) return;
    const before = current.transcript;
    if (!before.trim()) return;
    this.set(fixStarted(current));
    try {
      const fix = await this.io.fixSpelling(before);
      if (this.closed) return;
      this.set(fixApplied(this.state, before, fix));
    } catch (e) {
      if (this.closed) return;
      this.set(fixRefused(this.state, reason(e)));
    }
  }

  undo(): void {
    if (this.state.phase !== 'confirm') return;
    this.set(undoFix(this.state));
  }

  /** Send (submit) or insert: deliver, and hold the dialog open -- "sending…" -- until the
   *  words are known to have landed. A failure comes back to the confirm step with the
   *  message intact, so Send is a retry. The phase guard makes a double press harmless:
   *  the second finds 'sending'. */
  async send(submit: boolean): Promise<void> {
    const current = this.state;
    if (current.phase !== 'confirm' || !current.transcript) return;
    this.set(sendStarted(current));
    try {
      await this.io.deliver(current.transcript, submit);
      // A breath kept by `skip` dies with the flow it belonged to.
      this.kept?.discard(); this.kept = null;
      this.end();
    } catch (e) {
      if (this.closed) return;
      this.set(sendFailed(this.state, reason(e)));
    }
  }

  /** Cancel, or Close on the 'failed' step. Nothing dismisses the dialog while the text is
   *  in flight: closing early would cut the delivery and leave the question of whether it
   *  landed unanswerable. */
  cancel(): void {
    if (this.state.phase === 'sending') return;
    const rec = this.live; this.live = null;
    if (rec) rec.stop().then(() => rec.discard(), () => rec.discard());
    this.kept?.discard(); this.kept = null;
    this.end();
  }
}

// ── WHAT THE DIALOG SAYS ────────────────────────────────────────────────────────────────
// The phone's words, in this menu's register (its rows are lowercase; its sentences are
// sentences). Exported so the tests find rows by the words the dialog actually draws.

export function sendTitle(s: SendDialogState): string {
  switch (s.phase) {
    case 'sending': return 'sending…';
    case 'recording': return addingOn(s) ? 'still listening…' : 'listening…';
    case 'transcribing': return 'transcribing…';
    case 'failed': return "couldn't hear you";
    default: return SEND_LABEL;
  }
}

/** The one-line body under the label: what to do now, or what is happening. */
export function sendHint(s: SendDialogState): string {
  switch (s.phase) {
    case 'recording': return addingOn(s) ? 'Keep going — this gets added on.' : 'Speak now, then press Enter.';
    case 'transcribing': return 'Whisper is listening back…';
    case 'sending': return 'Putting it into the session…';
    case 'failed': return s.error ?? '';
    default:
      if (s.dictationFailed) return 'Your message is as it was — say it again or send it.';
      if (s.error) return 'Nothing was lost — send it again to retry.';
      if (s.typed) return 'Type what you want to send.';
      return 'Fix anything the transcription got wrong, then send.';
  }
}

/** A failure that arrived back on the confirm step, stated where the eye already is: above
 *  the words it failed to deliver -- or failed to add to -- which are still here. */
export function sendErrorLine(s: SendDialogState): string | null {
  if (s.phase !== 'confirm' || !s.error) return null;
  return s.dictationFailed ? `Didn't add anything: ${s.error}` : `Didn't reach the session: ${s.error}`;
}

/** THE ITEMS A CLICK CAN LAND ON. One number each; the field is the only one that also
 *  carries a position. */
export const SEND_ITEM = {
  field: 1,
  speak: 10, fix: 11, useDropped: 12, undo: 13,
  send: 20, insert: 21, cancel: 22,
  done: 30, skip: 31, close: 32,
} as const;

export interface SendButton { item: number; text: string; enabled: boolean }

/** How the message gets WRITTEN, as opposed to where it goes. Kept off the send/insert row
 *  on purpose: none of these dispatches anything, and a third verb down there is where a
 *  mis-click sends half a thought. The key for each is on the label -- this is a keyboard
 *  surface, and a button you can only click is a button you have to leave the field for. */
export function writeRowButtons(s: SendDialogState): SendButton[] {
  const out: SendButton[] = [];
  // First when it exists: the one moment it does is right after the mis-press, when taking
  // it back is the likeliest next move.
  if (s.droppedAudio) out.push({ item: SEND_ITEM.useDropped, text: '↶ use what I said ^R', enabled: true });
  out.push({ item: SEND_ITEM.speak, text: s.transcript ? '◉ say more ^T' : '◉ speak ^T', enabled: !s.fixing });
  const fixable = s.transcript.trim().length > 0 && !s.fixing;
  out.push({ item: SEND_ITEM.fix, text: s.fixing ? '✓ fixing…' : '✓ fix typos ^X', enabled: fixable });
  return out;
}

/** The buttons that DO something with the message -- or end the step. */
export function actionRowButtons(s: SendDialogState): SendButton[] {
  switch (s.phase) {
    case 'confirm': {
      const ready = s.transcript.length > 0;
      return [
        { item: SEND_ITEM.send, text: '↵ send', enabled: ready },
        { item: SEND_ITEM.insert, text: '⎇↵ insert', enabled: ready },
        { item: SEND_ITEM.cancel, text: 'esc cancel', enabled: true },
      ];
    }
    case 'recording':
      return [
        { item: SEND_ITEM.done, text: '↵ done', enabled: true },
        // Same action, two truthful names: with nothing said yet it drops the voice half,
        // mid-message it drops only this breath.
        { item: SEND_ITEM.skip, text: addingOn(s) ? 'esc back' : 'esc type', enabled: true },
        { item: SEND_ITEM.cancel, text: '^C cancel', enabled: true },
      ];
    case 'transcribing':
      return [{ item: SEND_ITEM.cancel, text: '^C cancel', enabled: true }];
    case 'failed':
      return [{ item: SEND_ITEM.close, text: '↵ close', enabled: true }];
    default:
      return [];   // sending: no way out mid-flight
  }
}

export const UNDO_BUTTON: SendButton = { item: SEND_ITEM.undo, text: '⟲ undo ^Z', enabled: true };

// ── GEOMETRY ────────────────────────────────────────────────────────────────────────────

/** Cells inside the dialog's borders. Wider than the menu (35): a message is a sentence or
 *  three, and a box narrower than a sentence is a box you scroll instead of read. 56 holds
 *  the widest button row (`say more` + `fix typos` + `use what I said`, with their keys)
 *  and still fits an 80-column terminal with the menu's own margin to spare. */
export const SEND_DIALOG_INNER = 56;
export const sendPad = (s: string) => (s + ' '.repeat(SEND_DIALOG_INNER)).slice(0, SEND_DIALOG_INNER);
export const sendBorder = '─'.repeat(SEND_DIALOG_INNER);

/** The message box: one cell in from each border. */
export const FIELD_WIDTH = SEND_DIALOG_INNER - 2;
/** The box is never smaller than the phone's (minLines = 2) and never eats the screen. */
export const FIELD_MIN_ROWS = 2;
export const FIELD_MAX_ROWS = 6;

/** Longest message the box takes. Not what the box can HOLD (it wraps and scrolls) -- a
 *  sanity bound on a string that is about to be typed into a prompt as keystrokes. */
export const MESSAGE_MAX_CHARS = 4000;

/** Cells between buttons on a row, and the indent every row in this dialog has. */
const BUTTON_GAP = 3;
const ROW_INDENT = 1;

/** Where each button on a row sits: [start, end) in inner cells. The drawing and the
 *  hit-test both read this, so the cells a button claims are the cells its words occupy. */
export function buttonCells(buttons: SendButton[]): { item: number; start: number; end: number }[] {
  const out: { item: number; start: number; end: number }[] = [];
  let x = ROW_INDENT;
  for (const b of buttons) {
    out.push({ item: b.item, start: x, end: x + b.text.length });
    x += b.text.length + BUTTON_GAP;
  }
  return out;
}

/** The message as the box shows it: hard-wrapped at `width`, `visible` rows of it, chosen
 *  so the caret is always on screen. Character-wrapped rather than word-wrapped on purpose
 *  -- the caret's cell is then arithmetic (`cursor` ÷ `width`), and a click in the box maps
 *  back to a character the same way, with nothing for the two to disagree about.
 *
 *  `total` counts the caret's own cell past the last character: a message that exactly
 *  fills its last row still has to show you where the next character goes. When the
 *  message overflows, the window is anchored so the caret sits on the LAST visible row --
 *  which is where it is while typing, the common case -- and moves up with it. Pure, so
 *  tests/testSendToSession.ts pins it without a render. */
export function wrapField(text: string, cursor: number, width: number, minRows: number, maxRows: number) {
  const at = Math.max(0, Math.min(cursor, text.length));
  const total = Math.floor(text.length / width) + 1;
  const visible = Math.max(minRows, Math.min(maxRows, total));
  const caretAbs = Math.floor(at / width);
  const top = Math.max(0, caretAbs - visible + 1);
  const rows: string[] = [];
  for (let i = 0; i < visible; i++) {
    const r = top + i;
    rows.push(r < total ? text.slice(r * width, (r + 1) * width) : '');
  }
  return { rows, caretRow: caretAbs - top, caretCol: at % width, top, total, visible };
}

/** The character a click at (`row`, `col`) inside the box means, given which rows the box
 *  is showing. Past the end of a row is the end of that row; below the text is its end. */
export function cursorAtCell(text: string, top: number, width: number, row: number, col: number): number {
  const start = (top + Math.max(0, row)) * width;
  return Math.min(text.length, start + Math.max(0, Math.min(col, width)));
}

/** Where every row of the dialog lands, as offsets from its top border. -1 = not drawn.
 *  One function, read by both the overlay and the hit-test, so a row cannot be drawn in
 *  one place and clicked in another (tests/testSendDialogRows.ts renders it and checks). */
export function computeSendLayout(s: SendDialogState) {
  let row = 0;
  row++;                                   // top border
  const titleRow = row; row++;
  const labelRow = row; row++;
  let errorRow = -1, hintRow = -1, fieldRow = -1, fieldRows = 0, echoRow = -1, echoRows = 0,
      noteRow = -1, writeRow = -1, actionRow = -1;
  switch (s.phase) {
    case 'confirm': {
      if (sendErrorLine(s)) { errorRow = row; row++; }
      hintRow = row; row++;
      fieldRow = row;
      fieldRows = wrapField(s.transcript, s.cursor, FIELD_WIDTH, FIELD_MIN_ROWS, FIELD_MAX_ROWS).visible;
      row += fieldRows;
      if (s.fixNote) { noteRow = row; row++; }
      writeRow = row; row++;
      actionRow = row; row++;
      break;
    }
    case 'recording': {
      hintRow = row; row++;
      // What it is being added TO, so the message you are still dictating is in front of
      // you while you dictate the rest of it. Two rows at most, from the END: the last
      // words are the ones the next breath continues.
      if (addingOn(s)) { echoRow = row; echoRows = Math.min(2, Math.ceil(s.transcript.length / FIELD_WIDTH)); row += echoRows; }
      actionRow = row; row++;
      break;
    }
    case 'transcribing':
    case 'failed':
      hintRow = row; row++;
      actionRow = row; row++;
      break;
    case 'sending':
      hintRow = row; row++;
      break;
  }
  row++;                                   // bottom border
  return { titleRow, labelRow, errorRow, hintRow, fieldRow, fieldRows, echoRow, echoRows, noteRow, writeRow, actionRow, height: row };
}

export type SendLayout = ReturnType<typeof computeSendLayout>;

/** What a click at (`rowOff`, `colOff`) inside the dialog means. `colOff` is 1-based from
 *  the left border, as the mouse handler measures it; anything outside the borders is
 *  null, and so is any row that is not a control. The field answers with the character the
 *  click lands on. */
export function sendHitTest(s: SendDialogState, layout: SendLayout, rowOff: number, colOff: number): { item: number; cursor?: number } | null {
  if (colOff < 1 || colOff > SEND_DIALOG_INNER) return null;
  const x = colOff - 1;
  if (layout.fieldRow >= 0 && rowOff >= layout.fieldRow && rowOff < layout.fieldRow + layout.fieldRows) {
    const w = wrapField(s.transcript, s.cursor, FIELD_WIDTH, FIELD_MIN_ROWS, FIELD_MAX_ROWS);
    return { item: SEND_ITEM.field, cursor: cursorAtCell(s.transcript, w.top, FIELD_WIDTH, rowOff - layout.fieldRow, x - 1) };
  }
  const onRow = (buttons: SendButton[]) => buttonCells(buttons).find(c => x >= c.start && x < c.end)?.item ?? null;
  if (rowOff === layout.writeRow) { const item = onRow(writeRowButtons(s)); return item === null ? null : { item }; }
  if (rowOff === layout.actionRow) { const item = onRow(actionRowButtons(s)); return item === null ? null : { item }; }
  if (rowOff === layout.noteRow && s.beforeFix !== null) {
    // The undo sits at the right end of the note's row; its cells are the label's.
    const start = SEND_DIALOG_INNER - ROW_INDENT - UNDO_BUTTON.text.length;
    if (x >= start && x < start + UNDO_BUTTON.text.length) return { item: SEND_ITEM.undo };
  }
  return null;
}
