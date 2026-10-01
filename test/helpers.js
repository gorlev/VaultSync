import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { git } from '../src/git.js';
import { stateFor, atomicJSON, snapshot } from '../src/state.js';
import { Engine } from '../src/engine.js';
export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultsync-test-'));
  const remote = path.join(root, 'remote.git'); await fs.mkdir(remote);
  await git(remote).text(['init', '--bare', '--initial-branch=main']);
  const devices = [];
  const make = async name => {
    const vault = path.join(root, name); await fs.mkdir(vault);
    const g = git(vault); await g.text(['init', '--initial-branch=main']);
    await g.text(['config', 'user.name', 'Test Device']); await g.text(['config', 'user.email', 'test@example.invalid']);
    await g.text(['remote', 'add', 'origin', remote]);
    const s = await stateFor(vault, path.join(root, 'state'));
    await atomicJSON(path.join(s.dir, 'config.json'), { vault, repo: 'test/vault', device: name });
    const engine = new Engine(s, { g, allowLocal: true }); engine.config = { repo: 'test/vault', device: name };
    const device = { vault, g, s, engine }; devices.push(device); return device;
  };
  t.after(async () => { for (const d of devices) await d.engine.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const a = await make('A'); await fs.writeFile(path.join(a.vault, 'note.md'), 'base\n'); await a.engine.commit(await snapshot(a.vault)); await a.g.text(['push', 'origin', 'main']);
  const b = await make('B'); await b.g.text(['fetch', 'origin']); await b.g.text(['reset', '--hard', 'origin/main']); b.engine.expected = await snapshot(b.vault);
  return { root, remote, a, b, make };
}
export async function edit(device, p, bytes) { const file = path.join(device.vault, p); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
export async function commit(device) { return device.engine.commit(await snapshot(device.vault)); }
export async function sync(device) { await device.engine.pull(); await device.engine.pull(); await device.g.text(['push', 'origin', 'main']); }
