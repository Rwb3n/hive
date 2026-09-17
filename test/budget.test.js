// Unit tests for api/budget.js — the decision table for refusing work.
// Run: node test/budget.test.js
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const budget = require('../api/budget.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-budget-'));

function dbWith(costs) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agent_costs (agent TEXT PRIMARY KEY, cost_usd REAL NOT NULL DEFAULT 0, updated_at TEXT)`);
  for (const [agent, cost] of Object.entries(costs)) {
    db.prepare('INSERT INTO agent_costs (agent, cost_usd) VALUES (?, ?)').run(agent, cost);
  }
  return db;
}

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${ok ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

// ---- no config at all = uncapped (a hive with no budget.json must still work)
{
  const cfg = budget.load(path.join(BASE, 'nonexistent'));
  const v = budget.check(dbWith({ 'worker-1': 9999 }), cfg, 'worker-1');
  t('no budget.json -> uncapped, allowed', [v.allow, v.state], [true, 'ok']);
}

// ---- per-agent cap
{
  const cfg = { ...budget.DEFAULTS, agent_usd: 2.0 };
  t('under agent cap -> ok',
    budget.check(dbWith({ 'w': 0.5 }), cfg, 'w').state, 'ok');
  t('at 80% of agent cap -> warn but allowed',
    (() => { const v = budget.check(dbWith({ 'w': 1.6 }), cfg, 'w'); return [v.allow, v.state]; })(),
    [true, 'warn']);
  t('at agent cap -> refused',
    (() => { const v = budget.check(dbWith({ 'w': 2.0 }), cfg, 'w'); return [v.allow, v.state]; })(),
    [false, 'agent_exceeded']);
  t('over agent cap -> refused',
    budget.check(dbWith({ 'w': 3.7 }), cfg, 'w').allow, false);
  t('one agent over does not block another',
    budget.check(dbWith({ a: 5, b: 0.1 }), { ...budget.DEFAULTS, agent_usd: 2 }, 'b').allow, true);
}

// ---- run (whole hive) cap, which is the sum across agents
{
  const cfg = { ...budget.DEFAULTS, run_usd: 5.0 };
  t('hive under run cap -> ok',
    budget.check(dbWith({ a: 1, b: 1 }), cfg, 'a').state, 'ok');
  t('hive at run cap -> refused even for a cheap agent',
    (() => { const v = budget.check(dbWith({ a: 4.9, b: 0.1 }), cfg, 'b'); return [v.allow, v.state]; })(),
    [false, 'run_exceeded']);
  t('run cap takes precedence over agent cap',
    budget.check(dbWith({ a: 10 }), { ...budget.DEFAULTS, run_usd: 5, agent_usd: 20 }, 'a').state,
    'run_exceeded');
}

// ---- per-agent overrides
{
  const cfg = { ...budget.DEFAULTS, agent_usd: 2.0, agents: { cheap: { agent_usd: 0.5 }, rich: { agent_usd: 10 } } };
  t('override lowers a cap', budget.check(dbWith({ cheap: 0.6 }), cfg, 'cheap').allow, false);
  t('override raises a cap', budget.check(dbWith({ rich: 5 }), cfg, 'rich').allow, true);
  t('unlisted agent uses the default', budget.check(dbWith({ other: 2.5 }), cfg, 'other').allow, false);
  t('explicit 0 override = uncapped', budget.capFor({ agent_usd: 2, agents: { free: { agent_usd: 0 } } }, 'free', 'agent_usd'), 0);
}

// ---- an agent with no recorded spend
{
  const cfg = { ...budget.DEFAULTS, agent_usd: 1 };
  t('unknown agent has spent nothing -> allowed',
    budget.check(dbWith({}), cfg, 'brand-new').allow, true);
}

// ---- per-task cap (checked after the fact)
{
  const cfg = { ...budget.DEFAULTS, task_usd: 1.0 };
  t('task under cap -> ok', budget.checkTask(cfg, 'w', 0.4).allow, true);
  t('task at cap -> flagged', budget.checkTask(cfg, 'w', 1.0).state, 'task_exceeded');
  t('task over cap -> flagged', budget.checkTask(cfg, 'w', 2.5).allow, false);
  t('no task cap -> always ok', budget.checkTask({ ...budget.DEFAULTS }, 'w', 99).allow, true);
  t('zero-cost task never flags', budget.checkTask(cfg, 'w', 0).allow, true);
}

// ---- warn threshold is configurable
{
  const cfg = { ...budget.DEFAULTS, agent_usd: 10, warn_at: 0.5 };
  t('custom warn_at fires earlier', budget.check(dbWith({ w: 5 }), cfg, 'w').state, 'warn');
  t('below custom warn_at stays ok', budget.check(dbWith({ w: 4.9 }), cfg, 'w').state, 'ok');
}

// ---- save/load round trip, and that it survives a corrupt file
{
  const home = path.join(BASE, 'h1');
  budget.save(home, { ...budget.DEFAULTS, run_usd: 7.5, agents: { x: { agent_usd: 1 } } });
  const back = budget.load(home);
  t('save/load round trip', [back.run_usd, back.agents.x.agent_usd], [7.5, 1]);

  const home2 = path.join(BASE, 'h2');
  fs.mkdirSync(home2, { recursive: true });
  fs.writeFileSync(path.join(home2, 'budget.json'), '{ this is not json');
  const v = budget.check(dbWith({ w: 100 }), budget.load(home2), 'w');
  t('corrupt budget.json -> uncapped, not a crash', [v.allow, v.state], [true, 'ok']);
}

// ---- the report shape `hive budget` renders
{
  const cfg = { ...budget.DEFAULTS, run_usd: 10, agent_usd: 2, agents: { s: { agent_usd: 1.5 } } };
  const r = budget.report(dbWith({ s: 0.75, w: 1.0 }), cfg);
  t('report: hive total and pct', [r.run.used, r.run.cap, r.run.pct], [1.75, 10, 18]);
  t('report: lists every agent seen or configured', r.agents.map((a) => a.agent), ['s', 'w']);
  t('report: per-agent pct uses the override', r.agents.find((a) => a.agent === 's').pct, 50);
  t('report: uncapped agent has null pct',
    budget.report(dbWith({ z: 1 }), { ...budget.DEFAULTS }).agents[0].pct, null);
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
