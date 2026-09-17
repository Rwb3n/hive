// Run every suite and report a single total. This is what the README badge claims.
//   node test/all.js
//
// Run it on BOTH platforms before trusting a change: two boundary bugs were only
// visible on one of them (case sensitivity on Linux, foreign absolute paths on Windows).
const { spawnSync } = require('child_process');
const path = require('path');

// Expected case counts. A suite that reports FEWER than this passed silently — which is
// how a security test disappears: the scope-guard suite skips its four symlink cases if
// the platform cannot create symlinks (Windows file symlinks need Developer Mode or
// admin), reports 25 passed, and exits 0. CI would go green with the symlink boundary
// untested. Asserting the count turns that into a loud failure.
const SUITES = [
  { name: 'scope-guard', expect: 29 },
  { name: 'budget', expect: 27 },
  { name: 'egress', expect: 25 },
  { name: 'yaml', expect: 10 },
];

let pass = 0;
let fail = 0;
let short = 0;
const failed = [];

for (const { name, expect } of SUITES) {
  const file = path.join(__dirname, `${name}.test.js`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? Number(m[1]) : 0;
  const f = m ? Number(m[2]) : 1;
  pass += p;
  fail += f;

  const skipped = out.match(/^SKIP\s+(.+)$/gm) || [];
  const isShort = p < expect;
  if (isShort) short++;
  const ok = r.status === 0 && f === 0 && !isShort;
  if (!ok) failed.push({ name, out });

  let note = '';
  if (isShort) note = `  <-- SHORT: expected ${expect}, cases were skipped`;
  else if (skipped.length) note = `  (${skipped.length} skipped, count still met)`;

  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${p} passed${f ? `, ${f} failed` : ''}${note}\n`
  );
  for (const s of skipped) process.stdout.write(`        ${s.trim()}\n`);
}

if (failed.length) {
  process.stdout.write('\n--- output from failing suites ---\n');
  for (const { name, out } of failed) {
    process.stdout.write(`\n### ${name}\n${out.split('\n').filter((l) => /FAIL|Error|failed/.test(l)).join('\n')}\n`);
  }
}

const expected = SUITES.reduce((n, s) => n + s.expect, 0);
process.stdout.write(
  `\n${pass} passed, ${fail} failed  (${SUITES.length} suites, ${process.platform}, node ${process.versions.node})\n`
);
if (short) {
  process.stdout.write(
    `\nFAILED: ${pass} of ${expected} expected cases ran. A suite skipped cases — a skipped\n` +
      `boundary test is an untested boundary, not a pass. See the SKIP lines above.\n`
  );
}
process.exit(fail || short ? 1 : 0);
