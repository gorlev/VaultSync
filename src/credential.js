#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile, stat, realpath } from 'node:fs/promises';
// Git credential protocol only. Never echo diagnostics or persist the token.
export async function loadToken(file) {
  if (!file) throw new Error('Missing external credential file');
  const s = await stat(file);
  if (!s.isFile() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error('Credential file must be owned by current user and mode 600');
  const text = await readFile(await realpath(file), 'utf8');
  const m = /^GITHUB_TOKEN=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))\s*$/m.exec(text);
  const token = m && (m[1] || m[2] || m[3]);
  if (!token || /[\r\n\0]/.test(token)) throw new Error('Expected GITHUB_TOKEN in external credential file');
  return token;
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) {
  try {
    let request = ''; for await (const c of process.stdin) request += c;
    const fields = Object.fromEntries(request.split('\n').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    if (process.argv[2] === 'get' && fields.protocol === 'https' && fields.host === 'github.com') {
      const token = await loadToken(process.env.VAULTSYNC_ENV_FILE);
      process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
    }
  } catch { process.exitCode = 1; }
}
