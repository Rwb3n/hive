// hive OTLP collector — receives Claude Code telemetry and writes cost/tokens into the
// hive DB, tagged per agent and room.
//
// Why this exists rather than a transcript parser: the CLI computes cost itself and exports
// it as `claude_code.cost.usage`. No price table to go stale, no JSONL to parse.
//
// IMPORTANT — aggregation: these are DELTA sums (aggregationTemporality: 1), so datapoints
// must be ADDED, not max'd. Verified: summing the four deltas of one run gave 0.126935,
// exactly the CLI's reported total_cost_usd. Taking the max gave 0.0744 and was wrong.
//
// Binds 0.0.0.0 so containerised agents can reach it via host.docker.internal.

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const HIVE_HOME = process.env.HIVE_HOME || path.join(process.env.HOME || '', 'hive');
const DB_PATH = process.env.HIVE_DB || path.join(HIVE_HOME, 'api', 'hive.db');
const PORT = Number(process.env.HIVE_OTLP_PORT || 4318);
const HOST = process.env.HIVE_OTLP_HOST || '0.0.0.0';
const RAW_LOG = process.env.HIVE_OTLP_RAW || ''; // set a path to keep raw payloads

const D = db.open(DB_PATH);

// attrs arrive as [{key, value:{stringValue|intValue|doubleValue|boolValue}}]
function flatten(attrs) {
  const out = {};
  for (const a of attrs || []) {
    const v = a.value || {};
    out[a.key] =
      v.stringValue !== undefined ? v.stringValue
      : v.intValue !== undefined ? Number(v.intValue)
      : v.doubleValue !== undefined ? v.doubleValue
      : v.boolValue !== undefined ? v.boolValue
      : null;
  }
  return out;
}

const num = (dp) =>
  dp.asDouble !== undefined ? Number(dp.asDouble)
  : dp.asInt !== undefined ? Number(dp.asInt)
  : 0;

function ingest(body) {
  let applied = 0;
  for (const rm of body.resourceMetrics || []) {
    const res = flatten(rm.resource && rm.resource.attributes);
    const agent = res['hive.agent'] || null;
    const room = res['hive.room'] || null;

    for (const sm of rm.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        const sum = m.sum;
        if (!sum) continue;
        // DELTA (1) means each export is an increment for that window. CUMULATIVE (2)
        // would mean "replace"; the CLI uses DELTA, but handle both defensively.
        const isDelta = sum.aggregationTemporality === 1 || sum.aggregationTemporality === 'AGGREGATION_TEMPORALITY_DELTA';

        for (const dp of sum.dataPoints || []) {
          const at = flatten(dp.attributes);
          const sessionId = at['session.id'] || null;
          const value = num(dp);
          if (!value && m.name !== 'claude_code.session.count') continue;

          if (m.name === 'claude_code.cost.usage') {
            bumpCost(sessionId, agent, value, isDelta, at);
            applied++;
          } else if (m.name === 'claude_code.token.usage') {
            bumpTokens(sessionId, agent, at['type'], value, isDelta);
            applied++;
          }
        }
      }
    }
    if (agent) {
      db.addEvent(D, {
        agent,
        evt: 'telemetry',
        payload: { room, service_version: res['service.version'] },
      });
    }
  }
  return applied;
}

// Cost lands on the task that owns this session. A session may serve several tasks over
// time, so attribute to the most recent task for that session.
function bumpCost(sessionId, agent, value, isDelta, at) {
  const t = sessionId
    ? D.prepare(
        `SELECT id, cost_usd FROM tasks WHERE session_id = ? ORDER BY id DESC LIMIT 1`
      ).get(sessionId)
    : null;

  if (t) {
    const next = isDelta ? Number(t.cost_usd || 0) + value : value;
    D.prepare(`UPDATE tasks SET cost_usd = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(Number(next.toFixed(6)), t.id);
  }

  // Always keep a per-agent running total, even when no task matches (boot turns,
  // manual pokes, a session the runner has not yet recorded).
  if (agent) {
    D.prepare(
      `INSERT INTO agent_costs (agent, cost_usd, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(agent) DO UPDATE SET
         cost_usd = agent_costs.cost_usd + excluded.cost_usd,
         updated_at = datetime('now')`
    ).run(agent, Number(value.toFixed(6)));
  }
}

function bumpTokens(sessionId, agent, type, value, isDelta) {
  if (!agent || !type) return;
  D.prepare(
    `INSERT INTO agent_tokens (agent, kind, tokens, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(agent, kind) DO UPDATE SET
       tokens = agent_tokens.tokens + excluded.tokens,
       updated_at = datetime('now')`
  ).run(agent, type, Math.round(value));
}

const server = http.createServer((req, res) => {
  let chunks = [];
  let bytes = 0;
  req.on('data', (c) => {
    bytes += c.length;
    if (bytes > 32 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (RAW_LOG) {
      try { fs.appendFileSync(RAW_LOG, buf.toString('utf8') + '\n'); } catch (e) {}
    }
    let applied = 0;
    if (/\/v1\/metrics$/.test(req.url || '')) {
      try {
        applied = ingest(JSON.parse(buf.toString('utf8')));
      } catch (e) {
        // protobuf or malformed: accept it so the agent is never blocked by telemetry
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ partialSuccess: {} }));
    if (applied) process.stdout.write(`otlp: ${applied} datapoints applied\n`);
  });
  req.on('error', () => {});
});

if (require.main === module) {
  server.listen(PORT, HOST, () =>
    process.stdout.write(`hive otlp collector on http://${HOST}:${PORT}  db: ${DB_PATH}\n`)
  );
  const bye = () => { try { server.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { server, ingest };
