import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const report = { schema_version: 1, kind: 'real-cli', ok: false, started_at: new Date().toISOString(), steps: [] };
const save = () => writeFileSync('/output/runtime-acceptance.json', JSON.stringify(report, null, 2) + '\n');
function run(name, args) {
  const start = Date.now();
  const result = spawnSync('paper-orchestra', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: Number(process.env.PO_TIMEOUT_SECONDS) * 1000 });
  const code = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 1);
  report.steps.push({ name, command: ['paper-orchestra', ...args], exit_code: code, signal: result.signal, duration_ms: Date.now() - start });
  save();
  // Do not persist arbitrary provider stdout/stderr: they may contain auth diagnostics.
  process.stdout.write(`${name}: exit ${code}\n`);
  return { code, stdout: result.stdout ?? '' };
}
let exit = run('doctor', ['doctor', '--model', process.env.PO_MODEL]).code;
if (!exit) {
  const args = process.env.PO_RESUME === '1'
    ? ['resume', '/output/workspace', '--headless', '--json', '--allow-lkm-spend']
    : ['write', '/materials', '--brief', '/run/brief.md', '--output', '/output/workspace', '--headless', '--json', '--mode', 'autonomous', '--allow-lkm-spend', '--model', process.env.PO_MODEL, '--max-lkm-calls', process.env.PO_MAX_LKM_CALLS, '--target-citations', process.env.PO_TARGET_CITATIONS, '--research-cutoff', process.env.PO_RESEARCH_CUTOFF, '--timeout-multiplier', process.env.PO_TIMEOUT_MULTIPLIER];
  if (process.env.PO_RESUME !== '1') {
    for (const [env, flag] of [['PO_MAX_TOTAL_TOKENS', '--max-total-tokens'], ['PO_MAX_TOTAL_COST', '--max-total-cost'], ['PO_MAX_MODEL_CALLS', '--max-model-calls'], ['PO_MAX_IMAGE_CALLS', '--max-image-calls'], ['PO_MAX_OPERATION_CALLS', '--max-operation-calls'], ['PO_MAX_RUN_MINUTES', '--max-run-minutes']]) {
      if (process.env[env]) args.push(flag, process.env[env]);
    }
  } else if (process.env.PO_RESUME_MAX_TOTAL_TOKENS) {
    args.push('--max-total-tokens', process.env.PO_RESUME_MAX_TOTAL_TOKENS);
  }
  const writing = run(process.env.PO_RESUME === '1' ? 'resume' : 'write', args);
  exit = writing.code;
  const status = run('status', ['status', '/output/workspace', '--json']);
  const validation = run('validate', ['validate', '/output/workspace', '--json']);
  exit ||= status.code || validation.code;
  try {
    const state = JSON.parse(status.stdout);
    report.status = { status: state.status, totals: state.totals, stages: state.stages.map(({ id, status }) => ({ id, status })) };
    report.validation = JSON.parse(validation.stdout).checks.map(({ name, passed, advisory }) => ({ name, passed, advisory }));
    const result = writing.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).at(-1);
    report.submission_ready = result?.submission_ready === true;
    report.export_present = ['main.tex', 'references.bib', 'final.pdf', 'README.md'].every(file => existsSync(`/output/workspace/submission/${file}`));
    if (state.status !== 'completed' || !report.submission_ready || !report.export_present) exit ||= 2;
  } catch { exit ||= 2; }
}
report.ok = exit === 0;
report.exit_code = exit;
report.finished_at = new Date().toISOString();
save();
process.exitCode = exit;
