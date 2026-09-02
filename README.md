# <div align="center">🎻 PaperOrchestra: A Multi-Agent Framework for Automated AI Research Paper Writing</div>
<div align="center">Yiwen Song<sup>1</sup>, Yale Song<sup>1</sup>, Tomas Pfister<sup>1</sup>, and Jinsung Yoon<sup>1</sup></div>
<div align="center"><sup>1</sup>Google Cloud AI Research</div>
<br><br>

PaperOrchestra turns unconstrained pre-writing materials — an idea and an
experimental log — into a submission-ready LaTeX manuscript, with literature
synthesis, generated figures, and a compiled PDF.

**This fork is a rewrite.** The original Python/Conda multi-agent pipeline has
been replaced by a standalone OpenCode-native agent in TypeScript. The writing
capability is PaperOrchestra's; the runtime is not. See
[MIGRATION.md](MIGRATION.md) for the module-by-module map and the reasoning.

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
| `--use-plotting` | `python3` with `matplotlib` |

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

That is the whole flow. It defaults to the current directory, the CVPR 2025
template, and OpenCode's own default model, and writes the finished PDF into a
timestamped workspace.

`--allow-lkm-spend` is required because literature retrieval costs real money.
Without it the run stops before searching and tells you what it would have
spent — roughly 2 CNY for a full paper.

A worked example lives in `examples/`.

### Common variations

```bash
# a specific model, and figures generated from your data
paper-orchestra write --model openai/gpt-5.6-terra --use-plotting --allow-lkm-spend

# a different venue, and a fixed literature cutoff
paper-orchestra write --template iclr2025 --research-cutoff 2024-11 --allow-lkm-spend

# pause for your approval after outline, literature, drafting and refinement
paper-orchestra write --mode collaborative --allow-lkm-spend

# your own LaTeX template
paper-orchestra write --template ./my-template --allow-lkm-spend
```

| Flag | Effect |
|---|---|
| `--template <venue\|dir>` | `cvpr2025`, `iclr2025`, or a path to your own (default: `cvpr2025`) |
| `--model <provider/model>` | e.g. `openai/gpt-5.6-terra`; omit for OpenCode's default |
| `--stage-model <stage>=<model>` | Override one stage's model; repeatable |
| `--use-plotting` | Generate figures from your data, not just place supplied ones |
| `--mode collaborative` | Pause for approval at four gates |
| `--headless` | Do not attach the OpenCode TUI |
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
paper-orchestra doctor
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
  cite what retrieval actually found.
- **Figure rendering** — the model writes a matplotlib script; the controller
  executes it in a scoped directory with no network. A figure exists because a
  process produced pixels.
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

Every call goes through an OpenCode session, so the provider is a flag and can
differ per stage. Figures are generated as *code*, not as images, so figure
generation is model-agnostic too — any model that writes Python can do it.

The one thing this rules out is conceptual **diagrams**, which need an
image-generation endpoint OpenCode does not expose. Supply those yourself under
`figures/`; the pipeline places them and notes the ones it skipped.

## The pipeline

| # | Stage | Produces |
|---|---|---|
| 1 | `outline` | `outline.json` — section plan, citation hints, figure plan |
| 2 | `literature` | `references.bib`, `citation_map.json`, `candidates.json` |
| 3 | `plotting` | `figures/*`, `plotting_results.json` |
| 4 | `section_writing` | `raw_draft.tex` |
| 5 | `refinement` | `final_paper.tex`, `final_paper.pdf` |

Retrieval (stage 2) is controller-owned: candidates come from Bohrium LKM, are
enriched from Crossref and DataCite, scored for relevance against the paper's
own topic, and written to disk before the model sees them. The model can only
cite what retrieval found, which is what makes a fabricated reference
impossible rather than merely discouraged.

Figures (stage 3) are matplotlib scripts the model writes and the **controller**
executes in a scoped directory with no network. Conceptual diagrams need an
image-generation endpoint that OpenCode does not expose, so they must be
supplied under `source/figures/`.

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
- `examples/` — a worked CVPR sample
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
