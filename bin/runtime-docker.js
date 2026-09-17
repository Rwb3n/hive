// Docker runtime adapter: a room becomes a container.
//
// Same interface as the tmux runtime (spawn / deliver / isReady / kill) so `runtime:` in
// agent.yaml selects between them without the runner caring which is in use.
//
// What changes vs tmux: the kernel enforces the boundary, so an agent in this runtime may
// be granted Bash. /room is the only writable host mount, the hooks are mounted read-only
// so an agent cannot disable its own guard, and cpu/memory are capped.
//
// What stays: the scope-guard hook still runs INSIDE the container. It is defence in depth
// now rather than the boundary itself — it turns a kernel EACCES into a useful message
// ("outside your room"), which the agent can act on.

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IMAGE = process.env.HIVE_AGENT_IMAGE || 'hive/agent:2.1.274';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

function containerName(agent) {
  return `hive-${agent}`;
}

function isRunning(agent) {
  const r = docker('inspect', '-f', '{{.State.Running}}', containerName(agent));
  return r.status === 0 && r.stdout.trim() === 'true';
}

function kill(agent) {
  docker('rm', '-f', containerName(agent));
}

// Start a long-lived container with tmux inside it, so the interactive TUI still has a
// PTY and `hive watch` can attach via `docker exec`. A one-shot `-p` task instead uses
// runTask() below and needs no tmux at all.
function spawn(cfg, opts = {}) {
  const name = containerName(cfg.name);
  kill(cfg.name);

  fs.mkdirSync(cfg.room_root, { recursive: true });
  fs.mkdirSync(cfg.log_dir, { recursive: true });

  // Settings must live where the container can see them: inside /room.
  const settingsSrc = path.join(cfg.agent_dir, '.claude', 'settings.json');
  const settingsDst = path.join(cfg.room_root, '.claude-settings.json');
  let settings = JSON.parse(fs.readFileSync(settingsSrc, 'utf8'));
  // Rewrite hook paths from host paths to the container's read-only mount.
  settings = JSON.parse(
    JSON.stringify(settings).replace(
      new RegExp(String(cfg.hive_bin || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      '/hive-bin'
    )
  );
  fs.writeFileSync(settingsDst, JSON.stringify(settings, null, 2) + '\n');

  const args = [
    'run', '-d', '--name', name,
    '--hostname', cfg.name,
    '-v', `${cfg.room_root}:/room`,
    '-v', `${cfg.log_dir}:/hive-logs`,
    '-v', `${cfg.hive_bin}:/hive-bin:ro`,          // read-only: cannot disable its own guard
    '-v', `${cfg.credentials}:/agent-home/.claude/.credentials.json:ro`,
    '-e', 'HIVE_ROOM_ROOT=/room',
    '-e', 'HIVE_LOG_DIR=/hive-logs',
    '-e', `HIVE_AGENT=${cfg.name}`,
    '-e', `HIVE_API=${opts.api || 'http://api:8787'}`,
    // telemetry: cost and tokens, tagged with this agent and room
    '-e', 'CLAUDE_CODE_ENABLE_TELEMETRY=1',
    '-e', 'OTEL_METRICS_EXPORTER=otlp',
    '-e', 'OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
    '-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${opts.otlp || 'http://collector:4318'}`,
    '-e', 'OTEL_METRIC_EXPORT_INTERVAL=10000',
    '-e', `OTEL_RESOURCE_ATTRIBUTES=hive.agent=${cfg.name},hive.room=${cfg.room},service.namespace=hive`,
    '--memory', cfg.memory || '2g',
    '--cpus', cfg.cpus || '2',
    '--pids-limit', '512',
    // Harden the container itself. A shell-enabled agent WILL find the writable paths
    // inside its own container (verified: it wrote to /tmp and reported doing so). That
    // is harmless — the container is disposable and the host is untouched — but a
    // read-only rootfs with small tmpfs mounts keeps the blast radius to /room and makes
    // the in-container scope-guard's promise closer to true.
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs', '/run:rw,noexec,nosuid,size=16m',
    '--tmpfs', `${cfg.agent_home || '/home/node'}:rw,nosuid,size=128m`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    ...(opts.network ? ['--network', opts.network] : ['--add-host', 'host.docker.internal:host-gateway']),
    IMAGE,
    'sleep', 'infinity',   // keep the container alive; tasks run via exec
  ];

  const r = docker(...args);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  return { ok: true, container: name };
}

// One task, one `claude -p` inside the running container. Returns the structured result —
// which is strictly better than scraping a pane: cost and usage come back authoritatively.
function runTask(cfg, prompt, opts = {}) {
  const name = containerName(cfg.name);
  const args = [
    'exec', '-i', name,
    'claude', '-p', prompt,
    '--settings', '/room/.claude-settings.json',
    '--strict-mcp-config',
    '--permission-mode', opts.permissionMode || 'acceptEdits',
    '--output-format', 'json',
  ];
  if (opts.sessionId) args.splice(4, 0, '--resume', opts.sessionId);
  try {
    const out = execFileSync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs || 900000,
    });
    const parsed = JSON.parse(out);
    const r = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    return {
      ok: !r.is_error,
      result: r.result,
      session_id: r.session_id,
      cost_usd: r.total_cost_usd,
      denials: r.permission_denials || [],
      num_turns: r.num_turns,
    };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).slice(0, 600) };
  }
}

// `hive watch` equivalent for this runtime.
function attachCommand(agent) {
  return `docker exec -it ${containerName(agent)} bash`;
}

function imageExists() {
  return docker('image', 'inspect', IMAGE).status === 0;
}

module.exports = { spawn, runTask, kill, isRunning, attachCommand, containerName, imageExists, IMAGE };
