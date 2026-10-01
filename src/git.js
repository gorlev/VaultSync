// Dependency debug output dumps argv, stderr and environment; disable it before
// loading simple-git so a caller's DEBUG setting cannot expose credentials.
delete process.env.DEBUG;
const { simpleGit } = await import('simple-git');
import { spawn } from 'node:child_process';
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
import { fileURLToPath } from 'node:url';

// No command output is put in exceptions: git diagnostics can contain note text,
// URLs with credentials, or credential-helper output.
export class GitError extends Error {
  constructor(op, code) { super(`Git ${op} failed (exit ${code}); check network, credentials and repository state`); this.code = code; }
}
export function gitEnv(envFile) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || ['PAGER', 'EDITOR', 'VISUAL', 'DEBUG', 'NODE_DEBUG'].includes(k)) delete env[k];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_LITERAL_PATHSPECS: '1' });
  if (envFile) env.VAULTSYNC_ENV_FILE = envFile;
  else delete env.VAULTSYNC_ENV_FILE;
  return env;
}
export function git(vault, envFile) {
  const config = ['core.hooksPath=/dev/null', 'commit.gpgSign=false', 'core.quotePath=false', 'core.autocrlf=false', 'core.safecrlf=false'];
  if (envFile) config.push('credential.helper=', `credential.helper=!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('./credential.js', import.meta.url)))}`);
  const env = gitEnv(envFile);
  const sg = simpleGit({ baseDir: vault, maxConcurrentProcesses: 1, trimmed: false, config, unsafe: { allowUnsafeHooksPath: true, allowUnsafeEditor: true, allowUnsafeCredentialHelper: !!envFile }, allowEnvironment: Object.keys(env), errors: (_error, result) => result.exitCode !== 0 ? new GitError('command', result.exitCode) : undefined, timeout: { block: 60000 } }).env(env);
  const prefix = config.flatMap(c => ['-c', c]);
  return {
    async text(args) { try { return await sg.raw(args); } catch (e) { throw new GitError(args[0], e.code ?? 'unknown'); } },
    async bytes(args, input, extraEnv = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn('git', [...prefix, ...args], { cwd: vault, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = []; child.stdout.on('data', c => chunks.push(c)); child.stderr.resume();
        child.on('error', () => reject(new GitError(args[0], 'spawn')));
        child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new GitError(args[0], code)));
        child.stdin.on('error', () => {}); child.stdin.end(input);
        const timer = setTimeout(() => child.kill('SIGTERM'), 60000); timer.unref(); child.on('close', () => clearTimeout(timer));
      });
    }
  };
}
export async function head(g) { try { return (await g.text(['rev-parse', '--verify', 'HEAD'])).trim(); } catch { return null; } }
export function parseTree(buf) {
  const out = new Map();
  if (!Buffer.from(buf.toString('utf8')).equals(buf)) throw new Error('Unsupported non-UTF-8 Git path; live vault unchanged');
  for (const record of buf.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), [mode, type, oid] = record.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw new Error('Unsupported tree entry (submodule or special file)');
    out.set(record.slice(tab + 1), { mode, oid });
  }
  return out;
}
export async function tree(g, ref) { return ref ? parseTree(await g.bytes(['ls-tree', '-rz', '--full-tree', ref])) : new Map(); }
export async function blob(g, entry) { return entry ? g.bytes(['cat-file', 'blob', entry.oid]) : null; }
export function githubRemote(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url.trim());
  return m?.[1]?.toLowerCase();
}
