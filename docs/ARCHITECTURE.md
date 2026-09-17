# Architecture

## The nouns

| | |
|---|---|
| **room** | a scope boundary: a directory plus a capability set. The room is the capability. |
| **agent** | a resident assigned to a room. Several agents may share one room. |
| **goal** | a standing intent that outlives a session. The one level above a task. |
| **task** | one unit of work for one agent. Nests via `parent_id`. |
| **API machine** | goals, tasks, authority policy, audit, budget. The only component everything else talks to. |

`goal` is the only durable one. Rooms and agents are regenerated from `hive.yaml`; tasks are
wiped by `hive reset`. A goal — with its budget, its lifetime counters and its progress note —
survives all of that on purpose, because it is the thing that says *what we are trying to do*.

A room and an agent are separate on purpose. Scope belongs to the *room*, so an agent never
restates where it may write, and several agents can be co-located (a planner and its workers)
without each re-declaring the boundary. Each agent still gets its own `workspace/` inside the
room, so two workers cannot clobber each other.

```
rooms/room-3/
  lead/                   (a planner)
    agent.yaml            identity, role, runtime, limits   (generated)
    agent.md              the role prompt the agent reads   (generated, editable)
    .claude/settings.json tool allow/deny + hooks           (GENERATED — never hand-edit)
    workspace/            the ONLY writable tree; the agent's cwd
    inbox/ outbox/        human-readable mirror of the task queue
    state/
  worker-1/  worker-2/    (workers)
  critic/                 (a reviewer)
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

## Classes: capability and authority travel together

An agent class bundles the four things that must agree for a role to mean anything:

```
tools     what it may do            enforced by permissions.deny in generated settings
role      whether it may delegate   enforced by the API's canTask()
runtime   where it runs             tmux (hook boundary) or docker (kernel boundary)
session   fresh | persistent        whether the session survives between tasks
```

Bundling them is the point. A "planner" that could still `Write` would be a worker with a
different prompt; a "reviewer" that could create tasks would be a slow planner. The classes are
meaningful because the capability and the authority are removed together:

| Class | tools | may delegate | in effect |
|---|---|---|---|
| `planner` | read-only | yes, own room | decides what to do, **cannot implement it** |
| `worker` | file-only | no | implements, **cannot create work** |
| `reviewer` | read-only | no | judges, **cannot edit or order fixes** |
| `supervisor` | file-only | yes, own room | decomposes and integrates |
| `builder` | shell (docker) | no | implements and runs tests |

The read-only classes still have the scope guard on `Read`/`Glob`/`Grep`, because a `Grep`
outside the room returns matching *lines* — it leaks file contents without writing anything.

### Session policy

`session: fresh` restarts the agent between tasks. It costs a context floor per task
(~$0.07–0.10) and buys two things: a safeguard flag cannot poison a queue (`CLI-NOTES.md`), and
a planner or reviewer does not carry the previous task's conclusions into this one. Judgement
roles default to `fresh` for the second reason as much as the first.

`session: persistent` keeps the session, so later tasks are mostly cache reads and much cheaper.
Right for a long-running supervisor that benefits from accumulated context.

## Authority is not transport

Hierarchy — `planner`/`supervisor` above `worker`/`builder`/`reviewer`, with `manager` and
`boss` above those — is a policy graph, not a routing graph.

Messages never travel *through* intermediate agents: every hop would cost tokens and lose
information to summarisation. Instead every agent's work arrives directly from the API, and the
hierarchy is enforced as **policy** on who may create tasks for whom.

```
POST /tasks  {from_agent, to_agent}
   human                        → anyone
   planner, supervisor          → producers in its OWN room
   manager                      → across rooms
   boss                         → anyone
   worker, builder, reviewer    → nobody          ← verified: 403
```

A worker may not task a peer or its planner; a reviewer may not order a fix. Producers report
upward through task *results*, not by creating work. Pinned by `test/classes.test.js`, refusals
included.

Practical consequence: depth costs money and latency, and parallelism at the leaves is where the
value is. One delegator plus N producers is the shape that pays; `manager` and `boss` above it
are ceremony until they have something to decide that a planner cannot.

## How a task flows

```
hive send ──► tasks(queued)
                   │
                   ▼  runner claims it (atomic; agent AND goal budget gates refuse here)
            writes task.json + input/ INTO the workspace
                   │
                   ▼  tmux send-keys:  "read ./task.json and begin"
            agent works inside its room
                   │       ▲
                   │       └─ scope-guard denies any path outside the room
                   ▼
            Stop hook ──► last_assistant_message ──► tasks(done) + artifacts + cost
                   │
                   └─ planner's DELEGATE lines ──► new tasks (policy re-checked)
```

Three details that matter:

**The task body is never sent as keystrokes.** A newline in planner-generated text would
submit the prompt early, and multi-line text mangles. The runner writes the task to
`workspace/task.json` and sends one short line pointing at it. The DB is the source of truth;
`inbox/*.json` is a human-readable mirror for debugging by eye.

**Inputs are copied into the room.** An agent cannot read anything outside its workspace, so the
runner copies the files a task references into `workspace/input/`. Duplicated bytes, absolute
boundary.

**A blocked task is parked, not lost.** If the agent is over its cap, or the task's goal is
paused or exhausted, the claim returns 402 and the task goes back to `queued` — so the agent
stays free for work under other goals and nothing disappears.

**Results arrive by hook, not by scraping.** The `Stop` hook carries
`last_assistant_message` — the agent's complete reply as text, no ANSI. `capture-pane` is used
only as a boot watchdog for first-run dialogs, which appear before any hook fires.

## Delegation

A planner or supervisor delegates by emitting lines in its reply:

```
DELEGATE worker-1: <instruction>
DELEGATE worker-2: <instruction>
```

The runner parses those and creates real tasks; the API re-applies the authority policy, so a
planner cannot delegate outside its room and a worker's or reviewer's `DELEGATE` line is refused.
A delegator has no other way to reach a producer — no shell, no network — which is what keeps
the policy authoritative rather than advisory.

Each instruction is everything its recipient gets: it cannot see the delegator's reasoning, the
other instructions, or anything outside its own room. So a good delegation names the output file,
states the sources, and says what *not* to cover. The generated `agent.md` for a planner says so.

The parser is deliberately liberal about shape — colon or dash separators, list items, bold or
backticked names — because a planner writes prose, not a protocol. It was once too strict and
silently dropped a correct plan (`POSTMORTEMS.md` #12).

## The control plane

Node built-ins only: `http` + `node:sqlite`. No dependencies.

```
agents      name, room, role, room_root, runtime, status, session_id
goals       id, title, brief, tag, status, priority, budget_usd, spent_usd, counters, notes
tasks       id, parent_id, goal_id, from_agent, to_agent, brief, status, result, cost_usd, artifacts
events      append-only audit: SessionStart, UserPromptSubmit, Stop, task.*, goal.*, budget.*, denial
denials     boundary violations, promoted out of events for visibility
messages    agent-to-agent notes that are not tasks
agent_costs / agent_tokens   running totals from OTLP telemetry
```

The schema *is* the interface — the HTTP layer, the runner and the CLI all agree there. Several
processes write this file (server, collector, CLI), which is why `db.js` sets `journal_mode=WAL`
and `busy_timeout=5000`; see `POSTMORTEMS.md` for what happens when it does not.

`db.js` also runs an additive `migrate()` on every open, **before** applying the schema:
`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a new column never
reaches an existing database and the server dies on first query. Keep migrations idempotent and
never destructive — a hive's DB holds goals that are meant to outlive everything else in it.

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
