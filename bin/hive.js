#!/usr/bin/env node
// hive — the CLI. A thin client over the API machine.
//
//   hive provision [plan.yaml]     build rooms + agents from hive.yaml
//   hive up                        start the API machine (in tmux)
//   hive down                      stop the API machine
//   hive start <agent|--all>       spawn agent(s) and their runner
//   hive stop  <agent|--all>       kill agent tmux session(s)
//   hive ps                        agents, status, task counts, cost
//   hive send <agent> "<brief>"    queue a task
//   hive task <id>                 show one task in full
//   hive tasks                     list tasks
//   hive watch <agent>             prints the tmux attach command
//   hive log [agent]               recent events
//   hive denials                   boundary violations
//   hive reset                     wipe tasks/events (keeps agents)

const { execFileSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HIVE_HOME = process.env.HIVE_HOME || path.join(os.homedir(), 'hive');
const API = process.env.HIVE_API || 'http://127.0.0.1:8787';
const TOKEN = process.env.HIVE_TOKEN || '';

// `soft: true` returns {code:0} instead of exiting when the server is unreachable —
// used by `up` to probe whether the api is already running.
function api(method, route, body, soft) {
  const args = ['-s', '-X', method, `${API}${route}`, '-H', 'content-type: application/json'];
  if (TOKEN) args.push('-H', `x-hive-token: ${TOKEN}`);
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  args.push('-w', '\n%{http_code}');
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    if (soft) return { code: 0, body: null };
    die(`cannot reach the api at ${API} — is it up? (hive up)`);
  }
  const i = out.lastIndexOf('\n');
  const code = Number(out.slice(i + 1).trim());
  const text = out.slice(0, i);
  if (code === 204 || !text.trim()) return { code, body: null };
  try {
    return { code, body: JSON.parse(text) };
  } catch (e) {
    return { code, body: null, raw: text };
  }
}

const die = (m) => { process.stderr.write(`hive: ${m}\n`); process.exit(1); };
const out = (s) => process.stdout.write(s + '\n');
const tmux = (...a) => spawnSync('tmux', a, { encoding: 'utf8' });

// ---------------------------------------------------------------- commands

const cmds = {};

cmds.provision = (args) => {
  const plan = args[0] || path.join(process.cwd(), 'hive.yaml');
  if (!fs.existsSync(plan)) die(`no plan at ${plan}`);
  const { provision } = require('./provision.js');
  const res = provision(plan, { force: args.includes('--force') });
  out(`provisioned ${res.agents.length} agents under ${res.home}`);
  // Register them with the API if it is up.
  const h = api('GET', '/health', undefined, true);
  if (h.code === 200) {
    for (const a of res.agents) {
      api('POST', '/agents', a);
      out(`  registered ${a.name.padEnd(12)} ${a.role.padEnd(11)} ${a.room_root}`);
    }
  } else {
    out('  (api not running — run `hive up`, then `hive provision` again to register)');
    for (const a of res.agents) out(`  ${a.name.padEnd(12)} ${a.role.padEnd(11)} ${a.room_root}`);
  }
};

cmds.up = () => {
  if (api('GET', '/health', undefined, true).code === 200) return out('api already up');
  const server = path.join(HIVE_HOME, 'api', 'server.js');
  if (!fs.existsSync(server)) die(`no server at ${server} — did you install the hive into ${HIVE_HOME}?`);
  tmux('kill-session', '-t', 'hive-api');
  tmux('new-session', '-d', '-s', 'hive-api', '-c', HIVE_HOME);
  const cmd = `HIVE_HOME=${HIVE_HOME}${TOKEN ? ` HIVE_TOKEN=${TOKEN}` : ''} node ${server} 2>&1 | tee -a ${path.join(HIVE_HOME, 'api', 'server.log')}`;
  tmux('send-keys', '-t', 'hive-api', cmd, 'Enter');
  for (let i = 0; i < 30; i++) {
    if (api('GET', '/health', undefined, true).code === 200) return out(`api up at ${API}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  die('api did not come up — check `tmux attach -t hive-api`');
};

cmds.down = () => {
  tmux('kill-session', '-t', 'hive-api');
  out('api stopped');
};

cmds.start = (args) => {
  const all = args.includes('--all');
  const names = all ? api('GET', '/agents').body.map((a) => a.name) : args.filter((a) => !a.startsWith('--'));
  if (!names.length) die('usage: hive start <agent>|--all');
  const runner = path.join(HIVE_HOME, 'bin', 'room-runner.js');
  for (const n of names) {
    const a = api('GET', `/agents/${n}`).body;
    if (!a || a.error) { out(`  ${n}: not registered — run hive provision`); continue; }
    const runnerSession = `hive-runner-${n}`;
    tmux('kill-session', '-t', runnerSession);
    tmux('new-session', '-d', '-s', runnerSession, '-c', HIVE_HOME);
    const env = [`HIVE_API=${API}`, TOKEN ? `HIVE_TOKEN=${TOKEN}` : ''].filter(Boolean).join(' ');
    tmux('send-keys', '-t', runnerSession,
      `${env} node ${runner} ${a.agent_dir} 2>&1 | tee -a ${path.join(HIVE_HOME, 'logs', n, 'runner.log')}`, 'Enter');
    out(`  started runner for ${n} (tmux: ${runnerSession}, agent: ${a.tmux_session})`);
  }
  out('\nwatch an agent work:  tmux attach -t hive-<agent>');
  out('watch its runner:     tmux attach -t hive-runner-<agent>');
};

cmds.stop = (args) => {
  const all = args.includes('--all');
  const names = all ? api('GET', '/agents').body.map((a) => a.name) : args.filter((a) => !a.startsWith('--'));
  for (const n of names) {
    tmux('kill-session', '-t', `hive-runner-${n}`);
    tmux('kill-session', '-t', `hive-${n}`);
    api('PATCH', `/agents/${n}`, { status: 'stopped' });
    out(`  stopped ${n}`);
  }
};

cmds.ps = () => {
  const s = api('GET', '/status').body;
  if (!s) die('no status');
  out('AGENT         ROOM     ROLE         STATUS    QUEUED  RUN  DONE  FAIL  SESSION');
  for (const a of s.agents) {
    const t = a.tasks || {};
    out(
      `${a.name.padEnd(13)} ${String(a.room).padEnd(8)} ${String(a.role).padEnd(12)} ` +
      `${String(a.status).padEnd(9)} ${String(t.queued || 0).padStart(6)} ${String(t.running || 0).padStart(4)} ` +
      `${String(t.done || 0).padStart(5)} ${String(t.failed || 0).padStart(5)}  ${(a.session_id || '-').slice(0, 8)}`
    );
  }
  out(`\ntasks: ${s.totals.tasks}  done: ${s.totals.done}  denials: ${s.totals.denials}  cost: $${s.totals.cost_usd}`);
};

cmds.send = (args) => {
  const to = args[0];
  const brief = args.slice(1).join(' ');
  if (!to || !brief) die('usage: hive send <agent> "<brief>"');
  const title = brief.length > 60 ? brief.slice(0, 57) + '...' : brief;
  const r = api('POST', '/tasks', { to_agent: to, title, brief });
  if (r.body && r.body.id) out(`queued ${r.body.id} -> ${to}`);
  else die((r.body && r.body.error) || `http ${r.code}`);
};

cmds.tasks = () => {
  const list = api('GET', '/tasks').body || [];
  if (!list.length) return out('no tasks');
  out('ID                    FROM         TO           STATUS     TITLE');
  for (const t of list) {
    out(
      `${t.id.padEnd(21)} ${String(t.from_agent).padEnd(12)} ${String(t.to_agent).padEnd(12)} ` +
      `${String(t.status).padEnd(10)} ${String(t.title).slice(0, 44)}`
    );
  }
};

cmds.task = (args) => {
  const t = api('GET', `/tasks/${args[0]}`).body;
  if (!t || t.error) die('no such task');
  out(`id:        ${t.id}`);
  out(`from -> to ${t.from_agent} -> ${t.to_agent}`);
  out(`status:    ${t.status}${t.error ? '  error: ' + t.error : ''}`);
  out(`title:     ${t.title}`);
  if (t.parent_id) out(`parent:    ${t.parent_id}`);
  out(`\n--- brief ---\n${t.brief}`);
  if (t.artifacts_json && t.artifacts_json !== 'null') {
    try { out(`\n--- artifacts ---\n${JSON.parse(t.artifacts_json).join('\n')}`); } catch (e) {}
  }
  if (t.result) out(`\n--- result ---\n${t.result}`);
};

cmds.watch = (args) => {
  const n = args[0];
  if (!n) die('usage: hive watch <agent>');
  out(`tmux attach -t hive-${n}          # the agent itself`);
  out(`tmux attach -t hive-runner-${n}   # its runner`);
  out('\n(detach with ctrl-b d)');
};

cmds.log = (args) => {
  const agent = args.find((a) => !a.startsWith('--'));
  const q = agent ? `?agent=${agent}&limit=40` : '?limit=40';
  const list = (api('GET', `/events${q}`).body || []).slice().reverse();
  for (const e of list) {
    out(`${e.ts}  ${String(e.agent || '-').padEnd(12)} ${e.evt}`);
  }
};

cmds.denials = () => {
  const list = api('GET', '/denials').body || [];
  if (!list.length) return out('no boundary violations recorded');
  for (const d of list) out(`${d.ts}  ${String(d.agent || '-').padEnd(12)} ${String(d.tool).padEnd(8)} ${d.attempted}`);
};

cmds.reset = () => {
  const { open } = require(path.join(HIVE_HOME, 'api', 'db.js'));
  const db = open(path.join(HIVE_HOME, 'api', 'hive.db'));
  db.exec('DELETE FROM tasks; DELETE FROM events; DELETE FROM denials; DELETE FROM messages;');
  out('cleared tasks, events, denials, messages (agents kept)');
};

cmds.help = () => {
  out(`hive — a building of scoped Claude agents

  hive provision [plan.yaml]   build rooms + agents (generates settings, pre-trusts rooms)
  hive up | down               start / stop the api machine
  hive start <agent|--all>     spawn agent(s) + runner
  hive stop  <agent|--all>     kill agent + runner sessions
  hive ps                      status table
  hive send <agent> "<brief>"  queue a task
  hive tasks | task <id>       list / show tasks
  hive watch <agent>           how to attach and watch
  hive log [agent] | denials   events / boundary violations
  hive reset                   wipe tasks + events

env: HIVE_HOME=${HIVE_HOME}  HIVE_API=${API}  HIVE_TOKEN=${TOKEN ? 'set' : 'unset'}`);
};

const cmd = process.argv[2] || 'help';
(cmds[cmd] || cmds.help)(process.argv.slice(3));
