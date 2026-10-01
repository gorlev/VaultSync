import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import chokidar from 'chokidar';
import { git, head, tree, blob, githubRemote } from './git.js';
import { stateFor, acquire, readJSON, atomicJSON, ignored, safePath, entryAt, snapshot, same, sameSnapshot, hash, syncDir, alive } from './state.js';
import { loadToken } from './credential.js';

export const IGNORE_TEXT = '\n# vaultsync private/local files\n.obsidian/workspace*\n.trash/\n.env\n.env.*\n**/.env\n**/.env.*\n.vaultsync-txn-*\n**/.vaultsync-txn-*\n';
export const dateLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function conflictName(p, occupied, d = new Date()) {
  const ext = path.posix.extname(p), stem = p.slice(0, p.length - ext.length), base = `${stem}.conflict-${dateLocal(d)}`;
  let name = `${base}${ext}`, i = 2; while (occupied.has(name)) name = `${base}-${i++}${ext}`;
  occupied.add(name); return name;
}
async function ensureIgnore(vault) {
  const file = path.join(vault, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  if (!current.includes(IGNORE_TEXT)) await fs.appendFile(file, IGNORE_TEXT);
}
export async function assertReady(vault, g) {
  if ((await g.text(['rev-parse', '--show-toplevel'])).trim() !== vault) throw new Error('Vault must be the Git repository root');
  const branch = (await g.text(['symbolic-ref', '--short', 'HEAD'])).trim();
  if (branch !== 'main') throw new Error('Expected checked-out main branch (detached HEAD is unsupported)');
  for (const name of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock']) {
    const p = (await g.text(['rev-parse', '--git-path', name])).trim();
    try { await fs.access(path.resolve(vault, p)); throw new Error(`Manual Git operation active: ${name}; finish it before vaultsync`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if ((await g.bytes(['ls-files', '-u', '-z'])).length) throw new Error('Unresolved manual Git conflicts; finish them before vaultsync');
}
export async function verifyRemote(g, repo, allowLocal = false) {
  const urls = (await g.text(['config', '--get-all', 'remote.origin.url'])).trim().split('\n');
  let pushes = ''; try { pushes = await g.text(['config', '--get-all', 'remote.origin.pushurl']); } catch {}
  if (pushes.trim() || urls.length !== 1 || (!allowLocal && githubRemote(urls[0]) !== repo.toLowerCase())) throw new Error('origin does not match the configured GitHub repository or has a push override');
  if (!allowLocal && !githubRemote(urls[0])) throw new Error('Unsupported origin URL; credentials must not be in URLs');
  // Git URL rewrites can silently send notes or a token elsewhere.
  let rewrites = ''; try { rewrites = await g.text(['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$']); } catch {}
  if (rewrites.trim()) throw new Error('Git URL rewrites are unsupported; use a direct origin URL');
}
export async function initVault({ vault, repo, envFile, stateRoot, verifyPrivate }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('--repo must be OWNER/REPO');
  const s = await stateFor(vault, stateRoot), release = await acquire(s.dir);
  try {
    if (envFile) {
      envFile = await fs.realpath(envFile);
      if (envFile === s.vault || envFile.startsWith(s.vault + path.sep)) throw new Error('Credential file must be outside the vault');
      await loadToken(envFile);
    }
    // Verification happens before any repository mutation.
    if (!verifyPrivate || !(await verifyPrivate(repo, envFile))) throw new Error('GitHub repository must exist and be private');
    const g = git(s.vault, envFile);
    let root = ''; try { root = (await g.text(['rev-parse', '--show-toplevel'])).trim(); } catch {}
    if (root && root !== s.vault) throw new Error('Vault is inside another repository; refusing to connect it');
    if (!root) await g.text(['init', '--initial-branch=main']);
    let origin = ''; try { origin = await g.text(['config', '--get', 'remote.origin.url']); } catch {}
    if (!origin) await g.text(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
    await verifyRemote(g, repo);
    await assertReady(s.vault, g);
    await ensureIgnore(s.vault);
    await atomicJSON(path.join(s.dir, 'config.json'), { vault: s.vault, repo, envFile: envFile || null, device: os.hostname(), version: 1 });
    // Commit locally, including removal of newly ignored tracked files. No initial
    // push: an existing remote must first be integrated by run.
    const engine = new Engine(s, { g }); await engine.commit(await snapshot(s.vault));
    return s;
  } finally { await release(); }
}
export class Engine {
  constructor(s, options = {}) {
    this.s = s; this.options = options; this.g = options.g || git(s.vault, options.envFile);
    this.debounce = options.debounceMs ?? 30000; this.interval = options.pullMs ?? 300000;
    this.clock = options.clock || Date.now; this.dirtyAt = null; this.nextNetwork = 0;
    this.queue = Promise.resolve(); this.expected = new Map(); this.closed = false;
  }
  async log(event, paths = []) { await fs.appendFile(path.join(this.s.dir, 'log.jsonl'), JSON.stringify({ time: new Date(this.clock()).toISOString(), event, paths }) + '\n', { mode: 0o600 }); }
  async save(patch) { this.status = { ...(this.status || {}), ...patch }; await atomicJSON(path.join(this.s.dir, 'status.json'), this.status); }
  async start() {
    this.release = await acquire(this.s.dir);
    try {
      this.status = await readJSON(path.join(this.s.dir, 'status.json'), {});
      this.config = await readJSON(path.join(this.s.dir, 'config.json'));
      if (!this.config) throw new Error('Run vaultsync init first');
      if (!this.options.g) this.g = git(this.s.vault, this.config.envFile);
      await assertReady(this.s.vault, this.g); await verifyRemote(this.g, this.config.repo, this.options.allowLocal);
      await this.recover(); await ensureIgnore(this.s.vault);
      this.expected = await this.headSnapshot();
      this.watcher = chokidar.watch(this.s.vault, { ignoreInitial: true, atomic: true, followSymlinks: false, ignored: full => { const p = path.relative(this.s.vault, full).split(path.sep).join('/'); return p && ignored(p); }, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
      this.watcher.on('all', (event, full) => {
        if (!['add', 'change', 'unlink'].includes(event)) return;
        const p = path.relative(this.s.vault, full).split(path.sep).join('/');
        this.serial(async () => {
          if (!same(await entryAt(this.s.vault, p), this.expected.get(p))) this.dirtyAt = this.clock();
        });
      });
      this.watcher.on('error', () => this.serial(() => this.save({ latestError: 'Filesystem watcher failed; restart daemon' })));
      await new Promise(resolve => this.watcher.once('ready', resolve));
      if (!sameSnapshot(await snapshot(this.s.vault), this.expected)) this.dirtyAt = this.clock();
      await this.save({ daemon: 'running', pid: process.pid });
      await this.tick();
      this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
      return this;
    } catch (e) { await this.save({ latestError: e.message }); await this.stop(); throw e; }
  }
  serial(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(async e => { await this.save({ latestError: e.message }); await this.log(e.message); });
    return this.queue;
  }
  tick() { return this.serial(() => this.cycle()); }
  async headSnapshot() {
    const result = new Map();
    for (const [p, entry] of await tree(this.g, await head(this.g))) {
      if (ignored(p)) continue;
      if (entry.mode === '120000') throw new Error('Symlinks are unsupported; live vault was not changed');
      const bytes = await blob(this.g, entry); result.set(p, { bytes, mode: entry.mode, hash: hash(bytes) });
    }
    return result;
  }
  async commit(captured) {
    await assertReady(this.s.vault, this.g);
    const old = await head(this.g), index = path.join(this.s.dir, `index-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
    try {
      await this.g.bytes(['read-tree', '--empty'], null, env);
      const rows = [];
      for (const [p, e] of captured) {
        if (!e || ignored(p)) continue;
        const oid = (await this.g.bytes(['hash-object', '-w', '--stdin'], e.bytes)).toString().trim();
        rows.push(Buffer.from(`${e.mode} ${oid}\t${p}\0`));
      }
      await this.g.bytes(['update-index', '-z', '--index-info'], Buffer.concat(rows), env);
      const treeId = (await this.g.bytes(['write-tree'], null, env)).toString().trim();
      if (old && treeId === (await this.g.text(['rev-parse', `${old}^{tree}`])).trim()) return old;
      const msg = `vaultsync: ${this.config?.device || os.hostname()} ${new Date(this.clock()).toISOString()}\n`;
      const newHead = (await this.g.bytes(['commit-tree', treeId, ...(old ? ['-p', old] : [])], Buffer.from(msg))).toString().trim();
      await this.g.text(['update-ref', 'refs/heads/main', newHead, old || '0'.repeat(40)]);
      await this.g.text(['read-tree', newHead]); // index only; never checkout the live vault
      this.expected = captured;
      await this.log('local commit'); return newHead;
    } finally { await fs.rm(index, { force: true }); }
  }
  async cycle() {
    if (this.closed) return;
    if (this.dirtyAt === null && this.clock() < this.nextNetwork) return;
    if (this.dirtyAt !== null && this.clock() - this.dirtyAt < this.debounce) return;
    await assertReady(this.s.vault, this.g); await verifyRemote(this.g, this.config.repo, this.options.allowLocal);
    const live = await snapshot(this.s.vault);
    if (!sameSnapshot(live, this.expected)) {
      if (this.dirtyAt === null) this.dirtyAt = this.clock();
      if (this.clock() - this.dirtyAt < this.debounce) return;
      await this.commit(live); this.dirtyAt = null; this.nextNetwork = 0;
    } else this.dirtyAt = null;
    if (this.clock() < this.nextNetwork) return;
    this.nextNetwork = this.clock() + this.interval;
    await this.pull();
    // The second fetch/rebase reduces the window for simultaneous-device pushes.
    // A later race is a normal rejected push, retried at next scheduled cycle.
    await this.pull();
    await this.options.beforePush?.();
    await this.g.text(['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await this.save({ lastPush: new Date(this.clock()).toISOString(), latestError: null });
    await this.log('push succeeded');
  }
  async pull() {
    const captured = await snapshot(this.s.vault);
    if (!sameSnapshot(captured, this.expected)) { this.dirtyAt = this.clock(); throw new Error('New edits detected; integration deferred until debounce'); }
    await this.g.text(['fetch', '--no-tags', 'origin']);
    let remote; try { remote = (await this.g.text(['rev-parse', '--verify', 'refs/remotes/origin/main'])).trim(); } catch {
      // Empty repository is valid; distinguish it from a different default branch.
      if ((await this.g.text(['ls-remote', '--heads', 'origin'])).trim()) throw new Error('Remote has no main branch');
      await this.save({ lastPull: new Date(this.clock()).toISOString() }); await this.log('pull succeeded (empty remote)'); return;
    }
    const local = await head(this.g);
    if (!local) throw new Error('Missing local commit');
    if (remote === local) { await this.save({ lastPull: new Date(this.clock()).toISOString() }); return; }
    let alreadyIntegrated = false;
    try { await this.g.text(['merge-base', '--is-ancestor', remote, local]); alreadyIntegrated = true; } catch {}
    if (alreadyIntegrated) { await this.save({ lastPull: new Date(this.clock()).toISOString() }); return; }
    const recovery = `refs/vaultsync/recovery/${Date.now()}-${randomUUID()}`;
    await this.g.text(['update-ref', recovery, local]);
    const wt = path.join(this.s.dir, `worktree-${randomUUID()}`), integrationRepo = `${wt}.git`;
    // Separate common Git directory: info/attributes must not affect Obsidian's
    // live repository. Shared objects are read-only; new commits are imported
    // before this isolated repository is removed.
    await this.g.text(['clone', '--bare', '--shared', '--no-hardlinks', '--', this.s.vault, integrationRepo]);
    const rg = git(integrationRepo, this.config.envFile);
    await fs.writeFile(path.join(integrationRepo, 'info/attributes'), '* -text -filter -working-tree-encoding -ident !merge !diff\n');
    for (const field of ['user.name', 'user.email']) await rg.text(['config', field, (await this.g.text(['config', '--get', field])).trim()]);
    await rg.text(['worktree', 'add', '--detach', wt, local]);
    const wg = git(wt, this.config.envFile);
    try {
      await this.options.beforeRebase?.();
      let base; try { base = (await wg.text(['merge-base', local, remote])).trim(); } catch { throw new Error('Unrelated histories; clone remote into a second folder and reconcile manually'); }
      const localTree = await tree(wg, local), remoteTree = await tree(wg, remote);
      const renameLinks = await this.renameLinks(wg, base, [local, remote]);
      const occupied = new Set([...localTree.keys(), ...remoteTree.keys(), ...captured.keys()]), copies = new Map();
      try { await wg.text(['rebase', '--no-rebase-merges', remote]); } catch {
        for (let count = 0; ; count++) {
          if (count > 1000) throw new Error('Too many rebase conflict steps; live vault unchanged');
          const raw = await wg.bytes(['ls-files', '-u', '-z']);
          if (!raw.length) throw new Error('Rebase stopped without supported file conflicts; live vault unchanged');
          const entries = raw.toString('utf8').split('\0').filter(Boolean).map(r => { const t = r.indexOf('\t'); return { p: r.slice(t + 1), mode: r.slice(0, t).split(' ')[0] }; });
          if (entries.some(e => !['100644', '100755'].includes(e.mode))) throw new Error('Unsupported symlink/submodule conflict; live vault unchanged');
          const paths = new Set(entries.map(e => e.p));
          let more = true; while (more) { more = false; for (const [a, b] of renameLinks) if (paths.has(a) || paths.has(b)) { for (const p of [a, b]) if (!paths.has(p)) { paths.add(p); more = true; } } }
          const stagePaths = new Set(paths);
          for (const p of paths) {
            safePath(wt, p);
            if (ignored(p)) { await fs.rm(safePath(wt, p), { force: true }); continue; }
            const l = localTree.get(p), r = remoteTree.get(p);
            if (!l && !r) {
              if (renameLinks.some(([a, b]) => a === p || b === p)) { await fs.rm(safePath(wt, p), { force: true }); await this.log('rename conflict: old-path deletion intent', [p]); continue; }
              throw new Error('Unsupported conflict structure; neither saved tip contains path; live vault unchanged');
            }
            const chosen = l || r;
            if (chosen.mode === '120000' || r?.mode === '120000') throw new Error('Unsupported symlink conflict');
            const full = safePath(wt, p); await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, await blob(wg, chosen)); await fs.chmod(full, chosen.mode === '100755' ? 0o755 : 0o644);
            if (!l || !r) await this.log('edit/delete conflict: deletion intent preserved in history', [p]);
            if (l && r && (l.oid !== r.oid || l.mode !== r.mode)) {
              let copy = copies.get(p); if (!copy) { copy = conflictName(p, occupied, new Date(this.clock())); copies.set(p, copy); }
              stagePaths.add(copy);
              const dest = safePath(wt, copy); await fs.mkdir(path.dirname(dest), { recursive: true });
              await fs.writeFile(dest, await blob(wg, r)); await fs.chmod(dest, r.mode === '100755' ? 0o755 : 0o644);
              await this.log('conflict versions preserved', [p, copy]);
            }
          }
          await this.stageRaw(wg, wt, stagePaths);
          try { await wg.text(['rebase', '--continue']); break; } catch {}
        }
      }
      // Remove excluded remote paths from the integrated tree without touching
      // local copies. They must not be reintroduced by remote history.
      const resultTree = await tree(wg, await head(wg));
      const remove = [...resultTree.keys()].filter(ignored);
      for (const p of remove) await fs.rm(safePath(wt, p), { force: true });
      if (remove.length) { await this.stageRaw(wg, wt, remove); await wg.text(['commit', '-m', `vaultsync: ${this.config.device} ${new Date(this.clock()).toISOString()}`]); }
      const integrated = await head(wg), desired = new Map();
      for (const [p, e] of await tree(wg, integrated)) {
        safePath(this.s.vault, p);
        if (e.mode === '120000') throw new Error('Unsupported incoming symlink; live vault unchanged');
        if (!ignored(p)) { const bytes = await blob(wg, e); desired.set(p, { bytes, mode: e.mode, hash: hash(bytes) }); }
      }
      for (const p of desired.keys()) {
        if ([...captured.keys()].some(oldPath => oldPath.startsWith(p + '/'))) throw new Error('Unsupported directory/file transition; live vault unchanged');
        let parent = path.posix.dirname(p); while (parent !== '.') { if (desired.has(parent) || captured.has(parent)) throw new Error('Unsupported file/directory transition; live vault unchanged'); parent = path.posix.dirname(parent); } }
      const normalized = new Set();
      for (const p of desired.keys()) { const key = process.platform === 'darwin' ? p.normalize('NFC').toLowerCase() : p; if (normalized.has(key)) throw new Error('Unsupported case/Unicode filename collision; live vault unchanged'); normalized.add(key); }
      await this.options.beforeApply?.();
      await assertReady(this.s.vault, this.g);
      if (!sameSnapshot(captured, await snapshot(this.s.vault)) || await head(this.g) !== local) { this.dirtyAt = this.clock(); throw new Error('Vault changed during integration; newer edits preserved; retry after debounce'); }
      await this.g.text(['fetch', '--no-tags', '--no-write-fetch-head', integrationRepo, integrated]);
      await this.g.text(['update-ref', recovery.replace('/recovery/', '/integrated/'), integrated]);
      await this.apply(captured, desired, local, integrated, recovery);
      this.expected = desired;
      await this.save({ lastPull: new Date(this.clock()).toISOString(), latestError: null }); await this.log('pull succeeded');
    } finally {
      await wg.text(['rebase', '--abort']).catch(() => {});
      await rg.text(['worktree', 'remove', '--force', wt]).catch(() => {});
      await fs.rm(integrationRepo, { recursive: true, force: true });
    }
  }
  async stageRaw(g, root, paths) {
    const rows = [];
    for (const p of paths) {
      const e = await entryAt(root, p);
      if (e && !ignored(p)) {
        const oid = (await g.bytes(['hash-object', '-w', '--stdin'], e.bytes)).toString().trim();
        rows.push(Buffer.from(`${e.mode} ${oid}\t${p}\0`));
      } else rows.push(Buffer.from(`0 ${'0'.repeat(40)}\t${p}\0`));
    }
    await g.bytes(['update-index', '-z', '--index-info'], Buffer.concat(rows));
  }
  async renameLinks(g, base, tips) {
    const links = [];
    for (const tip of tips) {
      const fields = (await g.bytes(['diff', '--name-status', '-z', '--find-renames', base, tip])).toString().split('\0').filter(Boolean);
      for (let i = 0; i < fields.length;) { const status = fields[i++], p = fields[i++]; if (status.startsWith('R')) links.push([p, fields[i++]]); }
    }
    return links;
  }
  async apply(before, after, oldHead, newHead, recoveryRef) {
    const id = randomUUID(), dir = path.join(this.s.dir, 'recovery', id); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const ops = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(p), b = after.get(p); if (same(a, b)) continue;
      const n = ops.length;
      for (const [name, e] of [['before', a], ['after', b]]) if (e) { const h = await fs.open(path.join(dir, `${n}.${name}`), 'wx', 0o600); try { await h.writeFile(e.bytes); await h.sync(); } finally { await h.close(); } }
      ops.push({ p, displaced: path.posix.join(path.posix.dirname(p), `.vaultsync-txn-${id}-${n}`), before: a ? { hash: a.hash, mode: a.mode } : null, after: b ? { hash: b.hash, mode: b.mode } : null });
    }
    await syncDir(dir);
    const journal = { id, dir, oldHead, newHead, recoveryRef, ops, phase: 'applying' };
    await atomicJSON(path.join(this.s.dir, 'journal.json'), journal);
    await this.options.afterJournal?.();
    try {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i], full = safePath(this.s.vault, op.p);
        if (!same(await entryAt(this.s.vault, op.p), op.before)) throw new Error('Edit during application; rolling back and preserving newer bytes');
        await fs.mkdir(path.dirname(full), { recursive: true });
        // Move old content to a unique, retained recovery path first. A concurrent
        // save between comparison and rename is captured by this move and checked.
        if (op.before) {
          const moved = safePath(this.s.vault, op.displaced);
          await fs.rename(full, moved);
          await syncDir(path.dirname(full));
          const bytes = await fs.readFile(moved);
          const backup = await fs.open(path.join(dir, `${i}.displaced`), 'wx', 0o600);
          try { await backup.writeFile(bytes); await backup.sync(); } finally { await backup.close(); }
          await syncDir(dir);
          if (hash(bytes) !== op.before.hash) {
            // Never overwrite a newer file an editor has already recreated.
            try { await fs.link(moved, full); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            throw new Error('Edit raced with replacement; captured in recovery directory');
          }
        }
        if (op.after) {
          const tmp = safePath(this.s.vault, `${op.displaced}-new`);
          const h = await fs.open(tmp, 'wx', op.after.mode === '100755' ? 0o755 : 0o644);
          try { await h.writeFile(await fs.readFile(path.join(dir, `${i}.after`))); await h.sync(); } finally { await h.close(); }
          // link is exclusive: it cannot clobber a new editor save at this path.
          try { await fs.link(tmp, full); } finally { await fs.rm(tmp, { force: true }); }
        }
        await syncDir(path.dirname(full));
        if (op.before) await fs.rm(safePath(this.s.vault, op.displaced), { force: true });
        await this.options.afterFile?.(i);
      }
      // Recheck all changed and unchanged paths before advancing Git history.
      if (!sameSnapshot(await snapshot(this.s.vault), after)) throw new Error('Edit during application; newer bytes preserved; retry integration');
      await this.g.text(['update-ref', 'refs/heads/main', newHead, oldHead]);
      await this.g.text(['read-tree', newHead]);
      journal.phase = 'committed'; await atomicJSON(path.join(this.s.dir, 'journal.json'), journal);
      await fs.rename(path.join(this.s.dir, 'journal.json'), path.join(dir, 'completed.json'));
    } catch (e) { await this.recover(); throw e; }
  }
  async recover() {
    const file = path.join(this.s.dir, 'journal.json'), j = await readJSON(file); if (!j) return;
    const currentHead = await head(this.g);
    if (currentHead === j.newHead) {
      await this.g.text(['read-tree', j.newHead]);
      await fs.rename(file, path.join(j.dir, 'completed.json')); await this.log('completed interrupted integration'); return;
    }
    if (currentHead !== j.oldHead) throw new Error('Recovery requires manual inspection: HEAD changed; journal and copies retained');
    for (let i = j.ops.length - 1; i >= 0; i--) {
      const op = j.ops[i], live = await entryAt(this.s.vault, op.p), full = safePath(this.s.vault, op.p);
      if (same(live, op.before)) continue;
      if (live && !same(live, op.after)) { await this.log('recovery preserved newer user edit', [op.p]); continue; }
      // If path is missing and a displaced copy exists, prefer its actual bytes.
      let restore = null;
      if (op.before) {
        const moved = safePath(this.s.vault, op.displaced);
        restore = await fs.readFile(moved).catch(e => { if (e.code === 'ENOENT') return fs.readFile(path.join(j.dir, `${i}.displaced`)).catch(e2 => { if (e2.code === 'ENOENT') return fs.readFile(path.join(j.dir, `${i}.before`)); throw e2; }); throw e; });
      }
      if (live) {
        const moved = safePath(this.s.vault, `${op.displaced}-rollback`);
        await fs.rename(full, moved);
        const actual = await fs.readFile(moved);
        const h = await fs.open(path.join(j.dir, `${i}.rollback-${randomUUID()}`), 'wx', 0o600);
        try { await h.writeFile(actual); await h.sync(); } finally { await h.close(); }
        if (hash(actual) !== live.hash) restore = actual;
        await fs.rm(moved);
      }
      if (restore) {
        await fs.mkdir(path.dirname(full), { recursive: true });
        const temp = safePath(this.s.vault, `${op.displaced}-restore`);
        const h = await fs.open(temp, 'w', op.before?.mode === '100755' ? 0o755 : 0o644);
        try { await h.writeFile(restore); await h.sync(); } finally { await h.close(); }
        // Exclusive link is atomic even when the external state is on a different device.
        try { await fs.link(temp, full); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        await fs.rm(temp, { force: true });

      }
      await fs.rm(safePath(this.s.vault, op.displaced), { force: true });
      await fs.rm(safePath(this.s.vault, `${op.displaced}-new`), { force: true });
      await syncDir(path.dirname(full));
    }
    await this.g.text(['read-tree', j.oldHead]);
    await fs.rename(file, path.join(j.dir, 'rolled-back.json')); await this.log('interrupted integration recovered; all recovery copies retained');
  }
  async stop() {
    this.closed = true; clearInterval(this.timer); await this.watcher?.close(); await this.queue;
    if (this.release) { await this.save({ daemon: 'stopped', pid: null }); await this.release(); this.release = null; }
  }
}
export async function getStatus(vault, stateRoot) {
  const s = await stateFor(vault, stateRoot), status = await readJSON(path.join(s.dir, 'status.json'), {}), lock = await readJSON(path.join(s.dir, 'lock.json'));
  const g = git(s.vault), live = await snapshot(s.vault), tracked = await tree(g, await head(g)), pending = [];
  for (const p of new Set([...live.keys(), ...tracked.keys()])) {
    if (ignored(p)) { if (tracked.has(p)) pending.push(p); continue; }
    const e = tracked.get(p), l = live.get(p); if (!e || !l || e.mode !== l.mode || !l.bytes.equals(await blob(g, e))) pending.push(p);
  }
  return { daemon: lock && alive(lock.pid) ? 'running' : 'stopped', lastPush: status.lastPush || 'never', lastPull: status.lastPull || 'never', pendingChanges: pending, latestError: status.latestError || null, conflictFiles: [...live.keys()].filter(p => /\.conflict-\d{4}-\d{2}-\d{2}(?:-\d+)?(?:\.[^/]*)?$/.test(p)), recoveryPending: !!(await readJSON(path.join(s.dir, 'journal.json'))), stateDirectory: s.dir };
}
