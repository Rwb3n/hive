// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

// Egress allowlist proxy — the last boundary.
//
// Containers give a room filesystem isolation (docs/SECURITY.md) but `hive-net` was a
// normal bridge, so a shell-enabled agent had full internet access. This closes that:
// agents sit on an `internal: true` network with no route out, and reach the world only
// through this proxy, which allows exactly the hosts on its allowlist.
//
// The allowlist was MEASURED, not guessed. A sniffing proxy logged every host a real task
// touched while fixing code:
//     api.anthropic.com:443                      <- required
//     http-intake.logs.us5.datadoghq.com:443     <- CLI telemetry, not required
// Claude Code honours HTTPS_PROXY/HTTP_PROXY, so no iptables or custom DNS is needed.
//
// This is a CONNECT proxy: it never sees inside TLS. It decides on hostname:port, then
// pipes bytes. That is the point — it is an allowlist, not an inspector.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.HIVE_PROXY_PORT || 3128);
const HOST = process.env.HIVE_PROXY_HOST || '0.0.0.0';
const HIVE_HOME = process.env.HIVE_HOME || path.join(process.env.HOME || '', 'hive');
const LOG_JSON = process.env.HIVE_PROXY_LOG || path.join(HIVE_HOME, 'logs', 'egress.jsonl');

// Hosts every agent may reach. Anything else is refused with 403 and logged.
// Keep this list minimal and justified — each entry is a way out of the room.
const DEFAULT_ALLOW = [
  'api.anthropic.com',        // the API. Without this an agent cannot think.
  'statsig.anthropic.com',    // feature flags; the CLI degrades gracefully without it
  'sentry.io',                // crash reporting; optional
  'o1158641.ingest.sentry.io',
];

// The hive's own services, always reachable. These are inside the internal network, so
// allowing them opens nothing outward — and it makes a missed NO_PROXY entry degrade to
// "works, routed through the proxy" instead of "telemetry silently refused and every
// budget cap reads $0.00". That failure happened twice while building this.
const INTERNAL_SERVICES = ['api', 'collector', 'hive-api', 'hive-collector', 'hive-proxy', 'localhost', '127.0.0.1'];

function loadAllow() {
  // <hive>/egress-allow.json overrides the defaults, so the allowlist is configuration
  // like everything else (see docs/CONFIG.md).
  const f = path.join(HIVE_HOME, 'egress-allow.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.allow)) return j.allow;
  } catch (e) {
    /* fall back to defaults */
  }
  return DEFAULT_ALLOW;
}

// Everything the proxy will pass: the configured allowlist plus the hive's own services.
function effectiveAllow() {
  return [...loadAllow(), ...INTERNAL_SERVICES];
}

// A pattern matches a host exactly, or as a leading-wildcard suffix ('*.example.com').
// Deliberately NOT a substring match: 'api.anthropic.com.evil.test' must not pass.
function allowed(host, patterns) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  for (const raw of patterns) {
    const p = String(raw).toLowerCase().replace(/\.$/, '');
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // '.example.com'
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

function logLine(rec) {
  try {
    fs.mkdirSync(path.dirname(LOG_JSON), { recursive: true });
    fs.appendFileSync(LOG_JSON, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch (e) {
    /* logging must never break the proxy */
  }
}

// Identify which agent a connection came from, so a refusal is attributable. Containers
// on the hive network are named hive-<agent>; the source IP maps via docker DNS, but the
// cheap reliable signal is the proxy-authorization header the runner sets per agent.
function agentOf(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (m) {
    try {
      return Buffer.from(m[1], 'base64').toString('utf8').split(':')[0] || null;
    } catch (e) {}
  }
  return req.headers['x-hive-agent'] || null;
}

const server = http.createServer((req, res) => {
  // Plain HTTP proxying. Agents use HTTPS, so this path is mostly a clear refusal.
  const allow = effectiveAllow();
  const host = String(req.headers.host || '').split(':')[0];
  const agent = agentOf(req);
  if (!allowed(host, allow)) {
    logLine({ evt: 'refused', proto: 'http', agent, host, url: req.url });
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end(`egress denied: ${host} is not on the hive allowlist\n`);
  }
  logLine({ evt: 'allowed', proto: 'http', agent, host });
  const proxied = http.request(
    { host, port: 80, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  proxied.on('error', () => { try { res.writeHead(502); res.end('upstream error\n'); } catch (e) {} });
  req.pipe(proxied);
});

// HTTPS goes through CONNECT. This is where the real decision happens.
server.on('connect', (req, clientSocket, head) => {
  const allow = effectiveAllow();
  const [rawHost, rawPort] = String(req.url || '').split(':');
  const host = (rawHost || '').toLowerCase();
  const port = Number(rawPort || 443);
  const agent = agentOf(req);

  if (!allowed(host, allow)) {
    logLine({ evt: 'refused', proto: 'connect', agent, host, port });
    try {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n' +
          `egress denied: ${host}:${port} is not on the hive allowlist\r\n`
      );
    } catch (e) {}
    return clientSocket.destroy();
  }

  // Only 443 (and 80 for the http path). An allowlisted host on a random port is a
  // tunnel waiting to happen.
  const isInternal = INTERNAL_SERVICES.includes(host);
  if (!isInternal && port !== 443 && port !== 80) {
    logLine({ evt: 'refused', proto: 'connect', agent, host, port, reason: 'port' });
    try { clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\nport not allowed\r\n'); } catch (e) {}
    return clientSocket.destroy();
  }

  logLine({ evt: 'allowed', proto: 'connect', agent, host, port });
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

if (require.main === module) {
  const allow = loadAllow();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`hive egress proxy on http://${HOST}:${PORT}\n`);
    process.stdout.write(`  allow: ${allow.join(', ')}\n`);
    process.stdout.write(`  log:   ${LOG_JSON}\n`);
  });
  const bye = () => { try { server.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { server, allowed, loadAllow, effectiveAllow, DEFAULT_ALLOW, INTERNAL_SERVICES };
