#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'run';
const userCommand = process.argv.slice(3);
if (userCommand[0] === '--') userCommand.shift();
if (!['run', 'resume', 'build', 'tools', 'services', 'exec'].includes(mode) || (mode !== 'exec' && userCommand.length) || (mode === 'exec' && !['bohr', 'hf', 'paper-orchestra'].includes(userCommand[0]))) {
  console.error('Usage: npm run test:docker -- [run|resume|build|tools|services] OR exec -- <bohr|hf|paper-orchestra> [args...]');
  process.exit(2);
}
const image = process.env.PO_DOCKER_IMAGE ?? 'paper-orchestra:e2e';
// Only discover standard identity paths; never open their contents on the host.
const defaultBohr = process.env.BOHR_CONFIG_DIR ?? join(homedir(), '.bohr-cli');
if (!process.env.PO_BOHR_CONFIG_DIR && existsSync(join(defaultBohr, 'config.yaml'))) process.env.PO_BOHR_CONFIG_DIR = defaultBohr;
const defaultHf = process.env.HF_HOME ?? join(homedir(), '.cache/huggingface');
if (!process.env.PO_HF_HOME && !process.env.PO_HF_TOKEN_FILE && existsSync(join(defaultHf, 'token'))) process.env.PO_HF_HOME = defaultHf;
if (process.getuid?.() === 0) throw new Error('Run the harness as a non-root user with Docker access');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const requestedOutput = process.env.PO_OUTPUT_DIR;
if (mode === 'resume' && !requestedOutput) throw new Error('resume requires PO_OUTPUT_DIR');
const output = resolve(requestedOutput ?? join(root, 'docker-output', `${stamp}-${process.pid}`));
// The only writable host bind must be a dedicated directory, never the repository or HOME.
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
if (inside(output, root) || output === process.env.HOME || output === '/' || output.includes(',')) throw new Error('Unsafe output directory');
const outputRoot = join(root, 'docker-output');
if (inside(root, output) && (!inside(outputRoot, output) || output === outputRoot)) throw new Error('Repository outputs must be dedicated children of docker-output');
const protectedPaths = [
  process.env.PO_MATERIALS_DIR ?? join(root, 'datasets/gewu-issue48/input'),
  process.env.PO_BRIEF_FILE ?? join(root, 'datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md'),
  ...['PO_TEXT_CONFIG_FILE', 'PO_MODEL_KEY_FILE', 'PO_OAUTH_PROVIDER_FILE', 'PO_TEXT_AUTH_FILE',
    'PO_CODEX_AUTH_FILE', 'PO_LKM_KEY_FILE', 'PO_BOHR_CONFIG_DIR', 'PO_HF_HOME', 'PO_HF_TOKEN_FILE']
    .map((name) => process.env[name]).filter(Boolean),
];
for (const path of protectedPaths) {
  if (inside(resolve(path), output) || inside(output, resolve(path))) throw new Error('Output overlaps an input, provider, or credential mount');
}
if (existsSync(output) && !['resume', 'exec'].includes(mode)) throw new Error('Output already exists; choose a new PO_OUTPUT_DIR or explicit resume/exec');
if (existsSync(output) && (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output)) throw new Error('Output must not be symlinked');
mkdirSync(output, { recursive: true, mode: 0o700 });
if (realpathSync(output) !== output) throw new Error('Output ancestors must not be symlinked');
const report = { schema_version: 1, kind: 'docker-real-cli-acceptance', mode, image, output, started_at: new Date().toISOString(), ok: false, steps: [] };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
if (['resume', 'exec'].includes(mode) && existsSync(join(output, 'acceptance.json'))) {
  // Retain previous attempt evidence; no previous manuscript/artifact is removed.
  writeFileSync(join(output, `acceptance-${stamp}.json`), readFileSync(join(output, 'acceptance.json')));
}
save();
console.log(`Image: ${image}\nOutput: ${output}`);
let exit = 0;
function docker(name, args, timeout = 1800000, capture = false) {
  const start = Date.now();
  const result = spawnSync('docker', args, { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const code = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 1);
  report.steps.push({ name, exit_code: code, signal: result.signal, duration_ms: Date.now() - start });
  save();
  return { code, stdout: result.stdout };
}
function mounted(path, target, directory = false) {
  const absolute = resolve(path);
  // Stat paths only; the host harness never opens any secret/config file.
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute || (directory ? !stat.isDirectory() : !stat.isFile()) || absolute.includes(',')) throw new Error(`Invalid mount for ${target}`);
  if (directory && (inside(absolute, root) || absolute === process.env.HOME)) throw new Error(`Overbroad mount for ${target}`);
  return ['--mount', `type=bind,src=${absolute},dst=${target},readonly`];
}
function bounded(name, fallback, min, max) {
  const value = process.env[name] ?? fallback;
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return String(value);
}
const uid = process.getuid?.() || 1000;
const gid = process.getgid?.() || 1000;
const isolation = ['--rm', '--init', '--user', `${uid}:${gid}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=8g', '--cpus=4', '--tmpfs', '/tmp:rw,nosuid,nodev,size=2g', '--tmpfs', `/home/runner:rw,nosuid,nodev,uid=${uid},gid=${gid},mode=700,size=2g`];
try {
  const network = process.env.PO_DOCKER_NETWORK ?? 'bridge';
  if (!/^[A-Za-z0-9_.-]+$/.test(network) || network === 'host') throw new Error('PO_DOCKER_NETWORK must be bridge, none or a named Docker network, never host/container networking');
  report.network = network;
  exit = docker('build', ['build', '--progress=plain', '--tag', image, '.']).code;
  if (!exit) {
    const info = docker('image-id', ['image', 'inspect', '--format', '{{.Id}}', image], 30000, true);
    exit = info.code;
    report.image_id = info.stdout?.trim();
  }
  if (!exit && mode === 'tools') {
    // No secret mounts. Online by default, but no model prompts or paid retrieval.
    for (const args of [['paper-orchestra', '--help'], ['opencode', '--version'], ['codex', '--version'], ['bohr', '--version'], ['hf', 'version'], ['pdflatex', '--version'], ['bibtex', '--version'], ['pdftotext', '-v'], ['pdftoppm', '-v'], ['python3', '-c', 'import numpy, matplotlib; print(numpy.__version__, matplotlib.__version__)'], ['paper-orchestra', 'doctor']]) {
      const result = docker(args.join(' '), ['run', ...isolation, `--network=${network}`, image, ...args], 120000);
      exit ||= result.code;
    }
  }
  if (!exit && ['run', 'resume', 'services', 'exec'].includes(mode)) {
    const live = ['run', 'resume'].includes(mode);
    if (Boolean(process.env.PO_OAUTH_PROVIDER_FILE) !== Boolean(process.env.PO_TEXT_AUTH_FILE)) throw new Error('OAuth text mode requires both PO_OAUTH_PROVIDER_FILE and PO_TEXT_AUTH_FILE');
    if (live && (!process.env.PO_MODEL || !process.env.PO_TEXT_CONFIG_FILE || !process.env.PO_CODEX_AUTH_FILE || !(process.env.PO_LKM_KEY_FILE || process.env.PO_BOHR_CONFIG_DIR))) throw new Error('Live acceptance requires PO_MODEL, PO_TEXT_CONFIG_FILE, PO_CODEX_AUTH_FILE and PO_LKM_KEY_FILE or PO_BOHR_CONFIG_DIR; no credential discovery is performed');
    if (live && process.env.PO_ALLOW_PAID !== '1') throw new Error('Set PO_ALLOW_PAID=1 to authorize real model/image/LKM spending');
    if (mode === 'services' && (!(process.env.PO_BOHR_CONFIG_DIR || process.env.PO_LKM_KEY_FILE) || !(process.env.PO_HF_HOME || process.env.PO_HF_TOKEN_FILE))) throw new Error('services requires an explicit bohr profile/key and HF home/token path');
    if (mode === 'resume' && !existsSync(join(output, 'workspace/.po-run/run.json'))) throw new Error('No resumable workspace in PO_OUTPUT_DIR');
    const materials = process.env.PO_MATERIALS_DIR ?? join(root, 'datasets/gewu-issue48/input');
    const brief = process.env.PO_BRIEF_FILE ?? join(root, 'datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md');
    if (inside(resolve(materials), output) || inside(output, resolve(materials))) throw new Error('Materials and output must be disjoint');
    const mounts = [...mounted(materials, '/materials', true), ...mounted(brief, '/run/brief.md')];
    for (const [env, name] of [['PO_TEXT_CONFIG_FILE', 'text-config.json'], ['PO_MODEL_KEY_FILE', 'model-key'], ['PO_TEXT_AUTH_FILE', 'text-auth.json'], ['PO_CODEX_AUTH_FILE', 'codex-auth.json'], ['PO_LKM_KEY_FILE', 'lkm-key']]) {
      if (process.env[env]) mounts.push(...mounted(process.env[env], `/run/secrets/${name}`));
    }
    const profiles = [];
    if (process.env.PO_OAUTH_PROVIDER_FILE) {
      mounts.push(...mounted(process.env.PO_OAUTH_PROVIDER_FILE, '/opt/po-provider/codex-oauth.mjs'));
      profiles.push({ setting: 'PO_OAUTH_PROVIDER_FILE', mount: '/opt/po-provider/codex-oauth.mjs', readonly: true });
      profiles.push({ setting: 'PO_TEXT_AUTH_FILE', mount: '/run/secrets/text-auth.json', readonly: true });
    }
    report.text_auth_route = process.env.PO_OAUTH_PROVIDER_FILE ? 'governed-oauth' : 'configured-api';
    if (process.env.PO_BOHR_CONFIG_DIR) {
      mounts.push(...mounted(process.env.PO_BOHR_CONFIG_DIR, '/run/secrets/bohr-profile', true));
      profiles.push({ setting: 'PO_BOHR_CONFIG_DIR', mount: '/run/secrets/bohr-profile', runtime: '/home/runner/.bohr', readonly: true });
    }
    // HF_HOME often contains enormous model/data caches. Mount identity files only.
    const hfToken = process.env.PO_HF_TOKEN_FILE ?? (process.env.PO_HF_HOME ? join(process.env.PO_HF_HOME, 'token') : undefined);
    if (hfToken) {
      mounts.push(...mounted(hfToken, '/run/secrets/hf-token'));
      profiles.push({ setting: process.env.PO_HF_TOKEN_FILE ? 'PO_HF_TOKEN_FILE' : 'PO_HF_HOME', mount: '/run/secrets/hf-token', runtime: '/home/runner/.cache/huggingface/token', readonly: true });
    }
    if (process.env.PO_HF_HOME && existsSync(join(process.env.PO_HF_HOME, 'stored_tokens'))) {
      mounts.push(...mounted(join(process.env.PO_HF_HOME, 'stored_tokens'), '/run/secrets/hf-stored-tokens'));
      profiles.push({ setting: 'PO_HF_HOME', mount: '/run/secrets/hf-stored-tokens', runtime: '/home/runner/.cache/huggingface/stored_tokens', readonly: true });
    }
    report.profiles = profiles;
    const knobs = {
      ...(process.env.PO_MODEL ? { PO_MODEL: process.env.PO_MODEL } : {}),
      PO_RESUME: mode === 'resume' ? '1' : '0',
      PO_TIMEOUT_SECONDS: bounded('PO_TIMEOUT_SECONDS', '7200', 60, 86400),
      PO_MAX_LKM_CALLS: bounded('PO_MAX_LKM_CALLS', '10', 0, 100),
      PO_TARGET_CITATIONS: bounded('PO_TARGET_CITATIONS', '5', 5, 100),
      PO_TIMEOUT_MULTIPLIER: bounded('PO_TIMEOUT_MULTIPLIER', '1', 0.1, 10),
      PO_RESEARCH_CUTOFF: process.env.PO_RESEARCH_CUTOFF ?? '2026-09',
    };
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(knobs.PO_RESEARCH_CUTOFF)) throw new Error('PO_RESEARCH_CUTOFF must be YYYY-MM');
    for (const name of ['PO_MAX_LKM_CALLS', 'PO_TARGET_CITATIONS']) {
      if (!Number.isInteger(Number(knobs[name]))) throw new Error(`${name} must be an integer`);
    }
    for (const [name, fallback, max, integer] of [
      ['PO_MAX_TOTAL_TOKENS', '8000000', 100000000, true], ['PO_MAX_TOTAL_COST', '100', 10000, false],
      ['PO_MAX_MODEL_CALLS', '80', 10000, true], ['PO_MAX_IMAGE_CALLS', '12', 1000, true],
      ['PO_MAX_OPERATION_CALLS', '64', 10000, true], ['PO_MAX_RUN_MINUTES', '120', 1440, false],
    ]) {
      knobs[name] = bounded(name, fallback, 0, max);
      if (integer && !Number.isInteger(Number(knobs[name]))) throw new Error(`${name} must be an integer`);
    }
    const container = `po-acceptance-${process.pid}-${Date.now()}`;
    if (mode === 'resume' && process.env.PO_MAX_TOTAL_TOKENS !== undefined) {
      knobs.PO_RESUME_MAX_TOTAL_TOKENS = knobs.PO_MAX_TOTAL_TOKENS;
    }
    const env = Object.entries(knobs).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    report.knobs = knobs;
    report.budget_application = mode === 'run' ? 'fresh-write-flags' : mode === 'resume'
      ? (knobs.PO_RESUME_MAX_TOTAL_TOKENS ? 'persisted-scope-with-explicit-token-increase' : 'persisted-scope') : 'user-argv-only';
    const command = live ? ['node', '/opt/acceptance/acceptance.mjs'] : ['node', '/opt/acceptance/user-command.mjs', mode, ...userCommand];
    exit = docker(live ? 'real-cli' : mode, ['run', ...isolation, `--network=${network}`, '--name', container, ...mounts, '--mount', `type=bind,src=${output},dst=/output`, ...env, image, ...command], mode === 'services' ? 300000 : Number(knobs.PO_TIMEOUT_SECONDS) * 1000 + 180000).code;
    // A timed-out Docker client does not reliably terminate its container.
    if (exit) docker('stop-after-failure', ['stop', '--time=10', container], 30000, true);
    const record = live ? 'runtime-acceptance.json' : `${mode}-acceptance.json`;
    if (existsSync(join(output, record))) report.runtime = JSON.parse(readFileSync(join(output, record), 'utf8'));
    if (!exit && live) {
      const rebuild = join(output, `recompile-${stamp}`);
      mkdirSync(rebuild, { mode: 0o700 });
      exit = docker('independent-recompile', ['run', ...isolation, '--network=none', ...mounted(join(output, 'workspace/submission'), '/submission', true), '--mount', `type=bind,src=${rebuild},dst=/output`, image, 'node', '/opt/acceptance/recompile.mjs'], 960000).code;
      if (existsSync(join(rebuild, 'recompile-acceptance.json'))) report.recompile = JSON.parse(readFileSync(join(rebuild, 'recompile-acceptance.json'), 'utf8'));
    }
  }
} catch (error) {
  exit ||= 2;
  report.error = error.message;
  console.error(error.message);
}
report.manuscript_accepted = exit === 0 && ['run', 'resume'].includes(mode) && report.runtime?.ok === true && report.recompile?.ok === true;
report.ok = ['run', 'resume'].includes(mode) ? report.manuscript_accepted : exit === 0;
report.command_ok = exit === 0;
report.exit_code = exit;
report.finished_at = new Date().toISOString();
save();
console.log(`${['run', 'resume'].includes(mode) ? 'Manuscript acceptance' : `${mode} verification`}: ${report.ok ? 'PASS' : 'NOT PASSED'} (${join(output, 'acceptance.json')})`);
process.exitCode = exit;
