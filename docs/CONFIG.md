# Configuration reference

Everything lives in `hive.yaml`. `hive provision` reads it and generates the rest:

```
hive.yaml ──► rooms/<room>/<agent>/agent.yaml          identity + runtime limits
          ──► rooms/<room>/<agent>/agent.md            role prompt (kept if edited)
          ──► rooms/<room>/<agent>/.claude/settings.json   tools + hooks
          ──► budget.json                              caps the API enforces
          ──► egress-allow.json                        hosts the proxy allows
          ──► ~/.claude.json                           pre-trusted room paths
```

**Generated files are not hand-edited.** An agent cannot widen its own scope or raise its own cap
by rewriting a file, because the file is overwritten from the plan on every provision. Only
`agent.md` is preserved once it exists (pass `--force` to regenerate it).

Some fields below are marked **(doc only)** — they describe intent but are not yet read by any
code. They are listed so the file is not mistaken for being more configurable than it is.

## Top level

```yaml
home: /home/you/hive       # where rooms, logs and the DB live. Keep this in the WSL
                           # filesystem — /mnt/d is slow and has exec-bit problems.

api:                       # (doc only) the server reads HIVE_PORT / HIVE_HOST env vars
  host: 127.0.0.1
  port: 8787
  otlp_port: 4318
```

## Agent classes

A class bundles the four fields that must agree for a role to mean anything: what it may do
(`tools`), whether it may delegate (`role`, enforced by the API), where it runs (`runtime`),
and whether its session survives between tasks (`session`).

```yaml
rooms:
  - name: room-3
    agents:
      - name: lead
        class: planner
      - name: worker-1
        class: worker
      - name: critic
        class: reviewer
```

| Class | tools | role | session | May delegate |
|---|---|---|---|---|
| `planner` | read-only | planner | fresh | workers, builders, reviewers **in its own room** |
| `worker` | file-only | worker | fresh | no |
| `reviewer` | read-only | reviewer | fresh | no |
| `supervisor` | file-only | supervisor | persistent | workers in its own room |
| `builder` | shell (docker) | builder | fresh | no |

The planner/worker/reviewer set has a property the supervisor/worker pair lacks, and it is
structural rather than prompt-based:

- a **planner** decides what to do and **cannot implement it** — `Write` and `Edit` are denied
- a **reviewer** judges work and **cannot edit what it finds**, so a finding has to be written
  down; it also may not task anyone, or it would just be a slower planner
- a **worker** implements and may not create work for anyone

Verified live: planner → two workers in parallel → reviewer, and the reviewer caught both
defects seeded into a worker's output while correctly passing the one it had no evidence against.

Override a built-in class, or define your own, with a `classes:` block:

```yaml
classes:
  planner:
    model: claude-opus-5        # keep the class, change one field
  auditor:                      # a new class
    role: reviewer              # role decides authority — pick an existing one
    tools: read-only
    session: fresh
```

## `classes` → `defaults` → `room` → `agent`

Most specific wins. **A class beats `defaults`** — that is the point: a planner stays
read-only even when `defaults` says `tools: file-only`.

```yaml
defaults:
  runtime: tmux            # tmux | docker
  tools: file-only         # read-only | file-only | shell
  session: persistent      # fresh | persistent
  model: ''                # '' = the CLI default
  memory: 2g               # docker runtime only
  cpus: 2                  # docker runtime only
  task_timeout_s: 900
```

| Field | Values | Meaning |
|---|---|---|
| `runtime` | `tmux`, `docker` | how the room comes alive. `docker` = kernel-enforced boundary |
| `tools` | `read-only`, `file-only`, `shell` | selects the role template. `shell` **requires** `runtime: docker`; an unknown value is refused at provision time |
| `session` | `fresh`, `persistent` | `fresh` restarts the agent between tasks: costlier (the context floor again) but a safeguard flag cannot poison a queue, and a planner or reviewer does not carry the last task's opinions into this one |
| `model` | any model id, or `''` | passed as `--model` |
| `memory`, `cpus` | docker units | container limits; one worker cannot starve the building |
| `task_timeout_s` | seconds | recorded in `agent.yaml`; the runner's own default is 900 |

`provision` **refuses** `tools: shell` with `runtime: tmux` — a shell escapes the room in the
tmux runtime, so the unsafe pairing cannot be configured by accident:

```
hive: w1: tools: shell requires runtime: docker — a shell escapes the room in the
tmux runtime. Set runtime: docker on the agent or its room, or use tools: file-only.
```

## `rooms`

```yaml
rooms:
  - name: room-3
    runtime: tmux          # applies to every agent in this room
    agents:
      - name: lead
        class: planner     # a class implies its role; `role:` alone also works
      - name: worker-1
        class: worker
      - name: worker-2
        class: worker
```

`role` drives two things: the generated `agent.md` (a planner is told how to delegate, a
reviewer how to report), and the authority policy on who may task whom.

## `policy` — **(doc only)**

```yaml
policy:
  supervisor_may_task: worker
  worker_may_task: none
  max_depth: 1
```

The policy is **enforced**, but from `canTask()` in `api/server.js`, not from this block. The
rules in force:

| From | May task |
|---|---|
| `human` | anyone |
| `planner` | workers, builders, reviewers **in its own room** |
| `supervisor` | workers, builders, reviewers **in its own room** |
| `manager` | supervisors, planners, workers, builders, reviewers — across rooms |
| `boss` | anyone |
| `worker`, `builder`, `reviewer` | **nobody** (403) |

Pinned by `test/classes.test.js`, including the refusals: a reviewer may not order fixes, a
worker may not task a peer or its planner, and nobody may task upward or sideways.

To change the rules, edit `canTask()`. `HIVE_POLICY_OPEN=1` disables the check entirely — for
debugging only.

## `budget`

Enforced by the API at task-claim time. Written to `budget.json`, which the API re-reads on every
check, so `hive budget set` takes effect without a restart.

```yaml
budget:
  run_usd: 5.00            # whole hive, since the last `hive reset`
  agent_usd: 2.00          # default per agent
  task_usd: 1.00           # a single task (checked after it runs)
  warn_at: 0.8             # log a warning at this fraction of a cap
  on_exceed: pause         # pause | stop | warn
  agents:                  # per-agent overrides
    supervisor:
      agent_usd: 1.50
```

`0` or omitted = **uncapped** for that dimension. No `budget` block at all = uncapped hive. A
corrupt `budget.json` also falls back to uncapped rather than crashing — both are tested.

| `on_exceed` | Behaviour |
|---|---|
| `pause` | stop delivering work, keep the session alive. The runner logs the reason and the two commands that fix it, then polls slowly (15s) until the cap is raised. |
| `stop` | as `pause`, and kill the agent's session. |
| `warn` | log only, keep going. Not for unattended use; it exists so you can measure a workload before choosing caps. |

### Sizing a cap

An agent pays for its context before doing any work: roughly **$0.07–0.10 per turn** in a clean
WSL config, more with skills and plugins loaded. **A cap below about $0.15 will pause an agent
after one trivial task** — verified, a $0.06 cap paused a worker 3 seconds after a one-line file
write.

Cache *reads* are far cheaper than cache *creation*, so a long-lived session costs less per task
than a fresh one. Weigh that against one-session-per-task, which is safer against safeguard
poisoning (`CLI-NOTES.md`).

## `egress`

```yaml
egress:
  enabled: true            # (doc only) — `hive net up`/`down` controls this
  proxy_port: 3128         # (doc only) — HIVE_PROXY_PORT env var
  network: hive-internal   # (doc only) — HIVE_NET env var
  allow:                   # ← this is the part that is read
    - api.anthropic.com
    - statsig.anthropic.com
    - '*.sentry.io'
```

Only `allow` is read, and it becomes `egress-allow.json`. Patterns are matched exactly, or as
`*.suffix` — never as a substring, so `api.anthropic.com.evil.test` does not pass. An empty list
refuses everything.

Package registries are deliberately absent; see `SECURITY.md`.

The hive's own service names are always reachable regardless of this list, so a configuration
mistake degrades to "works" rather than silently killing telemetry.

## Environment variables

Config that is per-machine rather than per-building:

| | |
|---|---|
| `HIVE_HOME` | the building root (default `~/hive`) |
| `HIVE_API` | control-plane URL the CLI and runner use |
| `HIVE_PORT`, `HIVE_HOST` | what the server binds |
| `HIVE_TOKEN` | shared token; sent as `x-hive-token` |
| `HIVE_OTLP` | telemetry endpoint given to agents |
| `HIVE_OTLP_PORT`, `HIVE_OTLP_HOST` | what the collector binds |
| `HIVE_PROXY_PORT`, `HIVE_NET` | egress proxy port, internal network name |
| `HIVE_AGENT_IMAGE` | container image for the docker runtime |
| `HIVE_POLL_MS`, `HIVE_BUDGET_POLL_MS`, `HIVE_BOOT_TIMEOUT_MS`, `HIVE_TASK_TIMEOUT_MS` | runner timings |
| `HIVE_ROOM_ROOT`, `HIVE_LOG_DIR` | set **by** the runner for each agent; the guard reads them |

`HIVE_ROOM_ROOT` must reach the hook process. Put it on the `claude` invocation itself, not in a
preceding `export` — and note the guard denies *everything* when it is missing, so a broken
launch presents as a totally inert agent. See `POSTMORTEMS.md`.

## Validating a plan

```bash
node bin/hive.js provision hive.yaml     # errors are reported plainly, not as stack traces
node test/yaml.test.js                   # the parser is pinned by tests
```

The YAML parser is a minimal subset (maps, lists, scalars, `#` comments, 2-space indent) — no
anchors, multi-line strings or nested flow collections. It is deliberately small, but it is
security-relevant: it produces the egress allowlist and the budget caps, so `test/yaml.test.js`
pins the cases where a mis-parse would silently configure something other than what was written.
