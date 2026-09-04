# <div align="center">🎻 PaperOrchestra: A Multi-Agent Framework for Automated AI Research Paper Writing</div>
<div align="center">Yiwen Song<sup>1</sup>, Yale Song<sup>1</sup>, Tomas Pfister<sup>1</sup>, and Jinsung Yoon<sup>1</sup></div>
<div align="center"><sup>1</sup>Google Cloud AI Research</div>
<br><br>

PaperOrchestra turns unconstrained pre-writing materials — an idea and an
experimental log — into a submission-ready LaTeX manuscript, with literature
synthesis, generated figures, and a compiled PDF.

**This fork is a rewrite.** The original Python/Conda multi-agent pipeline has
been replaced by a standalone OpenCode-native agent in TypeScript. The writing
capability is PaperOrchestra's; the runtime is not.

<div align="center">
  <img src="assets/overview.png" alt="PaperOrchestra Overview" width="90%"/>
</div>

## What is different from upstream

"Upstream" here means the original
[google-research/paper-orchestra](https://github.com/google-research/paper-orchestra)
— the Python/Conda multi-agent pipeline this repository was forked from, and
whose paper is cited below. The writing capability is theirs. What changed is
the runtime and the guarantees around it.

- **Model-agnostic.** Every model call goes through an OpenCode session, so the
  provider is a flag. Upstream required Vertex or `GEMINI_API_KEY`.
- **Validators decide when a stage is done**, never the model's own prose. A
  stage completes because artifacts exist and pass schema and content checks.
- **Mechanical work belongs to the controller.** LaTeX builds, literature
  retrieval, figure-script execution and PDF rendering run outside the session,
  cost zero model tokens, and cannot be faked by a textual claim. The agent has
  `bash`, `webfetch` and `websearch` denied.
- **Resumable.** Stage-level state, digest-locked inputs, and a git checkpoint
  per stage. Upstream restarted from the outline on any exception.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/a-green-hand-jack/paper-orchestra/main/scripts/install.sh | bash
```

This builds and links `paper-orchestra` globally. Re-run it to upgrade. From a
clone, `./scripts/install.sh` does the same thing from your working copy.

Then check what the machine is missing:

```bash
paper-orchestra doctor
```

It separates hard requirements from optional capabilities, so an absent
`matplotlib` is reported as a warning rather than a failure.

| Needed for | What |
|---|---|
| Everything | Node.js >= 20; [OpenCode](https://opencode.ai) on `PATH`, authenticated (`opencode auth login`) |
| Building the PDF | `pdflatex`, `bibtex`, `pdftotext`, `pdftoppm` |
| Literature retrieval | the [`bohr`](https://www.bohrium.com) CLI, logged in — about 0.05 CNY per search |
| Code-generated figures | `python3` with `matplotlib` |
| Text-to-image figures | [Codex](https://developers.openai.com/codex/) logged in with ChatGPT OAuth; or an executable `PAPER_ORCHESTRA_IMAGE_ADAPTER` |

## Usage

Put your materials in a directory:

```
my-paper/
├── idea_sparse.md          # the idea, problem statement, contributions
├── experimental_log.md     # experimental record, including result tables
└── figures/                # optional: figures you already have
```

Then run it from there:

```bash
cd my-paper/
paper-orchestra write --allow-lkm-spend
```

This is the interactive mode: PaperOrchestra creates a durable workspace,
starts the shared controller, and attaches OpenCode's native TUI. You can inspect
the stage sessions and talk to the writing agent while the controller keeps
validation, checkpoints, and approval state on disk. Closing the TUI preserves
the workspace; run `paper-orchestra resume <workspace>` to continue it.

For an autonomous run or a call from another agent, use the same command with
`--headless`. Add `--json` for NDJSON events followed by one stable result object:

```bash
paper-orchestra write --headless --json --allow-lkm-spend -o ./paper-run
paper-orchestra status ./paper-run --json
paper-orchestra validate ./paper-run --json
```

The result object includes the absolute workspace, run state, current and next
stage, validation failures, and paths to the LaTeX, bibliography, and final PDF.

`--allow-lkm-spend` is required because literature retrieval costs real money.
Without it the run stops before searching and tells you what it would have
spent — roughly 2 CNY for a full paper.

**Unless you bring your own bibliography.** Put a `references.bib` in your
materials and PaperOrchestra uses it instead of searching: zero retrieval calls,
zero spend, and `--allow-lkm-spend` is not needed. The file is used verbatim —
never rewritten, never added to — and the manuscript may only cite keys it
defines. A bibliography is a decision you have already made, so a run that has
one is free.

### Common variations

```bash
# a specific model, and figures generated from your data
paper-orchestra write --model openai/gpt-5.6-terra --use-plotting --allow-lkm-spend

# a specified venue, and a fixed literature cutoff
paper-orchestra write --template iclr2026 --research-cutoff 2024-11 --allow-lkm-spend

# pause for your approval after outline, literature, drafting and refinement
paper-orchestra write --mode collaborative --allow-lkm-spend

# your own LaTeX template
paper-orchestra write --template ./my-template --allow-lkm-spend

# list supported versioned templates and CCF-A venue identities
paper-orchestra templates list --ccf-a
```

| Flag | Effect |
|---|---|
| `--template <venue\|dir\|auto>` | Default `auto` asks the configured model to choose from reproducible current templates by topic. Any explicit adapter id or local template directory wins over the model. |
| `--model <provider/model>` | e.g. `openai/gpt-5.6-terra`; omit for OpenCode's default |
| `--stage-model <stage>=<model>` | Override one stage's model; repeatable |
| `--use-plotting` | Generate figures from your data, not just place supplied ones |
| `--mode collaborative` | Pause for approval at four gates |
| `--headless` | Do not attach the OpenCode TUI |
| `--json` | Emit NDJSON events and a stable machine-readable result |
| `--target-citations <n>` | How many distinct sources to cite, capped by how many relevant ones retrieval found (default: 20) |
| `--max-lkm-calls <n>` | Ceiling on paid retrieval calls (default: 40) |
| `--research-cutoff <yyyy-mm>` | Treat nothing published after this as prior work |
| `--until <stage>` | Stop after a stage, locking a shorter plan |
| `-o, --output <dir>` | Workspace directory (default: `./po-run-<timestamp>`) |

### Other commands

```bash
paper-orchestra status [dir]      # per-stage state, tokens, cost
paper-orchestra validate [dir]    # re-run every check without calling a model
paper-orchestra resume [dir]      # continue from the first unfinished stage
paper-orchestra approve [dir]     # release a collaborative gate
paper-orchestra history [dir]     # the checkpoint timeline
paper-orchestra checkpoint [dir]  # record a manual checkpoint
paper-orchestra doctor
paper-orchestra templates list
paper-orchestra templates info cvpr2026
```

### Where the output lands

```
<workspace>/.brain/manuscript/final_paper.pdf     the paper
<workspace>/.brain/manuscript/figures/            every figure used
<workspace>/.brain/raw/references.bib             the bibliography
<workspace>/.brain/raw/candidates.json            every retrieved source, auditable
```

## Features

### Validators, not self-assessment

A stage completes because its artifacts exist and pass checks — never because
the model said it was done. Eleven validators run per stage:

| Validator | Catches |
|---|---|
| `schema_valid` | An artifact that does not match its schema |
| `outline_coverage` | An empty section plan, or a figure with no usable id |
| `citation_integrity` | A `\cite` key that resolves to nothing |
| `citation_floor` | A manuscript that cites far fewer sources than were found |
| `bibliography_provenance` | A bibliography entry with no retrieval record behind it |
| `literature_dedup` | Two entries describing the same paper |
| `figure_coverage` | A planned figure that never rendered, or one never placed |
| `figure_render` | A "rendered" figure that is really an empty canvas |
| `latex_assembly` | A build failure, unresolved `[?]` marks, content overflowing its column |
| `template_compatibility` | A manuscript that changed the venue's document class |
| `no_unresolved_markers` | Leftover placeholders or TODO markers |

A failed check's message is written as the repair instruction and is handed
back to the model verbatim.

### The model cannot fabricate

The agent runs with `bash`, `webfetch` and `websearch` denied. Everything
mechanical belongs to the controller, costs zero model tokens, and cannot be
faked by a claim in a transcript:

- **Literature retrieval** — candidates come from Bohrium LKM, are enriched
  from Crossref and DataCite, scored for relevance against the paper's own
  topic, and written to disk *before* the model sees them. The model can only
  cite what retrieval actually found. When you supply a `references.bib`,
  retrieval is skipped and every entry traces to that digest-locked file
  instead — a stronger guarantee, since the reference set never came from a
  model at all.
- **Figure generation and review** — the outline agent selects a code or
  text-to-image route. The controller executes code in a network-disabled
  directory or calls an explicit image adapter, then visually reviews the
  rendered output before it can pass.
- **LaTeX builds** — four-pass `pdflatex`/`bibtex`, diagnosed from the final log.
- **PDF page rendering** for visual review.

### Literature quality

Retrieval is scored for relevance and the off-domain tail is dropped — LKM
indexes claims across all of science, so an unfiltered search for a
vision paper returns work in agriculture and gastroenterology. A second axis
keeps a foundational paper the outline explicitly asked for even when its
abstract shares little vocabulary with your topic.

Every entry carries its provider, provider id, relevance score, and the queries
that found it, so a bibliography can be audited after the fact.

### Resumable and reproducible

- Stage-level state in `.po-run/run.json`, and a git checkpoint per stage with
  machine-readable trailers.
- `source/` and `template/` are hashed at import and re-checked on resume, so a
  resume cannot silently change what is being written.
- Per-stage token and cost telemetry.
- Each stage runs in its own session, which bounds transcript growth.

### Safe by default

Credentials are refused at import: `.env*`, `.npmrc`, `.netrc`, key files and
token-shaped filenames never enter the workspace or a checkpoint. Generated
figure scripts run in a separate process with no network, in their own
directory.

### Model-agnostic

Every writing and reviewing call goes through an OpenCode session, so the
provider is a flag and can differ per stage. Figure generation also has two
explicit routes. Quantitative plots default to controller-executed code and must
produce PDF. Conceptual diagrams default to Codex's built-in `gpt-image-2`
generation when `codex login status` reports a ChatGPT login. This uses the
existing Codex OAuth session and does not require `OPENAI_API_KEY`:

```bash
codex login
paper-orchestra write --use-plotting --allow-lkm-spend
```

Set an external adapter only when another image provider or a custom image
service should override the Codex default:

```bash
export PAPER_ORCHESTRA_IMAGE_ADAPTER=/absolute/path/to/image-adapter
paper-orchestra write --use-plotting --allow-lkm-spend
```

The adapter reads one JSON request from stdin and returns one JSON object with
`provider`, `model`, `output_path`, and optional `parameters`. Its provider,
model, prompt, parameters, route, and output are recorded in
`plotting_results.json`. If a requested route is unavailable, the stage stops
with setup guidance instead of silently omitting the figure.

## The pipeline

| # | Stage | Produces |
|---|---|---|
| 1 | `triage` | `synthesized/idea.md`, `synthesized/experimental_log.md`, `triage.json` |
| 2 | `outline` | `outline.json` — section plan, citation hints, figure plan |
| 3 | `literature` | `references.bib`, `citation_map.json`, `candidates.json` |
| 4 | `plotting` | `figures/*`, `plotting_results.json` |
| 5 | `section_writing` | `raw_draft.tex` |
| 6 | `refinement` | `final_paper.tex`, `final_paper.pdf` |

Two stages need no model when you have already done their work. Triage is
skipped when you supply both pre-writing documents, and retrieval is skipped
when you supply a `references.bib` — in both cases the controller records what
it used and the validators confirm it, at zero cost.

Retrieval (stage 3) is controller-owned: candidates come from Bohrium LKM, are
enriched from Crossref and DataCite, scored for relevance against the paper's
own topic, and written to disk before the model sees them. The model can only
cite what retrieval found — or, with a supplied bibliography, only what that
file defines — which is what makes a fabricated reference impossible rather
than merely discouraged.

Figures (stage 3) use the route selected in `outline.json`. Code generation runs
in a scoped directory with no network and accepts PDF only; text-to-image uses
Codex's ChatGPT-authenticated built-in image generation by default, with
`PAPER_ORCHESTRA_IMAGE_ADAPTER` as an explicit override. Both outputs are
rendered to pixels, attached to a visual critic, and repaired once or fail with
the critic's concrete finding. Supplied figures continue to work without either
generation dependency.

## Workspace layout

```
<workspace>/
├── .brain/{input,raw,manuscript,tmp}   # artifacts, drafts, figures
├── source/                            # imported materials, read-only, digested
├── template/                          # LaTeX template, read-only, digested
├── .opencode/                         # per-run agent config and prompts
└── .po-run/{run.json,session.json,checkpoints/,logs/}
```

`source/` and `template/` are hashed at import and re-checked on resume, so a
resume cannot silently change what is being written. Credentials are refused at
import: `.env*`, key files and token-shaped filenames never enter the workspace.

## Project structure

- `src/` — the agent: controller, stages, validators, retrieval, LaTeX and
  figure execution
- `assets/commands/` — the stage prompts, hand-edited and authoritative
- `templates/` — conference LaTeX templates; add one as a new subdirectory
- `tests/` — unit and integration tests (`npm test`)

## Citation

If you find this repo or our paper helpful, please cite it as follows:

```bibtex
@article{song2026paperorchestra,
  title={PaperOrchestra: A Multi-Agent Framework for Automated AI Research Paper Writing},
  author={Song, Yiwen and Song, Yale and Pfister, Tomas and Yoon, Jinsung},
  journal={arXiv preprint arXiv:2604.05018},
  year={2026}
}
```

# Disclaimer

This is not an officially supported Google product.
