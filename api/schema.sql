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
  goal_id       TEXT,                       -- the standing intent this serves (goals.id).
                                            -- NOT a foreign key on purpose: a goal must
                                            -- survive `hive reset` wiping tasks, and a task
                                            -- must survive a goal being deleted.
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
CREATE INDEX IF NOT EXISTS idx_tasks_goal     ON tasks(goal_id, status);

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

-- ---------------------------------------------------------------------------
-- agent_costs / agent_tokens: running totals from OTLP telemetry.
-- claude_code.cost.usage is exported as a DELTA sum, so these accumulate by
-- ADDING each datapoint. (Verified: summing one run's four deltas reproduced the
-- CLI's total_cost_usd exactly; taking the max under-reported by 40%.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_costs (
  agent      TEXT PRIMARY KEY,
  cost_usd   REAL NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  agent      TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- input | output | cacheRead | cacheCreation
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (agent, kind)
);

-- ---------------------------------------------------------------------------
-- goals: an intent that OUTLIVES a session. The one hierarchy level above a
-- task, deliberately without portfolio/programme above it — this is a single
-- operator system and those would be nouns without questions (docs/ROADMAP.md).
--
-- Three things a goal buys that a flat task tree cannot:
--   1. a budget that follows the WORK rather than the worker, so a long project
--      and a quick experiment no longer share one agent cap
--   2. an intent that survives `hive reset`, reprovisioning and restarts —
--      somewhere for "we are building X, here is where we got to" to live
--   3. a priority that makes claim order meaningful instead of accidental
--
-- Portfolio and programme, if ever wanted, are VIEWS over `tag` — not tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,          -- g_<slug or id>
  title       TEXT NOT NULL,
  brief       TEXT,                      -- the standing intent, read by agents on tasks under it
  tag         TEXT,                      -- free grouping; a "programme" is a shared tag
  status      TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | abandoned
  priority    INTEGER NOT NULL DEFAULT 5,       -- 1 = highest; orders task claim within an agent
  budget_usd  REAL NOT NULL DEFAULT 0,          -- 0 = uncapped. Enforced at claim like agent caps.
  -- Spend accumulates HERE, not only as a sum over tasks: `hive reset` deletes tasks,
  -- and a goal's lifetime spend must not silently drop to zero when it does.
  spent_usd   REAL NOT NULL DEFAULT 0,
  tasks_total INTEGER NOT NULL DEFAULT 0,       -- lifetime counters, same reason
  tasks_done  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,                      -- durable progress note: what an archivist would keep
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, priority);
CREATE INDEX IF NOT EXISTS idx_goals_tag    ON goals(tag);
