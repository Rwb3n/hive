// hive provision — build the building from hive.yaml.
//
// Creates each room + agent directory, generates .claude/settings.json from the role
// template, and pre-registers EVERY room in ~/.claude.json in a single pass (N claude
// processes plus this writer racing on that file will lose entries — see docs/CLI-NOTES.md).
//
// The room is the capability; the agent is a resident. Settings are GENERATED, never
// hand-edited inside a room, so an agent cannot widen its own scope by rewriting them.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Minimal YAML subset parser — enough for hive.yaml (maps, lists, scalars, 2-space
// indent). Avoids a dependency; hive.yaml is ours and stays simple.
function parseYaml(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const root = {};
  const stack = [{ indent: -1, node: root }];

  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (body.startsWith('- ')) {
      let item = body.slice(2).trim();
      if (!Array.isArray(parent._list)) parent._list = [];
      // Strip a trailing comment BEFORE deciding whether this item is a map. A comment
      // containing ': ' would otherwise turn a plain string into a key/value pair — which
      // silently dropped 'api.anthropic.com' from the egress allowlist, i.e. removed the
      // one host agents actually need while looking like it had been configured.
      const iq = item[0];
      if (iq === '"' || iq === "'") {
        // A quoted item is the whole value; anything past the closing quote is a comment.
        const end = item.indexOf(iq, 1);
        if (end !== -1) item = item.slice(0, end + 1);
      } else {
        const h = item.search(/\s+#/);
        if (h !== -1) item = item.slice(0, h).trim();
      }
      if (item.includes(': ')) {
        const obj = {};
        const [k, ...rest] = item.split(': ');
        obj[k.trim()] = coerce(rest.join(': ').trim());
        parent._list.push(obj);
        stack.push({ indent, node: obj });
      } else if (item.endsWith(':')) {
        const obj = {};
        parent._list.push(obj);
        stack.push({ indent, node: obj });
      } else {
        parent._list.push(coerce(item));
      }
      continue;
    }

    const ci = body.indexOf(':');
    if (ci === -1) continue;
    const key = body.slice(0, ci).trim();
    const val = body.slice(ci + 1).trim();
    if (val === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = coerce(val);
    }
  }
  return normalize(root);
}

function coerce(v) {
  // Strip a trailing comment. A value that STARTS quoted keeps everything up to its
  // closing quote (so a '#' inside a string survives); anything after that quote is a
  // comment. Note `''` is a complete empty string, not an unterminated quote — an
  // earlier version treated it as quoted-and-open and swallowed the trailing comment.
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) v = v.slice(0, end + 1);
  } else {
    const h = v.search(/\s+#/);
    if (h !== -1) v = v.slice(0, h).trim();
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => coerce(s.trim().replace(/^["']|["']$/g, '')));
  }
  return v.replace(/^["']|["']$/g, '');
}

// Collapse the `_list` markers the parser produces into real arrays.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === 'object') {
    if (Array.isArray(node._list)) {
      const list = node._list.map(normalize);
      const extra = { ...node };
      delete extra._list;
      return Object.keys(extra).length ? Object.assign(list, normalize(extra)) : list;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = normalize(v);
    return out;
  }
  return node;
}

// ---------------------------------------------------------------- provisioning

function provision(planPath, opts = {}) {
  const plan = parseYaml(fs.readFileSync(planPath, 'utf8'));
  const HIVE_HOME = opts.home || plan.home || path.join(os.homedir(), 'hive');
  const HIVE_BIN = path.join(HIVE_HOME, 'bin');
  const templates = path.join(HIVE_HOME, 'templates');
  const created = [];
  const roomPaths = [];

  const rooms = Array.isArray(plan.rooms) ? plan.rooms : [];
  if (!rooms.length) throw new Error('hive.yaml defines no rooms');

  for (const room of rooms) {
    const roomName = room.name;
    if (!roomName) throw new Error('a room is missing `name`');
    const roomDir = path.join(HIVE_HOME, 'rooms', roomName);
    const agents = Array.isArray(room.agents) ? room.agents : [];

    for (const rawAgent of agents) {
      // defaults -> room -> agent, most specific wins
      const agent = Object.assign({}, plan.defaults || {}, { runtime: room.runtime || (plan.defaults || {}).runtime }, rawAgent);
      const name = agent.name;
      const role = agent.role || 'worker';
      if (!name) throw new Error(`room ${roomName} has an agent with no name`);

      const agentDir = path.join(roomDir, name);
      // Each agent gets its own workspace inside the room: co-located (that is the point
      // of a shared room) but non-colliding, so two workers cannot clobber each other.
      const workspace = path.join(agentDir, 'workspace');
      const dirs = [
        workspace,
        path.join(agentDir, 'inbox'),
        path.join(agentDir, 'outbox'),
        path.join(agentDir, '.claude'),
        path.join(agentDir, 'state'),
        path.join(HIVE_HOME, 'logs', name), // logs live OUTSIDE the room
      ];
      for (const d of dirs) fs.mkdirSync(d, { recursive: true });

      // A shell is only safe where the kernel enforces the boundary. In the tmux runtime
      // `bash -c` walks straight out of the room (verified — docs/SECURITY.md), so refuse
      // the combination at provision time rather than generating a room that looks scoped
      // and is not.
      if (agent.tools === 'shell' && (agent.runtime || 'tmux') !== 'docker') {
        throw new Error(
          `${name}: tools: shell requires runtime: docker — a shell escapes the room in the ` +
            `tmux runtime. Set runtime: docker on the agent or its room, or use tools: file-only.`
        );
      }

      // --- settings.json, generated from the role template
      const tplName = (agent.tools === 'shell' ? 'agent-settings.shell.json' : 'agent-settings.file-only.json');
      const tplPath = path.join(templates, tplName);
      let settings = fs.readFileSync(tplPath, 'utf8').replace(/\{\{HIVE_BIN\}\}/g, HIVE_BIN);
      const parsed = JSON.parse(settings);
      delete parsed._comment;
      fs.writeFileSync(path.join(agentDir, '.claude', 'settings.json'), JSON.stringify(parsed, null, 2) + '\n');

      // --- agent.md: the role prompt the agent actually reads
      const mdPath = path.join(agentDir, 'agent.md');
      if (!fs.existsSync(mdPath) || opts.force) {
        fs.writeFileSync(mdPath, roleMarkdown({ name, role, room: roomName, agent, workspace }));
      }

      // --- agent.yaml: identity + runtime, the runner's source of truth
      fs.writeFileSync(
        path.join(agentDir, 'agent.yaml'),
        [
          `name: ${name}`,
          `role: ${role}`,
          `room: ${roomName}`,
          `runtime: ${agent.runtime || room.runtime || 'tmux'}`,
          `model: ${agent.model || ''}`,
          `room_root: ${workspace}`,
          `agent_dir: ${agentDir}`,
          `log_dir: ${path.join(HIVE_HOME, 'logs', name)}`,
          `tmux_session: hive-${name}`,
          `tools: ${agent.tools || 'file-only'}`,
          `memory: ${agent.memory || '2g'}`,
          `cpus: ${agent.cpus || 2}`,
          `task_timeout_s: ${agent.task_timeout_s || 900}`,
          '',
        ].join('\n')
      );

      // The trust key must be the agent's CWD — which is its workspace.
      roomPaths.push(workspace);
      created.push({
        name, room: roomName, role,
        room_root: workspace,
        agent_dir: agentDir,
        runtime: agent.runtime || room.runtime || 'tmux',
        tmux_session: `hive-${name}`,
        log_dir: path.join(HIVE_HOME, 'logs', name),
      });
    }
  }

  // --- shared area + api dir
  fs.mkdirSync(path.join(HIVE_HOME, 'shared', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(HIVE_HOME, 'api'), { recursive: true });

  // --- budget.json: the API reads this on every cost check, so caps in hive.yaml take
  // effect without touching code. `hive budget set` edits the same file.
  if (plan.budget) {
    const b = plan.budget;
    fs.writeFileSync(
      path.join(HIVE_HOME, 'budget.json'),
      JSON.stringify(
        {
          run_usd: Number(b.run_usd) || 0,
          agent_usd: Number(b.agent_usd) || 0,
          task_usd: Number(b.task_usd) || 0,
          warn_at: Number(b.warn_at) || 0.8,
          on_exceed: b.on_exceed || 'pause',
          agents: b.agents || {},
        },
        null,
        2
      ) + '\n'
    );
  }

  // --- egress-allow.json: the proxy reads this, so the allowlist is configuration.
  // Each entry is a way out of a room; keep it minimal and justified.
  if (plan.egress && plan.egress.allow) {
    fs.writeFileSync(
      path.join(HIVE_HOME, 'egress-allow.json'),
      JSON.stringify({ allow: plan.egress.allow }, null, 2) + '\n'
    );
  }

  // --- ONE pass over ~/.claude.json for every room (avoids the write race)
  preTrust(roomPaths);

  return { home: HIVE_HOME, agents: created };
}

// Suppress the first-run dialogs that would otherwise hang an unattended spawn:
// theme, login method, folder trust, fullscreen upsell. See docs/CLI-NOTES.md.
function preTrust(workspacePaths) {
  const f = path.join(os.homedir(), '.claude.json');
  let j = {};
  if (fs.existsSync(f)) {
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      const bak = f + '.bak-' + Date.now();
      fs.copyFileSync(f, bak);
      j = {};
    }
  }
  j.hasCompletedOnboarding = true;
  if (!j.theme) j.theme = 'dark';
  if (j.fullscreenUpsellSeenCount === undefined || j.fullscreenUpsellSeenCount < 3) {
    j.fullscreenUpsellSeenCount = 3;
  }
  if (j.autoUpdates === undefined) j.autoUpdates = false; // a new version can add a new dialog
  j.projects = j.projects || {};
  for (const w of workspacePaths) {
    j.projects[w] = Object.assign(
      { allowedTools: [], history: [] },
      j.projects[w],
      { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
    );
  }
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
}

function roleMarkdown({ name, role, room, agent, workspace }) {
  const common = `# ${name}

You are **${name}**, a ${role} in **${room}** of a hive.

## Your room

Your workspace is \`${workspace}\`. It is the only place you can read or write.
A scope guard enforces this: any path outside it is denied before the tool runs.
This is normal and expected — do not try to work around it. If a task seems to need
something outside your room, say so in your reply and stop.

## How work reaches you

A task arrives as a file in \`../inbox/<id>.json\`... but you cannot read outside your
workspace, so the runner copies it to \`./task.json\` in your workspace, along with any
input files it references under \`./input/\`.

When you are told a task is ready:
1. Read \`./task.json\`
2. Read anything under \`./input/\`
3. Do the work, writing your output into your workspace (use the filename the task asks for)
4. End your reply with a short summary of what you produced and where

Your final message is captured as the task result — make it a useful report, not just "done".
`;

  if (role === 'supervisor') {
    return (
      common +
      `
## Supervising

You may split work among your workers by describing the split in your reply using this
exact format, one per line:

    DELEGATE <worker-name>: <one-line instruction>

The runner parses those lines and creates the tasks for you. You cannot message workers
directly — there is no network or shell tool available to you, by design.

When workers finish, their outputs are copied into your \`./input/\` and you are asked to
integrate. Your job then is judgement, not concatenation: resolve contradictions, remove
duplication, fix ordering, and say what you changed and why.
`
    );
  }

  return (
    common +
    `
## Working

You do one task at a time. Work only inside your workspace. Prefer writing complete files
over fragments. If the task is ambiguous, make a reasonable choice, do the work, and state
the assumption you made in your reply.
`
  );
}

module.exports = { provision, parseYaml, preTrust };

if (require.main === module) {
  const planPath = process.argv[2] || path.join(process.cwd(), 'hive.yaml');
  const force = process.argv.includes('--force');
  const out = provision(planPath, { force });
  process.stdout.write(`provisioned ${out.agents.length} agents under ${out.home}\n`);
  for (const a of out.agents) {
    process.stdout.write(`  ${a.name.padEnd(12)} ${a.role.padEnd(11)} ${a.room_root}\n`);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
