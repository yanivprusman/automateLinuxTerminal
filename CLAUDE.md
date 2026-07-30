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
- **`e` answers "what was this one about?"** — it opens a digest of the highlighted session (first prompt, latest prompt, turn count) and speaks it via `say`; `←`/`esc` closes it (`→` is an alias for `e`). No model is involved: `readSessionDigest` pulls the user's own first and last messages straight out of the transcript, so it is instant, free, and more recognizable than generated prose. The spoken sentence is composed separately from the panel — paths stripped, excerpts shortened — per the house voice rules, and `say` is spawned **detached** so pressing enter immediately after still lets the sentence finish. The user-message filter (skip `tool_result`, skip `isMeta`) and the prompt-wrapper stripping are deliberate local copies of the dashboard's `prompt-utils.ts`: importing them would tie the picker to a repo whose root is per-peer configurable.
- **Why no model generates the digest.** Transcripts reach **70 MB** — millions of tokens, so a whole transcript cannot be fed to any model at any context size, and Claude Code writes no `"type":"summary"` entries to reuse. Extraction sidesteps that entirely: `readSessionDigest` measures **~130 ms on the 70 MB worst case**, costs nothing, and never fails. If prose is ever wanted, the shape is fixed by the same constraint — extract the user turns first (kilobytes), then summarize *those*; `claude-haiku-4-5` is the fast/cheap tier for it, and its 200K context is ample once the input is the extract rather than the file.
- **`/` starts a search; every other letter is a command.** The picker used to filter on each printable key, which made single-letter commands impossible — `e` would just type "e" into the search box. Search is now an explicit mode (`/` to enter, `esc` to leave, text preserved), which buys the whole alphabet for actions: `e` digest, `q` quit. The prompt names the mode (`/` cursor = keys go to the search, `›` = keys are commands) and an unbound letter says so rather than being swallowed. Note **a command is the first character of `input`, not the whole string** — Ink delivers a fast typist or a paste as one multi-character `input`, so `input === "/"` silently fails on `/mon` and the remainder must seed the search box.
- **Keyboard only.** This runs inside the embedded shell, and the outer app claims the wheel (scrollback) and right-click (clipboard menu) before they reach the pty. Mouse-driven rows here would silently do nothing. Left-click and drag do reach a child that enables mouse tracking (`app.tsx` forwards SGR sequences when `term.modes.mouseTrackingMode !== 'none'`), but wheel and right-click never will.
- **The choice leaves through `--out`, not stdout** — stdout is Ink's canvas. No file written means the user quit.
- **It renders one empty frame before unmounting** so the list is erased instead of being left above the resumed session.
