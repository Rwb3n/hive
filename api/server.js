// Hive API machine. Node built-ins only (http + node:sqlite).
//
// Who talks to it:
//   - bin/signal.js        (agent lifecycle hooks)  -> POST /events
//   - bin/scope-guard.js   (boundary denials)       -> POST /denials
//   - bin/room-runner      (delivery + results)     -> claim/patch tasks
//   - bin/hive             (your CLI)               -> everything
//
// Who does NOT talk to it: the agents. They are file-only (no Bash, no WebFetch, no MCP),
// so they cannot reach the network at all. Their whole world is files in their room.
// That is what makes the isolation credible rather than merely declared.
//
// Auth: a shared token in HIVE_TOKEN (header `x-hive-token`). Bound to 127.0.0.1 by default.
// Per-agent tokens are the natural next step once agents gain a way to make requests.

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const HIVE_HOME = process.env.HIVE_HOME || path.join(process.env.HOME || process.env.USERPROFILE, 'hive');
const DB_PATH = process.env.HIVE_DB || path.join(HIVE_HOME, 'api', 'hive.db');
const PORT = Number(process.env.HIVE_PORT || 8787);
const HOST = process.env.HIVE_HOST || '127.0.0.1';
const TOKEN = process.env.HIVE_TOKEN || null;

const D = db.open(DB_PATH);

function send(res, code, body) {
  const s = JSON.stringify(body === undefined ? null : body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- routing

const routes = [];
const route = (method, pattern, handler) => {
  // '/tasks/:id' -> regex with named groups
  const names = [];
  const rx = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z_]+)/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, rx, names, handler });
};

// --- health / meta
route('GET', '/health', () => ({ ok: true, db: DB_PATH, home: HIVE_HOME }));

// --- agents
route('GET', '/agents', () => db.listAgents(D));
route('GET', '/agents/:name', (p) => {
  const a = db.getAgent(D, p.name);
  if (!a) return { _status: 404, error: 'no such agent' };
  return a;
});
route('POST', '/agents', (p, body) => {
  for (const f of ['name', 'room', 'role', 'room_root', 'agent_dir']) {
    if (!body[f]) return { _status: 400, error: `missing field: ${f}` };
  }
  db.upsertAgent(D, body);
  return db.getAgent(D, body.name);
});
route('PATCH', '/agents/:name', (p, body) => {
  if (!db.getAgent(D, p.name)) return { _status: 404, error: 'no such agent' };
  db.setAgentStatus(D, p.name, body);
  return db.getAgent(D, p.name);
});

// --- tasks
route('GET', '/tasks', (p, body, q) => db.listTasks(D, q));
route('POST', '/tasks', (p, body) => {
  for (const f of ['to_agent', 'title', 'brief']) {
    if (!body[f]) return { _status: 400, error: `missing field: ${f}` };
  }
  const to = db.getAgent(D, body.to_agent);
  if (!to) return { _status: 400, error: `no such agent: ${body.to_agent}` };

  // Policy: who may task whom. 'human' may task anyone; an agent may task only
  // those listed in its can_task (set by `hive provision` from hive.yaml).
  const from = body.from_agent || 'human';
  if (from !== 'human') {
    const f = db.getAgent(D, from);
    if (!f) return { _status: 400, error: `no such agent: ${from}` };
    const allowed = (process.env.HIVE_POLICY_OPEN === '1') || canTask(f, to);
    if (!allowed) {
      return { _status: 403, error: `${from} (${f.role}) may not task ${to.name} (${to.role})` };
    }
  }
  const t = db.createTask(D, { ...body, from_agent: from });
  db.addEvent(D, { agent: from, task_id: t.id, evt: 'task.created', payload: { to: to.name, title: t.title } });
  return t;
});
route('GET', '/tasks/:id', (p) => {
  const t = db.getTask(D, p.id);
  if (!t) return { _status: 404, error: 'no such task' };
  return t;
});
route('PATCH', '/tasks/:id', (p, body) => {
  const t = db.getTask(D, p.id);
  if (!t) return { _status: 404, error: 'no such task' };
  const out = db.updateTask(D, p.id, body);
  db.addEvent(D, { agent: t.to_agent, task_id: t.id, evt: 'task.' + (body.status || 'updated') });
  return out;
});
// The runner claims work atomically.
route('POST', '/agents/:name/claim', (p) => {
  const t = db.claimNextTask(D, p.name);
  if (!t) return { _status: 204, empty: true };
  return t;
});

// --- events (the input side: agent hooks POST here via bin/signal.js)
route('POST', '/events', (p, body) => {
  if (!body.evt) return { _status: 400, error: 'missing evt' };
  db.addEvent(D, {
    agent: body.agent,
    task_id: body.task_id,
    evt: body.evt,
    session_id: body.session_id,
    payload: body.payload || body,
  });
  // Keep agent liveness current from the events themselves.
  if (body.agent && db.getAgent(D, body.agent)) {
    const status =
      body.evt === 'SessionStart' ? 'idle'
      : body.evt === 'UserPromptSubmit' ? 'busy'
      : body.evt === 'Stop' ? 'idle'
      : undefined;
    const patch = {};
    if (status) patch.status = status;
    if (body.session_id) patch.session_id = body.session_id;
    if (Object.keys(patch).length) db.setAgentStatus(D, body.agent, patch);
  }
  return { ok: true };
});
route('GET', '/events', (p, body, q) => db.listEvents(D, q));

// --- denials (scope-guard posts boundary violations here)
route('POST', '/denials', (p, body) => {
  db.addDenial(D, body);
  db.addEvent(D, { agent: body.agent, evt: 'denial', session_id: body.session_id, payload: body });
  return { ok: true };
});
route('GET', '/denials', (p, body, q) => db.listDenials(D, q));

// --- messages (agent-to-agent notes that are not tasks)
route('POST', '/messages', (p, body) => {
  for (const f of ['from_agent', 'to_agent', 'body']) {
    if (!body[f]) return { _status: 400, error: `missing field: ${f}` };
  }
  return db.createMessage(D, body);
});
route('GET', '/agents/:name/messages', (p) => db.undeliveredMessages(D, p.name));
route('POST', '/messages/:id/delivered', (p) => {
  db.markMessageDelivered(D, p.id);
  return { ok: true };
});

// --- a compact status view for `hive ps`
route('GET', '/status', () => {
  const agents = db.listAgents(D);
  const tasks = db.listTasks(D);
  // Telemetry totals (OTLP collector writes these; DELTA sums already accumulated).
  const costs = {};
  const tokens = {};
  try {
    for (const r of D.prepare('SELECT agent, cost_usd FROM agent_costs').all()) costs[r.agent] = r.cost_usd;
    for (const r of D.prepare('SELECT agent, kind, tokens FROM agent_tokens').all()) {
      (tokens[r.agent] = tokens[r.agent] || {})[r.kind] = r.tokens;
    }
  } catch (e) { /* tables appear on first telemetry */ }
  const byAgent = {};
  for (const a of agents) {
    byAgent[a.name] = { queued: 0, running: 0, done: 0, failed: 0 };
  }
  let cost = 0;
  for (const t of tasks) {
    cost += t.cost_usd || 0;
    const b = byAgent[t.to_agent];
    if (!b) continue;
    if (t.status === 'queued' || t.status === 'delivered') b.queued++;
    else if (t.status === 'running') b.running++;
    else if (t.status === 'done') b.done++;
    else if (t.status === 'failed' || t.status === 'blocked') b.failed++;
  }
  return {
    agents: agents.map((a) => ({
      name: a.name, room: a.room, role: a.role, status: a.status,
      session_id: a.session_id, tmux_session: a.tmux_session,
      last_seen_at: a.last_seen_at, tasks: byAgent[a.name],
      cost_usd: Number((costs[a.name] || 0).toFixed(4)),
      tokens: tokens[a.name] || {},
    })),
    totals: {
      tasks: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      cost_usd: Number((Object.values(costs).reduce((x, y) => x + y, 0) || cost).toFixed(4)),
      denials: db.listDenials(D, { limit: 1000 }).length,
    },
  };
});

// Hierarchy policy: a supervisor may task workers in its own room; workers report
// upward via messages/results, not by tasking. Loaded from agents table roles.
function canTask(from, to) {
  if (from.role === 'supervisor') return to.role === 'worker' && to.room === from.room;
  if (from.role === 'manager') return to.role === 'supervisor' || to.role === 'worker';
  if (from.role === 'boss') return true;
  return false; // workers may not create tasks
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = Object.fromEntries(url.searchParams);

  if (TOKEN && url.pathname !== '/health') {
    if (req.headers['x-hive-token'] !== TOKEN) return send(res, 401, { error: 'bad or missing x-hive-token' });
  }

  const m = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
  if (!m) return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });

  const match = url.pathname.match(m.rx);
  const params = {};
  m.names.forEach((n, i) => (params[n] = decodeURIComponent(match[i + 1])));

  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  try {
    const out = m.handler(params, body, q);
    if (out && out._status) {
      const { _status, ...rest } = out;
      return send(res, _status, _status === 204 ? null : rest);
    }
    return send(res, 200, out);
  } catch (e) {
    db.addEvent(D, { evt: 'api.error', payload: { path: url.pathname, message: String(e.message) } });
    return send(res, 500, { error: String(e.message) });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `hive api listening on http://${HOST}:${PORT}\n  db:   ${DB_PATH}\n  auth: ${TOKEN ? 'token required' : 'OPEN (set HIVE_TOKEN)'}\n`
    );
  });
  const bye = () => { try { server.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { server, D, canTask };
