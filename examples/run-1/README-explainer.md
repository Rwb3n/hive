# Rooms, the Boundary, and the Runtime

This document describes how agents are contained and how they are run. It has two
halves. The first defines the room — the per-agent working directory — and the
boundary that keeps an agent inside it, along with an honest account of what that
boundary does and does not enforce. The second describes the runtime: how a pane is
launched unattended, how first-run dialogs are suppressed, how results are signalled
back to the runner, and what it costs.

The two halves depend on each other. The boundary is expressed as flags and hooks that
the runtime has to pass on the command line, and the runtime's choice to run under WSL
is what gives the boundary a clean configuration to enforce against.

## Rooms and the boundary

### What a room is

A room is a per-agent working directory. Each agent is given one room and is expected
to do all of its work inside it. The path is published to the agent's environment as
`HIVE_ROOM_ROOT`, and that variable is the single value the rest of the boundary keys
off. Logs are kept outside the room, so an agent's own transcript and diagnostic output
are not part of the tree it can read or modify.

### The scope-guard hook

Containment is enforced by a `PreToolUse` hook. Before a tool call runs, the hook
receives a JSON payload on stdin describing the pending call: `tool_name`, `tool_input`,
`cwd`, and `tool_use_id`. The guard resolves the paths in the payload against
`HIVE_ROOM_ROOT` and decides whether the call stays inside the room.

To block a call, the guard prints a `hookSpecificOutput` object with
`permissionDecision: "deny"` and exits 0. A denial is a normal, successful run of the
hook, not an error exit. Denials are also visible after the fact: a run with
`--output-format json` lists them under `permission_denials[]`, which makes the boundary
auditable rather than only observable in the moment.

### Fail-open versus fail-closed

The first version of the guard crashed on a syntax error. Because a crashed hook was
treated as no objection, the out-of-room write it was meant to stop silently succeeded —
the failure was invisible at exactly the moment it mattered. The guard must therefore
deny on every abnormal path: `HIVE_ROOM_ROOT` unset, a room root that does not exist, an
unparseable payload, and anything else it cannot reason about. Those paths are covered by
tests.

The trade-off is real and worth stating plainly. A fail-closed guard turns an
environment mistake into a completely inert agent: if `HIVE_ROOM_ROOT` is missing or the
payload is malformed, the agent denies even legitimate in-room work and does nothing at
all. That is the intended behaviour, but it means environment setup errors present as
total paralysis rather than as partial function.

### Which tools are restricted, and why

The other half of the boundary is `permissions.deny`, which removes a tool from the
session entirely rather than prompting for it. Denying `Bash` alone proved insufficient:
an agent with no adversarial prompting used `ToolSearch` to find a deferred tool and then
ran a shell command through `Monitor`. The verified list therefore has 21 entries,
covering every execution- and escalation-capable tool plus `ToolSearch` itself. The list
is re-audited on each CLI upgrade, because a new tool ships enabled and absent from the
list.

### What is genuinely enforced, and what is not

Enforced: path traversal and prefix-confusion attempts are blocked. The current suite is
25 cases, 25 passing and 0 failing, run on both Windows and WSL Linux. It covers `..`
and deep traversal, absolute paths in both Windows and POSIX form, UNC paths, sibling
rooms, prefix confusion (`room-evil` against `room`), `Glob`/`Grep` by path, the `edits[]`
arrays of a multi-edit, cwd-relative paths, and per-platform case sensitivity, alongside
the abnormal-path cases above. Reads of the credentials file are blocked. MCP servers are
stripped by `--strict-mcp-config`.

Not covered: the suite has no symlink case, so symlink resolution is untested and should
not be counted as enforced until it is.

Not enforced: path matching cannot secure a shell, so the guard's path logic is only as
good as the absence of an execution tool behind it. `--settings` merges with rather than
replaces the global config, so hooks and skills from the global configuration are still
inherited into the session.

Until containers arrive, the hook boundary should be treated as protection against
mistakes and drift rather than against a determined or prompt-injected agent. Of the two
halves, the tool boundary is the stronger one.

## The runtime

### Launching an agent unattended

Agents run as `claude` processes inside tmux panes on WSL Ubuntu. Two pieces of host
setup make an unattended launch possible: a user-local npm prefix, so the CLI installs
and updates without root, and credentials copied into the WSL home directory, so a
starting agent never needs an interactive browser login.

The verified launch sequence is to create a detached tmux session whose working
directory is the room directory, then start `claude` in it with `--settings`,
`--permission-mode acceptEdits` and `--strict-mcp-config`. The first and last of those
are how the boundary described above reaches the session. Environment variables —
`HIVE_ROOM_ROOT` among them — are set on the invocation itself rather than exported in a
prior command, using an explicit minimal PATH. The export-line form was tried and
discarded: a double-quoted outer `wsl.exe -e bash -lc` expanded `$PATH` to the Windows
interop PATH before the inner shell ever saw it, which killed the export line.

One rule governs how work reaches a pane: task text never goes through `send-keys`. The
task is written to a file and the pane receives a one-line pointer to that file.

### First-run dialogs

Four interactive first-run dialogs will hang an unattended pane forever, because nothing
is there to answer them: the theme picker, the login-method prompt, the folder-trust
prompt, and the fullscreen renderer upsell. Their state lives in `~/.claude.json`, not in
`~/.claude/settings.json`, which is where one would expect to find it; each dialog is
suppressed by pre-setting its corresponding field in that file.

Folder trust also imposes an ordering constraint. Every room must be pre-registered under
`projects` in a single pass, before any agent is spawned. Concurrent `claude` processes
rewrite `~/.claude.json`, and racing writers lose entries, so incremental registration
during spawn is unsafe.

Because a new CLI version can introduce a new dialog at any time, suppression alone is
not sufficient. A boot watchdog is required to detect a pane that has stalled on an
unrecognised prompt.

Separately, safeguard flags can strand a pane on a model-switch dialog, and that dialog
poisons the rest of the session. Two mitigations follow: task text is worded as ordinary
work, and one session per task is preferred over reusing a session.

### The signal contract

Lifecycle hooks give the runner a precise signal contract, removing the need to scrape
terminal output:

- `SessionStart` — the agent is ready.
- `UserPromptSubmit` — a task actually landed in the pane.
- `Stop` — carries `last_assistant_message`, the complete result text, free of ANSI
  escapes.

This makes the runner push-driven. `capture-pane` is retained only as the boot watchdog
described above. For full detail beyond the final message, `transcript_path` points at
the structured JSONL kept outside the room.

### Measured cost

Configuration is the dominant cost variable. One trivial write executed under the
Windows global config, with its skills and plugins loaded, consumed roughly 23,000
cache-creation tokens at about $0.25. The same work under a clean WSL config consumed
about 6,200 tokens at about $0.069 — roughly 3.7 times less per turn. Running rooms in
WSL is therefore how config isolation is achieved, not merely where the agents happen to
live. It is also the practical answer to the `--settings` merge noted above: the merge
cannot be prevented, but the global config it merges from can be kept small.

Two implications follow for v1: idle agents must cost nothing, and per-agent budget caps
belong in the first release rather than a later one.

### Alternative considered

The native `claude --bg` background-session runtime was tested but not chosen. Its
governing constraint is that a running session is held exclusively.
