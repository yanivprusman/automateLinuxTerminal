import { spawn, execFile } from "child_process";
import { readFile, stat, unlink } from "fs/promises";
import type { Recording } from "./sendToSession.js";

// The "send to session" dialog's world: the microphone, whisper, and the spelling fixer.
//
// The two services are reached THROUGH spokenView (`/transcribe`, `/fixspelling`) rather
// than by running whisper's client and spellfix here -- because that is exactly what the
// phone does. spokenView runs the one whisper client `talk` runs and the one corrector
// Shift+Pause runs, so a message dictated or fixed in this dialog, on the phone, or at the
// keyboard cannot drift into three ideas of what a transcription or a spelling fix is.
// There is no local path beside it: if the voice server is down, the dialog says so, and
// the words in the box are untouched.

export const PARECORD = "/usr/bin/parecord";
export const TIMEOUT = "/usr/bin/timeout";
export const ENSURE_AUDIO = "/root/bin/ensure-audio";
export const SAY_CTL = "/root/bin/say-ctl";
export const DAEMON = "/usr/local/bin/daemon";

/** The microphone: `talk`'s, by the same name and the same override. Not the default
 *  source -- that follows whatever was plugged in last, and the desktop's push-to-talk
 *  pins this one for that reason. tests/testDictation.ts pins the two equal, so a mic
 *  change in `talk` is a test failure here rather than a dialog that records silence. */
export const DEFAULT_MIC = "alsa_input.usb-Microsoft_Microsoft___LifeCam_Studio_TM_-02.mono-fallback";
export const micDevice = () => process.env.TALK_MIC || DEFAULT_MIC;

/** parecord, as `talk begin` runs it: 16 kHz mono (what whisper resamples to anyway) at a
 *  20 ms latency -- at 50 it captured half a second late, and the first words went missing. */
export const recordArgs = (mic: string, wav: string) =>
  [`--device=${mic}`, "--file-format=wav", "--latency-msec=20", "--rate=16000", "--channels=1", wav];

/** Backstop only: the key (or the click) is the stop signal, but a recording must never be
 *  able to run forever. `talk`'s number. */
export const MAX_RECORD_SECS = 60;

/** Under this the file holds less than ~half a second of audio -- `talk`'s "Too short". */
export const MIN_AUDIO_BYTES = 16000;

/** How long parecord gets to fail before it counts as recording. It has no readiness
 *  signal; a missing binary, a dead audio server or an unknown device all exit inside this. */
export const MIC_SETTLE_MS = 150;

/** One file per recording, never reused: a breath "type" kept on disk and the next breath
 *  being recorded must not share a path, or opening the mic would truncate the offer the
 *  confirm step is still making. */
let recordingSerial = 0;
export const recordingFile = () => `/tmp/automateLinuxTerminal-dictation-${process.pid}-${++recordingSerial}.wav`;

const firstLine = (s: string) => s.split("\n").map(l => l.trim()).find(Boolean) || "";

/** Fire-and-forget to the voice queue. `--borrow`: pause only if nothing was paused, and
 *  give back only what we took -- the user's own pause survives a dictation, exactly as it
 *  survives the talk key. Best effort by design: barge-in is a courtesy to the recording
 *  (Claude's own voice on the speakers would otherwise be in it), not a step the
 *  recording depends on. */
function voiceQueue(action: "pause" | "resume"): void {
  try {
    const p = spawn(SAY_CTL, [action, "--borrow"], { detached: true, stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

/**
 * Open the microphone. Resolves once parecord has been running for MIC_SETTLE_MS without
 * dying; rejects with the reason it died, or with "no audio server" when pipewire-pulse
 * cannot be brought up (ensure-audio: the root user manager persists across GDM restarts,
 * so the units stay stopped after a session teardown and the mic fails silently otherwise).
 */
export function startRecording(): Promise<Recording> {
  return new Promise((resolve, reject) => {
    execFile(ENSURE_AUDIO, { timeout: 5000 }, (err) => {
      if (err) return reject(new Error("no audio server"));
      const wav = recordingFile();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(TIMEOUT, [String(MAX_RECORD_SECS), PARECORD, ...recordArgs(micDevice(), wav)],
                      { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        return reject(new Error(`parecord: ${(e as Error).message}`));
      }
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
      let settled = false;
      let exited = false;
      let resumed = false;
      const ended: (() => void)[] = [];
      const giveBack = () => { if (!resumed) { resumed = true; voiceQueue("resume"); } };
      child.on("error", (e) => {
        exited = true;
        if (!settled) { settled = true; reject(new Error(`parecord: ${e.message}`)); }
      });
      child.on("exit", (code) => {
        exited = true;
        if (!settled) {
          settled = true;
          reject(new Error(firstLine(stderr) || `parecord exited (${code})`));
          return;
        }
        giveBack();
        for (const cb of ended) cb();
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        voiceQueue("pause");
        const recording: Recording = {
          path: wav,
          stop: () => new Promise<boolean>((res) => {
            const finish = () => {
              giveBack();
              stat(wav).then(s => res(s.size >= MIN_AUDIO_BYTES), () => res(false));
            };
            if (exited) return finish();
            child.once("exit", finish);
            // SIGTERM to the `timeout` wrapper, which forwards it to parecord so the WAV
            // header is flushed. A recorder that ignores that gets the harder signal.
            child.kill("SIGTERM");
            setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2000);
          }),
          discard: () => { unlink(wav).catch(() => {}); },
          onEnded: (cb) => { ended.push(cb); },
        };
        resolve(recording);
      }, MIC_SETTLE_MS);
    });
  });
}

/**
 * Where spokenView listens: the same three-step lookup `say`, `voice` and the caption
 * launcher use (the daemon's port registry, then $CLAUDE_VOICE_PORT, then the stack's
 * fixed default), so this dialog finds the voice server exactly where the voice does.
 * That chain is the voice stack's own contract for its port -- "daemon port dependency is
 * optional" -- not a fallback invented here.
 */
export function voiceServerPort(): Promise<number> {
  return new Promise((resolve) => {
    execFile(DAEMON, ["send", "getPort", "--key", "spokenView"], { timeout: 3000 }, (err, out) => {
      const n = Number(String(out || "").trim().split("\n").pop());
      if (!err && Number.isInteger(n) && n > 0) return resolve(n);
      resolve(Number(process.env.CLAUDE_VOICE_PORT) || 3511);
    });
  });
}

async function voicePost(path: string, body: BodyInit, contentType: string, timeoutMs: number): Promise<Response> {
  const port = await voiceServerPort();
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "Content-Type": contentType }, body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new Error(timedOut ? "voice server did not answer in time" : "voice server unreachable");
  }
}

/** Whisper, through spokenView -- the phone's route. A long clip takes a while (large-v3
 *  on the CPU), hence the long timeout. 503 is spokenView's word for a dead whisperd; it is
 *  named rather than folded into "nothing heard", because one of the two means a service
 *  needs restarting. */
export async function transcribeRecording(rec: Recording): Promise<string> {
  const audio = await readFile(rec.path);
  const res = await voicePost("/transcribe", audio, "audio/wav", 180_000);
  if (res.status === 503) throw new Error("whisperd is down");
  if (!res.ok) throw new Error(firstLine(await res.text()) || `transcribe: HTTP ${res.status}`);
  const data = await res.json() as { text?: unknown };
  return typeof data.text === "string" ? data.text : "";
}

/** The spelling fixer, through spokenView -- the phone's route. The first fix after a
 *  quiet spell pays for a `claude` being started and primed (~5 s; ~1.4 s once warm). A
 *  refusal comes back as the server's own words (it answers refusals in plain text and
 *  knows exactly what went wrong), because text that was not actually checked must never
 *  come back looking like a fix. */
export async function fixSpelling(text: string): Promise<{ text: string; changes: string }> {
  const res = await voicePost("/fixspelling", JSON.stringify({ text }), "application/json", 60_000);
  if (!res.ok) throw new Error(firstLine(await res.text()) || `spelling fixer: HTTP ${res.status}`);
  const data = await res.json() as { text?: unknown; changes?: unknown };
  return {
    text: typeof data.text === "string" ? data.text : text,
    changes: typeof data.changes === "string" ? data.changes : "",
  };
}
