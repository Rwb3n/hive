# Part B: The Runtime

## Launching an agent unattended

Agents run as `claude` processes inside tmux panes on WSL Ubuntu. Two pieces of host setup make an unattended launch possible: a user-local npm prefix, so the CLI installs and updates without root, and credentials copied into the WSL home directory, so a starting agent never needs an interactive browser login.

The verified launch sequence is to create a detached tmux session whose working directory is the room directory, then start `claude` in it with `--settings`, `--permission-mode acceptEdits` and `--strict-mcp-config`. Environment variables are set on the invocation itself rather than exported in a prior command, using an explicit minimal PATH. The export-line form was tried and discarded: a double-quoted outer `wsl.exe -e bash -lc` expanded `$PATH` to the Windows interop PATH before the inner shell ever saw it, which killed the export line.

One rule governs how work reaches a pane: task text never goes through `send-keys`. The task is written to a file and the pane receives a one-line pointer to that file.

## First-run dialogs

Four interactive first-run dialogs will hang an unattended pane forever, because nothing is there to answer them: the theme picker, the login-method prompt, the folder-trust prompt, and the fullscreen renderer upsell. Their state lives in `~/.claude.json`, not in `~/.claude/settings.json`, which is where one would expect to find it; each dialog is suppressed by pre-setting its corresponding field in that file.

Folder trust also imposes an ordering constraint. Every room must be pre-registered under `projects` in a single pass, before any agent is spawned. Concurrent `claude` processes rewrite `~/.claude.json`, and racing writers lose entries, so incremental registration during spawn is unsafe.

Because a new CLI version can introduce a new dialog at any time, suppression alone is not sufficient. A boot watchdog is required to detect a pane that has stalled on an unrecognised prompt.

Separately, safeguard flags can strand a pane on a model-switch dialog, and that dialog poisons the rest of the session. Two mitigations follow: task text is worded as ordinary work, and one session per task is preferred over reusing a session.

## The signal contract

Lifecycle hooks give the runner a precise signal contract, removing the need to scrape terminal output:

- `SessionStart` — the agent is ready.
- `UserPromptSubmit` — a task actually landed in the pane.
- `Stop` — carries `last_assistant_message`, the complete result text, free of ANSI escapes.

This makes the runner push-driven. `capture-pane` is retained only as the boot watchdog described above. For full detail beyond the final message, `transcript_path` points at structured JSONL.

## Measured cost

Configuration is the dominant cost variable. One trivial write executed under the Windows global config, with its skills and plugins loaded, consumed roughly 23,000 cache-creation tokens at about $0.25. The same work under a clean WSL config consumed about 6,200 tokens at about $0.069 — roughly 3.7 times less per turn. Running rooms in WSL is therefore how config isolation is achieved, not merely where the agents happen to live.

Two implications follow for v1: idle agents must cost nothing, and per-agent budget caps belong in the first release rather than a later one.

## Alternative considered

The native `claude --bg` background-session runtime was tested but not chosen. Its governing constraint is that a running session is held exclusively.
