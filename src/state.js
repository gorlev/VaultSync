import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function readJSON(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await fs.open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file); await syncDir(path.dirname(file));
}
export async function syncDir(dir) { const h = await fs.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } }
export async function stateFor(vault, root) {
  vault = await fs.realpath(vault);
  const base = root || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/vaultsync') : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'vaultsync'));
  let dir = path.resolve(base, hash(vault).slice(0, 20));
  if (dir === vault || dir.startsWith(vault + path.sep)) throw new Error('State directory must be outside vault');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }); dir = await fs.realpath(dir);
  if (dir === vault || dir.startsWith(vault + path.sep)) throw new Error('State directory resolves inside vault');
  await fs.chmod(dir, 0o700);
  return { vault, dir, id: hash(vault).slice(0, 20) };
}
export async function acquire(dir) {
  const file = path.join(dir, 'lock.json'), token = randomUUID();
  for (let n = 0; n < 3; n++) {
    try {
      const h = await fs.open(file, 'wx', 0o600);
      await h.writeFile(JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() })); await h.sync(); await h.close();
      return async () => { if ((await readJSON(file))?.token === token) await fs.unlink(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let lock; try { lock = await readJSON(file); } catch { throw new Error('Incomplete daemon lock; inspect before removal'); }
      if (!lock || alive(lock.pid)) throw new Error('A vaultsync operation/daemon is already running for this vault');
      // Exclusive stale-lock claim prevents two contenders unlinking a new lock.
      const claim = `${file}.stale`;
      let h; try { h = await fs.open(claim, 'wx', 0o600); } catch { throw new Error('Another process is reclaiming a stale lock'); }
      try { if ((await readJSON(file))?.token === lock.token) await fs.unlink(file); } finally { await h.close(); await fs.unlink(claim); }
    }
  }
  throw new Error('Unable to acquire daemon lock');
}
export function ignored(p) {
  const parts = p.split('/');
  return parts.some(x => x.startsWith('.vaultsync-txn-')) || parts.includes('.git') || parts.includes('.trash') || parts.some(x => x === '.env' || x.startsWith('.env.')) || (parts[0] === '.obsidian' && parts[1]?.startsWith('workspace'));
}
export function safePath(root, p) {
  if (!p || p.includes('\0') || path.isAbsolute(p) || p.split('/').some(x => x === '..' || x.toLowerCase() === '.git' || x === '')) throw new Error('Unsafe Git path');
  const full = path.resolve(root, p);
  if (!full.startsWith(root + path.sep)) throw new Error('Path outside vault');
  return full;
}
export async function entryAt(root, p) {
  const full = safePath(root, p);
  // Never traverse symlink parents, even if they point back into the vault.
  let parent = path.dirname(full);
  while (parent !== root) { try { if (!(await fs.lstat(parent)).isDirectory()) throw new Error('Unsupported non-directory parent'); } catch (e) { if (e.code !== 'ENOENT') throw e; } parent = path.dirname(parent); }
  try {
    const s = await fs.lstat(full);
    if (!s.isFile()) throw new Error('Unsupported file structure: symlink, directory or special file');
    const bytes = await fs.readFile(full);
    return { bytes, mode: (s.mode & 0o111) ? '100755' : '100644', hash: hash(bytes) };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function snapshot(root) {
  const out = new Map();
  async function walk(dir, prefix = '') {
    for (const e of await fs.readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
      const name = e.name.toString('utf8');
      if (!Buffer.from(name).equals(e.name)) throw new Error('Unsupported non-UTF-8 filename; vault unchanged');
      const p = prefix + name; if (ignored(p)) continue;
      if (e.isDirectory()) await walk(path.join(dir, name), p + '/');
      else { const entry = await entryAt(root, p); if (entry) out.set(p, entry); }
    }
  }
  await walk(root); return out;
}
export function same(a, b) { return (!a && !b) || !!(a && b && a.hash === b.hash && a.mode === b.mode); }
export function sameSnapshot(a, b) { return a.size === b.size && [...a].every(([p, e]) => same(e, b.get(p))); }
