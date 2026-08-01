// A topic wider than the menu row scrolls instead of being cut off. The scroll is a pure
// function of (text, width, step) so it can be checked here without rendering or waiting --
// the component only supplies the clock.
//
// What actually breaks if this drifts: a sign that never shows the END of the topic (the
// reason it scrolls at all), a sign that reads as one word where it wraps, or a row that
// changes width and tears the menu's borders.
//
//   npx tsx tests/testMarquee.ts
import { marqueeWindow, editWindow, TOPIC_VIEW_WIDTH, MARQUEE_HOLD_STEPS, TOPIC_MAX_CHARS, topicBarWidth, TOPIC_BAR_MAX_WIDTH } from "../menu.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };
const eq = (got: string, want: string, what: string) => {
  if (got !== want) fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const W = TOPIC_VIEW_WIDTH;
const short = "voice";
const long = "rewriting the peer heartbeat so a worker survives a leader restart";

// A topic that fits is not a sign: it must be byte-identical at every step, or it would
// jitter in a menu that is open for minutes.
for (const tick of [0, 1, 7, 999]) {
  eq(marqueeWindow(short, W, tick), short, `short topic still at step ${tick}`);
}
eq(marqueeWindow("x".repeat(W), W, 50), "x".repeat(W), "exactly-fitting topic still");

// An overflowing topic occupies the full width at every step -- a short frame would leave
// the row's padding showing mid-sign and the border ragged.
for (let tick = 0; tick < 200; tick++) {
  const frame = marqueeWindow(long, W, tick);
  if (frame.length !== W) { fail(`step ${tick} drew ${frame.length} cells, want ${W}`); break; }
}

// It starts at the head, and holds there long enough to be read before moving.
eq(marqueeWindow(long, W, 0), long.slice(0, W), "first frame is the head");
eq(marqueeWindow(long, W, MARQUEE_HOLD_STEPS), long.slice(0, W), "head still held at the last hold step");
eq(marqueeWindow(long, W, MARQUEE_HOLD_STEPS + 1), long.slice(1, W + 1), "moves one cell after the hold");

// The whole topic passes through the window: every character is shown by some step, which
// is the entire point -- the old row showed the first 24 characters and an ellipsis forever.
const seen = new Set<number>();
for (let tick = 0; tick < 400; tick++) {
  const frame = marqueeWindow(long, W, tick);
  for (let i = 0; i < long.length; i++) {
    if (frame.includes(long.slice(i, i + 1)) && frame.includes(long.slice(Math.max(0, i - 3), i + 1))) seen.add(i);
  }
}
if (seen.size < long.length - 3) fail(`only ${seen.size}/${long.length} characters ever became visible`);
// The tail specifically -- the end of the topic is what an ellipsis used to eat.
const tail = long.slice(-8);
if (!Array.from({ length: 400 }, (_, t) => marqueeWindow(long, W, t)).some(f => f.includes(tail))) {
  fail("the end of the topic never came into view");
}

// The pass loops, and the two ends are separated by blanks so "…restart" and "rewriting…"
// are never read as one phrase.
const cycleLen = long.length + 3 + MARQUEE_HOLD_STEPS;
eq(marqueeWindow(long, W, cycleLen), marqueeWindow(long, W, 0), "one full period returns to the head");
const wrapFrame = marqueeWindow(long, W, MARQUEE_HOLD_STEPS + long.length - 4);
if (!wrapFrame.includes("   ")) fail(`no gap where the sign wraps: ${JSON.stringify(wrapFrame)}`);

// Negative and zero widths are what a 1-column terminal hands us; they must not throw.
eq(marqueeWindow(long, 0, 3), "", "zero width draws nothing");
eq(marqueeWindow(long, -5, 3), "", "negative width draws nothing");

// Typing scrolls to the CURSOR, never marquees: the tail stays visible, with the clipped
// head marked. A field that slid while you typed could not be typed into.
eq(editWindow("short", 10), "short", "short edit buffer untouched");
eq(editWindow("abcdefghij", 10), "abcdefghij", "exactly-fitting edit buffer untouched");
eq(editWindow("abcdefghijkl", 10), "…defghijkl", "long edit buffer shows its tail");
if (editWindow("x".repeat(TOPIC_MAX_CHARS), W - 1).length !== W - 1) fail("edit window overflowed its field");

// The bar's cap tracks the terminal, and never inverts on a narrow one.
if (topicBarWidth(200) !== TOPIC_BAR_MAX_WIDTH) fail("wide terminal should cap the bar at TOPIC_BAR_MAX_WIDTH");
if (topicBarWidth(20) !== 16) fail(`narrow terminal bar width: got ${topicBarWidth(20)}, want 16`);
if (topicBarWidth(1) < 1) fail("1-column terminal produced a non-positive bar width");

// The two places a topic is drawn must START SCROLLING TOGETHER. When the bar was wider
// than the menu row, every topic between the two widths slid in the menu and sat still in
// the bar — one topic behaving two ways, which reads as the bar being broken.
if (TOPIC_BAR_MAX_WIDTH !== TOPIC_VIEW_WIDTH) {
  fail(`the bar caps at ${TOPIC_BAR_MAX_WIDTH} but the menu row is ${TOPIC_VIEW_WIDTH}: topics between them scroll in one place only`);
}
const borderline = "x".repeat(TOPIC_VIEW_WIDTH + 1);
const barW = Math.min(borderline.length, topicBarWidth(200));
if (!(borderline.length > barW)) fail("a topic one cell too wide for the menu row does not overflow the bar");

console.log(failures === 0 ? "PASS" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
