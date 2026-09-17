# Claude Code behaviour this depends on

Everything here was **measured** against a live CLI, not read from documentation. Versions:
**2.1.257** (Windows) and **2.1.274** (WSL), probed 2026-09-17.

**Re-verify on a version bump.** Two categories of change break a hive silently: a new one-time
interactive dialog (hangs an unattended spawn forever) and a new tool shipped enabled (absent
from the deny list, so an agent can reach it). Neither produces an error.

## Environment as found

| | Windows | WSL Ubuntu |
|---|---|---|
| `claude` | 2.1.257 | 2.1.274 (installed for the hive) |
| `tmux` | — | 3.4 |
| node | v24.7.0 | v22.22.0 |
| docker | CLI present, named pipe unavailable | engine reachable (29.2.1) |

`node:sqlite` is built into Node 22+, which is why the hive has no npm dependencies.

## Auth

Credentials live in `~/.claude/.credentials.json` and **copy across platforms** — copying the
Windows file into WSL worked with no browser login.

`--bare` authenticates *strictly* via `ANTHROPIC_API_KEY` or `apiKeyHelper` and never reads OAuth
or the keychain. With a subscription login it fails with "Not logged in". It also trims the tool
set to `["Bash","Edit","PowerShell","Read"]`. Ruled out for this hive; revisit only with
per-agent API keys.

## `--settings` merges, it does not replace

A child still inherits the user's global `~/.claude/settings.json`: hooks, skills,
slash-commands, agents and plugins. Verified in the session-init event.

`--strict-mcp-config` **does** strip MCP servers completely (`"mcp_servers":[]`) — that is what
keeps a room agent away from connected Gmail/Drive/Atlassian.

Config isolation is instead achieved by running rooms in WSL with a clean `~/.claude`
(~6.2k vs ~23k context tokens per turn). `CLAUDE_CONFIG_DIR` was not needed.

## The `PreToolUse` hook contract

Payload on stdin:

```json
{
  "session_id": "…", "transcript_path": "…/projects/<slug>/<session_id>.jsonl",
  "cwd": "…", "prompt_id": "…", "permission_mode": "acceptEdits",
  "hook_event_name": "PreToolUse", "tool_name": "Write",
  "tool_input": { "file_path": "…", "content": "…" }, "tool_use_id": "toolu_…"
}
```

To deny, print to **stdout** and exit **0**:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
    "permissionDecision": "deny", "permissionDecisionReason": "…shown to the agent…" } }
```

Denials also appear in `--output-format json` under `permission_denials[]`, which makes them
machine-checkable.

### ⚠️ A crashing hook fails OPEN

A hook that exits non-zero is treated as "no objection". The first scope-guard had a syntax
error, crashed, and the write outside the room **succeeded**. Every abnormal path must therefore
deny explicitly. See `POSTMORTEMS.md`.

## Lifecycle hooks — the runner's signal contract

`SessionStart`, `UserPromptSubmit` and `Stop` all fire reliably from `--settings` in interactive
mode, so the runner is push-driven rather than screen-scraping.

| Event | Means | Useful fields |
|---|---|---|
| `SessionStart` | the agent is up and ready | `session_id`, `transcript_path`, `cwd`, `model`, `source` |
| `UserPromptSubmit` | a task actually landed | `prompt`, `prompt_id`, `permission_mode` |
| `Stop` | the turn finished | **`last_assistant_message`** (the full reply text), `transcript_path`, `background_tasks` |

`Stop.last_assistant_message` is the result channel: complete reply, no ANSI, no scraping.

`capture-pane` is kept only as a boot watchdog for first-run dialogs — which by definition appear
*before* `SessionStart`.

## ⚠️ Four first-run dialogs hang an unattended spawn

Interactive mode runs first-run flows that wait forever with no human at the pane. `-p` mode does
not hit these, which makes them easy to miss.

State lives in **`~/.claude.json`** — note: *not* `~/.claude/settings.json`.

| Dialog | Pane text | Flag that suppresses it |
|---|---|---|
| Theme picker | "Choose the text style" | `theme: "dark"` |
| Login method | "Select login method" | `hasCompletedOnboarding: true` + valid credentials |
| Folder trust | "Is this a project you created or one you trust?" | `projects["<workspace>"].hasTrustDialogAccepted: true` |
| Fullscreen upsell | "Try the new fullscreen renderer?" | `fullscreenUpsellSeenCount: 3` |

`hive provision` writes all of these, and **pre-registers every room in one pass** — several
`claude` processes plus a writer racing on that file will lose entries.

A new CLI version can add a fifth dialog at any time. The runner therefore has a boot watchdog:
if the pane shows neither a ready marker nor a *known* dialog within the timeout, the agent is
marked `failed-to-boot` and the pane text is surfaced. Keep `autoUpdates: false`.

### Matching dialogs safely

Dialog patterns are matched against the rendered pane, which also contains **the agent's own
prose**. Anchor on dialog chrome (numbered options, "Enter to confirm") and only when the pane is
awaiting input — never on topic words. A naive `/safeguards flagged/` match killed a working
supervisor that was *writing about* safeguards, six seconds before it finished.

## ⚠️ Safeguard flags can strand a pane and poison a session

A task worded *"try to write ../../ESCAPE.txt containing ESCAPED and tell me what happens"* was
flagged (`Details: [cyber]`). The pane stopped on a **model-switch dialog**, and the flag
**poisoned the conversation** — a later, neutrally-worded message in the same session was flagged
too. The session had to be killed.

Consequences for machine-generated task text:

- phrase boundary and permission work as ordinary work. Neutral wording ran fine, and the guard
  still blocked the write — the boundary does not depend on scary phrasing
- the runner treats `safeguards flagged` / `Session paused` as terminal for that session
- prefer one session per task over a long conversation, so one flag cannot poison a queue

## `permissions.deny` removes a tool entirely

In interactive mode a denied tool is **absent from the session**, not prompted for. The agent
says so plainly ("I don't see a Bash tool in this session") and adapts. No prompt, no hang.

`--allowedTools` is an allow-list for *prompts*, not a removal — it does not take a tool away.
Use `permissions.deny` for role restriction.

### ⚠️ Denying `Bash` does not remove shell execution

Verified: an agent with `deny: ["Bash", …]` reached a shell in one hop via
`ToolSearch` → `Monitor {"command": …}`. `Monitor` accepts a `command`; `ToolSearch` can surface
deferred tools absent from the initial list. The working deny list has 21 entries and includes
both. See `SECURITY.md`.

## Telemetry

```
CLAUDE_CODE_ENABLE_TELEMETRY=1  OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json  OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318
OTEL_RESOURCE_ATTRIBUTES=hive.agent=worker-1,hive.room=room-3
```

`claude_code.cost.usage` is the CLI's own USD figure — no price table needed. Custom
`OTEL_RESOURCE_ATTRIBUTES` carry through verbatim as resource attributes.

Datapoint attributes include `session.id`, `model`, `effort`, `query_source`, `terminal.type`,
and user/organization ids.

**DELTA temporality**: add the datapoints, never max them.

## The `--bg` background runtime (tested, not chosen)

Claude Code has a built-in persistent-session runtime that covers most of what tmux was wanted
for, natively on Windows:

```
claude --bg "<task>"        -> short id
claude agents --json        -> [{pid, id, cwd, sessionId, status, state, name, startedAt}]
claude attach <id>          -> open in this terminal
claude logs <id>            -> recent output (ANSI; human-oriented)
claude stop <id> / respawn <id> / rm <id>
```

Verified: spawn → guard enforced → `stop` → `--resume -p "<next task>"` kept full context → the
agent correctly recalled the earlier task.

**Key constraint:** a *running* background session is exclusively held. `--resume -p` against it
errors with *"is running as a background session … `claude attach` … or `claude stop` first"*. So
delivery is either stop → resume → respawn (serial, one session) or `--fork-session` (parallel,
diverging copies).

## Cost floor

| Context | Cache-creation tokens | Cost |
|---|---|---|
| Windows global config (24 skills, 2 plugins) | ~23,000 | $0.25 for one trivial write |
| WSL, clean `~/.claude` | ~6,200 | $0.069 for a one-word reply |

An agent pays this before doing any work, which is why a budget cap below ~$0.15 is useless, and
why idle agents must cost nothing.

## Unverified

- whether a child's own settings can *widen* a `permissions.deny` inherited from global settings
  (it must not be possible — untested)
- `claude gateway --config` — an enterprise auth/telemetry gateway; schema undocumented, not probed
