# Roadmap

What is missing, in the order it hurts. Each item says what is broken today, what "done" means,
and roughly what it costs — so the list can be argued with rather than just agreed to.

Nothing here is speculative feature-listing: every item is either a gap the code admits
(`(doc only)` in `CONFIG.md`), a limit `SECURITY.md` states, or something a live run exposed.

---

## Now — the pipeline has a manual seam

### 1. Artifact hand-off between tasks

**Today.** A task records `artifacts_json` when it finishes, and nothing reads it. In every live
run so far, moving a worker's output into the reviewer's room was **a human copying files**. The
planner → worker → reviewer chain is three automated steps joined by two manual ones.

**Done means.** A task can declare where its inputs come from, and the runner materialises them:

```yaml
# in a DELEGATE line or a task body
inputs_from: [t_abc123, t_def456]     # the artifacts of those tasks
```

The runner copies those artifacts into `workspace/input/` exactly as it already does for
file paths. `parent_id` already exists in the schema and is already set by delegation, so "the
outputs of my siblings" is expressible without new plumbing.

**Why first.** Without it the class system is a demo: the roles are real but the pipeline is not.
Everything below is less valuable than closing this seam.

**Cost.** Small — one resolution step in `materialise()`, plus a syntax for it in a DELEGATE
line. Half a day.

### 2. The review loop

**Today.** A reviewer cannot task anyone (correctly — it would be a slow planner), so its
findings go into a task result and stop. Nothing acts on them.

**Done means.** A reviewer's findings return to the *planner*, which decides what to do about
them. That is the right shape: judgement flows up to the role with authority, not sideways into
the thing being judged.

```
planner ─► workers ─► reviewer ─► planner (round 2, with findings as input)
```

Needs #1, plus a `reply_to` on a task so a result can be routed back to its originator, and a
round counter so a bad loop terminates.

**Cost.** Small once #1 exists. The interesting part is not the plumbing but the stopping rule:
how many rounds, and who decides "good enough".

### 3. Make `(doc only)` config real — or delete it

**Today.** `CONFIG.md` honestly marks five fields as decorative: `api.host/port/otlp_port`,
`egress.enabled/proxy_port/network`, and the whole `policy:` block. The policy is enforced, but
from `canTask()` in code, so editing `hive.yaml` does nothing.

**Done means** either the fields are read, or they are removed from the file. A config field that
looks live and is not is the same class of problem as the rest of `POSTMORTEMS.md`.

The `policy:` block is the one worth making real: a hive whose authority graph is data can be
audited and diffed. `canTask()` becomes a table lookup over `hive.yaml`.

**Cost.** Half a day for the ports; a day for policy-as-data, including tests that the refusals
still hold.

---

## Next — shapes the primitives support but the code does not

### 4. Room classes

**Today.** `class:` works on an agent and is ignored on a room. `ARCHITECTURE.md` describes a
room as "a directory plus a capability set", but the only room-level dial is `runtime`.

The two worth building:

- **`worktree`** — the room *is* a git worktree of a shared bare repo; each agent gets a branch
  and the integrator merges. This changes the unit of work from *files* to *commits*, which makes
  "did this actually work" answerable by `git diff` and `npm test` rather than by reading prose.
  It is the single biggest change in usefulness on this list.
- **`readingroom`** — inputs mounted read-only, the only writable path is `outbox/`. The natural
  home for a reviewer, and it needs the guard to grow a read/write distinction (it currently
  treats both the same).

**Cost.** `worktree` is a few days: git plumbing, branch-per-agent, merge handling, and the
failure modes (conflicts, dirty trees) are where the work actually is. `readingroom` is a day,
mostly in the guard and its tests.

### 5. Retry and failure policy

**Today.** `tasks.attempts` is incremented and never consulted. A failed task stays failed. A
boot failure returns the task to the queue (good) but a *task* failure does not.

**Done means** per-class retry limits, a distinction between retryable failures (respawn failed,
timeout) and terminal ones (safeguard-flagged, over budget), and a dead-letter state a human
actually sees.

**Cost.** A day. Mostly deciding the taxonomy, not writing it.

### 6. The unused `messages` table

**Today.** The schema has `messages` with a delivery flag and nothing uses it. It was built for
"agent-to-agent notes that are not tasks" and that need never materialised, because results
carry everything so far.

**Done means** a decision: either wire it up for a real case (a worker flagging a concern
mid-task without failing) or drop the table. Dead schema is a trap for the next reader.

**Cost.** An hour to delete; a day to wire up properly.

---

## Later — real but not yet earned

### 7. Multi-machine

`ARCHITECTURE.md` already puts an HTTP seam in the right place for it, and `CLI-NOTES.md` notes
`claude gateway --config` exists as a possible aggregation point. Needs per-agent tokens (today
it is one shared `HIVE_TOKEN`), a non-loopback bind, and a real answer for credentials on a
second host.

**Cost.** A week, and it buys nothing until one machine is genuinely the constraint.

### 8. Egress: containing the allowlisted host

`SECURITY.md` states the limit plainly: an agent can reach `api.anthropic.com` and could encode
data into requests there. Containing that means a proxy that inspects and rewrites API traffic —
a different project, and one with its own failure modes.

### 9. Web view over the event log

Everything needed is already recorded: `events`, `denials`, `agent_costs`, task trees with
`parent_id`. A read-only page over the DB would make a run legible at a glance in a way `hive ps`
cannot. Pure convenience — worth doing only once the pipeline above is closed.

---

## Deliberately not planned

- **More roles.** `manager` and `boss` exist in the authority table and are ceremony until they
  have something to decide a planner cannot. Adding org-chart depth costs tokens and latency and
  buys nothing; parallelism at the leaves is where the value is.
- **A GUI.** The CLI plus `tmux attach` is the right interface for watching agents work.
- **Prompt-engineering the roles.** The classes work because capability and authority are
  *removed*, not because the prompt asks nicely. Tuning `agent.md` is the least durable
  improvement available.
- **Windows-native runtime.** `claude --bg` was tested and works (`CLI-NOTES.md`), but WSL is
  cheaper per turn and containers need it anyway.

---

## The standing rule

From `POSTMORTEMS.md`: nine of twelve bugs in this project were a safety mechanism silently doing
nothing while appearing configured. So for anything on this list, *done* means the mechanism
produced evidence — a denial in a log, a cost that moved, a refused delegation, a test that
exercises the attack. Not that the code looks right.
