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
//   hive denials                   filesystem boundary violations
//   hive cost                      per-agent tokens and real cost
//   hive budget [set …]            caps, spend, headroom
//   hive resume <agent>            un-pause an agent that hit its cap
//   hive net up|down|status|log    egress: internal network + allowlist proxy
//   hive reset                     wipe tasks/events (keeps agents)
//
// Reference: docs/OPERATIONS.md

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
  let res;
  try {
    res = provision(plan, { force: args.includes('--force') });
  } catch (e) {
    // A config error is the user's to fix — report it, do not dump a stack trace.
    die(e.message);
  }
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
  // Pass through the host/port the CLI itself will talk to, derived from HIVE_API. Without
  // this the server binds its own default while the CLI polls a different port and `up`
  // times out with a misleading "api did not come up".
  let apiHost = '127.0.0.1';
  let apiPort = '8787';
  try {
    const u = new URL(API);
    apiHost = u.hostname || apiHost;
    apiPort = u.port || apiPort;
  } catch (e) {}
  const env = [
    `HIVE_HOME=${HIVE_HOME}`,
    `HIVE_PORT=${process.env.HIVE_PORT || apiPort}`,
    `HIVE_HOST=${process.env.HIVE_HOST || apiHost}`,
    TOKEN ? `HIVE_TOKEN=${TOKEN}` : '',
  ].filter(Boolean).join(' ');
  const cmd = `${env} node ${server} 2>&1 | tee -a ${path.join(HIVE_HOME, 'api', 'server.log')}`;
  tmux('send-keys', '-t', 'hive-api', cmd, 'Enter');
  // The OTLP collector: cost and token accounting. Agents export to it directly.
  const collector = path.join(HIVE_HOME, 'api', 'collector.js');
  if (fs.existsSync(collector)) {
    tmux('kill-session', '-t', 'hive-otel');
    tmux('new-session', '-d', '-s', 'hive-otel', '-c', HIVE_HOME);
    tmux('send-keys', '-t', 'hive-otel',
      `HIVE_HOME=${HIVE_HOME} HIVE_OTLP_PORT=${process.env.HIVE_OTLP_PORT || 4318} node ${collector} 2>&1 | tee -a ${path.join(HIVE_HOME, 'api', 'collector.log')}`, 'Enter');
    out(`collector up at http://127.0.0.1:${process.env.HIVE_OTLP_PORT || 4318} (telemetry)`);
  }
  for (let i = 0; i < 30; i++) {
    if (api('GET', '/health', undefined, true).code === 200) return out(`api up at ${API}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  die('api did not come up — check `tmux attach -t hive-api`');
};

cmds.down = () => {
  tmux('kill-session', '-t', 'hive-api');
  tmux('kill-session', '-t', 'hive-otel');
  out('api + collector stopped');
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
  out('AGENT         ROOM     ROLE         STATUS    QUEUED  RUN  DONE  FAIL      COST  SESSION');
  for (const a of s.agents) {
    const t = a.tasks || {};
    out(
      `${a.name.padEnd(13)} ${String(a.room).padEnd(8)} ${String(a.role).padEnd(12)} ` +
      `${String(a.status).padEnd(9)} ${String(t.queued || 0).padStart(6)} ${String(t.running || 0).padStart(4)} ` +
      `${String(t.done || 0).padStart(5)} ${String(t.failed || 0).padStart(5)} ` +
      `${('$' + (a.cost_usd || 0).toFixed(4)).padStart(9)}  ${(a.session_id || '-').slice(0, 8)}`
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
  if (r.body && r.body.id) return out(`queued ${r.body.id} -> ${to}`);
  if (r.code === 402) {
    die(
      [
        (r.body && r.body.error) || 'over budget',
        `  raise it:  hive budget set --agent ${to} --agent-usd <n>`,
        `  then:      hive resume ${to}`,
      ].join('\n')
    );
  }
  die((r.body && r.body.error) || `http ${r.code}`);
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

cmds.cost = () => {
  const s = api('GET', '/status').body;
  if (!s) die('no status');
  out('AGENT          INPUT   OUTPUT  CACHE-READ  CACHE-CREATE       COST');
  for (const a of s.agents) {
    const k = a.tokens || {};
    out(
      `${a.name.padEnd(13)} ${String(k.input || 0).padStart(6)} ${String(k.output || 0).padStart(8)} ` +
      `${String(k.cacheRead || 0).padStart(11)} ${String(k.cacheCreation || 0).padStart(13)} ` +
      `${('$' + (a.cost_usd || 0).toFixed(4)).padStart(10)}`
    );
  }
  out(`
total: $${s.totals.cost_usd}   (from claude_code.cost.usage — the CLI's own figure)`);
};

// Network egress: an internal docker network with no route out, plus the allowlist
// proxy as the only bridge. See docs/SECURITY.md.
cmds.net = (args) => {
  const sub = args[0] || 'status';
  const INTERNAL = process.env.HIVE_NET || 'hive-internal';
  const EGRESS = 'hive-egress';
  const dk = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

  if (sub === 'up') {
    if (dk('network', 'inspect', INTERNAL).status !== 0) {
      const r = dk('network', 'create', '--internal', INTERNAL);
      if (r.status !== 0) die(`could not create ${INTERNAL}: ${(r.stderr || '').trim()}`);
      out(`created ${INTERNAL} (internal: no route out)`);
    } else out(`${INTERNAL} already exists`);

    if (dk('network', 'inspect', EGRESS).status !== 0) {
      dk('network', 'create', EGRESS);
      out(`created ${EGRESS} (proxy side, has egress)`);
    } else out(`${EGRESS} already exists`);

    // The proxy is the ONLY thing on both networks — that is what makes it the only way out.
    dk('rm', '-f', 'hive-proxy');
    const allowFile = path.join(HIVE_HOME, 'egress-allow.json');
    const r = dk('run', '-d', '--name', 'hive-proxy',
      '--network', INTERNAL,
      '-v', `${HIVE_HOME}:/hive:ro`,
      '-v', `${path.join(HIVE_HOME, 'logs')}:/hive/logs`,
      '-e', 'HIVE_HOME=/hive',
      '-e', `HIVE_PROXY_PORT=${process.env.HIVE_PROXY_PORT || 3128}`,
      '--restart', 'unless-stopped',
      'node:22-bookworm-slim', 'node', '/hive/api/egress-proxy.js');
    if (r.status !== 0) die(`could not start the proxy: ${(r.stderr || '').trim().slice(0, 300)}`);
    dk('network', 'connect', EGRESS, 'hive-proxy');
    out('started hive-proxy (bridges the two networks; the only way out)');

    // The collector must live INSIDE the internal network: an agent there has no route
    // to the host, so a host-side collector is unreachable and cost silently reads $0.00.
    dk('rm', '-f', 'hive-collector');
    const rc = dk('run', '-d', '--name', 'hive-collector',
      '--network', INTERNAL,
      '-v', `${HIVE_HOME}:/hive`,
      '-e', 'HIVE_HOME=/hive',
      '-e', 'HIVE_OTLP_HOST=0.0.0.0',
      '-e', 'HIVE_OTLP_PORT=4318',
      '--restart', 'unless-stopped',
      'node:22-bookworm-slim', 'node', '/hive/api/collector.js');
    if (rc.status === 0) out('started hive-collector inside the network (telemetry)');
    else out(`  WARNING collector did not start: ${(rc.stderr || '').trim().slice(0, 200)}`);
    if (fs.existsSync(allowFile)) {
      try {
        const a = JSON.parse(fs.readFileSync(allowFile, 'utf8'));
        out(`  allowlist: ${(a.allow || a).join(', ')}`);
      } catch (e) {}
    } else {
      out('  allowlist: built-in defaults (run `hive provision` to write egress-allow.json)');
    }
    return;
  }

  if (sub === 'down') {
    dk('rm', '-f', 'hive-proxy');
    dk('rm', '-f', 'hive-collector');
    dk('network', 'rm', INTERNAL);
    dk('network', 'rm', EGRESS);
    return out('proxy stopped, networks removed');
  }

  if (sub === 'log') {
    const f = path.join(HIVE_HOME, 'logs', 'egress.jsonl');
    if (!fs.existsSync(f)) return out('no egress decisions logged yet');
    const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-40);
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        out(`${j.ts}  ${String(j.evt).toUpperCase().padEnd(8)} ${String(j.agent || '-').padEnd(12)} ${j.host}:${j.port || ''}${j.reason ? ' (' + j.reason + ')' : ''}`);
      } catch (e) {}
    }
    return;
  }

  // status
  const inNet = dk('network', 'inspect', INTERNAL).status === 0;
  const proxyUp = dk('inspect', '-f', '{{.State.Running}}', 'hive-proxy').stdout.trim() === 'true';
  const collUp = dk('inspect', '-f', '{{.State.Running}}', 'hive-collector').stdout.trim() === 'true';
  out(`${INTERNAL}: ${inNet ? 'present (internal)' : 'missing'}`);
  out(`hive-proxy:     ${proxyUp ? 'running' : 'not running'}`);
  out(`hive-collector: ${collUp ? 'running (inside the network)' : 'not running'}`);
  const f = path.join(HIVE_HOME, 'egress-allow.json');
  if (fs.existsSync(f)) {
    try {
      const a = JSON.parse(fs.readFileSync(f, 'utf8'));
      out(`allowlist:      ${(a.allow || a).join(', ')}`);
    } catch (e) {}
  }
  if (!inNet || !proxyUp) out('\nbring it up with: hive net up');
};

cmds.budget = (args) => {
  const sub = args[0];

  // `hive budget set --run-usd 10 --agent worker-1 --agent-usd 3 --on-exceed pause`
  if (sub === 'set') {
    const flag = (n) => {
      const i = args.indexOf('--' + n);
      return i !== -1 ? args[i + 1] : undefined;
    };
    const patch = {};
    const agentName = flag('agent');
    const map = { 'run-usd': 'run_usd', 'agent-usd': 'agent_usd', 'task-usd': 'task_usd', 'warn-at': 'warn_at' };
    for (const [f, k] of Object.entries(map)) {
      const v = flag(f);
      if (v === undefined) continue;
      if (Number.isNaN(Number(v))) die(`--${f} needs a number, got "${v}"`);
      if (agentName && k !== 'run_usd') {
        patch.agents = patch.agents || {};
        patch.agents[agentName] = Object.assign({}, patch.agents[agentName], { [k]: Number(v) });
      } else {
        patch[k] = Number(v);
      }
    }
    const oe = flag('on-exceed');
    if (oe !== undefined) {
      if (!['pause', 'stop', 'warn'].includes(oe)) die('--on-exceed must be pause, stop or warn');
      patch.on_exceed = oe;
    }
    if (!Object.keys(patch).length) {
      die('nothing to set. e.g. hive budget set --run-usd 10 --agent worker-1 --agent-usd 3');
    }
    const r = api('PATCH', '/budget', patch);
    if (!r.body) die(`could not update budget (http ${r.code})`);
    out('budget updated');
    return renderBudget(r.body);
  }

  const r = api('GET', '/budget');
  if (!r.body) die('no budget data');
  return renderBudget(r.body);
};

function renderBudget(b) {
  const bar = (pct) => {
    if (pct === null || pct === undefined) return '';
    const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
    return '[' + '#'.repeat(n) + '.'.repeat(20 - n) + ']';
  };
  const cap = (c) => (c ? '$' + Number(c).toFixed(2) : 'uncapped');
  out(`on_exceed: ${b.on_exceed}    warn at ${Math.round(b.warn_at * 100)}% of a cap`);
  out('');
  out(`HIVE TOTAL   $${b.run.used.toFixed(4)} of ${cap(b.run.cap)}  ${bar(b.run.pct)}${b.run.pct !== null ? ' ' + b.run.pct + '%' : ''}`);
  out('');
  out('AGENT              USED         CAP              TASK CAP');
  for (const a of b.agents) {
    const flag = a.pct === null ? '' : a.pct >= 100 ? '  OVER' : a.pct >= Math.round(b.warn_at * 100) ? '  near' : '';
    out(
      `${a.agent.padEnd(15)} ${('$' + a.used.toFixed(4)).padStart(9)}   ${cap(a.cap).padEnd(10)} ` +
      `${bar(a.pct)}${a.pct !== null ? ' ' + String(a.pct).padStart(3) + '%' : ''}  ${cap(a.task_cap).padEnd(9)}${flag}`
    );
  }
}

cmds.resume = (args) => {
  const n = args[0];
  if (!n) die('usage: hive resume <agent>');
  const r = api('POST', `/agents/${n}/resume`);
  if (r.code === 402) die((r.body && r.body.error) || 'still over budget — raise the cap first');
  if (!r.body || r.body.error) die((r.body && r.body.error) || `http ${r.code}`);
  out(`${n} resumed (status: ${r.body.agent.status})`);
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
  hive cost                    per-agent tokens and cost (from telemetry)
  hive budget                  caps, spend and headroom
  hive budget set [flags]      --run-usd N | --agent <name> --agent-usd N
                               --task-usd N | --warn-at 0.8 | --on-exceed pause|stop|warn
  hive resume <agent>          un-pause an agent that hit its cap
  hive net up | down | status  egress: internal network + allowlist proxy
  hive net log                 every egress decision (allowed / refused)
  hive reset                   wipe tasks + events

env: HIVE_HOME=${HIVE_HOME}  HIVE_API=${API}  HIVE_TOKEN=${TOKEN ? 'set' : 'unset'}`);
};

const cmd = process.argv[2] || 'help';
(cmds[cmd] || cmds.help)(process.argv.slice(3));
