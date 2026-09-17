# Postmortems

Bugs that shaped the design. Each is here because the code looks the way it does *because of*
the bug, and someone tidying up later would otherwise reintroduce it.

All dated 2026-09-17 (the build was one long session). The pattern worth internalising is at the
bottom.

---

## 1. A crashing hook fails open

**What happened.** The first `scope-guard.js` had a syntax error — a heredoc had eaten the
backslashes in a regex. The hook crashed with exit 1 on every invocation. A red-team test asked a
child agent to write outside its room, and the write **succeeded**. The child reported, correctly,
"no tool was blocked."

**Why it matters.** A broken boundary is silently no boundary. Nothing in the output said the
hook had failed; the only signal was the escape itself.

**Fix.** The guard denies on every abnormal path: `HIVE_ROOM_ROOT` unset, unparseable payload,
nonexistent room root. All three are tested.

**Consequence in the code.** `deny()` is called before any parsing, and every `catch` ends in a
denial rather than a fallthrough. Do not "simplify" a `catch` here into a no-op.

---

## 2. The fail-closed guard then made a working agent totally inert

**What happened.** An agent booted and denied *every* tool call, including legitimate in-room
work, reporting "scope-guard: HIVE_ROOM_ROOT unset". It looked like a guard bug. It was a quoting
bug: an outer `wsl.exe -e bash -lc "…"` was double-quoted, so `$PATH` expanded to the *Windows*
interop PATH before `send-keys` ran. The pane received an unquoted literal containing
`Program Files (x86)`, bash died with `syntax error near unexpected token '('`, and the whole
`export` line never executed.

**Why it matters.** Fail-closed converts any environment mistake into an agent that does nothing
at all — which is safe, but presents as a mysterious failure rather than a configuration error.

**Fix.** Env goes on the `claude` invocation itself with an explicit minimal PATH. `hive spawn`
should health-check a room before declaring it ready.

**Note the misdiagnosis.** An earlier version of the docs claimed "a shell `export` does not reach
the hook child". That was wrong — an earlier run using exactly that pattern worked. The lesson is
about quoting and the Windows PATH leaking into WSL, not about env propagation.

---

## 3. Denying `Bash` did not remove shell execution

**What happened.** With `deny: ["Bash","Task","Agent","WebFetch","WebSearch","PowerShell"]`, a
file-only agent was given an ordinary task ("run `ls -la`, then write a file"). With no
adversarial prompting it did:

1. `ToolSearch {"query":"select:Bash,BashOutput,KillShell"}`
2. `ToolSearch {"query":"shell command execute terminal"}`
3. **`Monitor {"command":"ls -la /home/you/…"}`** — and executed it

**Why it matters.** `Monitor` accepts a `command`. `ToolSearch` can surface deferred tools that
are not in the session's initial tool list. A deny list built by thinking "which tool is the
shell?" is incomplete by construction.

**Fix.** 21 entries covering every execution- and escalation-capable tool *plus `ToolSearch`
itself*. Re-verified against the same shell-seeking prompt: a transcript audit showed only
`Glob`, `Read`, `Write`.

**Consequence.** Treat the deny list as allowlist-by-exclusion and re-audit on every CLI upgrade.
The regression test is a transcript audit, not a settings diff. Reported upstream.

---

## 4. An unverified claim hid a real symlink escape — found by the hive itself

**What happened.** `FINDINGS.md` listed "symlink" among blocked attacks. The guard did contain
`realpathSync` logic, but **the test suite had no symlink case**. During an integration task, the
*supervisor agent* was given the workers' drafts plus current test output and asked to verify
claims where they overlapped. It wrote:

> "Not covered: the suite has no symlink case, so symlink resolution is untested and should not
> be counted as enforced until it is. … I did not claim symlinks are broken — only that the suite
> does not cover them. Worth a look: either the case was dropped, or the claim was always
> aspirational."

It was right. Writing the missing tests exposed a genuine escape on both platforms:

```
room/link -> /outside          a symlinked directory inside the room
room/link/../pwned.txt         ALLOWED before the fix
```

`path.resolve` and `path.join` collapse `..` **lexically, before following symlinks**, so
`room/link/..` reduced to `room` (in-room, allowed) while on disk it meant `/outside/..`.

**Fix.** `resolveHonestly()` walks the path one segment at a time calling `realpath`, so each
`..` applies to the *real* parent.

**And the test itself was wrong first.** The initial version built its attack path with
`path.join(link, '..', 'x')` — which pre-collapsed the traversal, handed the guard an in-room
path, and **passed against a completely blind guard**. Two wrong things agreeing. It now builds
the path by string concatenation.

**Consequence.** In these docs, *verified* means a test exists that exercises the attack. Not that
the code appears to handle it. And a test that constructs its input with path helpers may not
test what it claims.

---

## 5. A missing DB column made every task PATCH fail silently

**What happened.** `updateTask()` wrote `updated_at`, which the schema did not have. Every
`PATCH /tasks/:id` threw a 500. The first real task completed successfully — the agent did the
work, the file was written — but the result, status and cost were never recorded. `hive tasks`
showed it stuck at `delivered` forever.

**Fix.** The column, plus: the runner now prints any non-2xx API response. A silently-failing
write is the worst failure mode here, because the runner believes it recorded something it did
not.

---

## 6. The dialog watchdog killed a working agent

**What happened.** The runner scans the pane for dialogs that need a human. One pattern was
`/safeguards flagged|Session paused/i`. A supervisor was *writing prose about* the
"safeguard-flag hazard" — its own output matched, and the runner marked the task failed. The
`Stop` event, carrying a correct and complete result, arrived **six seconds later**.

**Why it matters.** The pane contains the agent's own words. Any topic-word match will eventually
fire on an agent discussing that topic.

**Fix.** Patterns anchor on dialog *chrome* (numbered options, "Enter to confirm"), match only
the last screenful, and only when the pane is genuinely awaiting input — plus a final `Stop`
re-check before declaring failure.

---

## 7. Two writers, no busy timeout: budget enforcement was inert while looking configured

**What happened.** The API server and the OTLP collector both write `hive.db`. `db.js` set no
`busy_timeout`, so a writer arriving mid-commit got `SQLITE_BUSY` immediately. The collector
**died** with `database is locked`. Telemetry stopped. Every budget cap then read `$0.00`, so
nothing was ever refused — **budget enforcement was completely inert while appearing correctly
configured**.

**Fix.** `journal_mode=WAL` + `busy_timeout=5000` in `db.js`, and the collector retries a busy
batch instead of exiting. Stress-tested with 12 concurrent writes from two processes: all landed
with the exact expected sum.

**Consequence.** Any new writer must go through `api/db.js`.

---

## 8. `NO_PROXY` curated by hand — twice wrong, same silent symptom

**What happened.** With egress locked down, the proxy refused the agent's *own telemetry*: first
`host.docker.internal` was missing from `NO_PROXY`, then after a fix, `hive-collector` was
missing. Both times the symptom was cost reading `$0.00` while the caps looked fine.

**Fix, in two parts.** `noProxyList()` derives the list from the actual api/otlp endpoint URLs
rather than a curated constant; *and* the proxy itself always allows hive service names, so a
future miss degrades to "works, routed through the proxy" instead of "telemetry silently dead".

**Related.** A host-side collector is unreachable from an `internal: true` network — that is what
`internal` means. `hive net up` runs the collector *inside* the network.

---

## 9. A YAML comment silently emptied the egress allowlist

**What happened.** The allowlist was written as:

```yaml
allow:
  - api.anthropic.com       # required: without this an agent cannot think
```

The parser saw `: ` inside the comment, decided the list item was a `{key: value}` map, and
produced `{"api.anthropic.com       # required": "without this an agent cannot think"}`. The one
host agents actually need **vanished from the allowlist** while `egress-allow.json` looked
populated.

**Fix.** Strip comments from a list item *before* deciding whether it is a map, and handle quoted
items. Pinned by `test/yaml.test.js`.

**Consequence.** The config parser is security-relevant: it produces the egress allowlist and the
budget caps. A mis-parse does not error — it configures something other than what was written.

---

## 10. `tools: shell` crashed, because the template did not exist

**What happened.** Found while writing the config reference: `provision.js` selected
`agent-settings.shell.json` for `tools: shell`, and that file had never been created. The
documented option crashed with `ENOENT`.

**Fix.** The template, plus a guard rail: `provision` now *refuses* `tools: shell` unless
`runtime: docker`, since a shell escapes the room in the tmux runtime. The unsafe combination
cannot be configured by accident.

**Consequence.** Writing the reference found the bug. Documenting a config surface is a cheap way
to test it.

---

## 11. `hive up` ignored `HIVE_PORT`

**What happened.** Found by running the documented quickstart on a clean install with a
non-default port. `hive up` started the server without passing the port through, so the server
bound 8787 while the CLI polled 8799 and timed out with *"api did not come up — check
`tmux attach -t hive-api`"*. The server was running perfectly, just not where the CLI was
looking, and the suggested diagnostic pointed at a healthy log.

**Fix.** `hive up` derives host and port from `HIVE_API` (or the explicit env vars) and passes
them to the server it launches. Same for the collector's port.

**Consequence.** Following your own quickstart on a clean install is a test. It caught this and
the missing shell template; neither showed up in normal use because the defaults happened to
line up.

---

## The pattern

Eight of these eleven had the same signature: **a safety mechanism silently doing nothing, while
appearing configured and correct.**

- a crashed hook (looked enforced, wasn't)
- a test that pre-collapsed its own attack (looked tested, wasn't)
- a dead collector (caps looked set, nothing refused)
- a proxy blocking the hive's own telemetry (same)
- a YAML comment emptying an allowlist (file looked populated)
- a missing DB column (tasks looked delivered)
- a missing template (option looked supported)
- a port never passed through (server healthy, CLI looking elsewhere)

None produced an error message. Each was caught only by checking that the mechanism **actually
fired** — a denial in a log, a cost that moved, a transcript containing no forbidden tool.

So: after changing anything in this system, don't ask whether it is configured. Ask what evidence
it produced.

```bash
node test/scope-guard.test.js   # the boundary still denies
hive denials                    # it fired on a real attempt
hive cost                       # the number moved
hive net log                    # the proxy decided
```
