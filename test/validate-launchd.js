// Explicit opt-in live launchd smoke test; creates and removes a temporary service.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { git, head } from '../src/git.js';
import { stateFor, atomicJSON, snapshot } from '../src/state.js';
import { Engine, IGNORE_TEXT, getStatus } from '../src/engine.js';
import { manageService } from '../src/service.js';
const exec = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('Live validation requires macOS');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultsync-launchd-'));
const vault = path.join(root, 'Vault with spaces'), remote = path.join(root, 'remote.git');
await fs.mkdir(vault); await fs.mkdir(remote);
await git(remote).text(['init', '--bare', '--initial-branch=main']);
const g = git(vault); await g.text(['init', '--initial-branch=main']); await g.text(['config', 'user.name', 'Launchd validation']); await g.text(['config', 'user.email', 'test@example.invalid']); await g.text(['remote', 'add', 'origin', remote]);
const s = await stateFor(vault); await atomicJSON(path.join(s.dir, 'config.json'), { vault: s.vault, repo: 'test/vault', device: 'launchd-test' });
await fs.writeFile(path.join(vault, '.gitignore'), IGNORE_TEXT); await fs.writeFile(path.join(vault, 'note.md'), 'base\n');
const e = new Engine(s, { g }); e.config = { device: 'launchd-test' }; await e.commit(await snapshot(s.vault)); await g.text(['push', 'origin', 'main']);
const writer = path.join(root, 'writer'); await g.text(['clone', '--', remote, writer]);
const writerGit = git(writer); await writerGit.text(['config', 'user.name', 'Remote validation']); await writerGit.text(['config', 'user.email', 'test@example.invalid']);
await fs.writeFile(path.join(writer, 'incoming.md'), 'startup remote bytes\n'); await writerGit.text(['add', '--all']); await writerGit.text(['commit', '-m', 'remote startup change']); await writerGit.text(['push', 'origin', 'main']);
const runtime = path.join(root, 'runtime');
await fs.mkdir(path.join(runtime, 'test'), { recursive: true });
for (const folder of ['src', 'node_modules']) await fs.cp(fileURLToPath(new URL(`../${folder}`, import.meta.url)), path.join(runtime, folder), { recursive: true });
await fs.copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), path.join(runtime, 'package.json'));
const command = path.join(runtime, 'test/launchd-worker.js');
await fs.copyFile(fileURLToPath(new URL('./launchd-worker.js', import.meta.url)), command);
let service, report;
try {
  service = await manageService(s.vault, 'install', { command });
  for (let n = 0; n < 20; n++) { if ((await getStatus(s.vault)).lastPush !== 'never') break; await delay(500); }
  assert.equal(await fs.readFile(path.join(vault, 'incoming.md'), 'utf8'), 'startup remote bytes\n');
  const first = await getStatus(s.vault); assert.equal(first.daemon, 'running'); assert.notEqual(first.lastPush, 'never');
  const { stdout } = await exec('launchctl', ['print', `gui/${process.getuid()}/${service.label}`]); assert(stdout.includes('state = running'));
  const old = await head(g); await fs.writeFile(path.join(vault, 'note.md'), 'live launchd edit\n');
  // Debounce is 30 seconds; allow Git integration/push to complete afterward.
  for (let n = 0; n < 90; n++) { await delay(500); if ((await getStatus(s.vault)).lastPush !== first.lastPush) break; }
  assert.notEqual(await head(g), old);
  assert.equal((await g.text(['rev-parse', 'HEAD'])).trim(), (await git(remote).text(['rev-parse', 'main'])).trim());
  const final = await getStatus(s.vault); assert.notEqual(final.lastPush, first.lastPush);
  report = { platform: process.platform, node: process.version, testedAt: new Date().toISOString(), checks: ['plutil lint', 'launchctl bootstrap/enable/kickstart/print', 'daemon running', 'startup isolated-worktree pull applies remote bytes', 'real 30-second watched edit committed and pushed to local bare remote', 'status success timestamps', 'launchctl bootout and service removal'], linuxRuntime: 'not performed', githubLive: 'not performed (local bare remote only)' };
} catch (error) {
  for (const file of ['service.stderr.log', 'service.stdout.log', 'status.json', 'log.jsonl']) console.error(file, await fs.readFile(path.join(s.dir, file), 'utf8').catch(() => 'missing'));
  if (service) console.error((await exec('launchctl', ['print', `gui/${process.getuid()}/${service.label}`]).catch(e => ({ stdout: e.message }))).stdout);
  throw error;
} finally {
  await manageService(s.vault, 'uninstall').catch(() => {});
  for (let n = 0; n < 20; n++) { if ((await getStatus(s.vault)).daemon === 'stopped') break; await delay(250); }
  assert.equal((await getStatus(s.vault)).daemon, 'stopped');
  if (service) await assert.rejects(fs.access(service.file), { code: 'ENOENT' });
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(s.dir, { recursive: true, force: true });
}
await fs.writeFile(fileURLToPath(new URL('../VALIDATION.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
