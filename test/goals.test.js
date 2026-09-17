// Tests for goals: the one hierarchy level above a task.
//
// The load-bearing claim is DURABILITY: a goal outlives `hive reset`, which deletes every
// task. Its lifetime counters therefore live on the goal row and are maintained
// incrementally — a SUM over tasks would silently drop to zero on a wipe. That is exactly
// the failure mode this project keeps hitting (POSTMORTEMS.md), so it is tested directly.
// Run: node test/goals.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../api/db.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-goals-'));
const D = db.open(path.join(BASE, 'api', 'hive.db'));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${ok ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}
// Agents must exist for tasks to reference them.
for (const n of ['lead', 'worker-1']) {
  db.upsertAgent(D, { name: n, room: 'r1', role: n === 'lead' ? 'planner' : 'worker', room_root: '/x', agent_dir: '/x' });
}

// ---------------------------------------------------------------- creation

{
  const g = db.createGoal(D, { title: 'Ship the Widget API docs', budget_usd: 5, priority: 2, tag: 'docs' });
  t('id derives from the title', g.id, 'g_ship-the-widget-api-docs');
  t('defaults: status active', g.status, 'active');
  t('budget and priority stored', [g.budget_usd, g.priority], [5, 2]);
  t('starts at zero', [g.tasks_total, g.tasks_done, g.spent_usd], [0, 0, 0]);
  t('uncapped by default', db.createGoal(D, { title: 'no budget' }).budget_usd, 0);
  t('default priority is 5', db.createGoal(D, { title: 'default pri' }).priority, 5);
}

// ---------------------------------------------------------------- rollup

const G = 'g_ship-the-widget-api-docs';
{
  const t1 = db.createTask(D, { goal_id: G, from_agent: 'human', to_agent: 'lead', title: 'plan', brief: 'b' });
  t('task carries the goal', t1.goal_id, G);
  t('creating a task bumps tasks_total', db.getGoal(D, G).tasks_total, 1);

  // A child inherits the goal — a planner's delegations land under the same intent
  // without the planner needing to know the goal id.
  const t2 = db.createTask(D, { parent_id: t1.id, from_agent: 'lead', to_agent: 'worker-1', title: 'do', brief: 'b' });
  t('child inherits the parent goal', t2.goal_id, G);
  t('tasks_total counts the child too', db.getGoal(D, G).tasks_total, 2);

  // Cost arrives incrementally from the collector, so it must roll as a DELTA.
  db.updateTask(D, t2.id, { cost_usd: 0.05 });
  t('cost rolls up', db.getGoal(D, G).spent_usd, 0.05);
  db.updateTask(D, t2.id, { cost_usd: 0.12 }); // collector updates the same task again
  t('further cost rolls the DELTA, not the total', db.getGoal(D, G).spent_usd, 0.12);

  db.updateTask(D, t2.id, { status: 'done' });
  t('done increments tasks_done', db.getGoal(D, G).tasks_done, 1);
  db.updateTask(D, t2.id, { status: 'done', result: 'again' }); // a re-PATCH must not double count
  t('re-PATCHing done does not double count', db.getGoal(D, G).tasks_done, 1);

  const r = db.goalRollup(D, G);
  t('rollup: lifetime figures', [r.lifetime.tasks, r.lifetime.done, r.lifetime.spent_usd], [2, 1, 0.12]);
  t('rollup: percent of budget', r.lifetime.pct, 2);
  t('rollup: remaining', r.lifetime.remaining_usd, 4.88);
  t('rollup: live open count', r.open, 1); // t1 is still queued
  t('rollup: null pct when uncapped', db.goalRollup(D, 'g_no-budget').lifetime.pct, null);
}

// ---------------------------------------------------------------- DURABILITY
//
// The claim that justifies the whole level.

{
  const beforeWipe = db.goalRollup(D, G).lifetime;
  D.exec('DELETE FROM tasks'); // exactly what `hive reset` does
  const afterWipe = db.goalRollup(D, G);
  t('goal SURVIVES a task wipe', !!afterWipe, true);
  t('lifetime tasks survive', afterWipe.lifetime.tasks, beforeWipe.tasks);
  t('lifetime done survives', afterWipe.lifetime.done, beforeWipe.done);
  t('lifetime spend survives', afterWipe.lifetime.spent_usd, beforeWipe.spent_usd);
  t('live counts go to zero (tasks are gone)', afterWipe.open, 0);
  t('live cost is zero, lifetime is not',
    [afterWipe.live.cost_usd, afterWipe.lifetime.spent_usd > 0], [0, true]);
}

// ---------------------------------------------------------------- budget gate

{
  const g = db.createGoal(D, { title: 'tight budget', budget_usd: 0.10 });
  t('under budget: no block', db.goalOverBudget(D, g.id), null);

  const task = db.createTask(D, { goal_id: g.id, from_agent: 'human', to_agent: 'worker-1', title: 'x', brief: 'b' });
  db.updateTask(D, task.id, { cost_usd: 0.15 });
  const over = db.goalOverBudget(D, g.id);
  t('over budget: blocked', !!over, true);
  t('over budget: reason names the goal and the numbers', /g_tight-budget budget exhausted: \$0\.1500 of \$0\.10/.test(over.reason), true);

  // Status gates delivery too — a paused goal parks its work without losing it.
  const p = db.createGoal(D, { title: 'paused one' });
  db.updateGoal(D, p.id, { status: 'paused' });
  t('paused goal blocks', /is paused/.test(db.goalOverBudget(D, p.id).reason), true);
  db.updateGoal(D, p.id, { status: 'done' });
  t('done goal blocks', /is done/.test(db.goalOverBudget(D, p.id).reason), true);
  t('closed_at set when finished', !!db.getGoal(D, p.id).closed_at, true);
  db.updateGoal(D, p.id, { status: 'active' });
  t('reactivating unblocks', db.goalOverBudget(D, p.id), null);

  t('uncapped goal never blocks on budget', db.goalOverBudget(D, 'g_no-budget'), null);
  t('unknown goal does not block (task just has no goal)', db.goalOverBudget(D, 'g_nope'), null);
  t('null goal id does not block', db.goalOverBudget(D, null), null);
}

// ---------------------------------------------------------------- listing

{
  const all = db.listGoals(D);
  t('lists every goal', all.length >= 5, true);
  t('ordered by priority', all[0].priority <= all[all.length - 1].priority, true);
  t('filter by status', db.listGoals(D, { status: 'active' }).every((g) => g.status === 'active'), true);
  t('filter by tag (a "programme" is a shared tag)', db.listGoals(D, { tag: 'docs' }).map((g) => g.id), [G]);
  t('filter by tasks under a goal', db.listTasks(D, { goal_id: 'g_tight-budget' }).length, 1);
}

// ---------------------------------------------------------------- notes survive

{
  db.updateGoal(D, G, { notes: 'part A and B written; reviewer found 2 defects' });
  D.exec('DELETE FROM tasks');
  t('durable progress note survives a wipe',
    db.getGoal(D, G).notes, 'part A and B written; reviewer found 2 defects');
}

D.close();
fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
