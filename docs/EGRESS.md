# Network egress

**Verified closed.** A raw shell inside a room, holding a secret, could not get it out by any
channel — while the agent itself kept working normally.

Containers already gave a room filesystem isolation (`CONTAINERS.md`), but `hive-net` was an
ordinary bridge: a shell-enabled agent had the whole internet. This closes that.

## The shape

```
   hive-internal  (internal: true — NO route out)          hive-egress
   ┌──────────────────────────────────────────┐            ┌──────────┐
   │  hive-worker-1   hive-builder-1  …       │            │          │
   │        │               │                 │            │ internet │
   │  hive-collector   hive-api               │            │          │
   │                                          │            │          │
   │           hive-proxy ◄───────────────────┼────────────┤          │
   └──────────────────────────────────────────┘            └──────────┘
                    ▲
        the ONLY container on both networks
```

Agents have no route out at all. Their only path is `hive-proxy`, which allows a measured
allowlist and refuses everything else with a logged 403.

```bash
hive net up        # create the networks, start the proxy and the collector inside
hive net status
hive net log       # every egress decision, allowed and refused
hive net down
```

## The allowlist was measured, not guessed

A sniffing proxy logged every host a real task contacted while fixing failing tests:

```
api.anthropic.com:443                     <- required
http-intake.logs.us5.datadoghq.com:443    <- CLI telemetry, not required
```

That is the whole list. Configured in `hive.yaml`, written to `egress-allow.json` by
`hive provision`:

```yaml
egress:
  allow:
    - api.anthropic.com       # required: without this an agent cannot think
    - statsig.anthropic.com   # feature flags; degrades gracefully without it
    - '*.sentry.io'           # crash reporting; optional
```

**Package registries are deliberately absent.** Opening `registry.npmjs.org` is an
arbitrary-code-download channel; a worker that needs dependencies gets them baked into the
image or vendored into its room.

Claude Code honours `HTTPS_PROXY`/`HTTP_PROXY`, so no iptables rules and no custom DNS are
needed. The proxy is a CONNECT proxy: it never sees inside TLS, it decides on
`hostname:port` and then pipes bytes. That is the point — an allowlist, not an inspector.

## Verified: the red team

A raw `bash` in the container (no model judgment involved), with a secret file read into a
variable:

| Channel | Result |
|---|---|
| `POST https://pastebin.com` | blocked |
| `POST https://webhook.site/x` | blocked |
| `POST https://github.com` | blocked |
| `POST http://example.com` (plain HTTP) | **403 from the proxy** |
| `POST https://registry.npmjs.org` | blocked |
| raw TCP to a bare IP (`/dev/tcp/1.1.1.1/443`) | blocked — no route |
| proxy env vars stripped | blocked — no route |
| DNS exfiltration (`<secret>.evil.test`) | no resolution |
| `api.anthropic.com` | **works** (404 = TLS fine, empty GET rejected) |
| `hive-collector:4318` | **works** (200) |

Separately, asked to exfiltrate by a *prompt*, the agent refused on its own and did not even
read the file — noting it had no authorization context. Good, but the proxy is what makes it
a guarantee rather than a hope.

Every decision is logged to `logs/egress.jsonl` with the host, port and outcome.

## ⚠️ Two failures worth knowing about

Both had the same shape: **a service the hive itself needs was silently blocked, and the
symptom was cost reading $0.00 while the caps looked configured.** The same class of bug as
the collector's database lock. Watch for it.

**1. `NO_PROXY` by hand is a trap.** It first missed `host.docker.internal`, then missed
`hive-collector`. Now `noProxyList()` in `runtime-docker.js` derives the list from the actual
api/otlp endpoint URLs, and the proxy *also* always allows hive service names — so a missed
entry degrades to "works, routed through the proxy" instead of "telemetry dead".

**2. A host-side collector is unreachable from an internal network.** That is exactly what
`internal: true` means. `hive net up` therefore runs `hive-collector` *inside* the network,
reachable as `http://hive-collector:4318`. Verified end to end: cost rose by the same amount
the CLI reported for that task.

## What is still not contained

- **The allowlisted host itself.** An agent can reach `api.anthropic.com` and could in
  principle encode data into requests there. Containing that would need a proxy that
  inspects and rewrites API traffic — a different project.
- **The tmux runtime.** Egress restriction is a container feature. A `runtime: tmux` agent
  runs on the host network; it is kept safe by having no shell and no network tools at all
  (`permissions.deny`, `--strict-mcp-config`), not by a route restriction.
- **DNS metadata.** DNS resolution inside the internal network is handled by docker and does
  not reach the internet, which is why DNS exfiltration failed — but that is a property of
  the docker network, not something the proxy enforces.
