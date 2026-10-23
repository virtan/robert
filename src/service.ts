import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, REPO_ROOT } from './config.ts';
import { bold, fail, ok, say, warn } from './setup/ui.ts';

const LABEL = 'dev.robert.bot';
const UNIT = 'robert.service';
const entry = path.join(REPO_ROOT, 'bin', 'robert.ts');
const pathEnv = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

function sh(cmd: string, args: string[], quiet = false): boolean {
  try {
    execFileSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' });
    return true;
  } catch {
    return false;
  }
}

export function systemdUnit(system: boolean): string {
  const user = os.userInfo().username;
  return `[Unit]
Description=Robert, an AI assistant for Telegram groups
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${process.execPath} ${entry} start
Environment=ROBERT_HOME=${paths.home}
Environment=PATH=${pathEnv}
WorkingDirectory=${paths.home}
Restart=always
RestartSec=10
${system ? `User=${user}
Group=${os.userInfo().gid}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${paths.home}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
UMask=0077
` : ''}
[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`;
}

export function launchdPlist(): string {
  const log = path.join(paths.home, 'robert.log');
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(process.execPath)}</string>
    <string>${x(entry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROBERT_HOME</key><string>${x(paths.home)}</string>
    <key>PATH</key><string>${x(pathEnv)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${x(paths.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

export function installService(opts: { system?: boolean } = {}): boolean {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, launchdPlist());
    const domain = `gui/${process.getuid!()}`;
    sh('launchctl', ['bootout', `${domain}/${LABEL}`], true);
    if (!sh('launchctl', ['bootstrap', domain, file])) {
      fail(`launchctl couldn't load ${file}`);
      return false;
    }
    ok(`Installed launchd agent ${LABEL}; it starts when you log in and restarts if it stops`);
    say(`  Logs: ${bold(`tail -f ${path.join(paths.home, 'robert.log')}`)}`);
    say('  For a Mac without anyone logged in, enable automatic login or run it as a LaunchDaemon.');
    return true;
  }
  if (process.platform !== 'linux') {
    fail(`Service install isn't supported on ${process.platform}. Run \`robert start\` with your own supervisor.`);
    return false;
  }
  if (opts.system) {
    const unit = systemdUnit(true);
    if (process.getuid!() !== 0) {
      const file = path.join(paths.home, UNIT);
      fs.writeFileSync(file, unit);
      say(`Wrote ${file}. Install it as root:`);
      say(bold(`  sudo cp ${file} /etc/systemd/system/${UNIT} && sudo systemctl daemon-reload && sudo systemctl enable --now robert`));
      return true;
    }
    fs.writeFileSync(`/etc/systemd/system/${UNIT}`, unit);
    sh('systemctl', ['daemon-reload']);
    if (!sh('systemctl', ['enable', '--now', 'robert'])) return false;
    ok('Installed and started the system service robert');
    say(`  Logs: ${bold('journalctl -u robert -f')}`);
    return true;
  }
  const file = path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit(false));
  sh('systemctl', ['--user', 'daemon-reload']);
  if (!sh('systemctl', ['--user', 'enable', '--now', 'robert'])) {
    fail('systemctl --user failed. On servers without a user session, use `node bin/robert.ts service install --system`.');
    return false;
  }
  ok('Installed and started the user service robert');
  say(`  Logs: ${bold('journalctl --user -u robert -f')}`);
  let linger = '';
  try {
    linger = execFileSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'], { encoding: 'utf8' }).trim();
  } catch {}
  if (linger !== 'yes') {
    warn('So it keeps running after you log out and starts at boot, enable lingering once:');
    say(bold(`  sudo loginctl enable-linger ${os.userInfo().username}`));
  }
  return true;
}

export function uninstallService(): void {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    sh('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], true);
    fs.rmSync(file, { force: true });
    ok('Removed the launchd agent');
    return;
  }
  const userFile = path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);
  if (fs.existsSync(userFile)) {
    sh('systemctl', ['--user', 'disable', '--now', 'robert']);
    fs.rmSync(userFile, { force: true });
    sh('systemctl', ['--user', 'daemon-reload']);
    ok('Removed the user service');
  }
  if (fs.existsSync(`/etc/systemd/system/${UNIT}`)) {
    say(`A system service exists too; remove it with: ${bold('sudo systemctl disable --now robert && sudo rm /etc/systemd/system/robert.service')}`);
  }
}

export function restartService(): boolean {
  if (process.platform === 'darwin') return sh('launchctl', ['kickstart', '-k', `gui/${process.getuid!()}/${LABEL}`], true);
  if (process.platform === 'linux') return sh('systemctl', ['--user', 'restart', 'robert'], true);
  return false;
}
