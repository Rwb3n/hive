# Configuration

Everything about a hive lives in `hive.yaml`. `hive provision` reads it and generates the
rest: room directories, per-agent `.claude/settings.json`, `agent.yaml`, `budget.json`, and
the pre-trusted room entries in `~/.claude.json`.

**Generated files are not hand-edited.** An agent cannot widen its own scope or raise its own
cap, because both are regenerated from the plan on every provision.

## Layers

```
defaults:  →  room:  →  agent:        most specific wins
```

```yaml
defaults:
  runtime: tmux             # tmux | docker
  tools: file-only          # file-only | shell
  model: ''                 # '' = the CLI default
  memory: 2g                # docker runtime only
  cpus: 2                   # docker runtime only
  task_timeout_s: 900

rooms:
  - name: room-3
    runtime: tmux           # overrides defaults for every agent in this room
    agents:
      - name: worker-1
        role: worker        # worker | supervisor | manager | boss
        tools: file-only    # overrides the room and defaults
```

`tools: shell` selects `templates/agent-settings.shell.json` instead of the file-only
template. **Only pair it with `runtime: docker`** — in the tmux runtime a shell escapes the
room (see `FINDINGS.md`).

## Authority

```yaml
policy:
  supervisor_may_task: worker
  worker_may_task: none
  max_depth: 1
```

Enforced by the API on `POST /tasks`, not by the transport. Verified: a worker may not task a
peer or its own supervisor (403).

## Budget

```yaml
budget:
  run_usd: 5.00             # whole hive, since the last `hive reset`
  agent_usd: 2.00           # default per agent
  task_usd: 1.00            # a single task (checked after it runs)
  warn_at: 0.8              # log a warning at this fraction of a cap
  on_exceed: pause          # pause | stop | warn
  agents:
    supervisor:
      agent_usd: 1.50       # per-agent override
```

`0` or omitted means **uncapped** for that dimension. No `budget` block at all means the hive
is uncapped — verified by test, along with a corrupt `budget.json` falling back to uncapped
rather than crashing.

### Where it is enforced

| Point | Behaviour |
|---|---|
| `POST /agents/:name/claim` | **the hard gate** — 402, no work delivered, agent marked `paused` |
| `POST /tasks` | courtesy — refuses to queue work that could never run |
| `PATCH /tasks/:id` (done/failed) | per-task cap: cannot undo the spend, but pauses the agent so it is the last one |

Enforcement lives in the **API**, not the runner: a second runner or a direct `curl` cannot
route around it. Verified — a raw `curl` claim returns 402.

Costs come from the CLI's own telemetry (`claude_code.cost.usage`), so caps are real dollars.
See `TELEMETRY.md`.

### Modes

- **`pause`** (default) — stop delivering work, keep the session alive. The runner logs the
  reason and the two commands that fix it, then polls slowly (15s) until the cap is raised.
- **`stop`** — as pause, and kill the agent's session.
- **`warn`** — log only and keep going. Not recommended unattended; it exists so you can
  measure a workload before choosing caps.

### Operating it

```bash
hive budget                                              # caps, spend, headroom
hive budget set --run-usd 10                             # whole hive
hive budget set --agent worker-1 --agent-usd 3           # one agent
hive budget set --task-usd 0.5 --warn-at 0.9
hive budget set --on-exceed warn
hive resume worker-1                                     # un-pause after raising a cap
```

```
on_exceed: pause    warn at 80% of a cap

HIVE TOTAL   $0.7523 of $5.00  [###.................] 15%

AGENT              USED         CAP              TASK CAP
worker-1          $0.0970   $2.00      [#...................]   5%  $1.00
worker-2          $0.0973   $0.06      [####################] 162%  $1.00      OVER
```

Raising a cap does **not** auto-resume: `hive resume` is deliberate, and it refuses while the
agent is still over. The runner then recovers on its own — verified, it logs
`budget cleared — resuming` and takes the next task without a restart.

Every transition is an event (`budget.paused`, `budget.resumed`, `budget.updated`,
`budget.task_exceeded`), so `hive log` shows why an agent stopped.

## ⚠️ Sizing caps: the context floor

An agent pays for its context before doing any work — roughly **$0.07–0.10 per turn** in a
clean WSL config, more with skills and plugins loaded. A cap below about $0.15 will pause an
agent after a single trivial task. Verified: a $0.06 cap paused a worker 3 seconds after one
one-line file write.

Cache reads are much cheaper than cache creation, so a long-lived session is cheaper per task
than a fresh one — weigh that against "one session per task", which is safer against
safeguard poisoning (`RUNTIME.md`).

## ⚠️ Concurrent writers

The api server, the OTLP collector and the CLI all write `hive.db`. `api/db.js` sets
`journal_mode=WAL` and `busy_timeout=5000` for this reason.

This was a real bug: without the busy timeout the collector died with
`database is locked`, telemetry stopped silently, and **every cap read $0.00 — budget
enforcement was inert while appearing to work.** The collector now also retries a busy batch
instead of exiting. Stress-tested with 12 concurrent writes from two processes: all landed.

If you add another writer, keep it going through `api/db.js`.
