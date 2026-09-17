# Architecture

## The three nouns

| | |
|---|---|
| **room** | a scope boundary: a directory plus a capability set. The room is the capability. |
| **agent** | a resident assigned to a room. Several agents may share one room. |
| **API machine** | tasks, authority policy, audit, budget. The only component everything else talks to. |

A room and an agent are separate on purpose. Scope belongs to the *room*, so an agent never
restates where it may write, and several agents can be co-located (a supervisor and its workers)
without each re-declaring the boundary. Each agent still gets its own `workspace/` inside the
room, so two workers cannot clobber each other.

```
rooms/room-3/
  supervisor/
    agent.yaml            identity, role, runtime, limits   (generated)
    agent.md              the role prompt the agent reads   (generated, editable)
    .claude/settings.json tool allow/deny + hooks           (GENERATED — never hand-edit)
    workspace/            the ONLY writable tree; the agent's cwd
    inbox/ outbox/        human-readable mirror of the task queue
    state/
  worker-1/  …
  worker-2/  …
logs/<agent>/             denials, signals, runner log — OUTSIDE the room, so an agent
                          cannot edit its own audit trail
```

Settings are **generated** from `hive.yaml` on every provision. That is a security property, not
a convenience: an agent cannot widen its own scope or raise its own budget by rewriting a file,
because the file is overwritten from the plan.

## Agents never call the API

This is the load-bearing design decision.

A file-only agent has no `Bash`, no `WebFetch`/`WebSearch`, and no MCP servers
(`--strict-mcp-config`). It therefore *cannot* reach the control plane, another room, or the
internet. Its entire world is files in its workspace.

So the control plane is not a client library the agents use. The **runner** and the **lifecycle
hooks** talk to it; the agent only ever reads and writes files. That is why the isolation is
credible: there is no channel to abuse, rather than a channel that is policed.

Containerised agents do get a shell, and there the kernel and the egress proxy take over —
see `SECURITY.md`.

## Authority is not transport

Hierarchy (`boss → manager → supervisor → worker`) is a policy graph, not a routing graph.

Messages never travel *through* intermediate agents: every hop would cost tokens and lose
information to summarisation. Instead every agent's work arrives directly from the API, and the
hierarchy is enforced as **policy** on who may create tasks for whom.

```
POST /tasks  {from_agent, to_agent}
   human        → anyone
   supervisor   → workers in its own room
   manager      → supervisors, workers
   worker       → nobody          ← verified: 403
```

A worker may not task a peer, nor its own supervisor. Workers report upward through task
*results*, not by creating work.

Practical consequence: depth costs money and latency, and parallelism at the leaves is where the
value is. A supervisor plus N workers is the shape that pays; a `boss` and `manager` above it are
ceremony until they have something to decide that the supervisor cannot.

## How a task flows

```
hive send ──► tasks(queued)
                   │
                   ▼  runner claims it (atomic; budget gate refuses here if over cap)
            writes task.json + input/ INTO the workspace
                   │
                   ▼  tmux send-keys:  "read ./task.json and begin"
            agent works inside its room
                   │       ▲
                   │       └─ scope-guard denies any path outside the room
                   ▼
            Stop hook ──► last_assistant_message ──► tasks(done) + artifacts + cost
                   │
                   └─ supervisor's DELEGATE lines ──► new tasks (policy re-checked)
```

Three details that matter:

**The task body is never sent as keystrokes.** A newline in supervisor-generated text would
submit the prompt early, and multi-line text mangles. The runner writes the task to
`workspace/task.json` and sends one short line pointing at it. The DB is the source of truth;
`inbox/*.json` is a human-readable mirror for debugging by eye.

**Inputs are copied into the room.** An agent cannot read anything outside its workspace, so the
runner copies the files a task references into `workspace/input/`. Duplicated bytes, absolute
boundary.

**Results arrive by hook, not by scraping.** The `Stop` hook carries
`last_assistant_message` — the agent's complete reply as text, no ANSI. `capture-pane` is used
only as a boot watchdog for first-run dialogs, which appear before any hook fires.

## Delegation

A supervisor delegates by emitting lines in its reply:

```
DELEGATE worker-1: <instruction>
DELEGATE worker-2: <instruction>
```

The runner parses those and creates real tasks; the API still applies the authority policy, so a
supervisor cannot delegate outside its room and a worker's `DELEGATE` line is refused. The
supervisor has no other way to reach a worker — no shell, no network — which is what keeps the
policy authoritative rather than advisory.

## The control plane

Node built-ins only: `http` + `node:sqlite`. No dependencies.

```
agents      name, room, role, room_root, runtime, status, session_id
tasks       id, parent_id, from_agent, to_agent, brief, status, result, cost_usd, artifacts
events      append-only audit: SessionStart, UserPromptSubmit, Stop, task.*, budget.*, denial
denials     boundary violations, promoted out of events for visibility
messages    agent-to-agent notes that are not tasks
agent_costs / agent_tokens   running totals from OTLP telemetry
```

The schema *is* the interface — the HTTP layer, the runner and the CLI all agree there. Several
processes write this file (server, collector, CLI), which is why `db.js` sets `journal_mode=WAL`
and `busy_timeout=5000`; see `POSTMORTEMS.md` for what happens when it does not.

## Runtimes

One interface, two implementations, selected per agent by `runtime:` in `hive.yaml`.

| | `tmux` | `docker` |
|---|---|---|
| Boundary | `PreToolUse` hook matching paths | the kernel (mount namespace) |
| Shell for the agent | must be denied | **may be granted** |
| Watch a resident | `tmux attach -t hive-<agent>` | `docker exec -it hive-<agent> bash` |
| Results | `Stop` hook | `claude -p --output-format json` (also carries cost) |
| Egress control | none (host network) | internal network + allowlist proxy |

A third option exists and was tested but not chosen: Claude Code's own `--bg` background
sessions, which give persistence, `attach` and `logs` natively on Windows with no WSL or tmux.
Its constraint is that a *running* background session is exclusively held, so delivering a task
means `stop` → `--resume -p` → respawn. Details in `CLI-NOTES.md`.
