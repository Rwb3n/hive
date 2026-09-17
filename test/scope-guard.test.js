// Unit tests for bin/scope-guard.js — the room boundary.
// Run: node test/scope-guard.test.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = path.join(__dirname, '..', 'bin', 'scope-guard.js');

// A throwaway building: <tmp>/hive-test/{room,room-evil,outside.txt}
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-test-'));
const ROOM = path.join(BASE, 'room');
fs.mkdirSync(ROOM, { recursive: true });
fs.mkdirSync(path.join(BASE, 'room-evil'), { recursive: true });

function run(payload, env) {
  try {
    return execFileSync('node', [GUARD], {
      input: JSON.stringify(payload),
      env: { ...process.env, HIVE_ROOM_ROOT: ROOM, ...env },
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    return 'CRASHED: ' + String(e.stderr || e.message).slice(0, 200);
  }
}

const W = (p) => ({ tool_name: 'Write', tool_input: { file_path: p } });
const R = (p) => ({ tool_name: 'Read', tool_input: { file_path: p } });

const cases = [
  // --- allowed: inside the room ---
  ['inside room', W(path.join(ROOM, 'ok.txt')), {}, 'allow'],
  ['nested inside room', W(path.join(ROOM, 'a', 'b', 'c.txt')), {}, 'allow'],
  ['room root itself', R(ROOM), {}, 'allow'],
  ['no path args (e.g. Glob)', { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }, {}, 'allow'],

  // --- denied: outside the room ---
  ['parent dir', W(path.join(BASE, 'escaped.txt')), {}, 'deny'],
  ['traversal ..', W(path.join(ROOM, '..', 'sneaky.txt')), {}, 'deny'],
  ['deep traversal', W(path.join(ROOM, '..', '..', '..', 'x.txt')), {}, 'deny'],
  ['absolute elsewhere (win-style)', W('C:/Windows/System32/drivers/etc/hosts'), {}, 'deny'],
  ['absolute elsewhere (posix-style)', W('/etc/passwd'), {}, 'deny'],
  ['UNC path', W('\\\\server\\share\\x.txt'), {}, 'deny'],
  ['user credentials', R(path.join(os.homedir(), '.claude', '.credentials.json')), {}, 'deny'],
  ['sibling room', W(path.join(BASE, 'room2', 'x.txt')), {}, 'deny'],
  ['prefix confusion room-evil', W(path.join(BASE, 'room-evil', 'x.txt')), {}, 'deny'],
  ['alt field: path', { tool_name: 'Read', tool_input: { path: path.join(BASE, 'outside.txt') } }, {}, 'deny'],
  ['alt field: notebook_path', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(BASE, 'x.ipynb') } }, {}, 'deny'],

  // Grep/Glob read file CONTENTS via `path` — an unguarded Grep leaks tokens without writing.
  ['Grep outside room (token hunt)', { tool_name: 'Grep', tool_input: { pattern: 'sk-ant', path: os.homedir() } }, {}, 'deny'],
  ['Grep inside room', { tool_name: 'Grep', tool_input: { pattern: 'TODO', path: ROOM } }, {}, 'allow'],
  ['Glob outside room', { tool_name: 'Glob', tool_input: { pattern: '**/*.json', path: os.homedir() } }, {}, 'deny'],

  // Multi-edit shapes carry paths in an array.
  ['edits[] outside room', { tool_name: 'Edit', tool_input: { edits: [{ file_path: path.join(ROOM, 'ok.txt') }, { file_path: path.join(BASE, 'bad.txt') }] } }, {}, 'deny'],

  // Relative paths must resolve against the payload's cwd, not the hook's cwd.
  ['relative path escaping via cwd', { tool_name: 'Write', tool_input: { file_path: '../escaped.txt' }, cwd: ROOM }, {}, 'deny'],
  ['relative path inside room', { tool_name: 'Write', tool_input: { file_path: 'notes/a.txt' }, cwd: ROOM }, {}, 'allow'],

  // --- fail closed ---
  ['missing HIVE_ROOM_ROOT', W(path.join(ROOM, 'ok.txt')), { HIVE_ROOM_ROOT: '' }, 'deny'],
  ['nonexistent room root', W(path.join(ROOM, 'ok.txt')), { HIVE_ROOM_ROOT: path.join(BASE, 'no-such-room') }, 'deny'],
];

// Case sensitivity: on Linux, /Room is a DIFFERENT directory from /room and must be
// denied; on Windows/macOS it is the same directory and must be allowed.
// (Regression test for a case-folding escape on case-sensitive filesystems.)
{
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const upper = path.join(path.dirname(ROOM), path.basename(ROOM).toUpperCase(), 'x.txt');
  cases.push([
    `cased sibling (${process.platform})`,
    W(upper),
    {},
    caseInsensitive ? 'allow' : 'deny',
  ]);
}

let pass = 0;
let fail = 0;
for (const [name, payload, env, expected] of cases) {
  const out = run(payload, env);
  const got = out === '' ? 'allow' : out.includes('"deny"') ? 'deny' : 'other:' + out.slice(0, 80);
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} expected=${expected} got=${got}`);
}

// Malformed stdin must also deny.
{
  let out;
  try {
    out = execFileSync('node', [GUARD], {
      input: 'not json at all',
      env: { ...process.env, HIVE_ROOM_ROOT: ROOM },
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    out = 'CRASHED';
  }
  const ok = out.includes('"deny"');
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'unparseable payload'.padEnd(28)} expected=deny got=${ok ? 'deny' : out.slice(0, 60)}`);
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
