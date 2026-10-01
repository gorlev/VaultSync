import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, edit, commit, sync } from './helpers.js';
import { Engine, getStatus, conflictName, initVault, verifyRemote, dateLocal } from '../src/engine.js';
import { snapshot, acquire, readJSON, atomicJSON, stateFor } from '../src/state.js';
import { head, tree, blob } from '../src/git.js';

const bytes = (d, p) => fs.readFile(path.join(d.vault, p));
const conflicts = async d => (await getStatus(d.vault, path.join(path.dirname(d.vault), 'state'))).conflictFiles;

test('two devices: complete conflict bytes, multiple unpushed commits, same-day unique copies', async t => {
  const { a, b } = await fixture(t);
  const local = Buffer.from('local full\r\n\0unicode: İstanbul\n'), remote = Buffer.from('remote full\nlast line');
  await edit(a, 'note.md', remote); await commit(a); await sync(a);
  await edit(b, 'note.md', 'intermediate local\n'); await commit(b);
  await edit(b, 'note.md', local); await commit(b);
  await sync(b);
  assert.deepEqual(await bytes(b, 'note.md'), local);
  const first = await conflicts(b); assert.equal(first.length, 1); assert.deepEqual(await bytes(b, first[0]), remote);
  await sync(a); await edit(a, 'note.md', 'second incoming'); await commit(a); await sync(a);
  await edit(b, 'note.md', 'second local'); await commit(b); await sync(b);
  const copies = await conflicts(b); assert.equal(copies.length, 2); assert(copies.some(p => p.endsWith('-2.md')));
  assert.deepEqual(await bytes(b, first[0]), remote);
  assert.equal((await bytes(b, copies.find(p => p.endsWith('-2.md')))).toString(), 'second incoming');
  assert((await b.g.text(['for-each-ref', '--format=%(refname)', 'refs/vaultsync/recovery'])).includes('refs/vaultsync/recovery/'));
});

test('binary attachments, shared configuration, Unicode/spaces/newlines/tabs/leading dash', async t => {
  const { a, b } = await fixture(t);
  const names = ['assets/图 ü\t\n.bin', '.obsidian/plugins/x/data.json', '-strange.md'];
  for (const p of names) { await edit(a, p, Buffer.from([0, 255, 13, 10, 1])); }
  await commit(a); await sync(a); await sync(b);
  for (const p of names) assert.deepEqual(await bytes(b, p), Buffer.from([0, 255, 13, 10, 1]));
  await edit(a, names[1], '{"incoming":true}');
  await edit(a, names[0], Buffer.from([2, 255, 0])); await commit(a); await sync(a);
  await edit(b, names[1], '{"local":true}');
  await edit(b, names[0], Buffer.from([3, 0, 255])); await commit(b); await sync(b);
  assert.deepEqual(await bytes(b, names[0]), Buffer.from([3, 0, 255]));
  const copy = (await conflicts(b)).find(p => p.endsWith('.bin')); assert(copy); assert.deepEqual(await bytes(b, copy), Buffer.from([2, 255, 0]));
  const configCopy = (await conflicts(b)).find(p => p.endsWith('.json')); assert(configCopy);
  assert.equal((await bytes(b, configCopy)).toString(), '{"incoming":true}');
  assert.equal((await bytes(b, names[1])).toString(), '{"local":true}');
});

test('edit/delete in either direction preserves content and logs deletion intent; clean deletion propagates', async t => {
  const { a, b } = await fixture(t);
  await fs.unlink(path.join(a.vault, 'note.md')); await commit(a); await sync(a);
  await edit(b, 'note.md', 'survivor local'); await commit(b); await sync(b);
  assert.equal((await bytes(b, 'note.md')).toString(), 'survivor local');
  assert((await fs.readFile(path.join(b.s.dir, 'log.jsonl'), 'utf8')).includes('deletion intent'));
  await sync(a); await edit(a, 'note.md', 'survivor incoming'); await commit(a); await sync(a);
  await fs.unlink(path.join(b.vault, 'note.md')); await commit(b); await sync(b);
  assert.equal((await bytes(b, 'note.md')).toString(), 'survivor incoming');
  await sync(a); await fs.unlink(path.join(a.vault, 'note.md')); await commit(a); await sync(a); await sync(b);
  await assert.rejects(bytes(b, 'note.md'), { code: 'ENOENT' });
});

test('rename/rename preserves both destinations; rename/edit preserves both versions', async t => {
  const { a, b } = await fixture(t);
  await fs.rename(path.join(a.vault, 'note.md'), path.join(a.vault, 'remote name.md')); await commit(a); await sync(a);
  await fs.rename(path.join(b.vault, 'note.md'), path.join(b.vault, 'local name.md')); await commit(b); await sync(b);
  assert.equal((await bytes(b, 'local name.md')).toString(), 'base\n');
  assert.equal((await bytes(b, 'remote name.md')).toString(), 'base\n');
  await sync(a); await fs.rename(path.join(a.vault, 'local name.md'), path.join(a.vault, 'renamed.md')); await commit(a); await sync(a);
  await edit(b, 'local name.md', 'local changed'); await commit(b); await sync(b);
  assert.equal((await bytes(b, 'renamed.md')).toString(), 'local changed');
  assert.equal((await bytes(b, 'remote name.md')).toString(), 'base\n');
});

test('integration detects new user edits before apply and retries without losing bytes', async t => {
  const { a, b } = await fixture(t);
  await edit(a, 'remote.md', 'new incoming'); await commit(a); await sync(a);
  b.engine.options.beforeApply = () => edit(b, 'note.md', 'edited while rebase ran');
  await assert.rejects(b.engine.pull(), /Vault changed/);
  assert.equal((await bytes(b, 'note.md')).toString(), 'edited while rebase ran');
  await assert.rejects(bytes(b, 'remote.md'), { code: 'ENOENT' });
  delete b.engine.options.beforeApply; await commit(b); await sync(b);
  assert.equal((await bytes(b, 'note.md')).toString(), 'edited while rebase ran');
  assert.equal((await bytes(b, 'remote.md')).toString(), 'new incoming');
});

test('edits during application survive rollback; subsequent integration succeeds', async t => {
  const { a, b } = await fixture(t);
  await edit(a, 'note.md', 'incoming'); await edit(a, 'other.md', 'incoming other'); await commit(a); await sync(a);
  b.engine.options.afterFile = async i => { if (i === 0) await edit(b, 'note.md', 'newer live edit'); };
  await assert.rejects(b.engine.pull(), /Edit during application/);
  assert.equal((await bytes(b, 'note.md')).toString(), 'newer live edit');
  assert.equal(await readJSON(path.join(b.s.dir, 'journal.json')), null);
  delete b.engine.options.afterFile; await commit(b); await sync(b);
  assert.equal((await bytes(b, 'note.md')).toString(), 'newer live edit');
});

test('durable journal recovers interrupted application before or after updating HEAD', async t => {
  const { a, b } = await fixture(t);
  await edit(a, 'note.md', 'remote'); await commit(a); await sync(a);
  // Simulates process loss after the journal write; no catch/rollback in apply yet.
  b.engine.options.afterJournal = () => { throw new Error('simulated crash'); };
  await assert.rejects(b.engine.pull(), /simulated crash/);
  assert(await readJSON(path.join(b.s.dir, 'journal.json')));
  const j = await readJSON(path.join(b.s.dir, 'journal.json'));
  // Simulate first applied file, then a restart.
  const op = j.ops[0]; await fs.writeFile(path.join(b.vault, op.p), await fs.readFile(path.join(j.dir, '0.after')));
  await b.engine.recover(); assert.equal((await bytes(b, 'note.md')).toString(), 'base\n');
  delete b.engine.options.afterJournal; await sync(b);
  assert.equal((await bytes(b, 'note.md')).toString(), 'remote');
  const old = await head(b.g);
  await atomicJSON(path.join(b.s.dir, 'journal.json'), { ...j, newHead: old, oldHead: j.oldHead });
  await b.engine.recover(); assert.equal(await readJSON(path.join(b.s.dir, 'journal.json')), null);
});

test('manual rebase and unsupported symlink stop without changing live files', async t => {
  const { a, b } = await fixture(t);
  const gd = (await b.g.text(['rev-parse', '--git-dir'])).trim(); await fs.mkdir(path.resolve(b.vault, gd, 'rebase-merge'));
  await assert.rejects(commit(b), /Manual Git operation/); assert.equal((await bytes(b, 'note.md')).toString(), 'base\n');
  await fs.rm(path.resolve(b.vault, gd, 'rebase-merge'), { recursive: true });
  await fs.symlink('note.md', path.join(a.vault, 'unsafe-link'));
  await a.g.text(['add', '--all']); await a.g.text(['commit', '-m', 'manual symlink']); await a.g.text(['push', 'origin', 'main']);
  await assert.rejects(b.engine.pull(), /Unsupported incoming symlink/);
  await assert.rejects(fs.lstat(path.join(b.vault, 'unsafe-link')), { code: 'ENOENT' });
});

test('ignored files are removed from tracking but retained locally; status never and discovery', async t => {
  const { a } = await fixture(t);
  for (const p of ['.env', '.env.local', '.trash/secret.md', '.obsidian/workspace.json']) await edit(a, p, 'DO_NOT_LEAK');
  await a.g.text(['add', '--all']); await a.g.text(['commit', '-m', 'previously tracked']);
  await commit(a);
  for (const p of ['.env', '.env.local', '.trash/secret.md', '.obsidian/workspace.json']) { assert.equal((await bytes(a, p)).toString(), 'DO_NOT_LEAK'); assert(!(await tree(a.g, await head(a.g))).has(p)); }
  let status = await getStatus(a.vault, path.join(path.dirname(a.vault), 'state')); assert.equal(status.lastPush, 'never'); assert.equal(status.lastPull, 'never'); assert.equal(status.daemon, 'stopped');
  await edit(a, 'forgotten.conflict-2026-10-01-3.pdf', Buffer.from([0, 5])); status = await getStatus(a.vault, path.join(path.dirname(a.vault), 'state'));
  assert(status.conflictFiles.includes('forgotten.conflict-2026-10-01-3.pdf')); assert(status.pendingChanges.includes('forgotten.conflict-2026-10-01-3.pdf'));
  assert(!(await fs.readFile(path.join(a.s.dir, 'log.jsonl'), 'utf8')).includes('DO_NOT_LEAK'));
});

test('privacy verification precedes changes; mismatch remote and push overrides refused', async t => {
  const { a, root } = await fixture(t);
  const untouched = path.join(root, 'untouched'); await fs.mkdir(untouched);
  await assert.rejects(initVault({ vault: untouched, repo: 'test/vault', stateRoot: path.join(root, 'state'), verifyPrivate: async () => false }), /private/);
  await assert.rejects(fs.access(path.join(untouched, '.git')), { code: 'ENOENT' });
  await a.g.text(['remote', 'set-url', 'origin', 'https://github.com/wrong/repo.git']);
  await assert.rejects(verifyRemote(a.g, 'test/vault'), /does not match/);
  await a.g.text(['remote', 'set-url', 'origin', 'https://github.com/test/vault.git']); await verifyRemote(a.g, 'test/vault');
  await a.g.text(['config', 'remote.origin.pushurl', 'https://github.com/wrong/repo.git']); await assert.rejects(verifyRemote(a.g, 'test/vault'), /push override/);
});

test('single daemon lock, stale PID recovery, local-date filenames', async t => {
  const { a } = await fixture(t);
  const release = await acquire(a.s.dir); await assert.rejects(acquire(a.s.dir), /already running/); await release();
  await atomicJSON(path.join(a.s.dir, 'lock.json'), { pid: 99999999, token: 'dead' }); const next = await acquire(a.s.dir); await next();
  assert.equal(dateLocal(new Date(2026, 0, 2, 23)), '2026-01-02');
  assert.equal(conflictName('a.md', new Set(['a.conflict-2026-01-02.md']), new Date(2026, 0, 2)), 'a.conflict-2026-01-02-2.md');
});

test('text Markdown conflict copies bypass attributes and preserve complete raw bytes', async t => {
  const { a, b } = await fixture(t);
  await edit(a, '.gitattributes', '*.md text eol=crlf\n'); await commit(a); await sync(a); await sync(b);
  const incoming = Buffer.from('# incoming\r\ncomplete remote\r\n'), local = Buffer.from('# local\ncomplete local without trailing newline');
  await edit(a, 'note.md', incoming); await commit(a); await sync(a);
  await edit(b, 'note.md', local); await commit(b); await sync(b);
  assert.deepEqual(await bytes(b, 'note.md'), local);
  const copy = (await conflicts(b))[0]; assert.deepEqual(await bytes(b, copy), incoming);
  assert.deepEqual(await blob(b.g, (await tree(b.g, await head(b.g))).get(copy)), incoming);
});

test('unsupported directory/file transition stops before any live modification', async t => {
  const { a, b } = await fixture(t);
  await edit(a, 'folder/child.md', 'child bytes'); await commit(a); await sync(a); await sync(b);
  await fs.rm(path.join(a.vault, 'folder'), { recursive: true }); await edit(a, 'folder', 'a file'); await commit(a); await sync(a);
  const before = await snapshot(b.vault); await assert.rejects(b.engine.pull(), /directory\/file transition/);
  const after = await snapshot(b.vault); assert.deepEqual([...after].map(([p,e]) => [p,e.hash]), [...before].map(([p,e]) => [p,e.hash]));
});
