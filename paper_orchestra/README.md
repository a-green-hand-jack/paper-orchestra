# PaperOrchestra as a Harbor agent

Runs PaperOrchestra as a Harbor agent, so the benchmark drives it the way it
drives every other agent.

Install once, into Harbor's own environment -- it lives in an isolated
`uv tool` venv and cannot otherwise see this repository:

```bash
uv pip install -e . --python "$(dirname "$(readlink -f "$(which harbor)")")/python"
```

Editable, so the adapter that runs is the one in the checkout. Then, from
anywhere:

```bash
harbor run \
  --agent paper_orchestra:PaperOrchestra \
  --model openai/gpt-5.6-sol \
  -p datasets/paper-writing-exam/paperwrite-bench-short/pwb-0001 \
  --agent-timeout-multiplier 2.5
```

`--agent-timeout-multiplier` is needed because these tasks give an agent one
hour and PaperOrchestra's stage budgets sum to 145 minutes. That mismatch is
worth knowing rather than hiding: a pipeline that validates and remediates each
stage is slower than a single agent loop, and the tasks were written for the
latter.

## What the adapter does, and what it refuses to do

Install, credentials, invoke, and map the finished workspace onto the task's
submission contract. All mechanical.

It does **not** prepare the input. No pointing at a template, no naming a
document, no writing a guidelines file. If it ever appears to need to, that is
a capability missing from PaperOrchestra and it belongs there -- the whole
reason to run under Harbor is that the container gives the agent `/workspace`
and nobody the chance to tidy it first. Preparing workspaces by hand is how a
9-page limit got invented for a task whose brief says 11.

## Credentials

Forwards `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`,
and `BOHRIUM_PROJECT_ID` when the host has them, and
uploads `~/.local/share/opencode/auth.json` when it exists -- an OAuth login
has no key to forward, so the credential file itself has to travel. Same
approach as Harbor's own Codex adapter.

With `--ak allow_lkm_spend=true`, forwards `BOHR_ACCESS_KEY` (also accepts the
legacy host name `BOHRIUM_ACCESS_KEY`) and installs the Bohrium CLI. Without
Bohrium credentials the paid literature stage cannot retrieve, so start with
tasks that supply a `references.bib` (`paperwrite-bench-short`,
`lifesci-paperrecon-short`): those take the zero-spend path and exercise
template discovery and the supplied-bibliography path at once.

## Installation

`npm pack` of the working copy, uploaded and installed with
`npm install -g <tarball>`. Packing matters: npm symlinks a local *directory*,
so installing one leaves the container pointing at a path that is not there.
`scripts/install.sh` takes the same route for the same reason.

Packing from the working copy rather than a tag is deliberate -- a run should
measure the code in front of us.

## The instruction

Harbor renders `instruction.md`; the adapter saves it to
`/logs/agent/instruction.md` and passes it through `--brief`. Shell quoting keeps
the instruction data, not executable shell syntax.

The writing pipeline runs with `pipefail`, so `tee` cannot conceal failure.
On failure, available artifacts are retained with a `partial` status and the
original exception propagates. `submission-status.json` requires a completed
pipeline result plus final TeX/PDF before reporting `completed`; a raw-draft
fallback never qualifies. The final PDF is copied into the submission.

## Generation Configuration

`--ak use_plotting=true` is the default and explicitly enables generation.
`--ak use_plotting=false` passes `--no-plotting`. The adapter installs system
Python/matplotlib when plotting is enabled. Quantitative plots use code; image
generation must never substitute for numerical plotting.

For conceptual diagrams, use `--ak image_adapter=/container/path/to/executable`
to set `PAPER_ORCHESTRA_IMAGE_ADAPTER`. The task image or an explicit mount must
provide that executable and its dependencies. This is a **container-side** path;
the adapter does not copy arbitrary host executables or Codex credentials.
Without an external adapter, the product currently needs Codex with ChatGPT
OAuth and enabled `image_generation`, using `openai-codex-oauth/gpt-image-2`.
OpenCode authentication alone does not satisfy that requirement. Check image
capability in the execution environment before spending on the writing run.

## Gewu Issue48

From this repository root, prepare the private dataset using an already
authenticated `hf` CLI (no token arguments or credential dumps):

```bash
python3 scripts/prepare-gewu.py
```

This downloads only an explicit raw-file allowlist at revision
`576302afd4bc95cd3b3ed809f4822c611a1ea95f`, approximately 78 KB including the
dataset card and manifest. Assets live durably under the already ignored
`datasets/gewu-issue48/`. Rerunning verifies pinned content and refuses to
overwrite changed assets. No archive is needed: all archives are excluded,
with no extraction code or tar traversal/link attack surface.

Chosen solution: `lewton-agent_kerrDeflection-solution__57b47284`. The dataset
manifest lists it as accepted; its supplied numerical/symbolic audit records
`ALL_CHECKS_PASS = True` and `DERIVATION_CHECKS_PASS = True`. This is **raw
validation PASSED**, not an independently verified live journal `PASSED` label:
the preserved `problem.yaml` says `candidate`.

The input preserves all seven empirical CSV files, numerical Python sources,
run logs, research/reproduction notes, and problem/rubric metadata. The main CSV
has 60 rays, five orientations, and 12 impact parameters from 80 to 1160; the
preparer checks residual extrema against the summary CSV. No integration or
model is run. Finished PDFs/TeX, extracted paper text, bibliography, prebuilt
figures, notebooks, and unused support files are excluded. Notes may contain
links to excluded papers; the fixed brief explicitly forbids following them.

`manifest.json` records revision, acceptance/pass evidence, every inclusion and
exclusion within the selected solution, downloaded SHA-256 and remote Git blob
hashes, and hashes of the frozen task/instruction/verifier. Excluded content is
not read to manufacture SHA-256 values; its remote Git blob hash is recorded.

- Input: `datasets/gewu-issue48/input`
- Brief: `datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md`
- Harbor task: `datasets/gewu-issue48/benchmark/gewu-kerr-no-assets`

The fixed gates require a new compiled 6-12 page PDF, standalone source,
five references, structured sections, raw numeric anchors, unchanged input,
and a new quantitative plot plus an image-generated conceptual diagram, both
with provenance and passing visual reviews. Automated reward does not replace
human scientific/visual review or certify publication readiness.

After the primary run owner has provisioned text-model access, container image
generation, TeX, and explicitly authorized paid literature retrieval:

```bash
harbor run --agent paper_orchestra:PaperOrchestra \
  --model "$TEXT_MODEL" \
  -p datasets/gewu-issue48/benchmark/gewu-kerr-no-assets \
  --ak use_plotting=true --ak image_adapter="$CONTAINER_IMAGE_ADAPTER" \
  --ak allow_lkm_spend=true --ak max_lkm_calls=10 --ak target_citations=5 \
  --ak research_cutoff=2026-09 \
  --artifact /workspace/submission --artifact /workspace/po-run-harbor \
  --jobs-dir datasets/gewu-issue48/jobs --n-concurrent 1
```

Set those two non-secret model/path variables to the approved execution
configuration. The image adapter must already exist inside the task container
(custom task image or explicit mount); the generated base image does not ship
one. Without that provisioning the image requirement is blocked, not optional.
The command above is a future run command, not part of preparation.

A local run, with host-side image support, uses the same locked brief:

```bash
npm run build
node dist/cli.js doctor
node dist/cli.js write datasets/gewu-issue48/input \
  --brief datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md \
  --model "$TEXT_MODEL" --use-plotting --headless --json \
  --allow-lkm-spend --max-lkm-calls 10 --target-citations 5 \
  --research-cutoff 2026-09 -o datasets/gewu-issue48/po-run-local
```

The local command does not perform Harbor submission mapping itself; use the
local evaluator below or the Harbor adapter. Neither writing command should be
launched before the required image capability and paid-retrieval authorization
are in place.

### Local Evaluation Without Docker

The local evaluator now supplies the mechanical Harbor layout without needing
Docker or changing the frozen verifier:

```bash
python3 scripts/evaluate-gewu.py \
  --workspace datasets/gewu-issue48/run \
  --output datasets/gewu-issue48/evaluations/current-final
```

Run this after the primary owner's model run finishes. The output directory
must be new; omit `--output` for a unique timestamped directory. Exit codes are
`0` for all frozen checks passing, `1` for a graded failure, and `2` for a
pending run or evaluation/setup error. `evaluation.json` distinguishes those
states and records each check, reward, model/run configuration, input and
brief identity, verifier hash, and file mapping. A running/prepared/gated trial
is reported as pending without copying or inspecting its manuscript.

For a terminal trial the evaluator copies the actual CLI `submission/`, retains
tables and support files, aliases `final.pdf` to `final_paper.pdf`, and refuses
conflicting PDF aliases. Completion comes from `.po-run/run.json`, not mere
file existence. It copies plotting provenance without inventing reviews and
runs the unchanged verifier on a separate export; the live trial is untouched.
The original raw directory occupies the Harbor input location. Files omitted
by CLI importing are recorded separately (the current importer skips
`run_verified_nb_final_audit_run.txt`); they are not silently deleted from the
verifier's original-input hash contract. Imported files must match the originals.

For direct reproduction of the verifier invocation after mapping:

```bash
python3 datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/tests/verify.py \
  --workspace datasets/gewu-issue48/evaluations/current-final/workspace \
  --logs datasets/gewu-issue48/evaluations/current-final/verifier-repeat
```

No image model is invoked by evaluation. The writing trial uses **host-side**
image capability (the configured adapter or Codex image generation), not a
Docker adapter. Evaluation needs local `latexmk`, TeX/venue packages,
`pdfinfo`, and `pdftotext`. It evaluates only the new trial output, never any
excluded Gewu paper. Automated reward still requires separate human review.

### Before/After Baseline

```bash
python3 scripts/prepare-gewu.py --baseline-only
```

This exports `71a190f32f558767c2f75cac5bf9cd07d226a83e` with `git archive` into
ignored `datasets/gewu-issue48/baseline-code` and builds it. It is a build-only
snapshot, not a checkout, worktree, or named branch. All archive members are
validated before writing; links, special files, traversal and secret/data state
are refused. It reuses the existing ancestor `node_modules` only when the
package-lock matches, with no install/model invocation. Source hashes and the
archive hash are in `baseline-provenance.json`; compiler output is in
`baseline-build.log`, and `baseline-write-help.txt` captures the old interface.

Only the primary run owner should launch the following model command, with
the same text model and host-side image/retrieval access as the current trial:

```bash
set -o pipefail
node datasets/gewu-issue48/baseline-code/dist/cli.js write \
  datasets/gewu-issue48/input \
  --brief datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md \
  --model openai-evelyn/gpt-5.6-sol --use-plotting --headless --json \
  --allow-lkm-spend --max-lkm-calls 10 --target-citations 5 \
  --research-cutoff 2026-09 -o datasets/gewu-issue48/baseline-run \
  2>&1 | tee datasets/gewu-issue48/baseline-run.log

python3 scripts/evaluate-gewu.py \
  --workspace datasets/gewu-issue48/baseline-run \
  --output datasets/gewu-issue48/evaluations/baseline-final
```

The named model matches the currently prepared local trial. If the primary
owner changes that trial's model, use the same model for the baseline and
record the change. Both runs use the identical raw files, brief, and verifier;
template auto-selection remains part of the evaluated behavior. Record the
selected templates and models rather than claiming identical stochastic runs.

Old-interface differences: plotting defaults off (the common command explicitly
enables it); `--no-plotting` and `--bibliography-mode` are not supported; the old
CLI has no portable submission export or new early preflight. The evaluator
maps its `.brain/manuscript` plus template dependencies, with only portable
bibliography-path rewriting, to the same submission contract. No scientific
criterion or missing-generation requirement is waived for the baseline.

The allowed-notes review is recorded in
`datasets/gewu-issue48/provenance/material-notes-review.json`. No full manuscript
was found in those notes, but they do contain the principal formulas and short
result summaries. This is a **notes-plus-results** writing test, not a blind
results-only test. Verbatim overlap with excluded papers was not assessed,
because opening them would violate the no-reading boundary. The accepted/raw
validation status caveat above remains unchanged.
