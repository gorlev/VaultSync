#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Engine, initVault, getStatus } from './engine.js';
import { stateFor } from './state.js';
import { loadToken } from './credential.js';
import { manageService } from './service.js';
const exec = promisify(execFile);
export async function verifyPrivate(repo, envFile) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (envFile) env.GH_TOKEN = await loadToken(envFile);
  try {
    const { stdout } = await exec('gh', ['api', `repos/${repo}`, '--hostname', 'github.com'], { env, timeout: 60000, maxBuffer: 1024 * 1024 });
    const r = JSON.parse(stdout); return r.private === true && r.full_name.toLowerCase() === repo.toLowerCase();
  } catch { throw new Error('Cannot verify private GitHub repository; check gh authentication and repository access'); }
}
export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('vaultsync requires Node 24');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { vault: { type: 'string' }, repo: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0];
  if (values.help || !command) { console.log('vaultsync init --vault PATH --repo OWNER/REPO [--env-file EXTERNAL_PATH]\nvaultsync run|status|install|uninstall --vault PATH'); return; }
  if (!values.vault || positionals.length !== 1) throw new Error('Expected one command and explicit --vault PATH');
  if (command !== 'init' && (values.repo || values['env-file'])) throw new Error('--repo and --env-file are init options');
  if (command === 'init') { const s = await initVault({ vault: values.vault, repo: values.repo, envFile: values['env-file'], verifyPrivate }); console.log(`Initialized ${s.vault}; daemon has not been installed`); }
  else if (command === 'status') console.log(JSON.stringify(await getStatus(values.vault), null, 2));
  else if (command === 'install' || command === 'uninstall') console.log(JSON.stringify(await manageService(values.vault, command), null, 2));
  else if (command === 'run') {
    const engine = new Engine(await stateFor(values.vault)); await engine.start();
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await engine.stop(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } else throw new Error('Unknown command');
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`vaultsync: ${e.message}`); process.exitCode = 1; });
