// Unit tests for the egress allowlist matcher.
// This function is the whole boundary for network access — a substring bug here means
// 'api.anthropic.com.evil.test' gets out. Run: node test/egress.test.js
const { allowed } = require('../api/egress-proxy.js');

const ALLOW = ['api.anthropic.com', '*.sentry.io'];

let pass = 0, fail = 0;
function t(name, host, want, list = ALLOW) {
  const got = allowed(host, list);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${host.padEnd(38)} ${ok ? '' : `got=${got} want=${want}`}`);
}

// --- exact matches
t('exact allowlisted host', 'api.anthropic.com', true);
t('case is ignored', 'API.Anthropic.COM', true);
t('trailing dot (FQDN form)', 'api.anthropic.com.', true);

// --- the attacks a substring match would let through
t('suffix-appended lookalike', 'api.anthropic.com.evil.test', false);
t('prefix-prepended lookalike', 'evil-api.anthropic.com', false);
t('embedded in a longer name', 'notapi.anthropic.com', false);
t('allowlisted name as a subdomain', 'api.anthropic.com.attacker.io', false);
t('hyphen trick', 'api-anthropic.com', false);
t('different TLD', 'api.anthropic.co', false);
t('bare parent domain', 'anthropic.com', false);
t('unrelated host', 'example.com', false);
t('exfil target', 'pastebin.com', false);
t('cloud metadata endpoint', '169.254.169.254', false);
t('localhost is not special-cased', 'localhost', false);

// --- wildcard behaviour
t('wildcard matches a subdomain', 'o123.ingest.sentry.io', true);
t('wildcard matches one level', 'x.sentry.io', true);
t('wildcard does NOT match the bare domain', 'sentry.io', false);
t('wildcard does not match a lookalike', 'sentry.io.evil.test', false);
t('wildcard does not match a prefixed name', 'evilsentry.io', false);

// --- degenerate input must never pass
t('empty host', '', false);
t('null host', String(null), false);
t('whitespace', '   ', false);
t('empty allowlist refuses everything', 'api.anthropic.com', false, []);

// --- a wildcard-everything list is honoured (opt-in, for measuring a workload)
t('explicit *.com wildcard works', 'foo.com', true, ['*.com']);
t('*.com does not match bare com', 'com', false, ['*.com']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
