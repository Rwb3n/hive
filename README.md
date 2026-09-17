# hive

[![tests](https://github.com/Rwb3n/hive/actions/workflows/tests.yml/badge.svg)](https://github.com/Rwb3n/hive/actions/workflows/tests.yml)
[![platforms](https://img.shields.io/badge/verified-Windows%20%2B%20WSL%20Linux-blue)](docs/OPERATIONS.md)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#requirements)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](#requirements)
[![boundaries](https://img.shields.io/badge/boundaries-filesystem%20%C2%B7%20capability%20%C2%B7%20network%20%C2%B7%20spend-informational)](docs/SECURITY.md)
[![runtimes](https://img.shields.io/badge/runtimes-tmux%20%7C%20docker-0db7ed?logo=docker&logoColor=white)](docs/ARCHITECTURE.md#runtimes)

A building of scoped Claude Code agents. Each agent is a live `claude` process confined to its
own room, coordinated through a small HTTP control plane.

```
                    ┌──────────────────────────────┐
  you ─── hive ────►│  API machine (HTTP + SQLite) │◄─── lifecycle hooks
                    │  tasks · authority · audit   │     cost telemetry
                    └──────────────┬───────────────┘
                                   │ delivers work
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
   ┌──────────┐              ┌──────────┐             ┌──────────┐
   │ planner  │  DELEGATE ─► │ worker-1 │             │ reviewer │
   │          │              │ worker-2 │  ── output ►│          │
   └──────────┘              └──────────┘             └──────────┘
    read-only                  file-only                read-only
    decides, cannot            implements               judges, cannot
    implement                                           edit or delegate
```

The roles that **decide** cannot implement; the role that **judges** cannot edit or order fixes.
That is enforced by denying `Write`/`Edit` and by the API's authority policy, not by asking
nicely — see `docs/SECURITY.md`.

An agent's world is files in its room. It has no network tool, no shell (unless containerised),
and no MCP servers — so it cannot call the control plane, reach another room, or forge a message.
The runner and the hooks are the only things that talk to the API. **That is what makes the
isolation real rather than declared**, and each boundary below was verified by trying to break it.

## Status

Working, and exercised on real work. A supervisor decomposed a task, delegated to two workers who
ran in parallel, then integrated their output — editing it, not pasting it. In the process it
audited a claim against fresh test output, found an unverified assertion in this project's own
docs, and that led to a real symlink-traversal escape being found and fixed
(`examples/run-1/`, `docs/POSTMORTEMS.md`).

Three agent classes ship: **planner** (read-only, delegates), **worker** (writes), **reviewer**
(read-only, reports). Verified live — the reviewer caught both defects seeded into a worker's
output and correctly passed a third claim that turned out to be fine.

One seam is still manual: a task records its artifacts but nothing yet feeds them to the next
task, so moving a worker's output to a reviewer is a copy by hand. That is item 1 in
`docs/ROADMAP.md`.

**157 tests** green on Windows and WSL Linux — `node test/all.js`: 29 boundary, 27 budget, 25 egress,
45 classes, 21 delegation, 10 config. Run them on both platforms before trusting a change; two boundary bugs
were only visible on one of them.

## Quickstart

```bash
# one-time: claude inside WSL, credentials copied from Windows (no browser login needed)
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
npm install -g @anthropic-ai/claude-code
mkdir -p ~/.claude && cp /mnt/c/Users/<you>/.claude/.credentials.json ~/.claude/

# install and run
cp -r api bin templates hive.yaml ~/hive/ && cd ~/hive
node bin/hive.js up                    # control plane + telemetry collector
node bin/hive.js provision hive.yaml   # rooms, generated settings, pre-trusted dirs
node bin/hive.js start --all           # spawn agents and their runners

node bin/hive.js send lead "Plan the widget reference; split it between the workers."
node bin/hive.js ps                    # who is alive, doing what, at what cost
tmux attach -t hive-worker-1           # watch a resident work (ctrl-b d to detach)
```

Full command reference and the container/egress setup: `docs/OPERATIONS.md`.

## What is enforced

Five independent boundaries. Each was red-teamed, and what *isn't* covered is stated too.

| | Mechanism | Verified by attacking it |
|---|---|---|
| **Filesystem** | `PreToolUse` hook (tmux) / mount namespace (docker) | writes, reads, Glob/Grep, symlink + `..` traversal, credential reads — all blocked |
| **Capability** | `permissions.deny` removes tools from the session entirely | a shell-seeking prompt found no shell; denying `Bash` alone was *not* enough; a planner and reviewer genuinely cannot `Write` |
| **Network** | internal docker network + allowlist proxy | a raw shell could not exfiltrate by HTTPS, HTTP, raw TCP or DNS |
| **Authority** | the API refuses tasks the policy forbids | a worker cannot task a peer; a reviewer cannot order a fix |
| **Spend** | caps enforced at task-claim time | an agent paused itself 3s after exceeding its cap |

Not contained: a shell in the *tmux* runtime (use `runtime: docker`), traffic to the one
allowlisted host, and whatever a container does to itself. See `docs/SECURITY.md`.

## Documentation

Read in this order:

| | |
|---|---|
| `docs/ARCHITECTURE.md` | the model: rooms, agents, authority, how a task flows |
| `docs/SECURITY.md` | the five boundaries, what each does and does not cover |
| `docs/CONFIG.md` | every `hive.yaml` field |
| `docs/OPERATIONS.md` | running it: CLI, runtimes, telemetry, watching agents |
| `docs/CLI-NOTES.md` | Claude Code behaviour this depends on — **read before upgrading the CLI** |
| `docs/POSTMORTEMS.md` | the bugs that shaped the design, and why some code looks the way it does |
| `docs/ROADMAP.md` | what is missing, in the order it hurts — and what is deliberately not planned |

## Layout

```
hive.yaml              the building plan: rooms, agents, authority, budget, egress
api/
  server.js            control plane: tasks, authority policy, budget gate, audit
  collector.js         OTLP receiver — real cost and tokens, per agent
  egress-proxy.js      network allowlist; the only route out of a room
  budget.js            the cap decision table
  db.js  schema.sql    SQLite (WAL + busy_timeout — several processes write it)
bin/
  hive.js              the CLI
  provision.js         hive.yaml -> rooms, generated settings, pre-trusted dirs
  room-runner.js       spawns an agent, delivers tasks, collects results
  runtime-docker.js    a room as a container
  scope-guard.js       the filesystem boundary (PreToolUse hook)
  signal.js            lifecycle relay: SessionStart / UserPromptSubmit / Stop
docker/                agent image + compose stack
templates/             role settings, generated into each agent's .claude/
test/                  157 tests, both platforms
examples/run-1/        a real three-agent run: tasks, events, denials, output
```

## Requirements

WSL2 with Node 22+, `tmux`, and `claude` installed inside it; Docker for the container runtime
(the engine is reached from inside WSL). **No npm dependencies** — the whole thing runs on Node
built-ins, including SQLite (`node:sqlite`).
