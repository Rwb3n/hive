# Operations

## Install

One-time, inside WSL. `claude` must live in WSL because that is where tmux and the runner are;
the Windows binary cannot be driven from a Linux pane without path-translation pain.

```bash
# user-local npm prefix, so no sudo
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc

npm install -g @anthropic-ai/claude-code

# auth: copy the Windows credentials — no browser login needed
mkdir -p ~/.claude
cp /mnt/c/Users/<you>/.claude/.credentials.json ~/.claude/.credentials.json
chmod 600 ~/.claude/.credentials.json

# verify
claude -p "say OK" --output-format json     # must NOT say "Not logged in"
```

Then install the hive itself and provision:

```bash
cp -r api bin templates docker hive.yaml ~/hive/
cd ~/hive
node bin/hive.js up
node bin/hive.js provision hive.yaml
```

Running rooms in WSL with a clean `~/.claude` costs **~3.7× less per turn** than inheriting a
Windows global config full of skills and plugins (~6.2k vs ~23k context tokens), and isolates
better. Don't install skills or plugins into the hive's config dir without a reason.

> The copied credentials share a refresh token with Windows. If refresh rotates, one side may go
> stale; a single `claude` login inside WSL fixes it permanently.

## Commands

```
hive provision [plan.yaml] [--force]   build rooms + agents from hive.yaml
hive up | down                         control plane + telemetry collector
hive start <agent|--all>               spawn agent(s) and their runners
hive stop  <agent|--all>               kill agent + runner sessions
hive ps                                status table with cost
hive send <agent> "<brief>"            queue a task
hive tasks | task <id>                 list / show a task in full
hive watch <agent>                     print the attach command
hive log [agent]                       recent events
hive denials                           filesystem boundary violations
hive cost                              per-agent tokens and real cost
hive budget                            caps, spend, headroom
hive budget set [flags]                --run-usd N | --agent <name> --agent-usd N
                                       --task-usd N | --warn-at 0.8 | --on-exceed pause|stop|warn
hive resume <agent>                    un-pause an agent that hit its cap
hive goals                             every goal with its rollup
hive goal <id>                         one goal in full, with its tasks
hive goal new "<title>"                --budget N --priority 1-9 --tag X --brief "..."
hive goal set <id>                     --budget N --priority N --status … --notes "..."
hive send <agent> "…" --goal <id>      file a task under a goal
hive net up | down | status | log      egress: internal network + allowlist proxy
hive reset                             wipe tasks/events/denials (keeps agents AND goals)
```

## A normal session

```bash
hive up                                  # api + collector
hive start --all                         # agents boot in 2-3s
hive ps

hive goal new "Ship the widget reference" --budget 3 --priority 2
hive send lead "Plan it; split between worker-1 and worker-2." --goal g_ship-the-widget-reference
hive tasks                               # watch the planner's delegations appear
hive goals                               # progress and spend, rolled up per goal
hive task t_0mu5xkh2z7jif18              # brief, artifacts, and the full result

tmux attach -t hive-worker-1             # watch a resident work; ctrl-b d to detach
tmux attach -t hive-runner-worker-1      # watch its runner instead

hive cost                                # what it actually cost per agent
hive goal g_ship-the-widget-reference    # …and per goal, with its task list
hive stop --all && hive down
```

## Reading what happened

| Question | Command |
|---|---|
| who is alive, doing what, at what cost | `hive ps` |
| how is a piece of work progressing | `hive goals`, then `hive goal <id>` for its tasks |
| what did an agent actually reply | `hive task <id>` — the `result` is its `Stop` message |
| did it try to leave its room | `hive denials` |
| did it try to reach the network | `hive net log` |
| why did an agent stop | `hive log <agent>` — `budget.paused`, `runner.boot_failed`, … |
| did a delegation get refused | `hive log <planner>` — a 403 is logged by the runner as `delegation refused` |
| the full turn-by-turn detail | the session transcript: `~/.claude/projects/<slug>/<session>.jsonl` |

The transcript is worth knowing about: it is the most informative source of all, and it is what
exposed the `Monitor` shell bypass that the pane did not make obvious.

## The container runtime

For a role that needs a shell. Build the image once:

```bash
docker build -f docker/Dockerfile.agent -t hive/agent:2.1.274 \
  --build-arg UID=$(id -u) --build-arg GID=$(id -g) .
```

Then in `hive.yaml`:

```yaml
rooms:
  - name: room-9
    runtime: docker
    agents:
      - name: builder
        role: worker
        tools: shell
```

The image pins the CLI version deliberately: a new version can add a first-run dialog that hangs
an unattended spawn, so upgrading is an explicit act (`--build-arg CLAUDE_VERSION=`).

Docker notes for this machine: the Windows named pipe was unavailable, but the engine is reachable
from **inside WSL**, which is where the runner lives. Build and run from WSL.

Watch a containerised resident with `docker exec -it hive-<agent> bash`.

## Egress restriction

```bash
hive net up        # creates hive-internal (no route out) + hive-egress,
                   # starts hive-proxy (the only container on both)
                   # and hive-collector INSIDE the network
hive net status
hive net log       # every allow/refuse decision
hive net down
```

The collector must run *inside* the internal network: an agent there has no route to the host, so
a host-side collector is unreachable and cost silently reads `$0.00`. `hive net up` handles this.

## Budget

```bash
hive budget                                     # caps, spend, headroom
hive budget set --run-usd 10                    # whole hive
hive budget set --agent worker-1 --agent-usd 3  # one agent
hive resume worker-1                            # after raising a cap
```

```
on_exceed: pause    warn at 80% of a cap

HIVE TOTAL   $0.7523 of $5.00  [###.................] 15%

AGENT              USED         CAP              TASK CAP
worker-1          $0.0970   $2.00      [#...................]   5%  $1.00
worker-2          $0.0973   $0.06      [####################] 162%  $1.00      OVER
```

Raising a cap does **not** auto-resume; `hive resume` is deliberate and refuses while the agent
is still over. The runner then recovers on its own — it logs `budget cleared — resuming` and
takes the next task without a restart.

## Telemetry

Cost comes from the CLI itself, so nothing is estimated:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://hive-collector:4318
OTEL_RESOURCE_ATTRIBUTES=hive.agent=worker-1,hive.room=room-3,service.namespace=hive
```

The runner sets these for every agent. `OTEL_RESOURCE_ATTRIBUTES` carries custom tags through
verbatim, so every metric is labelled by agent and room.

| Metric | Notes |
|---|---|
| `claude_code.cost.usage` | **USD, computed by the CLI** — authoritative |
| `claude_code.token.usage` | one datapoint per `type`: `input`, `output`, `cacheRead`, `cacheCreation` |
| `claude_code.session.count`, `claude_code.active_time.total` | |

**These are DELTA sums** (`aggregationTemporality: 1`): datapoints must be **added**. Summing one
run's deltas reproduced the CLI's `total_cost_usd` to the cent; taking the max under-reported by
40%.

Optional dashboards: `docker compose --profile dashboards up -d` adds Prometheus and Grafana. Not
needed for `hive cost`, which reads the DB the collector writes.

There is also a `claude gateway --config <path>` subcommand described as an enterprise
auth/telemetry gateway. Its schema is undocumented and it was not probed; it may be a better
aggregation point for a multi-machine hive.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| agent boots then does nothing; every tool denied | `HIVE_ROOM_ROOT` never reached the hook, so the guard fails closed | check the launch line puts env on the `claude` invocation; `hive log <agent>` shows the denials |
| `hive cost` shows `$0.00` after real work | telemetry is not landing — collector died, or the proxy/network is blocking it | `docker logs hive-collector`, `hive net log`, check the collector process is alive |
| agent paused unexpectedly | budget cap | `hive budget`, then `hive budget set` + `hive resume` |
| agent stuck, `hive ps` says `busy` forever | safeguard flag stranded the pane on a dialog | `tmux attach` to look, then `hive stop`/`start`; reword the task as ordinary work |
| `runner.boot_failed` | an unknown first-run dialog | `hive log <agent>` includes the pane text; add the flag to `~/.claude.json` |
| `tools: shell` refused at provision | it needs `runtime: docker` | set the runtime, or use `file-only` |
| everything refused with 402 | run-wide cap exhausted | `hive budget set --run-usd <n>` then resume the agents |
| one goal's tasks refused, others fine | that goal is paused, done or over its budget | `hive goal <id>`, then `hive goal set <id> --budget N --status active` |
| a goal shows lifetime tasks but 0 open | normal after `hive reset` — tasks are wiped, goals are not | nothing to fix; `hive goal <id>` shows both figures |

Start with `hive log`, then `hive denials` and `hive net log`. Between them they cover
"what did it try to do that it was not allowed to do", which is most failures.

## Upgrading the CLI

Read `CLI-NOTES.md` first. In short: a new version can add a one-time interactive dialog that
hangs an unattended spawn, and can ship a new tool that is enabled and absent from the deny list.
Both have happened in spirit; both are silent. After upgrading:

```bash
node test/scope-guard.test.js        # the boundary still holds
hive start worker-1 && hive send worker-1 "write ok.txt containing OK"
                                     # boots without a dialog, and does work
# then audit the transcript: no tool outside the role's allow list
```

## CI

`.github/workflows/tests.yml` runs the suites on **ubuntu-latest and windows-latest, node 22
and 24**, with `fail-fast: false` so one platform's failure cannot hide the other's.

The matrix is not decoration. Two boundary bugs in this project were visible on one OS only:
case-folding let `/Room/x` past a `/room` guard on case-sensitive Linux, and a Windows-style
`C:/…` path is not absolute on Linux, so an escape attempt resolved *inside* the room. A
single-platform CI would have shipped both.

CI runs no agent and spends nothing — the suites unit-test the boundary logic, budget decision
table, egress matcher and config parser. No binaries, no network, no credentials.

Beyond the suites it asserts:

- `node:sqlite` is available (the control plane needs it; Node 22+)
- symlink capability is probed and printed, so a skip is never a surprise
- the shipped `hive.yaml` parses to the values it appears to declare — including that no
  allowlist entry parsed as a map, the inline-comment bug from `POSTMORTEMS.md`
- both role templates are valid JSON with a deny list
- the file-only role denies all 10 known execution paths and allows none — the regression test
  for the `ToolSearch` → `Monitor` bypass
- `node --check` on every source file, and no doc reference points at a consolidated file

**A skipped case fails the build.** `test/all.js` asserts an expected count per suite, because
the scope-guard suite skips its four symlink cases when the platform cannot create symlinks —
it would report "25 passed, 0 failed" and exit 0, going green with the symlink boundary
untested. That is this project's recurring failure mode (`POSTMORTEMS.md`), so it is now a
loud failure with the reason named.

Measured on the runners: both Ubuntu and Windows runners **can** create junctions and file
symlinks, so all 91 cases genuinely run on every combination. Windows file symlinks normally
need Developer Mode or elevation, so do not assume this of other CI providers or a local
Windows checkout — the count assertion is what tells you.

```bash
node test/all.js     # what CI runs; run it on both platforms before trusting a change
```
