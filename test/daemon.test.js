import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, edit, commit, sync } from './helpers.js';
import { Engine, getStatus, IGNORE_TEXT } from '../src/engine.js';
import { head } from '../src/git.js';
import { snapshot } from '../src/state.js';

async function prepare(a, b) {
  await edit(a, '.gitignore', IGNORE_TEXT); await commit(a); await sync(a); await sync(b);
}

test('startup pull, five-minute schedule and precise 30-second trailing debounce using controlled clock', async t => {
  const { a, b, root } = await fixture(t); await prepare(a, b);
  await edit(a, 'startup.md', 'startup'); await commit(a); await sync(a);
  let now = 1000000;
  const e = new Engine(b.s, { g: b.g, allowLocal: true, clock: () => now, tickMs: 1000000 });
  b.engine = e; t.after(() => e.stop()); await e.start();
  assert.equal((await fs.readFile(path.join(b.vault, 'startup.md'))).toString(), 'startup');
  const initial = await head(b.g), first = await getStatus(b.vault, path.join(root, 'state'));
  assert.equal(first.lastPull, new Date(now).toISOString()); assert.equal(first.lastPush, new Date(now).toISOString());
  await edit(b, '.obsidian/workspace.json', 'ignored'); await delay(350); await e.queue; assert.equal(e.dirtyAt, null);
  // Watcher itself must extend the deadline after atomic editor saves.
  await edit(b, 'draft.md', 'first'); await delay(350); await e.queue; assert.equal(e.dirtyAt, now);
  now += 29999; await e.tick(); assert.equal(await head(b.g), initial);
  await fs.writeFile(path.join(b.vault, 'editor.tmp'), 'second'); await fs.rename(path.join(b.vault, 'editor.tmp'), path.join(b.vault, 'draft.md'));
  await delay(350); await e.queue; assert.equal(e.dirtyAt, now);
  now += 29999; await e.tick(); assert.equal(await head(b.g), initial);
  now += 1; await e.tick(); assert.notEqual(await head(b.g), initial);
  const last = await getStatus(b.vault, path.join(root, 'state')); assert.equal(last.lastPush, new Date(now).toISOString());
  await sync(a); await edit(a, 'periodic.md', 'periodic'); await commit(a); await sync(a);
  now += 299999; await e.tick(); await assert.rejects(fs.access(path.join(b.vault, 'periodic.md')), { code: 'ENOENT' });
  now += 1; await e.tick(); assert.equal((await fs.readFile(path.join(b.vault, 'periodic.md'))).toString(), 'periodic');
  await delay(350); await e.queue; assert.equal(e.dirtyAt, null, 'remote watcher events are not user edits');
});

test('startup dirty vault waits for debounce before pull; offline commits retained and retry on scheduled cycle', async t => {
  const { a, b, remote, root } = await fixture(t); await prepare(a, b);
  await edit(b, 'draft.md', 'offline draft'); await edit(a, 'incoming.md', 'incoming'); await commit(a); await sync(a);
  await fs.rm(path.join(b.s.dir, 'status.json'), { force: true });
  const offline = remote + '.offline'; await fs.rename(remote, offline);
  let now = 1000000;
  const e = new Engine(b.s, { g: b.g, allowLocal: true, clock: () => now, tickMs: 1000000 }); b.engine = e; t.after(() => e.stop()); await e.start();
  assert.equal((await getStatus(b.vault, path.join(root, 'state'))).lastPull, 'never');
  const original = await head(b.g); now += 30000; await e.tick(); const retained = await head(b.g); assert.notEqual(retained, original);
  let status = await getStatus(b.vault, path.join(root, 'state')); assert.equal(status.lastPush, 'never'); assert(status.latestError);
  await fs.rename(offline, remote); now += 299999; await e.tick(); assert.equal(await head(b.g), retained);
  now += 1; await e.tick(); status = await getStatus(b.vault, path.join(root, 'state'));
  assert.equal(status.lastPush, new Date(now).toISOString()); assert.equal(status.latestError, null);
  assert.equal((await fs.readFile(path.join(b.vault, 'incoming.md'))).toString(), 'incoming');
  assert.equal((await fs.readFile(path.join(b.vault, 'draft.md'))).toString(), 'offline draft');
});

test('rejected push keeps local history, does not force; retries next cycle and keeps last success accurate', async t => {
  const { a, b, remote, root } = await fixture(t); await prepare(a, b);
  let now = 1000000;
  const e = new Engine(b.s, { g: b.g, allowLocal: true, clock: () => now, tickMs: 1000000 }); b.engine = e; t.after(() => e.stop()); await e.start();
  const oldStatus = await getStatus(b.vault, path.join(root, 'state'));
  const hook = path.join(remote, 'hooks/pre-receive'); await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await edit(b, 'rejected.md', 'keep commit'); await delay(350); await e.queue; now += 30000; await e.tick();
  const kept = await head(b.g), fail = await getStatus(b.vault, path.join(root, 'state')); assert.equal(fail.lastPush, oldStatus.lastPush); assert(fail.latestError);
  assert.equal(fail.lastPull, new Date(now).toISOString());
  await fs.rm(hook); now += 300000; await e.tick(); assert.equal(await head(b.g), kept); assert.equal((await getStatus(b.vault, path.join(root, 'state'))).lastPush, new Date(now).toISOString());
  await sync(a); assert.equal((await fs.readFile(path.join(a.vault, 'rejected.md'))).toString(), 'keep commit');
});

test('second daemon rejected without disturbing owner status; graceful stop releases lock', async t => {
  const { a, b, root } = await fixture(t); await prepare(a, b);
  const e = new Engine(b.s, { g: b.g, allowLocal: true, tickMs: 1000000 }); b.engine = e; t.after(() => e.stop()); await e.start();
  const second = new Engine(b.s, { g: b.g, allowLocal: true }); await assert.rejects(second.start(), /already running/);
  assert.equal((await getStatus(b.vault, path.join(root, 'state'))).daemon, 'running'); await e.stop();
  assert.equal((await getStatus(b.vault, path.join(root, 'state'))).daemon, 'stopped');
});

test('concurrent remote advancement after second pull rejects normal push and recovers on schedule', async t => {
  const { a, b, root } = await fixture(t); await prepare(a, b);
  let now = 1000000; const observed = [], originalText = b.g.text.bind(b.g);
  b.g.text = async args => { observed.push(args); return originalText(args); };
  const e = new Engine(b.s, { g: b.g, allowLocal: true, clock: () => now, tickMs: 1000000 }); b.engine = e; await e.start();
  const first = await getStatus(b.vault, path.join(root, 'state'));
  e.options.beforePush = async () => { delete e.options.beforePush; await edit(a, 'concurrent.md', 'other device'); await commit(a); await sync(a); };
  await edit(b, 'own.md', 'this device'); await delay(350); await e.queue; now += 30000; await e.tick();
  assert.equal((await getStatus(b.vault, path.join(root, 'state'))).lastPush, first.lastPush);
  assert((await getStatus(b.vault, path.join(root, 'state'))).latestError);
  now += 300000; await e.tick(); assert.equal((await fs.readFile(path.join(b.vault, 'concurrent.md'))).toString(), 'other device');
  assert(observed.filter(args => args[0] === 'push').every(args => !args.some(a => a.startsWith('+') || a.includes('--force'))));
  await e.stop();
});
