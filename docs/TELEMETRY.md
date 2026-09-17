# Telemetry — cost and token accounting

**Verified working** (claude 2.1.257, probed 2026-09-17). Cost does not need to be computed,
parsed out of transcripts, or estimated from a price table: the CLI exports it over OTLP.

## Enabling it

Environment variables on the `claude` invocation (the same place the hive already sets
`HIVE_ROOM_ROOT` — see `docs/RUNTIME.md`):

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp                 # optional: per-event logs, verbose (~28KB/turn)
OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # http/json is easiest to receive; protobuf also works
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_METRIC_EXPORT_INTERVAL=10000       # ms; 2000 used while probing
OTEL_RESOURCE_ATTRIBUTES=hive.agent=worker-1,hive.room=room-3,service.namespace=hive
```

`OTEL_RESOURCE_ATTRIBUTES` is the important one for a hive: **custom attributes carry through
verbatim** as resource attributes, so every metric is labelled with the agent and room that
produced it. No join against session ids is required (though `session.id` is also present on
each datapoint, and the hive stores it per task, so the join is available as a cross-check).

## What arrives

`POST /v1/metrics` (and `/v1/logs` when enabled), OTLP JSON.

| Metric | Type | Notes |
|---|---|---|
| `claude_code.cost.usage` | sum, double | **USD, computed by the CLI** — authoritative |
| `claude_code.token.usage` | sum, int | one datapoint per `type`: `input`, `output`, `cacheRead`, `cacheCreation` |
| `claude_code.session.count` | sum, int | |
| `claude_code.active_time.total` | sum, double | seconds |

Datapoint attributes on cost/token:

```
user.id, user.email, user.account_uuid, user.account_id,
organization.id, session.id,
model            e.g. claude-opus-5[1m]
terminal.type    e.g. vscode
query_source     e.g. main
effort           e.g. high
```

Resource attributes: `service.name=claude-code`, `service.version`, `host.arch`, `os.type`,
`os.version`, plus anything from `OTEL_RESOURCE_ATTRIBUTES`.

Observed on one trivial turn: `cost.usage = 0.26036`, with
`cacheCreation = 26010` / `input = 2` / `output = 10` / `cacheRead = 0` — which independently
confirms the context-floor measurement in `FINDINGS.md`.

## Why this matters more than bookkeeping

The subscription has 5-hour and 7-day windows. A hive that fans out across several agents can
consume the interactive budget without anyone noticing, and each agent pays a per-turn context
floor before doing any work. The useful output of telemetry here is therefore **budget
enforcement**, not a dashboard: the runner should refuse to deliver new work once an agent or a
run passes its cap.

Cost per turn is dominated by cache creation, so long-lived sessions that keep their context
warm are much cheaper per task than fresh ones — worth weighing when choosing between
"one session per task" (safer against safeguard poisoning) and a persistent resident.

## Note on `claude gateway`

There is a `claude gateway --config <path>` subcommand described as an "enterprise
auth/telemetry gateway". Its config schema is not documented in `--help` and was not probed.
It may be a better aggregation point than a hand-rolled collector for a multi-machine hive;
worth investigating before scaling past one host.
