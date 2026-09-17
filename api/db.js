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

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
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
  db.prepare(
    `INSERT INTO tasks (id, parent_id, from_agent, to_agent, title, brief, inputs_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`
  ).run(
    id,
    t.parent_id || null,
    t.from_agent,
    t.to_agent,
    t.title,
    t.brief,
    JSON.stringify(t.inputs || [])
  );
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
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getTask(db, id);
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
  upsertAgent, listAgents, getAgent, setAgentStatus,
  createTask, getTask, listTasks, claimNextTask, updateTask,
  addEvent, listEvents, addDenial, listDenials,
  createMessage, undeliveredMessages, markMessageDelivered,
};
