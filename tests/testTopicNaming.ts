// WHAT A SESSION'S NAME MAY BE.
//
// The namer is a model, so nothing here calls one: these are the rules its reply must pass
// and the prompt it is given, which are the parts that decided every naming failure so far.
// What breaks if this drifts: a concluded session renamed back into open work, names cut
// mid-word by the conclude marker, a name another session already holds, the user's own
// label never reaching the model — and a rejection nobody can diagnose.
//
//   npx tsx tests/testTopicNaming.ts
import { readFileSync } from "fs";
import {
  CONC_MARKER, PICKER_WIDTH, MAX_TOPIC_CHARS,
  splitMarker, withMarker, takenNames, judgeReply, namingPrompt, retryPrompt, MAX_CANDIDATES,
} from "../topicNaming.js";

let failures = 0;
const fail = (msg: string) => { failures++; console.log("  FAIL " + msg); };
const eq = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fail(`${what}: got ${g}, want ${w}`);
};
const ok = (cond: boolean, what: string) => { if (!cond) fail(what); };

// ── THE NUMBERS ARE OTHER FILES' NUMBERS ────────────────────────────────────────────────
// The picker's width and the conclude marker are owned elsewhere; a copy here that drifted
// would budget names for a list that no longer exists.
const picker = readFileSync(new URL("../sessionPicker.tsx", import.meta.url), "utf8");
eq(Number(picker.match(/const TOPIC_W = (\d+);/)?.[1]), PICKER_WIDTH, "PICKER_WIDTH is sessionPicker.tsx TOPIC_W");
const concluder = readFileSync("/root/.claude/skills/conclude-issues-and-close-session-skill/mark-concluding.sh", "utf8");
eq(concluder.match(/readonly MARKER="([^"]+)"/)?.[1], CONC_MARKER, "CONC_MARKER is mark-concluding.sh MARKER");
eq(Number(concluder.match(/readonly TOPIC_W=(\d+)/)?.[1]), PICKER_WIDTH, "mark-concluding.sh budgets for the same width");
// The point of the budget: a name at the limit, marked, is exactly the picker's width.
eq(withMarker("x".repeat(MAX_TOPIC_CHARS), true).length, PICKER_WIDTH, "a full-length name fits beside the marker");

// ── THE MARKER IS STATE, NOT NAME ───────────────────────────────────────────────────────
eq(splitMarker("panelShed ads audit conc"), { name: "panelShed ads audit", concluded: true }, "marker split off");
eq(splitMarker("טלוריות נחושת conc"), { name: "טלוריות נחושת", concluded: true }, "marker split off a Hebrew name");
eq(splitMarker("conc"), { name: "", concluded: true }, "a bare marker is a concluded session with no name");
eq(splitMarker("ben voiceControl"), { name: "ben voiceControl", concluded: false }, "no marker, nothing split");
// Only the whole word at the end is the marker.
eq(splitMarker("concrete"), { name: "concrete", concluded: false }, "'concrete' is not concluded");
eq(splitMarker("pour concrete"), { name: "pour concrete", concluded: false }, "'... concrete' is not concluded");
eq(withMarker("copper thermowells", true), "copper thermowells conc", "a concluded session keeps its marker");
eq(withMarker("copper thermowells", false), "copper thermowells", "an open session gets none");

// ── TAKEN NAMES ─────────────────────────────────────────────────────────────────────────
const store = new Map([
  ["self", "pt"],
  ["a", "pt conc"], ["b", "pt conc"], ["c", "PT conc"],
  ["d", "voice"], ["e", "conc"], ["f", "ben voiceControl"],
]);
const taken = takenNames(store, "self");
eq(taken, ["pt", "voice", "ben voiceControl"], "marker stripped, repeats and bare markers dropped, self excluded");

// ── THE REPLY ───────────────────────────────────────────────────────────────────────────
const takenSet = new Set(taken.map((t) => t.toLowerCase()));
eq(judgeReply("ads area geo\n", takenSet), { ok: true, name: "ads area geo" }, "a plain label passes");
eq(judgeReply('"rdp screen mode".', takenSet), { ok: true, name: "rdp screen mode" }, "quotes and a full stop are shed");
eq(judgeReply("NOTHING", takenSet), { ok: false, nothing: true }, "NOTHING is the model's own verdict");
const why = (reply: string) => {
  const v = judgeReply(reply, takenSet);
  return v.ok || v.nothing ? "" : v.why;
};
// Every rejection says which rule, in words the retry can hand back to the model.
ok(/31 characters and the limit is 19/.test(why("panelshed checkout security fix")), "too long says by how much");
ok(/already another session's name/.test(why("Ben VoiceControl")), "a taken name is caught whatever its case");
ok(/already another session's name/.test(why("pt")), "a name only its marker away from a taken one is caught");
ok(/sentence, not a label/.test(why("Which would you prefer?")), "a question is not a label");
ok(/added separately/.test(why("pt routes conc")), "the marker is not the model's to write");
ok(/more than 4 words/.test(why("a b c d e")), "a string of tiny words is not a label");
ok(/empty/.test(why("   ")), "an empty reply says so");
eq(judgeReply("x".repeat(MAX_TOPIC_CHARS), takenSet).ok, true, "exactly at the limit passes");

// ── THE PROMPT ──────────────────────────────────────────────────────────────────────────
const digest = { first: "", last: "", userTurns: 2, sample: ["make ben talk to me in the app", "fix the mic"] };
const base = { dir: "automateLinux", digest, spoken: [], current: "", brief: "", taken: [] as string[] };
const plain = namingPrompt(base);
const seeded = namingPrompt({ ...base, current: "ben voiceControl", brief: "Made Ben the voice backend.", taken });

// The user's own name reaches the model — the namer used to overwrite it blind.
ok(seeded.includes(`called "ben voiceControl" right now`), "the current name is shown");
ok(!plain.includes("right now"), "no current name, no line about one");
// The brief is material, and goes in first: it is the most complete account there is.
const at = (s: string) => seeded.indexOf(s);
ok(at("MATERIAL BEGINS") < at("Made Ben the voice backend.") && at("Made Ben the voice backend.") < at("messages the user typed"),
  "the brief sits inside the material, ahead of the typed turns");
ok(!plain.includes("own account"), "no brief, no brief section");
// The ask comes after everything the model reads, and states the budget it is judged by.
ok(at("MATERIAL ENDS") < at("Now name that session"), "the ask follows the material");
ok(seeded.includes(`at most ${MAX_TOPIC_CHARS} characters`), "the prompt states the character budget");
ok(seeded.includes("- ben voiceControl") && seeded.includes("- pt"), "taken names are listed");
// The retry hands back every rule broken, so the model is told what to fix.
eq(retryPrompt(plain, "it is too long").slice(plain.length),
  "\n\nNone of your labels can be used: it is too long. Answer again with labels that fix that.",
  "the retry names the broken rules");

// ── CANDIDATES ──────────────────────────────────────────────────────────────────────────
// A model cannot count characters; its shorter second thought is the name that fits.
eq(judgeReply("panelShed ads resumed\npanelShed ads\nshed ads", takenSet), { ok: true, name: "panelShed ads" },
  "the first candidate that keeps every rule wins");
eq(judgeReply("ben voiceControl\nben voice app", takenSet), { ok: true, name: "ben voice app" },
  "a taken first choice gives way to the next");
const all = judgeReply("panelShed ads resumed\npt", takenSet);
ok(!all.ok && !all.nothing && /21 characters/.test(all.why) && /"pt" is already/.test(all.why),
  "when none fits, every candidate's reason is reported");
eq(judgeReply("a\nb\nc\nd fits too", takenSet), { ok: true, name: "a" }, "the first is used when it fits");
const fourth = judgeReply("panelShed ads resumed\npanelShed ads resumed\npanelShed ads resumed\nok", takenSet);
eq(fourth.ok, false, `no more than ${MAX_CANDIDATES} candidates are read`);
eq(judgeReply("NOTHING\nsome label", takenSet), { ok: false, nothing: true }, "NOTHING first is the verdict");

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("topic naming: all checks pass");
