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

## Requirements

- Node.js ≥ 20 and [OpenCode](https://opencode.ai) on `PATH`, authenticated
  with at least one provider (`opencode auth login`).
- A LaTeX toolchain: `pdflatex`, `bibtex`, plus `pdftotext` and `pdftoppm`.
- `python3` with `matplotlib`, only for `--use-plotting`.
- The [`bohr`](https://www.bohrium.com) CLI, logged in, for literature
  retrieval. Each search costs about 0.05 CNY.

```bash
npm install && npm run build
node dist/cli.js doctor      # reports exactly what is missing
```

`doctor` separates hard requirements from capability probes, so an absent
`matplotlib` is reported as a warning rather than a failure.

## Usage

```bash
paper-orchestra write ./raw-materials \
  --template templates/cvpr2025 \
  --output ./my-paper \
  --model openai/gpt-5.6-terra \
  --research-cutoff 2024-11 \
  --allow-lkm-spend
```

The raw-materials directory needs an idea document and an experimental log
(`--idea-filename`, `--experimental-log-filename`), plus optionally a
`figures/` directory of supplied images. A worked example is in `examples/`.

Retrieval costs real money, so `--allow-lkm-spend` is required before any
search runs; without it the run stops and tells you what it would have spent.

### Frequently used flags

| Flag | Effect |
|---|---|
| `--use-plotting` | Generate figures from data instead of only using supplied ones |
| `--mode collaborative` | Pause for approval after outline, literature, drafting and refinement |
| `--headless` | Do not attach the OpenCode TUI |
| `--stage-model <stage>=<provider/model>` | Override the model for one stage; repeatable |
| `--target-citations <n>` | How many distinct sources to cite, capped by how many relevant ones retrieval found |
| `--max-lkm-calls <n>` | Ceiling on paid retrieval calls |
| `--until <stage>` | Stop after a stage, locking a shorter plan |

### Other commands

```bash
paper-orchestra status <run> [--json]     # per-stage state, tokens, cost
paper-orchestra validate <run> [--json]   # re-run every check; exit 2 on failure
paper-orchestra approve <run>             # release a collaborative gate
paper-orchestra resume <run>              # continue from the first incomplete stage
paper-orchestra doctor
```

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
