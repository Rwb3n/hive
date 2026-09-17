// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

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
const budget = require('./budget');

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

// --- goals: the one level above a task. An intent that outlives a session.
route('GET', '/goals', (p, body, q) => db.listGoals(D, q).map((g) => db.goalRollup(D, g.id)));
route('POST', '/goals', (p, body) => {
  if (!body.title) return { _status: 400, error: 'missing field: title' };
  const g = db.createGoal(D, body);
  db.addEvent(D, { evt: 'goal.created', payload: { id: g.id, title: g.title, budget_usd: g.budget_usd } });
  return db.goalRollup(D, g.id);
});
route('GET', '/goals/:id', (p) => {
  const r = db.goalRollup(D, p.id);
  if (!r) return { _status: 404, error: 'no such goal' };
  return r;
});
route('PATCH', '/goals/:id', (p, body) => {
  if (!db.getGoal(D, p.id)) return { _status: 404, error: 'no such goal' };
  db.updateGoal(D, p.id, body);
  db.addEvent(D, { evt: 'goal.updated', payload: { id: p.id, ...body } });
  return db.goalRollup(D, p.id);
});
route('GET', '/goals/:id/tasks', (p) => db.listTasks(D, { goal_id: p.id }));

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
  // Courtesy check: refuse to queue work for an agent that is already exhausted, so a
  // supervisor delegating into a spent worker is told now instead of queueing a task
  // that can never run. The claim gate is still the authority.
  const bcfg = budget.load(HIVE_HOME);
  const bv = budget.check(D, bcfg, to.name);
  if (!bv.allow && (bcfg.on_exceed || 'pause') !== 'warn') {
    return { _status: 402, error: `cannot queue for ${to.name}: ${bv.reason}`, budget: bv };
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

  // A single runaway task cannot be prevented after the fact, but it can be the last
  // one: pause the agent so the next claim is refused.
  if (body.status === 'done' || body.status === 'failed') {
    const cfg = budget.load(HIVE_HOME);
    const tv = budget.checkTask(cfg, t.to_agent, (out && out.cost_usd) || 0);
    if (!tv.allow && (cfg.on_exceed || 'pause') !== 'warn') {
      db.setAgentStatus(D, t.to_agent, { status: 'paused' });
      db.addEvent(D, { agent: t.to_agent, task_id: t.id, evt: 'budget.task_exceeded', payload: tv });
    }
  }
  return out;
});
// The runner claims work atomically. This is the HARD budget gate: nothing is
// delivered to an agent that is over its cap, whoever queued it and whichever runner
// asks. Checked before the claim so an over-budget task stays queued rather than
// being marked delivered and then refused.
route('POST', '/agents/:name/claim', (p) => {
  const cfg = budget.load(HIVE_HOME);
  const verdict = budget.check(D, cfg, p.name);

  if (!verdict.allow) {
    const mode = cfg.on_exceed || 'pause';
    if (mode === 'warn') {
      db.addEvent(D, { agent: p.name, evt: 'budget.over_warn_only', payload: verdict });
    } else {
      // Record once per transition, not on every poll, or the event log floods.
      const a = db.getAgent(D, p.name);
      if (a && a.status !== 'paused') {
        db.setAgentStatus(D, p.name, { status: 'paused' });
        db.addEvent(D, { agent: p.name, evt: 'budget.paused', payload: verdict });
      }
      return { _status: 402, error: verdict.reason, budget: verdict };
    }
  } else if (verdict.state === 'warn') {
    const a = db.getAgent(D, p.name);
    if (a && a.status !== 'warned') {
      db.addEvent(D, { agent: p.name, evt: 'budget.warn', payload: verdict });
    }
  }

  const t = db.claimNextTask(D, p.name);
  if (!t) return { _status: 204, empty: true };

  // A goal's budget and status gate delivery too: a cap that follows the WORK rather
  // than the worker. A paused or exhausted goal hands its task back to the queue so it
  // is not lost, and the agent stays free for work under other goals.
  if (t.goal_id) {
    const gv = db.goalOverBudget(D, t.goal_id);
    if (gv) {
      db.updateTask(D, t.id, { status: 'queued' });
      db.addEvent(D, { agent: p.name, task_id: t.id, evt: 'goal.blocked', payload: gv });
      return { _status: 402, error: gv.reason, goal: db.goalRollup(D, t.goal_id) };
    }
  }
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

// --- budget: read the report, adjust caps, resume a paused agent
route('GET', '/budget', () => budget.report(D, budget.load(HIVE_HOME)));
route('PATCH', '/budget', (p, body) => {
  const cfg = budget.load(HIVE_HOME);
  for (const k of ['run_usd', 'agent_usd', 'task_usd', 'warn_at', 'on_exceed']) {
    if (body[k] !== undefined) cfg[k] = body[k];
  }
  if (body.agents && typeof body.agents === 'object') {
    cfg.agents = cfg.agents || {};
    for (const [name, caps] of Object.entries(body.agents)) {
      cfg.agents[name] = Object.assign({}, cfg.agents[name], caps);
    }
  }
  budget.save(HIVE_HOME, cfg);
  db.addEvent(D, { evt: 'budget.updated', payload: body });
  return budget.report(D, cfg);
});
// Raising a cap does not by itself un-pause an agent: the operator says when to resume.
route('POST', '/agents/:name/resume', (p) => {
  const a = db.getAgent(D, p.name);
  if (!a) return { _status: 404, error: 'no such agent' };
  const v = budget.check(D, budget.load(HIVE_HOME), p.name);
  if (!v.allow) return { _status: 402, error: `still over budget: ${v.reason}`, budget: v };
  db.setAgentStatus(D, p.name, { status: 'idle' });
  db.addEvent(D, { agent: p.name, evt: 'budget.resumed' });
  return { ok: true, agent: db.getAgent(D, p.name) };
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

// Authority policy: who may create work for whom. Enforced here rather than in the
// transport, because the API is the one chokepoint every task passes (docs/ARCHITECTURE.md).
//
// The roles that may delegate are the ones that cannot implement:
//   planner     read-only (Write/Edit denied) — decides what to do, cannot do it
//   supervisor  file-only — decomposes and integrates within its own room
//   manager     spans rooms
// The roles that produce or judge work may not create it:
//   worker      writes; may not task anyone, reports upward through results
//   builder     writes and runs a shell in a container; same
//   reviewer    read-only; judges work and cannot even edit what it finds, so a review
//               has to be written down. It also may not task anyone — a reviewer that
//               could order fixes would just be a slower planner.
const PRODUCERS = ['worker', 'builder', 'reviewer'];
const DELEGATORS = {
  // A planner is room-scoped like a supervisor: it plans the work in front of it, and
  // cannot reach into another room's agents. Crossing rooms is a manager's job.
  planner: (to, from) => PRODUCERS.includes(to.role) && to.room === from.room,
  supervisor: (to, from) => PRODUCERS.includes(to.role) && to.room === from.room,
  manager: (to) => ['supervisor', 'planner', ...PRODUCERS].includes(to.role),
  boss: () => true,
};

function canTask(from, to) {
  const rule = DELEGATORS[from.role];
  if (!rule) return false; // worker, builder, reviewer: may not create tasks
  return !!rule(to, from);
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
