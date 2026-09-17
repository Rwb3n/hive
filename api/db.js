// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

// SQLite access for the hive. Uses node:sqlite (built into Node 22+) — zero dependencies.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // Several processes write this file — the api server, the OTLP collector, and the CLI.
  // WAL allows concurrent readers with one writer, but a writer that arrives while
  // another is committing gets SQLITE_BUSY *immediately* unless a busy timeout is set.
  // Without this the collector dies with "database is locked" and cost data is silently
  // lost, which is exactly the failure that makes budget enforcement useless.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  // Migrate BEFORE applying the schema: schema.sql creates an index on tasks(goal_id),
  // and on a pre-goals database that statement fails with "no such column" before any
  // migration inside it could run.
  migrate(db);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a new
// column never reaches an existing database — the server then dies on first query with
// "no such column". Additive migrations, each idempotent, applied on every open.
//
// Keep them append-only and never destructive: a hive's DB holds goals that are meant to
// outlive everything else in the system.
function migrate(db) {
  const ADDITIONS = [
    ['tasks', 'goal_id', 'TEXT'],
    ['tasks', 'updated_at', 'TEXT'],
  ];
  for (const [table, column, type] of ADDITIONS) {
    // PRAGMA table_info on a missing table returns an EMPTY LIST rather than throwing,
    // so absence has to be checked explicitly — otherwise a fresh database tries to
    // ALTER a table that schema.sql has not created yet.
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length) continue; // new database: schema.sql creates it complete
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

// Sortable, readable-ish id: time prefix + randomness, so `ORDER BY id` is chronological.
function newId(prefix) {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

// ---------------------------------------------------------------- agents

function upsertAgent(db, a) {
  db.prepare(
    `INSERT INTO agents (name, room, role, room_root, agent_dir, runtime, tmux_session)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       room=excluded.room, role=excluded.role, room_root=excluded.room_root,
       agent_dir=excluded.agent_dir, runtime=excluded.runtime,
       tmux_session=excluded.tmux_session`
  ).run(a.name, a.room, a.role, a.room_root, a.agent_dir, a.runtime || 'tmux', a.tmux_session || null);
}

function listAgents(db) {
  return db.prepare('SELECT * FROM agents ORDER BY room, role DESC, name').all();
}

function getAgent(db, name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
}

function setAgentStatus(db, name, patch) {
  const fields = [];
  const vals = [];
  for (const k of ['status', 'session_id', 'pid', 'tmux_session']) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!fields.length) return;
  fields.push("last_seen_at = datetime('now')");
  vals.push(name);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE name = ?`).run(...vals);
}

// ---------------------------------------------------------------- tasks

function createTask(db, t) {
  const id = t.id || newId('t');
  // A child task inherits its parent's goal, so a planner's delegations land under the
  // same intent without the planner having to know the goal id.
  let goalId = t.goal_id || null;
  if (!goalId && t.parent_id) {
    const p = getTask(db, t.parent_id);
    if (p) goalId = p.goal_id || null;
  }
  db.prepare(
    `INSERT INTO tasks (id, parent_id, goal_id, from_agent, to_agent, title, brief, inputs_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
  ).run(
    id,
    t.parent_id || null,
    goalId,
    t.from_agent,
    t.to_agent,
    t.title,
    t.brief,
    JSON.stringify(t.inputs || [])
  );
  if (goalId) bumpGoal(db, goalId, { tasks: 1 });
  return getTask(db, id);
}

function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function listTasks(db, filter = {}) {
  const where = [];
  const vals = [];
  if (filter.status) {
    const list = String(filter.status).split(',');
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    vals.push(...list);
  }
  if (filter.to_agent) {
    where.push('to_agent = ?');
    vals.push(filter.to_agent);
  }
  if (filter.parent_id) {
    where.push('parent_id = ?');
    vals.push(filter.parent_id);
  }
  if (filter.goal_id) {
    where.push('goal_id = ?');
    vals.push(filter.goal_id);
  }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  return db.prepare(sql).all(...vals);
}

// The runner's claim: take the oldest queued task for an agent and mark it delivered
// in one statement, so two runners can't both grab it.
function claimNextTask(db, agent) {
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE to_agent = ? AND status = 'queued' ORDER BY id LIMIT 1`
    )
    .get(agent);
  if (!row) return null;
  const res = db
    .prepare(
      `UPDATE tasks SET status='delivered', delivered_at=datetime('now'), attempts=attempts+1
       WHERE id = ? AND status='queued'`
    )
    .run(row.id);
  if (res.changes !== 1) return null; // someone else won the race
  return getTask(db, row.id);
}

function updateTask(db, id, patch) {
  const fields = [];
  const vals = [];
  for (const k of ['status', 'result', 'artifacts_json', 'session_id', 'cost_usd', 'error']) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if ('finished' in patch) fields.push("finished_at = datetime('now')");
  fields.push("updated_at = datetime('now')");
  if (!fields.length) return;
  vals.push(id);

  const before = getTask(db, id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const after = getTask(db, id);

  // Roll the goal's durable counters forward. Cost is rolled as a DELTA (the collector
  // updates a task's cost repeatedly as telemetry arrives), and 'done' only once —
  // otherwise a re-PATCH of a finished task would double-count.
  if (after && after.goal_id) {
    const dCost = Number(after.cost_usd || 0) - Number((before && before.cost_usd) || 0);
    const becameDone = after.status === 'done' && (!before || before.status !== 'done');
    if (dCost || becameDone) {
      bumpGoal(db, after.goal_id, { done: becameDone ? 1 : 0, cost: dCost });
    }
  }
  return after;
}

// ---------------------------------------------------------------- events

function addEvent(db, e) {
  db.prepare(
    `INSERT INTO events (agent, task_id, evt, session_id, payload_json) VALUES (?, ?, ?, ?, ?)`
  ).run(e.agent || null, e.task_id || null, e.evt, e.session_id || null,
        e.payload ? JSON.stringify(e.payload) : null);
}

function listEvents(db, filter = {}) {
  const where = [];
  const vals = [];
  if (filter.agent) { where.push('agent = ?'); vals.push(filter.agent); }
  if (filter.task_id) { where.push('task_id = ?'); vals.push(filter.task_id); }
  if (filter.evt) { where.push('evt = ?'); vals.push(filter.evt); }
  if (filter.since_id) { where.push('id > ?'); vals.push(Number(filter.since_id)); }
  const lim = Math.min(Number(filter.limit) || 100, 1000);
  return db
    .prepare(
      `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY id DESC LIMIT ${lim}`
    )
    .all(...vals);
}

function addDenial(db, d) {
  db.prepare(
    `INSERT INTO denials (agent, session_id, tool, attempted, resolved, room)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(d.agent || null, d.session_id || null, d.tool || null, d.attempted || null,
        d.resolved || null, d.room || null);
}

function listDenials(db, filter = {}) {
  const lim = Math.min(Number(filter.limit) || 100, 1000);
  if (filter.agent) {
    return db.prepare(`SELECT * FROM denials WHERE agent = ? ORDER BY id DESC LIMIT ${lim}`).all(filter.agent);
  }
  return db.prepare(`SELECT * FROM denials ORDER BY id DESC LIMIT ${lim}`).all();
}

// ---------------------------------------------------------------- messages

function createMessage(db, m) {
  const id = m.id || newId('m');
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, task_id, body) VALUES (?, ?, ?, ?, ?)`
  ).run(id, m.from_agent, m.to_agent, m.task_id || null, m.body);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function undeliveredMessages(db, agent) {
  return db
    .prepare('SELECT * FROM messages WHERE to_agent = ? AND delivered = 0 ORDER BY id')
    .all(agent);
}

function markMessageDelivered(db, id) {
  db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(id);
}

module.exports = {
  open, newId,
  createGoal, getGoal, listGoals, updateGoal, bumpGoal, goalRollup, goalOverBudget,
  upsertAgent, listAgents, getAgent, setAgentStatus,
  createTask, getTask, listTasks, claimNextTask, updateTask,
  addEvent, listEvents, addDenial, listDenials,
  createMessage, undeliveredMessages, markMessageDelivered,
};

// ---------------------------------------------------------------- goals
//
// A goal is the one level above a task: a standing intent that outlives sessions.
// Its counters are maintained incrementally rather than computed as a SUM over tasks,
// because `hive reset` deletes tasks and a goal's lifetime spend must not silently
// drop to zero when it does. `goalRollup()` reports both: the durable lifetime figures
// and the live open-task counts.

function slugId(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return 'g_' + (slug || Math.random().toString(36).slice(2, 8));
}

function createGoal(db, g) {
  const id = g.id || slugId(g.title);
  db.prepare(
    `INSERT INTO goals (id, title, brief, tag, priority, budget_usd, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, g.title, g.brief || null, g.tag || null,
        Number(g.priority) > 0 ? Number(g.priority) : 5,
        Number(g.budget_usd) > 0 ? Number(g.budget_usd) : 0,
        g.notes || null);
  return getGoal(db, id);
}

// A function declaration, not a const arrow: `module.exports` appears above this section
// in the file, and a const would be in its temporal dead zone at export time.
function getGoal(db, id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

function listGoals(db, filter = {}) {
  const where = [];
  const vals = [];
  if (filter.status) {
    const list = String(filter.status).split(',');
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    vals.push(...list);
  }
  if (filter.tag) { where.push('tag = ?'); vals.push(filter.tag); }
  return db
    .prepare(`SELECT * FROM goals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority, id`)
    .all(...vals);
}

function updateGoal(db, id, patch) {
  const fields = [];
  const vals = [];
  for (const k of ['title', 'brief', 'tag', 'status', 'priority', 'budget_usd', 'notes']) {
    if (k in patch) { fields.push(`${k} = ?`); vals.push(patch[k]); }
  }
  if (!fields.length) return getGoal(db, id);
  fields.push("updated_at = datetime('now')");
  if (patch.status && ['done', 'abandoned'].includes(patch.status)) fields.push("closed_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getGoal(db, id);
}

// Called when a task is created under a goal, and when one finishes. Incremental so the
// figures survive a task wipe.
function bumpGoal(db, goalId, { tasks = 0, done = 0, cost = 0 } = {}) {
  if (!goalId || !getGoal(db, goalId)) return null;
  db.prepare(
    `UPDATE goals SET tasks_total = tasks_total + ?, tasks_done = tasks_done + ?,
       spent_usd = spent_usd + ?, updated_at = datetime('now') WHERE id = ?`
  ).run(tasks, done, Number(cost) || 0, goalId);
  return getGoal(db, goalId);
}

// Lifetime figures from the goal row, plus the live state of tasks that still exist.
function goalRollup(db, id) {
  const g = getGoal(db, id);
  if (!g) return null;
  const live = { queued: 0, running: 0, done: 0, failed: 0, cost_usd: 0 };
  let rows = [];
  try {
    rows = db.prepare('SELECT status, cost_usd FROM tasks WHERE goal_id = ?').all(id);
  } catch (e) { /* tasks may have been reset */ }
  for (const t of rows) {
    live.cost_usd += Number(t.cost_usd || 0);
    if (t.status === 'queued' || t.status === 'delivered') live.queued++;
    else if (t.status === 'running') live.running++;
    else if (t.status === 'done') live.done++;
    else if (t.status === 'failed' || t.status === 'blocked') live.failed++;
  }
  live.cost_usd = Number(live.cost_usd.toFixed(4));
  const cap = Number(g.budget_usd) > 0 ? Number(g.budget_usd) : 0;
  return {
    goal: g,
    lifetime: {
      tasks: g.tasks_total,
      done: g.tasks_done,
      spent_usd: Number(Number(g.spent_usd).toFixed(4)),
      cap,
      pct: cap ? Math.round((g.spent_usd / cap) * 100) : null,
      remaining_usd: cap ? Number((cap - g.spent_usd).toFixed(4)) : null,
    },
    live,
    open: live.queued + live.running,
  };
}

// Budget check for a goal, same shape as the agent check in api/budget.js so the API
// can treat them uniformly at claim time.
function goalOverBudget(db, goalId) {
  const g = goalId ? getGoal(db, goalId) : null;
  if (!g) return null;
  if (g.status === 'paused') return { reason: `goal ${g.id} is paused` };
  if (g.status === 'done' || g.status === 'abandoned') return { reason: `goal ${g.id} is ${g.status}` };
  const cap = Number(g.budget_usd);
  if (cap > 0 && Number(g.spent_usd) >= cap) {
    return { reason: `goal ${g.id} budget exhausted: $${Number(g.spent_usd).toFixed(4)} of $${cap.toFixed(2)}` };
  }
  return null;
}
