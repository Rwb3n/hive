# hive

A building of scoped Claude Code agents. Each agent is a live `claude` process confined to
its own directory, coordinated through a small HTTP control plane.

**Status: working.** A supervisor decomposed a task, delegated to two workers who ran in
parallel, then integrated their output into one document — editing it, not pasting it. In
the process it audited a claim against fresh test output, found an unverified assertion in
this project's own docs, and that led to a real symlink-traversal escape being found and
fixed. See `examples/run-1/`.

```
hive/
  hive.yaml              the building plan: rooms, agents, policy
  api/                   the API machine (HTTP + SQLite, node built-ins only)
    schema.sql           tasks, events, denials, messages, agents, costs, tokens
    server.js            the control plane
    collector.js         OTLP receiver: writes real cost + tokens into the DB
    db.js
  bin/
    hive.js              the CLI
    provision.js         hive.yaml -> rooms, generated settings, pre-trusted dirs
    room-runner.js       spawns an agent, delivers tasks, collects results
    runtime-docker.js    a room as a container — the boundary a shell cannot cross
    scope-guard.js       the room boundary (PreToolUse hook)
    signal.js            lifecycle relay (SessionStart/UserPromptSubmit/Stop)
  docker/                agent image + compose stack (api, collector, dashboards)
  templates/             role settings, generated into each agent's .claude/
    budget.js            caps: enforced at claim time, so nothing bypasses them
  test/                  56 tests (boundary + budget), green on Windows and Linux
  docs/
    CONFIG.md            everything in hive.yaml: rooms, roles, authority, budget
    FINDINGS.md          verified CLI behaviour — read before changing anything
    RUNTIME.md           how to launch an agent unattended, every trap documented
    CONTAINERS.md        the kernel-enforced boundary; what it does and does not cover
    TELEMETRY.md         cost/token accounting straight from the CLI
  examples/run-1/        a real three-agent run: tasks, events, denials, output
```

## The model

```
room          a scope boundary: a directory + a capability set
agent         a resident assigned to a room; several may share one room
API machine   tasks, events, audit, and the who-may-task-whom policy
```

An agent's world is files in its room. It has no network tool, no shell, and no MCP
servers — so it cannot call the API, cannot reach another room, and cannot forge a message.
The runner and the lifecycle hooks are the only things that talk to the control plane. That
is what makes the isolation credible rather than merely declared.

Hierarchy is **authority, not transport**. Messages never route through intermediate agents
(each hop costs tokens and loses information through summarisation); the API enforces who
may task whom. Verified: a worker may not task another worker, nor its own supervisor.

## Quickstart (WSL)

```bash
# one-time: claude in WSL with a user-local npm prefix, credentials copied in
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
npm install -g @anthropic-ai/claude-code
cp /mnt/c/Users/<you>/.claude/.credentials.json ~/.claude/.credentials.json

# install and run
cp -r api bin templates hive.yaml ~/hive/
cd ~/hive
node bin/hive.js up                      # start the API machine + telemetry collector
node bin/hive.js provision hive.yaml     # build rooms, generate settings, pre-trust
node bin/hive.js start --all             # spawn agents + runners
node bin/hive.js ps                      # who is alive, what they are doing, cost

node bin/hive.js send supervisor "Split the doc work between your workers."
node bin/hive.js tasks                   # the task tree
node bin/hive.js task <id>               # brief, artifacts, and the full result
node bin/hive.js denials                 # boundary violations
node bin/hive.js cost                    # per-agent tokens and real cost

tmux attach -t hive-worker-1             # watch a resident work (ctrl-b d to detach)
```

## How a task flows

```
hive send ──► tasks(queued) ──► runner claims ──► writes task.json into the workspace
                                              └─► tmux: "read ./task.json and begin"
                                                        │
agent works inside its room ◄─── scope-guard denies anything outside
                                                        │
              Stop hook ──► last_assistant_message ──► tasks(done) + artifacts
                                                        │
                        supervisor's DELEGATE lines ──► new tasks for workers
```

A supervisor delegates by emitting `DELEGATE <worker>: <instruction>` in its reply; the
runner turns those into tasks, and the API still checks the policy. Workers cannot delegate.

## What is actually enforced

| | |
|---|---|
| Writes/reads/Glob/Grep outside the room | blocked (29/29 tests, both platforms) |
| Reads of `~/.claude/.credentials.json` | blocked |
| MCP servers (Gmail, Drive, …) | none loaded (`--strict-mcp-config`) |
| Shell execution for file-only roles | removed from the session (21-entry deny list) |
| Worker tasking a peer or its supervisor | 403 from the API |
| Symlink escapes, incl. symlink + `..` traversal | blocked |
| Guard crash / missing env / bad payload | fails **closed** |
| Audit log | written outside the room; the agent cannot edit it |
| **A role granted a shell (tmux runtime)** | **not contained — use the docker runtime** |
| A role granted a shell (docker runtime) | contained: host FS unreachable, verified |
| Network egress from a container | **not restricted** — see `docs/CONTAINERS.md` |
| Spend past a cap | refused at claim (402); agent paused, audited |

The tool boundary (`permissions.deny`) is the stronger half of the tmux runtime: it removes
the capability from the session entirely rather than filtering arguments. Path matching cannot
secure a shell — so a worker that must run tests gets `runtime: docker`, where the kernel does
the enforcing. Verified: a shell-enabled agent fixed failing tests and could not touch the host.

## Cost

Telemetry comes from the CLI itself (`claude_code.cost.usage` over OTLP), so nothing is
estimated and there is no price table to go stale:

```
hive cost
AGENT          INPUT   OUTPUT  CACHE-READ  CACHE-CREATE       COST
worker-1        1417      234      153898          1099    $0.0970
builder-1       3724     2487      188794         49580    $0.6553
```

One caveat worth knowing: `cost.usage` is a **DELTA** sum — datapoints must be added, not
max'd. Summing one run's deltas reproduced the CLI's `total_cost_usd` to the cent; taking the
max under-reported by 40%.

## Budget

Caps are declared in `hive.yaml` and enforced by the **API at claim time**, so no runner and
no stray `curl` can route around them:

```yaml
budget:
  run_usd: 5.00        # whole hive
  agent_usd: 2.00      # per agent (per-agent overrides supported)
  task_usd: 1.00       # a single task
  on_exceed: pause     # pause | stop | warn
```

```
hive budget                                    # caps, spend, headroom
hive budget set --agent worker-1 --agent-usd 3
hive resume worker-1
```

Verified live: a worker with a $0.06 cap did one real task ($0.0973), **paused itself 3
seconds later** with the fix commands in its own log, refused the next task at the door, and
— once the cap was raised and it was resumed — recovered without a restart. Details and how
to size a cap: `docs/CONFIG.md`.

## Before you change anything

Read `docs/RUNTIME.md`. It documents the traps that cost the most to find: four first-run
dialogs that silently hang an unattended spawn, why a crashing hook fails open, why
denying `Bash` alone does not remove shell execution, how safeguard flags can strand a
pane, and the env/PATH quoting that makes an agent inert.

Every claim in the docs was tested against a live CLI. Re-verify on a version bump.
