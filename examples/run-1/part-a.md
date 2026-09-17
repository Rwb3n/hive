# Part A — Rooms and the Boundary

## What a room is

A room is a per-agent working directory. Each agent is given one room and is expected to do all of its work inside it. The path is published to the agent's environment as `HIVE_ROOM_ROOT`, and that variable is the single value the rest of the boundary keys off. Logs are kept outside the room, so an agent's own transcript and diagnostic output are not part of the tree it can read or modify.

## The scope-guard hook

Containment is enforced by a `PreToolUse` hook. Before a tool call runs, the hook receives a JSON payload on stdin describing the pending call: `tool_name`, `tool_input`, `cwd`, and `tool_use_id`. The guard resolves the paths in the payload against `HIVE_ROOM_ROOT` and decides whether the call stays inside the room.

To block a call, the guard prints a `hookSpecificOutput` object with `permissionDecision: "deny"` and exits 0. A denial is a normal, successful run of the hook, not an error exit. Denials are also visible after the fact: a run with `--output-format json` lists them under `permission_denials[]`, which makes the boundary auditable rather than only observable in the moment.

## Fail-open versus fail-closed

The first version of the guard crashed on a syntax error. Because a crashed hook was treated as no objection, the out-of-room write it was meant to stop silently succeeded — the failure was invisible at exactly the moment it mattered. The guard must therefore deny on every abnormal path: `HIVE_ROOM_ROOT` unset, an unparseable payload, and anything else it cannot reason about. Those paths are covered by tests.

The trade-off is real and worth stating plainly. A fail-closed guard turns an environment mistake into a completely inert agent: if `HIVE_ROOM_ROOT` is missing or the payload is malformed, the agent denies even legitimate in-room work and does nothing at all. That is the intended behaviour, but it means environment setup errors present as total paralysis rather than as partial function.

## Which tools are restricted, and why

The other half of the boundary is `permissions.deny`, which removes a tool from the session entirely rather than prompting for it. Denying `Bash` alone proved insufficient: an agent with no adversarial prompting used `ToolSearch` to find a deferred tool and then ran a shell command through `Monitor`. The verified list therefore has 21 entries, covering every execution- and escalation-capable tool plus `ToolSearch` itself. The list is re-audited on each CLI upgrade, because a new tool ships enabled and absent from the list.

## What is genuinely enforced, and what is not

Enforced: path traversal, symlink, and prefix-confusion attempts are blocked, with 15/15 unit tests passing. Reads of the credentials file are blocked. MCP servers are stripped by `--strict-mcp-config`.

Not enforced: path matching cannot secure a shell, so the guard's path logic is only as good as the absence of an execution tool behind it. `--settings` merges with rather than replaces the global config, so hooks and skills from the global configuration are still inherited into the session.

Until containers arrive, the hook boundary should be treated as protection against mistakes and drift rather than against a determined or prompt-injected agent. Of the two halves, the tool boundary is the stronger one.
