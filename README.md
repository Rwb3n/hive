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
    schema.sql           tasks, events, denials, messages, agents
    server.js            the control plane
    db.js
  bin/
    hive.js              the CLI
    provision.js         hive.yaml -> rooms, generated settings, pre-trusted dirs
    room-runner.js       spawns an agent, delivers tasks, collects results
    scope-guard.js       the room boundary (PreToolUse hook)
    signal.js            lifecycle relay (SessionStart/UserPromptSubmit/Stop)
  templates/             role settings, generated into each agent's .claude/
  test/                  29 boundary tests, green on Windows and Linux
  docs/
    FINDINGS.md          verified CLI behaviour — read before changing anything
    RUNTIME.md           how to launch an agent unattended, every trap documented
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
node bin/hive.js up                      # start the API machine (in tmux)
node bin/hive.js provision hive.yaml     # build rooms, generate settings, pre-trust
node bin/hive.js start --all             # spawn agents + runners
node bin/hive.js ps                      # who is alive, what they are doing, cost

node bin/hive.js send supervisor "Split the doc work between your workers."
node bin/hive.js tasks                   # the task tree
node bin/hive.js task <id>               # brief, artifacts, and the full result
node bin/hive.js denials                 # boundary violations

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
| **A role granted a shell** | **not contained — waits for containers** |

The tool boundary (`permissions.deny`) is the stronger half: it removes the capability from
the session entirely rather than filtering arguments. Path matching cannot secure a shell,
so a worker that must run tests needs a container, not a better hook.

## Before you change anything

Read `docs/RUNTIME.md`. It documents the traps that cost the most to find: four first-run
dialogs that silently hang an unattended spawn, why a crashing hook fails open, why
denying `Bash` alone does not remove shell execution, how safeguard flags can strand a
pane, and the env/PATH quoting that makes an agent inert.

Every claim in the docs was tested against a live CLI. Re-verify on a version bump.
