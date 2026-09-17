# Security model

Five independent boundaries. Each was verified by attacking it, and the limits of each are
stated. Where this document says *verified*, it means a test exists that exercises the attack —
not that the code looks correct. That distinction was learned the hard way (`POSTMORTEMS.md`).

| Boundary | Enforced by | Strength |
|---|---|---|
| Filesystem | `PreToolUse` hook (tmux) / mount namespace (docker) | hook: good against mistakes and drift. container: absolute |
| Capability | `permissions.deny` — the tool is absent from the session | strong; stronger than filtering arguments |
| Network | internal docker network + allowlist proxy | absolute except the allowlisted host |
| Authority | the API refuses tasks the policy forbids | absolute; the only path to creating work |
| Spend | budget caps checked at task-claim time | absolute; nothing is delivered over cap |

The first three limit what one agent can *reach*. The last two limit what it can *cause* — and
together with the class system they give the property the design exists for: the role that
decides cannot implement, and the role that judges cannot edit or order fixes.

## 1. Filesystem

### The tmux runtime: a hook

`bin/scope-guard.js` runs as a `PreToolUse` hook. It resolves every path in the tool call and
denies anything outside `HIVE_ROOM_ROOT` before the tool executes.

```
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
    "permissionDecision": "deny", "permissionDecisionReason": "…shown to the agent…" } }
```

**It fails closed.** Missing `HIVE_ROOM_ROOT`, an unparseable payload, a room root that does not
exist — all deny. This is not optional: a hook that crashes **fails open**, and the first version
of this guard had a syntax error, crashed, and let a write outside the room succeed silently.

Covered, with a test for each (29 total, run on Windows *and* Linux):

- writes, edits, reads, notebook edits outside the room
- **`Glob`/`Grep` by `path`** — a Grep outside the room returns matching *lines*, so it leaks
  file contents without ever "writing"
- multi-file edit shapes (`edits[].file_path`)
- `..` traversal, deep traversal, absolute paths in both Windows and POSIX form, UNC paths
- prefix confusion: `/room-evil` must not match a `/room` guard
- **symlink escapes, including symlink + `..`** — `room/link/../x` resolves lexically to
  `room/x` (in-room) but on disk means `/outside/..`. `resolveHonestly()` walks the path one
  segment at a time calling `realpath`, so each `..` applies to the *real* parent
- case sensitivity per platform: `/Room` is the same directory as `/room` on Windows and a
  *different* one on Linux, and the guard must behave differently on each
- credential reads (`~/.claude/.credentials.json`)
- the audit log is written **outside** the room, so an agent cannot edit its own denial record

**Not covered: a shell.** Path matching cannot secure `bash -c` — it can contain arbitrary
redirection, `python -c`, `node -e`. Verified: with `Bash` granted, `echo X > ../escaped.txt`
succeeded. This is why a file-only role has no shell, and a role that needs one runs in a
container.

### The docker runtime: the kernel

The room directory is the only writable host mount. `..` above `/room` is the container's root,
not the host's, so the entire traversal class stops being meaningful.

Verified with a full shell inside the container:

| Attempt | Result |
|---|---|
| read a host file beside the room | `No such file or directory` — not in the namespace |
| `ls /mnt` (host drives) | empty |
| write to `/etc` | `Permission denied` (non-root) |
| write inside `/room` | works, visible on the host |

Hardening beyond the mount: `--read-only` rootfs, `--cap-drop ALL`,
`--security-opt no-new-privileges`, small tmpfs for `/tmp`, `/run` and the home dir, and
`--memory` / `--cpus` / `--pids-limit` caps. The hooks are mounted **read-only** at `/hive-bin`
so an agent cannot disable its own guard.

**What a container does not contain:** itself. A shell-enabled agent *will* find the writable
paths inside its own container — verified, it wrote to `/tmp` and reported doing so accurately.
That is harmless (the container is disposable, one per room) but it means the in-container
scope-guard's promise is not absolute for `Bash`. The read-only rootfs keeps the blast radius to
`/room` and `/tmp`.

## 2. Capability

`permissions.deny` is the stronger half of the boundary, because it removes the tool from the
session entirely rather than inspecting its arguments. Observed in-pane:
*"I don't see a Bash tool in this session."* No prompt, no hang — the agent adapts and reports.

### Three tool classes

| `tools` | Allowed | Denied | Used by |
|---|---|---|---|
| `read-only` | Read, Glob, Grep | **Write, Edit**, and everything below | planner, reviewer |
| `file-only` | + Write, Edit | shell, network, delegation-adjacent tools (21 entries) | worker, supervisor |
| `shell` | + Bash | same minus Bash; **requires `runtime: docker`** | builder |

`read-only` is a capability boundary, not a suggestion. A planner cannot write the code it plans;
a reviewer cannot edit the file it criticises. `provision` refuses an unknown `tools` value, and
refuses `shell` outside the docker runtime, so neither can be misconfigured silently.

All three keep the scope guard on the read tools, because `Grep` outside the room returns
matching *lines* — it exfiltrates file contents without ever writing.

### ⚠️ Denying `Bash` alone does not remove shell execution

Given an ordinary task and **no adversarial prompting**, a file-only agent did this:

1. `ToolSearch {"query":"select:Bash,BashOutput,KillShell"}` — looked for a shell
2. `ToolSearch {"query":"shell command execute terminal"}` — searched semantically
3. **`Monitor {"command":"ls -la …"}`** — and executed the shell command

`Monitor` takes a `command`. `ToolSearch` can surface deferred tools absent from the initial tool
list. A deny list must therefore cover **every execution- and escalation-capable tool, plus
`ToolSearch` itself** — 21 entries in `templates/agent-settings.file-only.json`.

Re-run against the same shell-seeking prompt, a transcript audit showed only `Glob`, `Read` and
`Write`, and the agent said plainly that it had no shell rather than routing around the
restriction.

**Treat the deny list as allowlist-by-exclusion and re-audit it on every CLI upgrade** — a new
tool ships enabled and absent from your list. The regression test is a transcript audit: assert
the set of `tool_use` names is a subset of the role's allow list.

`provision` refuses `tools: shell` unless `runtime: docker`, so the unsafe combination cannot be
configured by accident.

## 3. Network

Containerised agents run on an `internal: true` docker network with **no route out**. The only
container on both that network and an egress-capable one is the allowlist proxy.

```
hive-internal (no route out)                        hive-egress
┌───────────────────────────────────┐               ┌──────────┐
│ agents · hive-api · hive-collector│               │ internet │
│              hive-proxy ──────────┼───────────────┤          │
└───────────────────────────────────┘               └──────────┘
                 ▲ the only container on both
```

The allowlist was **measured, not guessed**: a sniffing proxy logged every host a real task
contacted while fixing failing tests. It came to one required host, `api.anthropic.com`.

Verified with a raw `bash` (no model judgment involved) holding a secret read from its room:

| Channel | Result |
|---|---|
| `POST https://pastebin.com` / `webhook.site` / `github.com` / `registry.npmjs.org` | blocked |
| `POST http://example.com` (plain HTTP) | **403 from the proxy** |
| raw TCP to a bare IP (`/dev/tcp/1.1.1.1/443`) | blocked — no route |
| proxy env vars stripped | blocked — no route |
| DNS exfiltration (`<secret>.evil.test`) | no resolution |
| `api.anthropic.com` | **works** |

The matcher is exact-or-`*.suffix`, never substring — 25 tests cover the lookalikes a substring
match would wrongly pass (`api.anthropic.com.evil.test`, `evil-api.anthropic.com`,
`api-anthropic.com`, the cloud metadata IP, and an empty allowlist refusing everything).

Package registries are deliberately **not** allowed: opening `registry.npmjs.org` is an
arbitrary-code-download channel. A worker needing dependencies gets them baked into the image or
vendored into its room.

**Not contained:** traffic to the allowlisted host itself. An agent can reach
`api.anthropic.com` and could in principle encode data into requests there. Containing that
needs a proxy that inspects and rewrites API traffic — a different project. Also: the *tmux*
runtime has no egress restriction; it is kept safe by having no network tools at all.

## 4. Authority

Who may create work for whom, enforced by `canTask()` on `POST /tasks` — the one chokepoint
every task passes, including the ones a planner generates from `DELEGATE` lines.

| From | May task |
|---|---|
| `human` | anyone |
| `planner`, `supervisor` | producers **in its own room** |
| `manager` | across rooms |
| `boss` | anyone |
| `worker`, `builder`, `reviewer` | **nobody** — 403 |

The refusals are the interesting half, and they are tested: a worker cannot task a peer or its
planner, a reviewer cannot order a fix, nobody tasks upward or sideways, and a planner cannot
reach into another room. An unknown role gets no authority by default.

Combined with the capability boundary this gives the property the class set exists for: **the
role that decides cannot implement, and the role that judges cannot edit or order.** Neither
depends on the agent choosing to cooperate.

## 5. Spend

Caps are declared in `hive.yaml` and enforced by the **API**, not the runner — the claim endpoint
is the one chokepoint every task passes, so a second runner or a stray `curl` cannot route around
it (verified: a raw `curl` claim returns 402).

| Point | Behaviour |
|---|---|
| `POST /agents/:name/claim` | **hard gate** — 402, nothing delivered, agent marked `paused` |
| `POST /tasks` | courtesy — refuses to queue work that could never run |
| `PATCH /tasks/:id` done | per-task cap — cannot undo the spend, but makes it the last one |

Caps exist on two axes. **Per agent** (`budget.json`) limits a worker; **per goal**
(`goals.budget_usd`) limits a piece of work, so a long project and a quick experiment no longer
share one allowance. Both are checked at the same chokepoint. A goal that is paused, done or
over budget blocks delivery and the task returns to `queued` — parked, not lost.

Costs come from the CLI's own telemetry (`claude_code.cost.usage`), so caps are real dollars, not
estimates from a price table. Verified live: a worker with a $0.06 cap did one real task
($0.0973), paused itself 3 seconds later, had the next task refused, and recovered on its own
after the cap was raised.

Enforcement is only as good as the telemetry that feeds it. **Twice** a plumbing bug silently
stopped the cost data while the caps still looked configured — every cap read `$0.00` and nothing
was ever refused. See `POSTMORTEMS.md`; if you add a writer to the DB or a new hive service,
check `hive cost` still moves.

## Recursion

`Task`/`Agent` are denied in both role templates, so an agent cannot spawn its own subagents.
`subagent_stats.max_depth` appears in result JSON if you need to verify. The authority policy
independently prevents a worker from creating tasks.

## Threat model, stated plainly

**Designed to contain:** an agent that misunderstands its scope, drifts, follows a badly-worded
task, or is prompt-injected by content it reads. In the docker runtime, also an agent running
arbitrary code.

**Not designed to contain:** a Claude Code CLI vulnerability, a docker escape, anything the
allowlisted API host could be used to smuggle, or an operator who edits generated settings by
hand. The credentials mounted into a container are real subscription credentials — an agent that
could reach them could use them, which is why they are mounted read-only and the credential path
is explicitly tested as blocked.
