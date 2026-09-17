// Tests for the DELEGATE line parser.
//
// This is the seam between a planner's prose and real tasks, and it failed in production:
// a planner wrote `DELEGATE: worker-2 — Write writes.md…`, the strict pattern matched
// nothing, both workers sat idle, and the task was recorded as done. The plan was right;
// the parser was too narrow. So accept what a model actually writes.
// Run: node test/delegation.test.js
const { parseDelegations } = require('../bin/room-runner.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}
const one = (to, brief) => [{ to, brief }];

// --- the documented form
t('DELEGATE name: brief', parseDelegations('DELEGATE worker-1: write reads.md'), one('worker-1', 'write reads.md'));

// --- the form that actually broke it
t('DELEGATE: name — brief  (colon + em dash)', parseDelegations('DELEGATE: worker-2 — Write writes.md'), one('worker-2', 'Write writes.md'));
t('DELEGATE: name - brief  (colon + hyphen)', parseDelegations('DELEGATE: worker-2 - Write writes.md'), one('worker-2', 'Write writes.md'));
t('DELEGATE: name – brief  (en dash)', parseDelegations('DELEGATE: worker-2 – Write writes.md'), one('worker-2', 'Write writes.md'));

// --- other shapes a model writes unprompted
t('markdown list item', parseDelegations('- DELEGATE worker-1: do the thing'), one('worker-1', 'do the thing'));
t('asterisk list item', parseDelegations('* DELEGATE worker-1: do the thing'), one('worker-1', 'do the thing'));
t('bold DELEGATE', parseDelegations('**DELEGATE** worker-1: do the thing'), one('worker-1', 'do the thing'));
t('backticked name', parseDelegations('DELEGATE `worker-1`: do the thing'), one('worker-1', 'do the thing'));
t('bold name', parseDelegations('DELEGATE **worker-1**: do the thing'), one('worker-1', 'do the thing'));
t('lowercase keyword', parseDelegations('delegate worker-1: do the thing'), one('worker-1', 'do the thing'));
t('leading whitespace', parseDelegations('    DELEGATE worker-1: do the thing'), one('worker-1', 'do the thing'));

// --- multiple, in order
t('two lines, both parsed', parseDelegations(['DELEGATE worker-1: A', 'DELEGATE worker-2: B'].join('\n')),
  [{ to: 'worker-1', brief: 'A' }, { to: 'worker-2', brief: 'B' }]);

// --- one task per recipient, so a restated plan does not queue duplicate work
t('duplicate recipient ignored', parseDelegations(['DELEGATE worker-1: first', 'DELEGATE worker-1: restated'].join('\n')),
  one('worker-1', 'first'));

// --- surrounded by prose, which is the normal case
t('extracted from a full reply', parseDelegations([
  'I split the work by endpoint group so neither worker duplicates the other.',
  '',
  'DELEGATE worker-1: Write reads.md covering the GET endpoints.',
  'DELEGATE worker-2: Write writes.md covering POST and DELETE.',
  '',
  'Both should use only the spec.',
].join('\n')), [
  { to: 'worker-1', brief: 'Write reads.md covering the GET endpoints.' },
  { to: 'worker-2', brief: 'Write writes.md covering POST and DELETE.' },
]);

// --- must NOT match
t('no delegate lines', parseDelegations('I considered delegating but did the work myself.'), []);
t('the word inside prose', parseDelegations('I will delegate worker tasks later.'), []);
t('empty brief is skipped', parseDelegations('DELEGATE worker-1:'), []);
t('empty input', parseDelegations(''), []);
t('null input', parseDelegations(null), []);
t('a heading mentioning it', parseDelegations('## How DELEGATE works'), []);

// --- a long real brief survives intact
{
  const brief = 'Write `writes.md` into your own workspace documenting exactly two endpoints from `./input/spec.md`: `POST /widgets` and `DELETE /widgets/:id`. Do NOT document the GET endpoints.';
  t('long brief preserved verbatim', parseDelegations(`DELEGATE: worker-2 — ${brief}`), one('worker-2', brief));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
