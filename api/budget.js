// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

// Budget enforcement.
//
// Enforced in the API rather than the runner, because the API owns the cost data and is
// the only chokepoint every task must pass: a second runner, or a direct curl, cannot
// route around it. Checked at two points:
//
//   POST /agents/:name/claim   the HARD gate — work is not delivered over budget
//   POST /tasks                a courtesy — refuse to queue work that could never run
//
// Costs come from the CLI's own telemetry (claude_code.cost.usage via api/collector.js),
// so these are real dollars, not estimates from a price table.
//
// A cap of 0, null or undefined means "uncapped" for that dimension.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  run_usd: 0,
  agent_usd: 0,
  task_usd: 0,
  warn_at: 0.8,
  on_exceed: 'pause', // pause | stop | warn
  agents: {},
};

// Config is read from disk on each check, so `hive budget set` takes effect without a
// server restart. The file is tiny and the OS caches it; a cost check is not hot.
function load(hiveHome) {
  const f = path.join(hiveHome, 'budget.json');
  let cfg = { ...DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) {
    /* no budget file = uncapped */
  }
  cfg.agents = cfg.agents || {};
  return cfg;
}

function save(hiveHome, cfg) {
  const f = path.join(hiveHome, 'budget.json');
  fs.mkdirSync(hiveHome, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

const capFor = (cfg, agent, key) => {
  const per = cfg.agents[agent] || {};
  const v = per[key] !== undefined ? per[key] : cfg[key];
  return Number(v) > 0 ? Number(v) : 0; // 0 / missing = uncapped
};

// Spend so far. agent_costs is the telemetry running total (DELTA sums accumulated);
// tasks.cost_usd is the per-task attribution and is only a fallback.
function spend(D) {
  const byAgent = {};
  let total = 0;
  try {
    for (const r of D.prepare('SELECT agent, cost_usd FROM agent_costs').all()) {
      byAgent[r.agent] = Number(r.cost_usd || 0);
      total += Number(r.cost_usd || 0);
    }
  } catch (e) {
    /* table appears with the first telemetry */
  }
  return { byAgent, total };
}

// The decision. Returns {allow, reason, state} where state is one of
// ok | warn | agent_exceeded | run_exceeded.
function check(D, cfg, agent) {
  const { byAgent, total } = spend(D);
  const used = byAgent[agent] || 0;

  const runCap = Number(cfg.run_usd) > 0 ? Number(cfg.run_usd) : 0;
  const agentCap = capFor(cfg, agent, 'agent_usd');

  if (runCap && total >= runCap) {
    return {
      allow: false,
      state: 'run_exceeded',
      used, total, cap: runCap,
      reason: `run budget exhausted: $${total.toFixed(4)} of $${runCap.toFixed(2)} spent across the hive`,
    };
  }
  if (agentCap && used >= agentCap) {
    return {
      allow: false,
      state: 'agent_exceeded',
      used, total, cap: agentCap,
      reason: `${agent} budget exhausted: $${used.toFixed(4)} of $${agentCap.toFixed(2)}`,
    };
  }

  const warnAt = Number(cfg.warn_at) > 0 ? Number(cfg.warn_at) : 0.8;
  const nearAgent = agentCap && used >= agentCap * warnAt;
  const nearRun = runCap && total >= runCap * warnAt;
  if (nearAgent || nearRun) {
    return {
      allow: true,
      state: 'warn',
      used, total,
      cap: nearAgent ? agentCap : runCap,
      reason: nearAgent
        ? `${agent} at $${used.toFixed(4)} of $${agentCap.toFixed(2)} (${Math.round((used / agentCap) * 100)}%)`
        : `hive at $${total.toFixed(4)} of $${runCap.toFixed(2)} (${Math.round((total / runCap) * 100)}%)`,
    };
  }
  return { allow: true, state: 'ok', used, total, cap: agentCap };
}

// After a task finishes: did that single task cost more than task_usd? This cannot
// prevent the spend (the work already happened) but it catches a runaway task and can
// pause the agent before it takes another.
function checkTask(cfg, agent, taskCost) {
  const cap = capFor(cfg, agent, 'task_usd');
  if (!cap || !(taskCost > 0)) return { allow: true, state: 'ok' };
  if (taskCost >= cap) {
    return {
      allow: false,
      state: 'task_exceeded',
      used: taskCost,
      cap,
      reason: `single task cost $${Number(taskCost).toFixed(4)}, over the $${cap.toFixed(2)} per-task cap`,
    };
  }
  return { allow: true, state: 'ok' };
}

// A compact report for `hive budget`.
function report(D, cfg) {
  const { byAgent, total } = spend(D);
  const runCap = Number(cfg.run_usd) > 0 ? Number(cfg.run_usd) : 0;
  const names = new Set([...Object.keys(byAgent), ...Object.keys(cfg.agents)]);
  return {
    on_exceed: cfg.on_exceed || 'pause',
    warn_at: Number(cfg.warn_at) || 0.8,
    run: {
      used: Number(total.toFixed(4)),
      cap: runCap,
      pct: runCap ? Math.round((total / runCap) * 100) : null,
    },
    agents: [...names].sort().map((a) => {
      const used = byAgent[a] || 0;
      const cap = capFor(cfg, a, 'agent_usd');
      return {
        agent: a,
        used: Number(used.toFixed(4)),
        cap,
        pct: cap ? Math.round((used / cap) * 100) : null,
        task_cap: capFor(cfg, a, 'task_usd'),
      };
    }),
  };
}

module.exports = { load, save, check, checkTask, report, spend, capFor, DEFAULTS };
