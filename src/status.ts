/**
 * Finds out how Robert is running on this machine (systemd, launchd, Docker or started by hand),
 * and updates it: pull the code, install dependencies, restart the right way.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.ts';
import { restartService } from './service.ts';
import { bold, confirm, dim, fail, ok, say, warn } from './setup/ui.ts';

export type RunKind = 'systemd-user' | 'systemd-system' | 'launchd' | 'docker' | 'manual';

export interface Instance {
  kind: RunKind;
  /** Process id, when known (not for Docker). */
  pid?: number;
  /** The Robert checkout it runs from, when known. */
  dir?: string;
  /** Extra detail, e.g. the container name and status. */
  detail?: string;
}

const LAUNCHD_LABEL = 'dev.robert.bot';

/** Runs a command and returns its stdout, or null if it isn't installed or fails. */
function run(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd, timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** `ps -eo pid=,args=` lines that are a running `robert.ts start`. */
export function parsePs(out: string, selfPid = process.pid): { pid: number; args: string }[] {
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), args: m[2] }))
    .filter((p) => p.pid !== selfPid && /\brobert\.ts\s+start\b/.test(p.args) && !/\b(grep|ps)\b/.test(p.args.split(' ')[0]));
}

/** The pid in `launchctl print` output, if the agent is running. */
export function parseLaunchctl(out: string): number | undefined {
  const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
  return pid ? Number(pid) : undefined;
}

/** Directory a robert.ts command line runs from: its absolute path, or the process's working directory. */
function dirOf(pid: number, args: string): string | undefined {
  const script = args.split(/\s+/).find((a) => a.endsWith('robert.ts'));
  if (script && path.isAbsolute(script)) return path.resolve(path.dirname(script), '..');
  let cwd: string | undefined;
  if (process.platform === 'linux') {
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
  } else {
    cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])?.split('\n').find((l) => l.startsWith('n'))?.slice(1);
  }
  return cwd && script ? path.resolve(cwd, script, '..', '..') : cwd;
}

function inContainer(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/mnt`) !== fs.readlinkSync('/proc/self/ns/mnt');
  } catch {
    return false;
  }
}

export function detect(): Instance[] {
  const found: Instance[] = [];
  const procs = parsePs(run('ps', ['-eo', 'pid=,args=']) ?? '');
  const servicePids = new Set<number>();

  if (process.platform === 'linux') {
    for (const [kind, flag] of [['systemd-user', ['--user']], ['systemd-system', []]] as const) {
      if (run('systemctl', [...flag, 'is-active', 'robert']) !== 'active') continue;
      const pid = Number(run('systemctl', [...flag, 'show', 'robert', '-p', 'MainPID', '--value'])) || undefined;
      if (pid) servicePids.add(pid);
      const proc = procs.find((p) => p.pid === pid);
      found.push({ kind, pid, dir: proc ? dirOf(proc.pid, proc.args) : undefined });
    }
  }
  if (process.platform === 'darwin') {
    const out = run('launchctl', ['print', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
    const pid = out ? parseLaunchctl(out) : undefined;
    if (pid) {
      servicePids.add(pid);
      const proc = procs.find((p) => p.pid === pid);
      found.push({ kind: 'launchd', pid, dir: proc ? dirOf(proc.pid, proc.args) : undefined });
    }
  }

  const docker = run('docker', [
    'ps', '--filter', 'label=com.docker.compose.service=robert',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  for (const line of docker?.split('\n').filter(Boolean) ?? []) {
    const [name, status, dir] = line.split('\t');
    found.push({ kind: 'docker', dir: dir || undefined, detail: `container ${name}, ${status}` });
  }

  // Anything else is a process someone started by hand (npm start, tmux, nohup…). On Linux,
  // processes inside containers show up too; they live in another mount namespace.
  for (const p of procs) {
    if (servicePids.has(p.pid) || inContainer(p.pid)) continue;
    // npm runs node as a child; report the node process only.
    if (/^(npm|sh|bash)\b/.test(path.basename(p.args.split(' ')[0]))) continue;
    found.push({ kind: 'manual', pid: p.pid, dir: dirOf(p.pid, p.args) });
  }
  return found;
}

const LABEL: Record<RunKind, string> = {
  'systemd-user': 'systemd user service (robert)',
  'systemd-system': 'systemd system service (robert)',
  launchd: `launchd agent (${LAUNCHD_LABEL})`,
  docker: 'Docker Compose',
  manual: 'started by hand (npm start, tmux, nohup…)',
};

function version(dir = REPO_ROOT): string {
  const commit = run('git', ['log', '-1', '--format=%h %cs %s'], dir);
  return commit ?? 'unknown (not a git checkout)';
}

export function runStatus(): Instance[] {
  const list = detect();
  say(bold('Robert status'));
  say(`This checkout: ${REPO_ROOT}`);
  say(`Version here:  ${version()}`);
  if (!list.length) {
    warn('Robert is not running on this machine.');
    say(`  Start it with ${bold('npm start')}, or run it in the background with ${bold('node bin/robert.ts service install')}.`);
    return list;
  }
  for (const i of list) {
    ok(`Running as ${LABEL[i.kind]}${i.pid ? `, pid ${i.pid}` : ''}${i.detail ? `, ${i.detail}` : ''}`);
    if (i.dir) {
      say(`  from ${i.dir}${path.resolve(i.dir) === REPO_ROOT ? dim(' (this checkout)') : ''}`);
      if (path.resolve(i.dir) !== REPO_ROOT) say(`  version there: ${version(i.dir)}`);
    }
    say(`  restart: ${bold(restartHint(i))}`);
  }
  if (list.length > 1) {
    warn('More than one copy is running. With the same bot token they steal each other\'s updates; stop all but one.');
  }
  return list;
}

function restartHint(i: Instance): string {
  switch (i.kind) {
    case 'systemd-user':
    case 'launchd':
      return 'node bin/robert.ts service restart';
    case 'systemd-system':
      return 'sudo systemctl restart robert';
    case 'docker':
      return `docker compose up -d --build${i.dir ? ` (in ${i.dir})` : ''}`;
    case 'manual':
      return `stop it (kill ${i.pid}) and start it again the way you did before`;
  }
}

function sh(cmd: string, args: string[], cwd = REPO_ROOT): boolean {
  say(dim(`$ ${cmd} ${args.join(' ')}`));
  return spawnSync(cmd, args, { stdio: 'inherit', cwd }).status === 0;
}

/** Pulls the latest code, installs dependencies and restarts Robert the way it runs. */
export async function runUpdate(opts: { yes?: boolean } = {}): Promise<boolean> {
  const before = runStatus();
  say('');
  const elsewhere = before.filter((i) => i.dir && path.resolve(i.dir) !== REPO_ROOT);
  if (elsewhere.length) {
    fail(`Robert runs from ${elsewhere[0].dir}, not from this checkout. Run the update there.`);
    return false;
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
    fail('This checkout has local changes to tracked files. Commit or stash them, then update again.');
    return false;
  }
  if (!opts.yes && !(await confirm('Pull the latest version and restart?'))) return false;

  const old = run('git', ['rev-parse', 'HEAD']);
  if (!sh('git', ['pull', '--ff-only'])) {
    fail('git pull failed; nothing was changed.');
    return false;
  }
  const now = run('git', ['rev-parse', 'HEAD']);
  if (old === now) ok('Already up to date.');
  else ok(`Updated to ${version()}`);

  const dockerOnly = before.length > 0 && before.every((i) => i.kind === 'docker');
  if (!dockerOnly && !sh('npm', ['ci', '--no-audit', '--no-fund'])) {
    fail('npm ci failed. Fix the error above, then run: npm ci && npm run update');
    return false;
  }
  if (old === now && before.length) {
    say('No new code, so no restart needed.');
    return true;
  }

  let okAll = true;
  for (const i of before) {
    switch (i.kind) {
      case 'systemd-user':
      case 'launchd':
        if (restartService()) {
          ok('Restarted the service.');
        } else {
          fail('Restart failed; try: node bin/robert.ts service restart');
          okAll = false;
        }
        break;
      case 'systemd-system':
        say('The system service needs root to restart:');
        okAll = sh('sudo', ['systemctl', 'restart', 'robert']) && okAll;
        break;
      case 'docker':
        okAll = sh('docker', ['compose', 'up', '-d', '--build'], i.dir ?? REPO_ROOT) && okAll;
        break;
      case 'manual':
        warn(`Robert was started by hand (pid ${i.pid}), so it can't be restarted from here.`);
        say(`  Stop it (Ctrl+C where it runs, or ${bold(`kill ${i.pid}`)}) and start it again with ${bold('npm start')}.`);
        say(`  To have it restart itself from now on: ${bold('node bin/robert.ts service install')}`);
        okAll = false;
        break;
    }
  }
  if (!before.length) say(`Robert isn't running. Start it with ${bold('npm start')} or ${bold('node bin/robert.ts service install')}.`);
  return okAll;
}
