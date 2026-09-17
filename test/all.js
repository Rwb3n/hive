// Run every suite and report a single total. This is what the README badge claims.
//   node test/all.js
//
// Run it on BOTH platforms before trusting a change: two boundary bugs were only
// visible on one of them (case sensitivity on Linux, foreign absolute paths on Windows).
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = ['scope-guard', 'budget', 'egress', 'yaml'];

let pass = 0;
let fail = 0;
const failed = [];

for (const name of SUITES) {
  const file = path.join(__dirname, `${name}.test.js`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? Number(m[1]) : 0;
  const f = m ? Number(m[2]) : 1;
  pass += p;
  fail += f;
  const ok = r.status === 0 && f === 0;
  if (!ok) failed.push({ name, out });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${p} passed${f ? `, ${f} failed` : ''}\n`);
}

if (failed.length) {
  process.stdout.write('\n--- output from failing suites ---\n');
  for (const { name, out } of failed) {
    process.stdout.write(`\n### ${name}\n${out.split('\n').filter((l) => /FAIL|Error|failed/.test(l)).join('\n')}\n`);
  }
}

process.stdout.write(
  `\n${pass} passed, ${fail} failed  (${SUITES.length} suites, ${process.platform})\n`
);
process.exit(fail ? 1 : 0);
