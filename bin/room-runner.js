// room-runner — makes a room come alive.
//
// One runner process per agent. It:
//   1. spawns the agent in a tmux pane (all first-run dialogs pre-suppressed)
//   2. waits for the SessionStart event to know it is ready (NOT screen-scraping)
//   3. claims a queued task from the API, materialises it into the workspace
//   4. tells the pane to read it, one short line (never the task body — a newline submits early)
//   5. waits for the Stop event, whose last_assistant_message IS the result
//   6. records the result, parses DELEGATE lines from a supervisor, loops
//
// Signals come from bin/signal.js (agent hooks) via the API. capture-pane is used only
// as a boot watchdog for unknown first-run dialogs, which appear before SessionStart.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API = process.env.HIVE_API || 'http://127.0.0.1:8787';
const TOKEN = process.env.HIVE_TOKEN || '';
const POLL_MS = Number(process.env.HIVE_POLL_MS || 1500);
const BOOT_TIMEOUT_MS = Number(process.env.HIVE_BOOT_TIMEOUT_MS || 60000);
const TASK_TIMEOUT_MS = Number(process.env.HIVE_TASK_TIMEOUT_MS || 900000);

// Dialog signatures that mean "a human is needed" — the pane will hang forever otherwise.
//
// These are matched against the rendered pane, which ALSO contains the agent's own prose.
// An agent writing *about* safeguards must not look like a safeguard dialog, so each
// pattern anchors on dialog chrome (numbered options, "Enter to confirm") rather than on
// topic words. Learned the hard way: a supervisor writing the phrase "safeguard-flag
// hazard" was killed by a naive /safeguards flagged/ match six seconds before it finished.
const BLOCKING_DIALOGS = [
  ['login', /^\s*❯?\s*\d\.\s*(Claude account with subscription|Anthropic Console account)/im],
  ['login-code', /Paste code here if prompted/i],
  ['trust', /❯?\s*\d\.\s*(Yes, I trust this folder|No, exit)/i],
  ['theme', /Choose the text style that looks best/i],
  ['upsell', /❯?\s*\d\.\s*Yes, try it/i],
  ['safeguard', /❯?\s*\d\.\s*(Switch to Opus|Switch automatically|Stay on Opus)/i],
  ['api-error', /Claude Code can't respond to this message with/i],
];

// Dialog chrome that appears with any of the above: a prompt awaiting a keypress.
const AWAITING_INPUT = /Enter to (confirm|select)\s*·|Esc to cancel/i;
const READY_MARK = /shift\+tab to cycle/;
const BUSY_MARK = /esc to interrupt/;

// ---------------------------------------------------------------- api helpers

function api(method, route, body) {
  const args = ['-s', '-X', method, `${API}${route}`, '-H', 'content-type: application/json'];
  if (TOKEN) args.push('-H', `x-hive-token: ${TOKEN}`);
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  args.push('-w', '\n%{http_code}');
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const i = out.lastIndexOf('\n');
  const code = Number(out.slice(i + 1).trim());
  const text = out.slice(0, i);
  // A silently-failing write is the worst failure mode here: the runner would think a
  // task was recorded when it was not. Always surface a non-2xx.
  if (code >= 400) {
    process.stderr.write(`API ${method} ${route} -> ${code}: ${text.slice(0, 300)}\n`);
  }
  if (code === 204 || !text.trim()) return { code, body: null };
  try {
    return { code, body: JSON.parse(text) };
  } catch (e) {
    return { code, body: null, raw: text };
  }
}

const log = (agent, msg) => {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${agent}: ${msg}\n`);
};

// ---------------------------------------------------------------- tmux helpers

const tmux = (...args) => spawnSync('tmux', args, { encoding: 'utf8' });

function paneText(session, lines = 60) {
  const r = tmux('capture-pane', '-t', session, '-p', '-S', `-${lines}`);
  return r.status === 0 ? r.stdout : '';
}

function sessionExists(session) {
  return tmux('has-session', '-t', session).status === 0;
}

function sleep(ms) {
  // Synchronous sleep keeps the runner a simple sequential loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------- lifecycle

function loadAgentYaml(agentDir) {
  const text = fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function spawnAgent(cfg) {
  const { tmux_session: S, room_root: ROOM, agent_dir: DIR, log_dir: LOGS, name } = cfg;
  if (sessionExists(S)) {
    log(name, `tmux session ${S} already exists — killing it for a clean boot`);
    tmux('kill-session', '-t', S);
  }
  fs.mkdirSync(LOGS, { recursive: true });
  fs.mkdirSync(ROOM, { recursive: true });

  tmux('new-session', '-d', '-s', S, '-c', ROOM, '-x', '220', '-y', '50');

  // Env goes on the claude invocation itself with an explicit minimal PATH:
  // the Windows PATH leaks into WSL through interop and breaks the shell line.
  const settings = path.join(DIR, '.claude', 'settings.json');
  const cmd = [
    'env',
    `HIVE_ROOM_ROOT=${ROOM}`,
    `HIVE_LOG_DIR=${LOGS}`,
    `HIVE_AGENT=${name}`,
    `HIVE_API=${API}`,
    TOKEN ? `HIVE_TOKEN=${TOKEN}` : '',
    'PATH=$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    'claude',
    '--settings', settings,
    '--strict-mcp-config',
    cfg.model ? `--model ${cfg.model}` : '',
  ].filter(Boolean).join(' ');

  tmux('send-keys', '-t', S, cmd, 'Enter');
  log(name, `spawned in tmux:${S} (cwd ${ROOM})`);
}

// Ready = the agent's SessionStart event arrived. Fall back to the pane marker, and
// fail fast on a known blocking dialog rather than waiting out the timeout.
function awaitReady(cfg, sinceEventId) {
  const t0 = Date.now();
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    const ev = api('GET', `/events?agent=${cfg.name}&evt=SessionStart&since_id=${sinceEventId}&limit=1`);
    if (ev.body && ev.body.length) {
      const e = ev.body[0];
      let sid = null;
      try { sid = JSON.parse(e.payload_json || '{}').session_id || e.session_id; } catch (x) {}
      log(cfg.name, `ready (SessionStart, session ${String(sid).slice(0, 8)})`);
      return { ok: true, session_id: sid };
    }
    const txt = paneText(cfg.tmux_session, 40);
    const tail = txt.split('\n').slice(-16).join('\n');
    if (AWAITING_INPUT.test(tail)) {
      for (const [kind, rx] of BLOCKING_DIALOGS) {
        if (rx.test(tail)) {
          log(cfg.name, `BLOCKED on '${kind}' dialog — a human is needed`);
          return { ok: false, blocked: kind, pane: tail.slice(-1200) };
        }
      }
    }
    if (READY_MARK.test(txt)) {
      log(cfg.name, 'ready (pane marker; SessionStart not seen — check hooks)');
      return { ok: true, session_id: null, via: 'pane' };
    }
    if (!sessionExists(cfg.tmux_session)) {
      return { ok: false, blocked: 'session-died', pane: '' };
    }
    sleep(1000);
  }
  return { ok: false, blocked: 'timeout', pane: paneText(cfg.tmux_session, 40).slice(-1200) };
}

// Put the task where the agent can actually reach it: inside its workspace.
// The agent cannot read its own inbox/ (that is outside the room) — by design.
function materialise(cfg, task) {
  const ws = cfg.room_root;
  const inputDir = path.join(ws, 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  let inputs = [];
  try { inputs = JSON.parse(task.inputs_json || '[]'); } catch (e) {}
  const copied = [];
  for (const src of inputs) {
    try {
      const base = path.basename(src);
      fs.copyFileSync(src, path.join(inputDir, base));
      copied.push(base);
    } catch (e) {
      log(cfg.name, `WARN could not copy input ${src}: ${e.message}`);
    }
  }

  const doc = {
    id: task.id,
    title: task.title,
    from: task.from_agent,
    brief: task.brief,
    inputs: copied.map((c) => `input/${c}`),
  };
  fs.writeFileSync(path.join(ws, 'task.json'), JSON.stringify(doc, null, 2) + '\n');

  // Mirror to the agent's inbox/ too — the human-debuggable view (DB is truth).
  const inbox = path.join(cfg.agent_dir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, `${task.id}.json`), JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

function deliver(cfg, task) {
  materialise(cfg, task);
  const S = cfg.tmux_session;
  // One short line. NEVER the task body: a newline in it would submit early.
  tmux('send-keys', '-t', S, '-l', `A new task is ready. Read ./task.json in your workspace and begin.`);
  sleep(400);
  tmux('send-keys', '-t', S, 'Enter');
  log(cfg.name, `delivered ${task.id} (${task.title})`);
}

// Wait for this turn's Stop event. Its last_assistant_message is the result.
function awaitResult(cfg, sinceEventId) {
  const t0 = Date.now();
  let sawSubmit = false;
  while (Date.now() - t0 < TASK_TIMEOUT_MS) {
    const ev = api('GET', `/events?agent=${cfg.name}&since_id=${sinceEventId}&limit=50`);
    const list = (ev.body || []).slice().reverse();
    for (const e of list) {
      let p = {};
      try { p = JSON.parse(e.payload_json || '{}'); } catch (x) {}
      if (e.evt === 'UserPromptSubmit') sawSubmit = true;
      if (e.evt === 'Stop') {
        return { ok: true, result: p.last_assistant_message || '', session_id: p.session_id || e.session_id, event_id: e.id };
      }
    }
    // Only the LAST screenful matters for dialog detection, and only when the pane is
    // actually waiting for a keypress — otherwise the agent's own prose can trip it.
    const txt = paneText(cfg.tmux_session, 30);
    const tail = txt.split('\n').slice(-14).join('\n');
    if (AWAITING_INPUT.test(tail) && !BUSY_MARK.test(tail)) {
      for (const [kind, rx] of BLOCKING_DIALOGS) {
        if (rx.test(tail)) {
          // Re-check for Stop before giving up: a turn can complete in the same instant.
          const late = api('GET', `/events?agent=${cfg.name}&evt=Stop&since_id=${sinceEventId}&limit=1`);
          if (late.body && late.body.length) {
            let p = {};
            try { p = JSON.parse(late.body[0].payload_json || '{}'); } catch (x) {}
            return { ok: true, result: p.last_assistant_message || '', session_id: p.session_id, event_id: late.body[0].id };
          }
          return { ok: false, blocked: kind, pane: tail.slice(-1200) };
        }
      }
    }
    // If the prompt never submitted, nudge once — observed occasionally.
    if (!sawSubmit && Date.now() - t0 > 8000 && !BUSY_MARK.test(txt)) {
      tmux('send-keys', '-t', cfg.tmux_session, 'Enter');
      sawSubmit = true; // only nudge once
      log(cfg.name, 'prompt had not submitted — nudged Enter');
    }
    sleep(POLL_MS);
  }
  return { ok: false, blocked: 'task-timeout' };
}

// A supervisor delegates by emitting `DELEGATE <worker>: <instruction>` lines.
// The runner turns those into real tasks (the API still enforces who may task whom).
function parseDelegations(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]\s*)?DELEGATE\s+([A-Za-z0-9._-]+)\s*:\s*(.+?)\s*$/);
    if (m) out.push({ to: m[1], brief: m[2] });
  }
  return out;
}

function lastEventId() {
  const r = api('GET', '/events?limit=1');
  return r.body && r.body.length ? r.body[0].id : 0;
}

// ---------------------------------------------------------------- main loop

function run(agentDir, opts = {}) {
  const cfg = loadAgentYaml(agentDir);
  cfg.agent_dir = cfg.agent_dir || agentDir;
  const name = cfg.name;

  const before = lastEventId();
  spawnAgent(cfg);
  api('PATCH', `/agents/${name}`, { status: 'booting' });

  const ready = awaitReady(cfg, before);
  if (!ready.ok) {
    api('PATCH', `/agents/${name}`, { status: 'failed' });
    api('POST', '/events', { agent: name, evt: 'runner.boot_failed', payload: { reason: ready.blocked, pane: ready.pane } });
    log(name, `boot failed: ${ready.blocked}`);
    if (ready.pane) process.stdout.write('--- pane ---\n' + ready.pane + '\n------------\n');
    return 1;
  }
  api('PATCH', `/agents/${name}`, { status: 'idle', session_id: ready.session_id || null });

  let idleLoops = 0;
  for (;;) {
    const claim = api('POST', `/agents/${name}/claim`);
    if (claim.code === 204 || !claim.body) {
      idleLoops++;
      if (opts.once && idleLoops > 2) { log(name, 'no work; exiting (--once)'); return 0; }
      sleep(POLL_MS);
      continue;
    }
    idleLoops = 0;
    const task = claim.body;

    const mark = lastEventId();
    api('PATCH', `/tasks/${task.id}`, { status: 'running' });
    api('PATCH', `/agents/${name}`, { status: 'busy' });
    deliver(cfg, task);

    const res = awaitResult(cfg, mark);
    if (!res.ok) {
      api('PATCH', `/tasks/${task.id}`, { status: 'failed', error: res.blocked, finished: true });
      api('PATCH', `/agents/${name}`, { status: 'failed' });
      log(name, `task ${task.id} failed: ${res.blocked}`);
      if (res.pane) process.stdout.write('--- pane ---\n' + res.pane + '\n------------\n');
      return 1;
    }

    // Record what the agent produced, so the supervisor can be handed real files.
    const artifacts = fs
      .readdirSync(cfg.room_root, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name !== 'task.json')
      .map((d) => path.join(cfg.room_root, d.name));

    api('PATCH', `/tasks/${task.id}`, {
      status: 'done',
      result: res.result,
      artifacts_json: JSON.stringify(artifacts),
      session_id: res.session_id,
      finished: true,
    });
    api('PATCH', `/agents/${name}`, { status: 'idle' });
    log(name, `task ${task.id} done (${res.result.length} chars, ${artifacts.length} files)`);

    // Supervisor delegation
    const dels = parseDelegations(res.result);
    for (const d of dels) {
      const t = api('POST', '/tasks', {
        from_agent: name,
        to_agent: d.to,
        parent_id: task.id,
        title: `from ${name}: ${d.brief.slice(0, 60)}`,
        brief: d.brief,
      });
      if (t.body && t.body.id) log(name, `delegated -> ${d.to}: ${t.body.id}`);
      else log(name, `delegation to ${d.to} REFUSED: ${(t.body && t.body.error) || t.code}`);
    }

    if (opts.once) { log(name, 'task complete; exiting (--once)'); return 0; }
  }
}

module.exports = { run, parseDelegations, loadAgentYaml };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: room-runner.js <agent-dir> [--once]\n');
    process.exit(2);
  }
  process.exit(run(path.resolve(dir), { once: process.argv.includes('--once') }));
}
