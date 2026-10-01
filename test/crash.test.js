import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, edit, commit, sync } from './helpers.js';
import { Engine, IGNORE_TEXT, getStatus } from '../src/engine.js';
import { readJSON } from '../src/state.js';

test('real SIGKILL during a file update: stale lock and journal recover on daemon restart', async t => {
  const { a, b, root } = await fixture(t);
  await edit(a, '.gitignore', IGNORE_TEXT); await commit(a); await sync(a); await sync(b);
  await edit(a, 'note.md', 'incoming after crash'); await edit(a, 'new.md', 'also incoming'); await commit(a); await sync(a);
  const signal = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./crash-worker.js', import.meta.url)), b.vault, path.join(root, 'state')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', c => err += c); child.on('error', reject); child.on('close', (code, signal) => signal ? resolve(signal) : reject(new Error(`Worker exited ${code}: ${err}`)));
  });
  assert.equal(signal, 'SIGKILL'); assert(await readJSON(path.join(b.s.dir, 'journal.json')));
  await edit(b, 'note.md', 'new edit after crash');
  const e = new Engine(b.s, { allowLocal: true, debounceMs: 0, tickMs: 1000000 }); b.engine = e;
  await e.start(); assert.equal(await readJSON(path.join(b.s.dir, 'journal.json')), null);
  assert.equal((await fs.readFile(path.join(b.vault, 'note.md'), 'utf8')), 'new edit after crash');
  assert.equal((await fs.readFile(path.join(b.vault, 'new.md'), 'utf8')), 'also incoming');
  assert.equal((await getStatus(b.vault, path.join(root, 'state'))).latestError, null);
  await e.stop();
});
