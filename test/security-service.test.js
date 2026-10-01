import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadToken } from '../src/credential.js';
import { git, gitEnv, githubRemote } from '../src/git.js';
import { renderService, manageService } from '../src/service.js';
import { fixture } from './helpers.js';
const exec = promisify(execFile);

test('external token bridge is noninteractive, host-scoped and never in Git args/config/logs', async t => {
  const { a, root } = await fixture(t);
  const file = path.join(root, 'protected.env'), token = 'test-secret-token-NOT-REAL';
  await fs.writeFile(file, `GITHUB_TOKEN=${token}\n`, { mode: 0o600 }); assert.equal(await loadToken(file), token);
  await fs.chmod(file, 0o644); await assert.rejects(loadToken(file), /mode 600/); await fs.chmod(file, 0o600);
  const cg = git(a.vault, file);
  // Credential fill exercises Git's own helper protocol and quoted executable paths.
  const response = await cg.bytes(['credential', 'fill'], Buffer.from('protocol=https\nhost=github.com\n\n'));
  assert(response.toString().includes(`password=${token}`));
  await assert.rejects(cg.bytes(['credential', 'fill'], Buffer.from('protocol=https\nhost=example.invalid\n\n')));
  assert(!(await fs.readFile(path.join(a.vault, '.git/config'), 'utf8')).includes(token));
  assert(!(await fs.readFile(path.join(a.s.dir, 'log.jsonl'), 'utf8')).includes(token));
  assert.equal(githubRemote(`https://${token}@github.com/test/vault.git`), undefined);
  assert.equal(githubRemote('git@github.com:Test/Vault.git'), 'test/vault');
  // Generic diagnostic strips a deliberately secret-bearing remote URL.
  const bad = { ...cg }; await a.g.text(['remote', 'set-url', 'origin', `https://${token}@127.0.0.1:1/no.git`]);
  await assert.rejects(bad.text(['fetch', 'origin']), e => !e.message.includes(token));
});

test('launchd/systemd escaping and service install/uninstall preserve vault', async t => {
  const { a, root } = await fixture(t);
  const s = { ...a.s, vault: '/tmp/vault & "special" % name' };
  const mac = renderService(s, 'darwin'), linux = renderService(s, 'linux');
  assert(mac.content.includes('&amp;')); assert(mac.content.includes('&quot;'));
  assert(linux.content.includes('%%')); assert(linux.content.includes('\\"special\\"'));
  const plist = path.join(root, 'validation.plist'); await fs.writeFile(plist, mac.content);
  if (process.platform === 'darwin') await exec('plutil', ['-lint', plist]);
  const calls = [], execute = async (command, args) => { calls.push([command, args]); return { stdout: '' }; };
  const home = path.join(root, 'home');
  const installed = await manageService(a.vault, 'install', { stateRoot: path.join(root, 'state'), platform: 'linux', home, execute });
  assert((await fs.readFile(installed.file, 'utf8')).includes('ExecStart=')); assert(calls.some(([,args]) => args.includes('enable')));
  await manageService(a.vault, 'uninstall', { stateRoot: path.join(root, 'state'), platform: 'linux', home, execute });
  await assert.rejects(fs.access(installed.file), { code: 'ENOENT' }); assert.equal((await fs.readFile(path.join(a.vault, 'note.md'), 'utf8')), 'base\n');
  assert(calls.some(([,args]) => args.includes('disable')));
});

test('CLI works through a symlink; init connects matching remote and leaves ignored bytes local', async t => {
  const { a, root } = await fixture(t);
  const { initVault } = await import('../src/engine.js');
  await a.g.text(['remote', 'set-url', 'origin', 'https://github.com/test/vault.git']);
  await fs.writeFile(path.join(a.vault, '.env'), 'untracked-private-bytes');
  const s = await initVault({ vault: a.vault, repo: 'test/vault', stateRoot: path.join(root, 'state'), verifyPrivate: async repo => repo === 'test/vault' });
  assert.equal((await fs.readFile(path.join(a.vault, '.env'), 'utf8')), 'untracked-private-bytes');
  assert((await fs.readFile(path.join(s.dir, 'config.json'), 'utf8')).includes('test/vault'));
  const link = path.join(root, 'vaultsync');
  await fs.symlink(new URL('../src/cli.js', import.meta.url).pathname.replaceAll('%20', ' '), link);
  const help = await exec(process.execPath, [link, '--help']); assert(help.stdout.includes('vaultsync init'));
});


test('ambient dependency DEBUG cannot leak credentials or raw Git errors', async t => {
  const { a } = await fixture(t);
  const token = 'fake-secret-for-debug-test';
  await a.g.text(['remote', 'set-url', 'origin', `https://${token}@127.0.0.1:1/no.git`]);
  const module = new URL('../src/git.js', import.meta.url).href;
  const script = `const {git}=await import(${JSON.stringify(module)}); try {await git(process.argv[1]).text(['fetch','origin'])} catch(e) {console.error(e.message)}`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', script, a.vault], { env: { ...process.env, DEBUG: '*', GH_TOKEN: token } });
  assert(!result.stderr.includes(token)); assert(!result.stdout.includes(token));
});
