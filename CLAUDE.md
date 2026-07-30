# automateLinuxTerminal

A terminal emulator built with Ink. The app embeds a real shell inside an Ink layout, so widgets (clock, status, etc.) live alongside the terminal as React components.

## Rules

- **Ink only.** All UI must be built with Ink components (`<Box>`, `<Text>`, hooks). No raw ANSI escape codes, ncurses, blessed, or other terminal rendering.
- The shell is embedded via `node-pty` + `@xterm/headless`. Pty output is parsed by xterm into a screen buffer, then rendered through Ink's React tree.
- Widgets are standard Ink/React components placed around the terminal area.

## Stack

- React + Ink (terminal UI framework)
- node-pty (pseudo-terminal for the embedded shell)
- @xterm/headless (terminal emulation / ANSI parser)
- TypeScript, run with `tsx`

## Run

```bash
npm start
```

Type `exit` in the embedded shell to quit.

## Context Menus (right-click)

Two right-click menus exist, rendered as absolutely-positioned Ink overlays with box-drawing borders (`ContextMenuOverlay` in `app.tsx`):

1. **`automateLinuxTerminalMenu`** — triggered by right-clicking the clock/status area. Shows the active Claude session ID (first 8 chars) and Claude's working directory. Items are hover-highlighted.
2. **`clipboard`** — triggered by right-clicking the terminal area. Provides Copy (disabled if no selection) and Paste.

## Session picker (`sessionPicker.tsx`)

A standalone Ink app that lists Claude sessions by the **topic** set in the session menu, so a session can be resumed by what it was about instead of by UUID. The `claudeResume` shell function (automateLinux `terminal/functions/claude.sh`) runs it and resumes whatever it returns; `claudeResumeById <uuid>` is the direct-by-id path.

```bash
npx tsx sessionPicker.tsx --out /tmp/pick.json [--filter monster]
npx tsx tests/testSessionPickerData.ts     # data-layer sanity check
```

- **Topics come from the dashboard's durable store** (`/opt/automateLinux/data/dashboard/claude-session-meta.json`), read as a file so the picker works with the dashboard down. A **missing** store is the "no topics set yet" case, not an error — `loadTopicSessions` returns empty on `ENOENT` only, so the caller prints its instruction instead of an `ENOENT` stack trace (`data/**` is gitignored, so a fresh machine always starts here). A corrupt store still throws. `sessionPickerData.ts` joins those topics to the transcripts under `~/.claude/projects`, taking each session's working directory from the `"cwd"` in its transcript — never from the project-dir name, which is a lossy encoding (`/root/.openclaw` → `-root--openclaw`).
- **`e` asks a Claude session what this one was about** — it spawns `claude -p --model haiku`, shows the answer in a panel, and speaks it via `say`; `←`/`esc` closes it (`→` is an alias). The panel opens **immediately** with an elapsed counter and fills in when the model returns: a one-shot costs ~4 s of startup plus inference (~11 s measured on a full session), which is far too long to block Ink's event loop or to leave looking frozen. `say` is spawned **detached** so pressing enter right after still lets the sentence finish. On failure the panel shows the error — it never falls back to showing raw prompts.
- **The voice captions are the best input, and the reason summaries are any good.** `/root/.claude/voice-history.jsonl` logs every line spoken by either side, tagged with its session id. Each of those lines was *already* composed to lead with the outcome and be understood without context — so the log is a pre-condensed narrative of what happened, both sides, in under a megabyte where the transcript is 70 MB of raw. It is also the only source that carries **outcomes rather than requests**: fed just the typed turns, the summarizer correctly answered *"I don't have direct access… I can't describe what improvements were suggested"*, because nothing it received said what came of anything. `readSpokenLines` joins on session id (verified: 20/20 newest sessions match). Absent captions are normal — a silent run, or no voice stack — and the summary falls back to typed turns alone; only an unreadable-but-present log throws.
- **Never describe the material's limits to a model you want an answer from.** The first prompt politely explained that long sessions are abridged; the model took that as licence to write about what it could not see instead of summarizing what it could. Same failure from a ragged clip: cutting a caption mid-sentence produced *"the analysis cut off mid-sentence, so it's unclear what was finished"* — the truncation became the story. Hence `clipToSentence`, and an explicit "summarize whatever is here, never say what you cannot determine".
- **`say` is called with `--topic`**, so a summary of `pt` is captioned, filed in voice history, and replayed under **pt** — not under whatever session the picker happens to be running inside (`say` otherwise resolves the label by process ancestry). `--session` is deliberately *not* pinned: it drives per-session mute at play time, so pinning it would let muting a session silently swallow the summaries you asked for about it.
- **The transcript is never sent; the user's own turns are.** Transcripts reach **70 MB** — millions of tokens, past any context window at any size — and Claude Code writes no `"type":"summary"` entries to reuse. So `readSessionDigest` extracts the user's turns locally (**~130 ms even on the 70 MB worst case**) and only that bounded `sample` becomes the prompt: first 30 turns, last 30, each clipped to 400 chars, which holds a 64-turn session to the same cost as a 6-turn one. The user-message filter (skip `tool_result`, skip `isMeta`) and the prompt-wrapper stripping are deliberate local copies of the dashboard's `prompt-utils.ts` — importing them would tie the picker to a repo whose root is per-peer configurable.
- **Three traps in spawning `claude` from here**, each of which has cost a session before: (1) **stdin must be `"ignore"`** — `claude -p` waits on it, and the picker's stdin is the user's keyboard, so inheriting it both eats keystrokes and stalls; (2) **spawn the binary at its absolute path, never the `claude` shell function** — the function re-enters itself in a non-interactive child (`BASH_ENV` redefines it) and forkbombed a past session into ~680 processes; `spawn()` with no shell cannot reach it; (3) **cwd is the picker's own directory, not the session's** — `claude` loads the `CLAUDE.md` of wherever it starts, and pulling a whole project's instructions into a one-line summary costs seconds and tokens for nothing.
- **The summary is written for the ear as well as the screen** — the same string is displayed and spoken, so the prompt forbids paths, code, hashes, and identifiers, and asks for rounded numbers. A superseded request is killed (`e` on a new row, or unmount) rather than left running.
- **Search matches the directory's last segment, never the whole path.** Every session here runs under `/opt/…`, so matching the full `cwd` made the needle `pt` match **all 83** sessions instead of the 7 actually about pt — the search silently did nothing for exactly the short needles worth typing.
- **`/` starts a search; every other letter is a command.** The picker used to filter on each printable key, which made single-letter commands impossible — `e` would just type "e" into the search box. Search is now an explicit mode (`/` to enter, `esc` to leave, text preserved), which buys the whole alphabet for actions: `e` digest, `q` quit. The prompt names the mode (`/` cursor = keys go to the search, `›` = keys are commands) and an unbound letter says so rather than being swallowed. Note **a command is the first character of `input`, not the whole string** — Ink delivers a fast typist or a paste as one multi-character `input`, so `input === "/"` silently fails on `/mon` and the remainder must seed the search box.
- **Keyboard only.** This runs inside the embedded shell, and the outer app claims the wheel (scrollback) and right-click (clipboard menu) before they reach the pty. Mouse-driven rows here would silently do nothing. Left-click and drag do reach a child that enables mouse tracking (`app.tsx` forwards SGR sequences when `term.modes.mouseTrackingMode !== 'none'`), but wheel and right-click never will.
- **The choice leaves through `--out`, not stdout** — stdout is Ink's canvas. No file written means the user quit.
- **It renders one empty frame before unmounting** so the list is erased instead of being left above the resumed session.
