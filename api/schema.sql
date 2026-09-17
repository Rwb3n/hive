-- Hive control plane schema.
-- The schema IS the interface: the HTTP layer, the runner and the CLI all agree here.
-- Agents never touch this DB (they are file-only, no network tools) — the runner and the
-- lifecycle hooks are the only writers. That is what makes room isolation credible.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- agents: one row per resident, generated from hive.yaml by `hive provision`
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  name          TEXT PRIMARY KEY,           -- 'supervisor', 'worker-1'
  room          TEXT NOT NULL,              -- 'room-3'
  role          TEXT NOT NULL,              -- 'supervisor' | 'worker'
  room_root     TEXT NOT NULL,              -- absolute path; the boundary
  agent_dir     TEXT NOT NULL,              -- where agent.yaml/agent.md/.claude live
  runtime       TEXT NOT NULL DEFAULT 'tmux',
  tmux_session  TEXT,
  status        TEXT NOT NULL DEFAULT 'stopped',  -- stopped|booting|idle|busy|failed
  session_id    TEXT,                       -- current claude session
  pid           INTEGER,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- tasks: the unit of work. Hierarchy lives here (parent_id), not in the transport.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,           -- t_<ulid-ish>
  parent_id     TEXT REFERENCES tasks(id),
  from_agent    TEXT NOT NULL,              -- 'human' or an agents.name
  to_agent      TEXT NOT NULL REFERENCES agents(name),
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL,              -- the full instruction; mirrored to inbox/
  inputs_json   TEXT NOT NULL DEFAULT '[]', -- files to copy into the room before delivery
  status        TEXT NOT NULL DEFAULT 'queued',
                -- queued -> delivered -> running -> done | failed | blocked | cancelled
  result        TEXT,                       -- Stop.last_assistant_message
  artifacts_json TEXT,                      -- files the agent produced, discovered post-run
  session_id    TEXT,
  cost_usd      REAL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT,
  delivered_at  TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_to_agent ON tasks(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);

-- ---------------------------------------------------------------------------
-- events: append-only audit. Fed by bin/signal.js (agent hooks) and the runner.
-- Every hook payload lands here; this is the replay log for a whole run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  agent        TEXT,
  task_id      TEXT,
  evt          TEXT NOT NULL,               -- SessionStart|UserPromptSubmit|Stop|denial|runner.*
  session_id   TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent, id);
CREATE INDEX IF NOT EXISTS idx_events_task  ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_evt   ON events(evt, id);

-- ---------------------------------------------------------------------------
-- denials: boundary violations, promoted out of events for visibility.
-- An agent trying to leave its room is the single most interesting signal here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS denials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  agent      TEXT,
  session_id TEXT,
  tool       TEXT,
  attempted  TEXT,
  resolved   TEXT,
  room       TEXT
);
CREATE INDEX IF NOT EXISTS idx_denials_agent ON denials(agent, id);

-- ---------------------------------------------------------------------------
-- messages: agent-to-agent notes that are not tasks (a worker reporting a
-- concern upward, a supervisor broadcasting context). Routed by policy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id),
  body       TEXT NOT NULL,
  delivered  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, delivered);
