// Lifecycle signal relay: SessionStart / UserPromptSubmit / Stop -> the hive's log dir.
// Installed into each agent's generated settings; this is the runner's INPUT side, replacing
// tmux screen-scraping. Verified working in interactive mode (claude 2.1.274).
//
// Usage in settings.json:  { "type": "command", "command": "node <hive>/bin/signal.js Stop" }
// Env: HIVE_LOG_DIR (required, outside the room), HIVE_AGENT (optional label)
//
// Must never block or fail the agent: any error exits 0 silently.
const fs = require('fs');
const path = require('path');

const evt = process.argv[2] || 'unknown';
const dir = process.env.HIVE_LOG_DIR;
const agent = process.env.HIVE_AGENT || path.basename(process.env.HIVE_ROOM_ROOT || 'unknown');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  if (!dir) process.exit(0);
  let p = {};
  try {
    p = JSON.parse(raw);
  } catch (e) {
    p = { _unparsed: raw.slice(0, 500) };
  }

  // Keep the record small and useful: the fields the runner actually dispatches on.
  const rec = {
    ts: new Date().toISOString(),
    evt,
    agent,
    session_id: p.session_id,
    cwd: p.cwd,
    transcript_path: p.transcript_path,
  };
  if (evt === 'SessionStart') {
    rec.model = p.model;
    rec.source = p.source;
  }
  if (evt === 'UserPromptSubmit') {
    rec.prompt_id = p.prompt_id;
    rec.prompt = String(p.prompt || '').slice(0, 2000);
  }
  if (evt === 'Stop') {
    // The result channel: the agent's complete reply, as text.
    rec.last_assistant_message = String(p.last_assistant_message || '');
    rec.stop_hook_active = p.stop_hook_active;
    rec.background_tasks = p.background_tasks;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'signals.jsonl'), JSON.stringify(rec) + '\n');
  } catch (e) {
    /* never let logging failure affect the agent */
  }

  // Also push to the API machine — this is the runner's input side. The file log
  // above stays as a fallback so a stopped server cannot lose the audit trail.
  post(rec, () => process.exit(0));
});

function post(rec, done) {
  const api = process.env.HIVE_API;
  if (!api) return done();
  let u;
  try {
    u = new URL('/events', api);
  } catch (e) {
    return done();
  }
  const payload = JSON.stringify({
    agent: rec.agent,
    evt: rec.evt,
    session_id: rec.session_id,
    payload: rec,
  });
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const req = mod.request(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      timeout: 3000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(process.env.HIVE_TOKEN ? { 'x-hive-token': process.env.HIVE_TOKEN } : {}),
      },
    },
    (res) => {
      res.resume();
      res.on('end', done);
    }
  );
  // A hook must never block or break the agent: on any failure, just move on.
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.write(payload);
  req.end();
}
