import { copyFileSync, existsSync, mkdirSync, readFileSync, chmodSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

process.umask(0o077);
for (const directory of [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME, process.env.CODEX_HOME, process.env.BOHR_CONFIG_DIR, process.env.HF_HOME]) {
  mkdirSync(directory, { recursive: true });
}
// Auth-only mounts do not bring host feature settings. Enable the real image route
// explicitly in disposable HOME without importing the host Codex configuration.
writeFileSync(`${process.env.CODEX_HOME}/config.toml`, '[features]\nimage_generation = true\n', { mode: 0o600 });
// Only the runtime reads mounted secrets. OAuth refresh writes to disposable tmpfs,
// never to the read-only host auth file or the persistent manuscript output.
for (const [file, variable] of [['model-key', 'PO_MODEL_KEY'], ['lkm-key', 'BOHR_ACCESS_KEY']]) {
  if (existsSync(`/run/secrets/${file}`)) process.env[variable] = readFileSync(`/run/secrets/${file}`, 'utf8').trim();
}
if (existsSync('/run/secrets/text-config.json')) process.env.OPENCODE_CONFIG = '/run/secrets/text-config.json';
if (existsSync('/run/secrets/codex-auth.json')) {
  copyFileSync('/run/secrets/codex-auth.json', `${process.env.CODEX_HOME}/auth.json`);
  chmodSync(`${process.env.CODEX_HOME}/auth.json`, 0o600);
}
// Copy the explicitly selected bohr profile only, not tools, extensions or caches.
// Refuse links/special files rather than following them outside the profile mount.
let files = 0;
let bytes = 0;
function copyProfile(from, to, depth = 0) {
  if (depth > 8) throw new Error('Profile nesting exceeds limit');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    if (['tools', 'extensions', 'cache', 'logs', '.git'].includes(name)) continue;
    const stat = lstatSync(`${from}/${name}`);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Profile links/special files refused');
    if (stat.isDirectory()) copyProfile(`${from}/${name}`, `${to}/${name}`, depth + 1);
    else {
      if (++files > 256 || (bytes += stat.size) > 16 * 1024 * 1024) throw new Error('Profile exceeds size limit');
      copyFileSync(`${from}/${name}`, `${to}/${name}`);
      chmodSync(`${to}/${name}`, 0o600);
    }
  }
}
if (existsSync('/run/secrets/bohr-profile')) copyProfile('/run/secrets/bohr-profile', process.env.BOHR_CONFIG_DIR);
for (const [source, name] of [['hf-token', 'token'], ['hf-stored-tokens', 'stored_tokens']]) {
  if (existsSync(`/run/secrets/${source}`)) {
    copyFileSync(`/run/secrets/${source}`, `${process.env.HF_HOME}/${name}`);
    chmodSync(`${process.env.HF_HOME}/${name}`, 0o600);
  }
}
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Container command could not start\n'); process.exitCode = 127; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
