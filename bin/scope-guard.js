// Copyright 2026 Ruben <lab@mindunder.dev>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE at the repo
// root. Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. This project
// implements agent isolation boundaries and documents what each does NOT cover —
// read docs/SECURITY.md before relying on it.

// scope-guard prototype: deny any path outside HIVE_ROOM_ROOT. Fails CLOSED.
const path = require('path');
const fs = require('fs');

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

const ROOM = process.env.HIVE_ROOM_ROOT;
if (!ROOM) deny('scope-guard: HIVE_ROOM_ROOT unset — refusing all filesystem access.');

// Audit log lives OUTSIDE the room: the hook runs as the OS user, the agent's
// tools do not, so the agent must not be able to read or rewrite its own log.
const LOG_DIR = process.env.HIVE_LOG_DIR;

// Windows/macOS are case-insensitive; Linux is not. Case-folding on Linux would let
// /Room/x slip past a /room guard (realpath fails on the nonexistent cased path,
// the lexical fallback folds, and the compare wrongly matches).
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function logDenial(p, attempted, resolved) {
  const rec = {
    ts: new Date().toISOString(),
    agent: process.env.HIVE_AGENT || null,
    session_id: p.session_id,
    tool: p.tool_name,
    tool_use_id: p.tool_use_id,
    attempted,
    resolved,
    room: ROOM,
  };
  if (LOG_DIR) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, 'denied.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) {
      /* never let logging failure open the boundary */
    }
  }
  // Report to the API machine too, so `hive denials` sees boundary hits live.
  // Fire-and-forget with a hard cap: the guard must stay fast and must still DENY
  // even if the server is down, so we never await the response.
  if (process.env.HIVE_API) {
    try {
      const { spawn } = require('child_process');
      const args = ['-s', '-m', '2', '-X', 'POST', new URL('/denials', process.env.HIVE_API).href,
        '-H', 'content-type: application/json'];
      if (process.env.HIVE_TOKEN) args.push('-H', `x-hive-token: ${process.env.HIVE_TOKEN}`);
      args.push('-d', JSON.stringify(rec));
      spawn('curl', args, { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      /* ignore */
    }
  }
}

// Resolve a path the way the FILESYSTEM will, not the way string math does.
//
// `path.resolve` collapses '..' lexically BEFORE any symlink is followed, which is a real
// escape: if room/link -> /outside, then room/link/../x resolves lexically to room/x
// (in-room, allowed) but on disk means /outside/../x = /x. So walk the path one segment at
// a time, calling realpath as we go, and let each '..' apply to the REAL parent.
function resolveHonestly(p) {
  // NOTE: do NOT path.resolve() here. It collapses '..' lexically, which is the very
  // thing this function exists to prevent — it would hand the loop a path with the
  // traversal already (wrongly) applied.
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(/[\\/]+/).filter((s) => s && s !== '.');
  let cur = root;
  for (const seg of parts) {
    if (seg === '..') {
      // Ascend from the resolved location, so a symlinked dir cannot hide the real parent.
      try {
        cur = fs.realpathSync(cur);
      } catch (e) {
        /* not yet on disk: lexical parent is the best available */
      }
      cur = path.dirname(cur);
      continue;
    }
    cur = path.join(cur, seg);
    try {
      cur = fs.realpathSync(cur); // follows a link the moment we step onto it
    } catch (e) {
      /* tail does not exist yet (a file about to be created) — keep the lexical path */
    }
  }
  return cur;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    deny('scope-guard: unparseable hook payload — denying.');
  }

  // Relative paths must resolve against the AGENT's cwd (from the payload), not the hook
  // process's cwd — the hook may be spawned anywhere.
  const base = typeof p.cwd === 'string' && p.cwd ? p.cwd : ROOM;

  // A path that is absolute for the OTHER platform (e.g. "C:/Windows/..." or "\\\\server\\share"
  // seen on Linux) is NOT relative — treating it as relative would resolve it inside the room and
  // silently allow it. Refuse outright: nothing legitimate in a room uses foreign absolute paths.
  const foreignAbsolute = (s) => /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('//');
  // Compare only. Inputs here are ALREADY fully resolved by resolveHonestly, so this
  // must not call path.resolve again — that would re-collapse any '..' and undo the work.
  const norm = (s) => {
    const q = String(s).split(path.sep).join('/').replace(/\/+$/, '');
    return CASE_INSENSITIVE ? q.toLowerCase() : q;
  };

  // Resolve the room itself too: if ROOM is given via a symlink or 8.3 short path,
  // a realpath'd candidate would never match a lexical room prefix.
  let roomReal;
  try {
    roomReal = fs.realpathSync(ROOM);
  } catch (e) {
    deny(`scope-guard: room root does not exist or is unreadable (${ROOM}) — denying.`);
  }
  const room = norm(roomReal);
  const inRoom = (f) => {
    const n = norm(f);
    return n === room || n.startsWith(room + '/');
  };

  const ti = p.tool_input || {};
  // `path` covers Glob/Grep — a Grep outside the room returns matching LINES, so an
  // unmatched Grep leaks file contents (e.g. tokens) even though it never "writes".
  // `edits[].file_path` covers multi-file edit shapes.
  const candidates = [ti.file_path, ti.path, ti.notebook_path]
    .concat(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.file_path) : [])
    .filter((v) => typeof v === 'string' && v.length > 0);

  for (const c of candidates) {
    if (!path.isAbsolute(c) && foreignAbsolute(c)) {
      logDenial(p, c, c);
      deny(
        `scope-guard: ${p.tool_name} blocked. Path "${c}" is not a valid path on this platform. Use paths inside your room (${ROOM}).`
      );
    }
    // Join by string, not path.join: join would collapse '..' lexically before
    // resolveHonestly can apply it to the REAL (symlink-resolved) parent.
    const candidateAbs = path.isAbsolute(c)
      ? c
      : String(base).replace(/[\/]+$/, '') + path.sep + c;
    const real = resolveHonestly(candidateAbs);
    if (!inRoom(real)) {
      logDenial(p, c, real);
      deny(`scope-guard: ${p.tool_name} blocked. Path "${c}" is outside your room (${ROOM}). Stay within your room.`);
    }
  }
  process.exit(0);
});
