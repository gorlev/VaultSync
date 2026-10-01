import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stateFor, readJSON } from './state.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// systemd quoted strings still process percent specifiers and backslash escapes.
const unitQuote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
export function renderService(s, platform = process.platform, node = process.execPath, command = cli) {
  const label = `dev.vaultsync.${s.id}`, args = [node, command, 'run', '--vault', s.vault];
  const servicePath = `${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  if (platform === 'darwin') return { label, name: `${label}.plist`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>StandardOutPath</key><string>${xml(path.join(s.dir, 'service.stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(s.dir, 'service.stderr.log'))}</string>\n</dict></plist>\n` };
  if (platform === 'linux') return { label, name: `vaultsync-${s.id}.service`, content: `[Unit]\nDescription=Git Obsidian vault sync\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(unitQuote).join(' ')}\nEnvironment=${unitQuote('PATH=' + servicePath)}\nRestart=always\nRestartSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  throw new Error('Services supported only on macOS and Linux');
}
export async function manageService(vault, action, { stateRoot, platform = process.platform, home = os.homedir(), execute = exec, node = process.execPath, command = cli } = {}) {
  const s = await stateFor(vault, stateRoot);
  if (!(await readJSON(path.join(s.dir, 'config.json')))) throw new Error('Run init before installing or uninstalling a service');
  const service = renderService(s, platform, node, command);
  const folder = platform === 'darwin' ? path.join(home, 'Library/LaunchAgents') : path.join(home, '.config/systemd/user');
  const file = path.join(folder, service.name);
  if (action === 'install') {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, service.content, { mode: 0o600 });
    if (platform === 'darwin') {
      await execute('plutil', ['-lint', file]);
      await execute('launchctl', ['bootout', `gui/${process.getuid()}/${service.label}`]).catch(() => {});
      await execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
      await execute('launchctl', ['enable', `gui/${process.getuid()}/${service.label}`]);
      await execute('launchctl', ['kickstart', `gui/${process.getuid()}/${service.label}`]);
    } else {
      await execute('systemctl', ['--user', 'daemon-reload']); await execute('systemctl', ['--user', 'enable', '--now', service.name]);
    }
  } else {
    if (platform === 'darwin') await execute('launchctl', ['bootout', `gui/${process.getuid()}/${service.label}`]).catch(() => {});
    else await execute('systemctl', ['--user', 'disable', '--now', service.name]);
    await fs.rm(file, { force: true });
    if (platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload']);
  }
  return { file, label: service.label, service: service.name };
}
