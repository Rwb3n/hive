// Tests for agent classes and the authority policy.
//
// These two things have to agree or a class is just a label: the planner and reviewer
// classes are only meaningful because Write/Edit are actually denied, and because the
// API actually refuses a reviewer that tries to create work. Both are asserted here.
// Run: node test/classes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { provision } = require('../bin/provision.js');
const { canTask } = require('../api/server.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-classes-'));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${ok ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

// ---------------------------------------------------------------- provisioning

const home = path.join(BASE, 'hive');
fs.mkdirSync(path.join(home, 'templates'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, '..', 'templates'))) {
  fs.copyFileSync(path.join(__dirname, '..', 'templates', f), path.join(home, 'templates', f));
}

const plan = path.join(BASE, 'plan.yaml');
fs.writeFileSync(
  plan,
  [
    `home: ${home.split(path.sep).join('/')}`,
    'defaults:',
    '  tools: file-only', // a class must override this, or the class means nothing
    '  runtime: tmux',
    '  session: persistent',
    'rooms:',
    '  - name: room-1',
    '    agents:',
    '      - name: lead',
    '        class: planner',
    '      - name: worker-1',
    '        class: worker',
    '      - name: critic',
    '        class: reviewer',
    '',
  ].join('\n')
);

const res = provision(plan, { force: true });
const agentDir = (n) => path.join(home, 'rooms', 'room-1', n);
const yaml = (n) => {
  const out = {};
  for (const line of fs.readFileSync(path.join(agentDir(n), 'agent.yaml'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};
const settings = (n) => JSON.parse(fs.readFileSync(path.join(agentDir(n), '.claude', 'settings.json'), 'utf8'));
const prompt = (n) => fs.readFileSync(path.join(agentDir(n), 'agent.md'), 'utf8');

t('provisions every agent', res.agents.length, 3);

// --- a class must beat `defaults`, or it is decoration
t('planner class overrides defaults.tools', yaml('lead').tools, 'read-only');
t('reviewer class overrides defaults.tools', yaml('critic').tools, 'read-only');
t('worker class keeps file-only', yaml('worker-1').tools, 'file-only');
t('class implies role: planner', yaml('lead').role, 'planner');
t('class implies role: reviewer', yaml('critic').role, 'reviewer');
t('class implies role: worker', yaml('worker-1').role, 'worker');
t('class overrides defaults.session', yaml('lead').session, 'fresh');

// --- the capability that makes the class real
for (const n of ['lead', 'critic']) {
  const s = settings(n);
  t(`${n}: Write denied`, s.permissions.deny.includes('Write'), true);
  t(`${n}: Edit denied`, s.permissions.deny.includes('Edit'), true);
  t(`${n}: cannot write, only read`, s.permissions.allow.sort(), ['Glob', 'Grep', 'Read']);
  t(`${n}: no shell`, ['Bash', 'PowerShell', 'Monitor', 'ToolSearch'].every((x) => s.permissions.deny.includes(x)), true);
}
{
  const s = settings('worker-1');
  t('worker-1: may write', s.permissions.allow.includes('Write'), true);
  t('worker-1: no shell', s.permissions.deny.includes('Bash'), true);
}

// --- the guard is still wired on the read tools (an unguarded Grep leaks file contents)
{
  const m = settings('lead').hooks.PreToolUse[0].matcher;
  t('read-only role still guards Read/Glob/Grep', ['Read', 'Glob', 'Grep'].every((x) => m.includes(x)), true);
}

// --- role prompts must actually differ, and say the constraint out loud
t('planner prompt has a Planning section', /^## Planning$/m.test(prompt('lead')), true);
t('reviewer prompt has a Reviewing section', /^## Reviewing$/m.test(prompt('critic')), true);
t('worker prompt has a Working section', /^## Working$/m.test(prompt('worker-1')), true);
t('planner is told it cannot write', /cannot write or edit files/i.test(prompt('lead')), true);
t('reviewer is told it cannot write', /cannot write or edit files/i.test(prompt('critic')), true);
t('planner is told the delegate format', /DELEGATE <agent-name>/.test(prompt('lead')), true);
t('reviewer is NOT told to delegate', /DELEGATE/.test(prompt('critic')), false);

// --- an unknown tools value must fail loudly, not silently pick a default
{
  const bad = path.join(BASE, 'bad.yaml');
  fs.writeFileSync(
    bad,
    [`home: ${path.join(BASE, 'h2').split(path.sep).join('/')}`, 'rooms:', '  - name: r', '    agents:', '      - name: a', '        tools: nonsense', ''].join('\n')
  );
  fs.mkdirSync(path.join(BASE, 'h2', 'templates'), { recursive: true });
  for (const f of fs.readdirSync(path.join(home, 'templates'))) {
    fs.copyFileSync(path.join(home, 'templates', f), path.join(BASE, 'h2', 'templates', f));
  }
  let msg = '';
  try { provision(bad, { force: true }); } catch (e) { msg = e.message; }
  t('unknown tools value is refused', /unknown tools/.test(msg), true);
}

// ---------------------------------------------------------------- authority

const A = (role, room = 'room-1') => ({ role, room, name: role });

// who MAY delegate
t('planner -> worker (own room)', canTask(A('planner'), A('worker')), true);
t('planner -> reviewer (own room)', canTask(A('planner'), A('reviewer')), true);
t('planner -> builder (own room)', canTask(A('planner'), A('builder')), true);
t('supervisor -> worker (own room)', canTask(A('supervisor'), A('worker')), true);
t('manager -> supervisor', canTask(A('manager'), A('supervisor')), true);
t('boss -> anyone', canTask(A('boss'), A('manager')), true);

// who MAY NOT — this is the point of the class set
t('worker -> worker  REFUSED', canTask(A('worker'), A('worker')), false);
t('worker -> planner  REFUSED', canTask(A('worker'), A('planner')), false);
t('reviewer -> worker  REFUSED (a reviewer reports, it does not order)', canTask(A('reviewer'), A('worker')), false);
t('reviewer -> planner  REFUSED', canTask(A('reviewer'), A('planner')), false);
t('builder -> worker  REFUSED', canTask(A('builder'), A('worker')), false);
t('planner -> planner  REFUSED (no peer tasking)', canTask(A('planner'), A('planner')), false);
t('planner -> supervisor  REFUSED (no upward tasking)', canTask(A('planner'), A('supervisor')), false);
t('supervisor -> supervisor  REFUSED', canTask(A('supervisor'), A('supervisor')), false);

// room scoping: a planner plans the work in front of it
t('planner -> worker in ANOTHER room  REFUSED', canTask(A('planner', 'room-1'), A('worker', 'room-9')), false);
t('supervisor -> worker in ANOTHER room  REFUSED', canTask(A('supervisor', 'room-1'), A('worker', 'room-9')), false);
t('manager MAY cross rooms', canTask(A('manager', 'room-1'), A('worker', 'room-9')), true);

// an unknown role must not gain authority by accident
t('unknown role has no authority', canTask(A('wizard'), A('worker')), false);

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
