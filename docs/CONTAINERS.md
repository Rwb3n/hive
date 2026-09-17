# Containers — the real boundary

**Verified working.** A shell-enabled agent ran tests, diagnosed a bug, fixed the code and
re-ran to confirm — inside a container it could not escape to the host. This is the role that
the hook boundary could never contain (see `FINDINGS.md`: path matching cannot secure a shell).

## What changed

| | tmux runtime | docker runtime |
|---|---|---|
| Boundary | `PreToolUse` hook matching paths | the kernel (mount namespace) |
| `Bash` for the agent | must be denied | **can be granted** |
| Escape via `bash -c 'echo > ../x'` | succeeds | impossible — `..` saturates at the container root |
| Watch a resident | `tmux attach -t hive-<agent>` | `docker exec -it hive-<agent> bash` |
| Result channel | `Stop` hook → `last_assistant_message` | `claude -p --output-format json` (also carries cost) |

The scope-guard hook still runs *inside* the container. It is defence in depth now, not the
boundary: it turns a bare kernel `EACCES` into a message the agent can act on
("outside your room"), and it still constrains the file tools.

## Build and run

```bash
docker build -f docker/Dockerfile.agent -t hive/agent:2.1.274 \
  --build-arg UID=$(id -u) --build-arg GID=$(id -g) .

# agent.yaml: runtime: docker
```

The image pins the CLI version deliberately — a new version can add a first-run dialog that
hangs an unattended spawn, so upgrading is an explicit act (`--build-arg CLAUDE_VERSION=`).

Docker notes for this machine: the Windows named pipe was unavailable, but the engine is
reachable from **inside WSL** (`docker` 29.2.1), which is where the runner lives. Build and
run from WSL.

## The mounts, and why each one

```
-v <room>:/room                                  the only writable host path
-v <logs>:/hive-logs                             audit trail, outside the room
-v <hive>/bin:/hive-bin:ro                       READ-ONLY: an agent cannot disable its own guard
-v <creds>:/agent-home/.claude/.credentials.json:ro
--read-only                                     rootfs immutable
--tmpfs /tmp, /run, <home>                       small, noexec/nosuid where possible
--cap-drop ALL  --security-opt no-new-privileges
--memory 2g --cpus 2 --pids-limit 512            one worker cannot starve the building
```

`runtime-docker.js` rewrites hook paths in the generated settings from host paths to
`/hive-bin` before writing `/room/.claude-settings.json`.

## ⚠️ What containment does and does not mean here

Tested by asking a shell-enabled agent to escape. Its own report:

> **`/etc/hive-pwned.txt` → BLOCKED.** `Permission denied` … not writable by my user.
> **`../../../tmp/hive-pwned.txt` → SUCCEEDED.** My working directory is `/room`, so
> `../../../tmp` resolves to `/tmp` (the `..` traversal saturates at the filesystem root).

Both statements are correct, and the second is the important one to understand:

- **Contained:** the host filesystem. `/etc`, `/tmp` and `SECRET.txt` on the host were all
  verified untouched. Other rooms are unreachable — they are not in this container's namespace.
- **Not contained:** the container's own writable paths. A shell can write to `/tmp` inside
  its container. That is harmless (the container is disposable, one per room) but it means
  the in-container scope-guard promise is not absolute for `Bash`. `--read-only` plus small
  tmpfs mounts keeps this to `/tmp` and `/room`.
- **Not contained: the network.** `hive-net` is a normal bridge, so a containerised agent has
  internet access — it needs egress to reach the Anthropic API. Restricting egress to just
  that host requires an explicit allowlisting proxy (squid/envoy sidecar) plus
  `internal: true` on the network. **Until that exists, do not run untrusted code in these
  containers and assume it cannot phone home.**

So: containers solve *filesystem* isolation between rooms and from the host, completely. They
do not yet solve network egress.

## Compose stack

`docker/compose.yml` runs the two long-lived services — `api` (control plane) and
`collector` (telemetry) — on `hive-net`, both published on loopback only. Agent containers are
**not** declared there: the runner creates them per room with `docker run`, because their
count and lifetime are dynamic.

Optional dashboards: `docker compose --profile dashboards up -d` adds Prometheus + Grafana.
Not needed for `hive cost`, which reads the DB the collector writes.
