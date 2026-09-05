import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2];
const report = { schema_version: 1, kind: mode, ok: false, started_at: new Date().toISOString(), steps: [] };
const destination = `/output/${mode}-acceptance.json`;
const save = () => writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
const dataset = 'Jack-Jieke-Wu/Gewu-Solutions';
const revision = '576302afd4bc95cd3b3ed809f4822c611a1ea95f';
const commands = mode === 'services' ? [
  ['bohr-identity', 'bohr', ['auth', 'whoami', '--no-interactive', '-o', 'json']],
  ['bohr-account-read', 'bohr', ['billing', 'balance', '--no-interactive', '-o', 'json']],
  ['hf-identity', 'hf', ['auth', 'whoami', '--format', 'json']],
  ['hf-dataset-info', 'hf', ['datasets', 'info', dataset, '--revision', revision, '--expand', 'sha', '--format', 'json']],
] : [['user-command', process.argv[3], process.argv.slice(4)]];
let exit = 0;
for (const [name, command, args] of commands) {
  const start = Date.now();
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: mode === 'services' ? 60000 : Number(process.env.PO_TIMEOUT_SECONDS) * 1000 });
  const code = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 1);
  let valid = code === 0;
  if (valid && mode === 'services') {
    try {
      const data = JSON.parse(result.stdout);
      if (command === 'bohr') valid = data.ok === true && data.data != null;
      else if (name === 'hf-dataset-info') valid = data.id === dataset && data.sha === revision;
      else valid = typeof data.user === 'string' && data.user.length > 0;
    } catch { valid = false; }
  }
  const status = { name, executable: command, exit_code: code, passed: valid, duration_ms: Date.now() - start };
  if (valid && name === 'hf-dataset-info') status.resource = { id: dataset, revision };
  report.steps.push(status);
  // Deliberately discard ALL raw auth/API/exec output and user args. Even valid
  // JSON can contain access keys, billing data, signed URLs or private identities.
  exit ||= code || (valid ? 0 : 2);
  save();
  process.stdout.write(`${name}: ${valid ? 'passed' : 'failed'} (exit ${code})\n`);
}
report.ok = exit === 0;
report.exit_code = exit;
report.finished_at = new Date().toISOString();
save();
process.exitCode = exit;
