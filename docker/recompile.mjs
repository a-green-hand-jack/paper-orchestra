import { cpSync, existsSync, readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const report = { schema_version: 1, kind: 'independent-recompile', ok: false, steps: [] };
let exit = 0;
try {
  const check = directory => {
    for (const name of readdirSync(directory)) {
      const path = `${directory}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Nonportable export');
      if (stat.isDirectory()) check(path);
    }
  };
  check('/submission');
  cpSync('/submission', '/output/build', { recursive: true, filter: path => !/\.(?:pdf|aux|bbl|bcf|blg|log|out|toc|fls|fdb_latexmk)$/.test(path) || /\/figures\//.test(path) });
  // Preserve all source figures (including PDFs outside figures/) but never a prebuilt main PDF.
  const copyPdfs = (directory, relative = '') => {
    for (const name of readdirSync(directory)) {
      const rel = relative ? `${relative}/${name}` : name;
      if (lstatSync(`${directory}/${name}`).isDirectory()) copyPdfs(`${directory}/${name}`, rel);
      else if (name.endsWith('.pdf') && !['main.pdf', 'final.pdf', 'final_paper.pdf'].includes(rel)) cpSync(`${directory}/${name}`, `/output/build/${rel}`);
    }
  };
  copyPdfs('/submission');
  for (const [command, args] of [
    ['latexmk', ['-norc', '-pdf', '-bibtex', '-pdflatex=pdflatex -no-shell-escape -halt-on-error -interaction=nonstopmode %O %S', 'main.tex']],
    ['pdfinfo', ['main.pdf']],
    ['pdftotext', ['main.pdf', 'main.txt']],
  ]) {
    const result = spawnSync(command, args, { cwd: '/output/build', encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    const code = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 1);
    report.steps.push({ command: [command, ...args], exit_code: code });
    writeFileSync(`/output/${command}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (code) { exit = code; break; }
  }
  if (!exit && (!existsSync('/output/build/main.pdf') || !readFileSync('/output/build/main.txt', 'utf8').trim())) exit = 2;
} catch { exit ||= 1; }
report.ok = exit === 0;
report.exit_code = exit;
writeFileSync('/output/recompile-acceptance.json', JSON.stringify(report, null, 2) + '\n');
process.exitCode = exit;
