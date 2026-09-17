// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

// Tests for the hive.yaml parser in bin/provision.js.
//
// This parser is security-relevant: it produces the egress allowlist and the budget caps.
// A silent mis-parse does not error, it just configures something different from what was
// written — e.g. a list item with an inline comment containing ': ' became a {key: value}
// map, which dropped 'api.anthropic.com' from the allowlist while looking configured.
// Run: node test/yaml.test.js
const { parseYaml } = require('../bin/provision.js');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// --- scalars and comments
{
  const y = parseYaml(
    [
      'a: plain',
      'b: 42',
      'c: 3.5',
      'd: true',
      'e: false',
      "f: ''            # empty string, then a comment",
      'g: "has # hash"  # trailing comment',
      "h: 'quoted'      # trailing",
      'i: with spaces   # trailing',
    ].join('\n')
  );
  t('scalar types and comment stripping', y, {
    a: 'plain', b: 42, c: 3.5, d: true, e: false,
    f: '', g: 'has # hash', h: 'quoted', i: 'with spaces',
  });
}

// --- LISTS: the case that broke the egress allowlist
{
  const y = parseYaml(
    [
      'allow:',
      '  - api.anthropic.com       # required: without this an agent cannot think',
      '  - statsig.anthropic.com',
      "  - '*.sentry.io'           # optional: crash reporting",
      '  - "*.example.com"         # quoted with: a colon in the comment',
    ].join('\n')
  );
  t('list items keep inline comments out of the value', y.allow, [
    'api.anthropic.com', 'statsig.anthropic.com', '*.sentry.io', '*.example.com',
  ]);
  t('every allowlist entry is a string, never a map', y.allow.every((x) => typeof x === 'string'), true);
}

// --- lists of maps must still work (rooms/agents depend on this)
{
  const y = parseYaml(
    [
      'rooms:',
      '  - name: room-3',
      '    runtime: tmux',
      '    agents:',
      '      - name: supervisor',
      '        role: supervisor',
      '      - name: worker-1',
      '        role: worker',
      '        tools: file-only    # inline comment',
    ].join('\n')
  );
  t('list of maps: room name', y.rooms[0].name, 'room-3');
  t('list of maps: nested agents', y.rooms[0].agents.map((a) => a.name), ['supervisor', 'worker-1']);
  t('list of maps: value with a comment', y.rooms[0].agents[1].tools, 'file-only');
}

// --- nested maps (budget per-agent overrides)
{
  const y = parseYaml(
    [
      'budget:',
      '  run_usd: 5.00',
      '  on_exceed: pause          # pause | stop | warn',
      '  agents:',
      '    supervisor:',
      '      agent_usd: 1.50',
      '    worker-1:',
      '      agent_usd: 2.00',
    ].join('\n')
  );
  t('nested map: scalars', [y.budget.run_usd, y.budget.on_exceed], [5, 'pause']);
  t('nested map: per-agent overrides', y.budget.agents, { supervisor: { agent_usd: 1.5 }, 'worker-1': { agent_usd: 2 } });
}

// --- whole-line comments and blank lines are ignored
{
  const y = parseYaml(['# a heading comment', '', 'a: 1', '   # indented comment', 'b: 2'].join('\n'));
  t('comment and blank lines ignored', y, { a: 1, b: 2 });
}

// --- inline flow lists
{
  const y = parseYaml(['a: [one, two, three]', 'b: []'].join('\n'));
  t('inline flow list', [y.a, y.b], [['one', 'two', 'three'], []]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
