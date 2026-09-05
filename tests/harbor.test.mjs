import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('Harbor preserves failure, generation flags, and explicit partial labeling', () => {
  const output = execFileSync('python3', ['-c', String.raw`
import asyncio
import importlib.util
import logging
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import json

for name in ['typing_extensions', 'harbor', 'harbor.agents', 'harbor.agents.installed',
             'harbor.agents.installed.base', 'harbor.agents.installed.node_install',
             'harbor.environments', 'harbor.environments.base', 'harbor.models',
             'harbor.models.agent', 'harbor.models.agent.context']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['typing_extensions'].override = lambda fn: fn
class Base:
    def __init__(self, **kwargs):
        self.model_name = 'test/model'
        self.logger = logging.getLogger('test')
sys.modules['harbor.agents.installed.base'].BaseInstalledAgent = Base
sys.modules['harbor.agents.installed.node_install'].nvm_node_install_snippet = lambda: ''
sys.modules['harbor.environments.base'].BaseEnvironment = object
sys.modules['harbor.models.agent.context'].AgentContext = object
spec = importlib.util.spec_from_file_location('adapter', 'paper_orchestra/agent.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

async def exercise():
    for fail in (False, True):
        agent = m.PaperOrchestra(use_plotting='false' if fail else 'true')
        commands, mappings = [], []
        async def provision(env): return {}
        async def execute(environment, command, **kwargs):
            commands.append(command)
            if ' | stdbuf' in command and fail:
                raise RuntimeError('pipeline exit 7')
        async def mapping(env, failed=False): mappings.append(failed)
        agent._provision_credentials = provision
        agent.exec_as_agent = execute
        agent._map_submission = mapping
        try:
            await agent.run("brief\nPO_EOF\n$(false)", None, None)
            assert not fail
        except RuntimeError as error:
            assert fail and str(error) == 'pipeline exit 7'
        assert mappings == [fail]
        assert 'set -eo pipefail;' in commands[-1]
        assert ('--no-plotting ' if fail else '--use-plotting ') in commands[-1]
        assert "printf '%s\\n'" in commands[0]
    pipeline = subprocess.run(['bash', '-c', 'set -eo pipefail; (exit 7) | tee /dev/null'])
    assert pipeline.returncode == 7

    for final, failed, state in [(False, False, 'failed'), (True, True, 'completed'),
                                  (True, False, 'completed'), (True, False, 'prepared')]:
        with tempfile.TemporaryDirectory(dir='/tmp/opencode', prefix='harbor-test-') as tmp:
            root = Path(tmp)
            ws = root / 'workspace/po-run-harbor'
            manuscript = ws / '.brain/manuscript'
            manuscript.mkdir(parents=True)
            (manuscript / ('final_paper.tex' if final else 'raw_draft.tex')).write_text('synthetic test draft')
            if final:
                (manuscript / 'final_paper.pdf').write_bytes(b'%PDF-synthetic-test')
            portable = final and not failed and state == 'completed'
            if portable:
                export = ws / 'submission'
                (export / 'tables').mkdir(parents=True)
                (export / 'main.tex').write_text('portable synthetic source')
                (export / 'final.pdf').write_bytes(b'%PDF-synthetic-test')
                (export / 'tables/results.tex').write_text('synthetic table')
            logs = root / 'logs/agent'
            logs.mkdir(parents=True)
            (logs / 'paper-orchestra.jsonl').write_text(json.dumps({'type': 'result', 'run_state': state}))
            agent = m.PaperOrchestra()
            async def shell(env, command, **kwargs):
                command = command.replace('/workspace', str(root / 'workspace')).replace('/logs/agent', str(logs))
                subprocess.run(['bash', '-c', command], check=True, capture_output=True)
            agent.exec_as_agent = shell
            await agent._map_submission(None, failed=failed)
            sub = root / 'workspace/submission'
            status = json.loads((sub / 'submission-status.json').read_text())
            assert status['status'] == ('completed' if final and not failed and state == 'completed' else 'partial')
            assert (sub / 'final_paper.pdf').exists() == final
            if portable:
                assert (sub / 'main.tex').read_text() == 'portable synthetic source'
                assert (sub / 'tables/results.tex').is_file()
asyncio.run(exercise())
print('adapter checks passed')
`], { encoding: 'utf8' });
  assert.match(output, /adapter checks passed/);
});

test('Local evaluator preserves frozen gates and maps portable/legacy exports without mutating trials', {
  skip: !existsSync('datasets/gewu-issue48/manifest.json'),
}, () => {
  const output = execFileSync('python3', ['-c', String.raw`
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile

spec = importlib.util.spec_from_file_location('evaluation', 'scripts/evaluate-gewu.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
verifier = m.DATA / 'benchmark/gewu-kerr-no-assets/tests/verify.py'
before = m.sha(verifier)
with tempfile.TemporaryDirectory(dir='/tmp/opencode', prefix='gewu-evaluation-') as tmp:
    root = Path(tmp)
    trial = root / 'trial'
    shutil.copytree(m.DATA / 'input', trial / 'source')
    shutil.copyfile(m.DATA / 'benchmark/gewu-kerr-no-assets/instruction.md', trial / 'source/BRIEF.md')
    (trial / '.po-run').mkdir()
    state = trial / '.po-run/run.json'
    state.write_text(json.dumps({'status': 'running', 'run_id': 'synthetic'}))
    def evaluate(name):
        args = argparse.Namespace(workspace=trial, input=m.DATA / 'input', output=root / name)
        with contextlib.redirect_stdout(io.StringIO()):
            code = m.evaluate(args)
        return code, json.loads((args.output / 'evaluation.json').read_text())
    code, report = evaluate('pending')
    assert code == 2 and report['status'] == 'pending'
    assert not (root / 'pending/workspace').exists()
    manuscript = trial / '.brain/manuscript'
    manuscript.mkdir(parents=True)
    (manuscript / 'final_paper.tex').write_text('internal source must not override portable export')
    export = trial / 'submission'
    (export / 'tables').mkdir(parents=True)
    (export / 'main.tex').write_text('synthetic incomplete source')
    (export / 'final.pdf').write_bytes(b'%PDF-synthetic-invalid')
    (export / 'tables/results.tex').write_text('synthetic table')
    state.write_text(json.dumps({'status': 'completed', 'run_id': 'synthetic'}))
    original = {str(p.relative_to(trial)): m.sha(p) for p in trial.rglob('*') if p.is_file()}
    code, report = evaluate('terminal')
    assert code == 1 and report['status'] == 'failed'
    assert report['mapping_mode'] == 'cli_export'
    assert report['checks']['completed_submission'] and not report['checks']['new_pdf']
    mapped = root / 'terminal/workspace/submission'
    assert (mapped / 'main.tex').read_text() == 'synthetic incomplete source'
    assert (mapped / 'final_paper.pdf').read_bytes() == (export / 'final.pdf').read_bytes()
    assert (mapped / 'tables/results.tex').is_file()
    assert original == {str(p.relative_to(trial)): m.sha(p) for p in trial.rglob('*') if p.is_file()}
    (export / 'final_paper.pdf').write_bytes(b'conflicting output')
    code, report = evaluate('conflict')
    assert code == 2 and report['status'] == 'error' and 'disagree' in report['reason']
    legacy = root / 'legacy'
    (legacy / '.brain/manuscript/tables').mkdir(parents=True)
    (legacy / '.brain/manuscript/final_paper.tex').write_text(r'\bibliography{../raw/references}')
    (legacy / '.brain/manuscript/tables/result.tex').write_text('synthetic legacy table')
    mode, mappings = m.map_submission(legacy, root / 'legacy-export')
    assert mode == 'legacy_layout'
    assert (root / 'legacy-export/main.tex').read_text() == r'\bibliography{references}'
    assert (root / 'legacy-export/tables/result.tex').is_file()
assert m.sha(verifier) == before
print('local evaluator checks passed')
`], { encoding: 'utf8' });
  assert.match(output, /local evaluator checks passed/);
});
