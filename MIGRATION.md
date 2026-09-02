# Migration: Python pipeline → OpenCode-native TypeScript agent

PaperOrchestra 2.0 is a rewrite, not a port. The original Python/Conda
multi-agent pipeline has been removed; this file records where each piece went,
so the old code stays navigable through `git log` rather than by memory.

The Python was deleted in the commit that added this file. To read it:

```sh
git log --diff-filter=D --name-only -- 'methods/*' 'utils/*'
git show <that commit>^:methods/agents/plotting_agent.py
```

## Why it was removed rather than kept as a reference

It could not run in the target environment at all:

* `paper_writing_cli.sh` requires `conda`, which is not installed.
* `utils/gemini_utils.py:31-47` raises unless Vertex or `GEMINI_API_KEY` is
  set; neither exists here, and the project deliberately targets OpenAI models
  through OpenCode's provider layer.

It was also dead weight in the running system: no TypeScript module imported
it, no test exercised it, and every capability it held had been reimplemented.
Keeping unrunnable code in the tree costs a reader real effort — deciding which
half is live — for no benefit that `git log` does not already provide.

## Reading the removed code from source comments

Several TypeScript comments cite the Python by `path:line` — for example
`src/figures.ts` explains why script execution moved out of process by pointing
at `paper_banana_utils.py:293-323`. Those citations are deliberate: they record
*why* a design decision was made, and the reasoning outlives the file. Resolve
one with the `git show` recipe above.

## Module map

| Removed | Replaced by |
|---|---|
| `methods/paper_writer.py`, `paper_writer_with_plotting.py` | `src/controller.ts` — the stage loop, gates, checkpoints, resume |
| `methods/agents/outline_agent.py` | `assets/commands/1-po-outline.md` + `src/artifacts.ts` (`OutlineSchema`) |
| `methods/agents/literature_review_agent.py` | `src/literature.ts` (retrieval, dedup, citation keys, BibTeX), `src/queries.ts` (query construction), `src/relevance.ts` (relevance gate), `assets/commands/2-po-literature.md` |
| `methods/agents/plotting_agent.py`, `utils/paper_banana_utils.py` | `src/figures.ts` (controller-owned script execution), `assets/commands/3-po-plotting.md`, `figure_render` in `src/validation.ts` |
| `methods/agents/section_writing_agent.py` | `assets/commands/4-po-section-writing.md` |
| `methods/agents/content_refinement_agent.py` | `assets/commands/5-po-refinement.md`; its embedded `compile_latex` became `src/latexbuild.ts` |
| `methods/prompts/*.py` | `assets/commands/*.md` |
| `methods/prompts/format_agent.py` | **nothing** — it had no importer anywhere and was already dead |
| `utils/pdf_utils.py:169-250` (`compile_latex`) | `src/latexbuild.ts` (`compileLatex`), including the `TEXINPUTS`/`TEXMF*` scrubbing |
| `utils/pdf_utils.py:253-293` (`pdf_to_grid_images`) | `renderPdfPages` in `src/latexbuild.ts`, via `pdftoppm` — drops the PyMuPDF and OpenCV dependencies |
| `utils/scholar_utils.py` | `src/literature.ts` — Bohrium LKM plus Crossref/DataCite enrichment, replacing Semantic Scholar |
| `utils/gemini_utils.py`, `openai_utils.py`, `llm_backend_utils.py` | OpenCode's provider layer; the model is selected per prompt via `body.model` |
| `utils/prompt_utils.py` | the no-leakage block is carried inline in each `assets/commands/*.md` |
| `utils/common_utils.py`, `content_parsing_utils.py` | `src/files.ts`, `src/input.ts` |
| `autoraters/` | not ported — evaluation is a separate concern; `src/validation.ts` covers in-pipeline checks |
| `frontend/app.py`, `frontend_utils.py` | not ported — the CLI plus the native OpenCode TUI replace it |
| `frontend/examples/` | **kept**, moved to `examples/` — the real CVPR sample every acceptance run uses |
| `scripts/port_prompts.py` | removed with its inputs; `assets/commands/*.md` are now the source of truth and are hand-edited |
| `requirements.txt` | `package.json`; Python is now needed only to run generated figure scripts (`matplotlib`) |
| `templates/` | **kept** — the conference LaTeX templates are inputs the TypeScript runtime consumes directly |

## CLI map

```
# before
./paper_writing_cli.sh \
    --raw_materials_dir DIR --latex_template_dir DIR --output_dir DIR \
    --use_plotting \
    --writer_model_name M --reflection_model_name M \
    --plotting_model_name M --image_model_name M

# after
paper-orchestra write DIR --template DIR --output DIR [--use-plotting] \
    --model provider/model \
    [--stage-model section_writing=provider/model]...
```

| Before | After |
|---|---|
| `--raw_materials_dir` | positional `<raw-materials>` |
| `--latex_template_dir` | `--template` |
| `--output_dir` | `--output` / `-o` |
| `--use_plotting` | `--use-plotting` |
| `--writer_model_name`, `--reflection_model_name`, `--plotting_model_name`, `--image_model_name` | `--model <provider/model>` plus repeatable `--stage-model <stage>=<provider/model>` |
| *(none)* | `--research-cutoff`, `--max-lkm-calls`, `--target-citations`, `--allow-lkm-spend`, `--mode`, `--headless`, `--until`, `--timeout-multiplier` |

The four model flags collapse because OpenCode selects the model **per prompt**,
so a per-stage override is native rather than a separate parameter per agent.

New subcommands with no Python equivalent: `approve`, `status`, `validate`,
`checkpoint`, `resume`, `doctor`.

## Behaviour that deliberately did not survive

* **The score-driven accept/revert loop.** `content_refinement_agent.py` ran
  three reflection rounds driven by an LLM peer-review score
  (`autoraters/agent_review.py:90-109`), accepting a revision when the score
  rose. That makes a model's own numeric self-assessment the objective
  function, which is the "textual completion claim" the controller contract
  exists to refuse. Replaced by validators plus one bounded remediation.
* **The plotting critic loop.** Up to three rounds terminated by the model
  emitting the literal string `"No changes needed."`
  (`plotting_agent.py:139`) — the same defect. Replaced by `figure_render`
  plus the per-stage retry.
* **In-process `exec()` of model-generated matplotlib**
  (`paper_banana_utils.py:293-323`), which ran generated code with the
  pipeline's full privileges. The controller now executes each script as a
  separate process in a scoped directory.
* **The `PaperBanana` few-shot corpus.** `paper_banana_utils.py:33` read
  examples and style guides from a sibling repo that does not exist on disk, so
  those paths silently no-opped and the plotting agent was already running
  degraded. The style guidance is now stated directly in the plotting prompt.
* **Diagram generation.** It required `gemini-3-pro-image-preview`. OpenCode
  exposes no image-generation endpoint — `Model.capabilities` declares an
  `output.image` modality, but no response part carries generated binary — so
  diagrams must be supplied under `source/figures/`. Plots, being code
  generation, are fully model-agnostic and are the default path.
* **The 2-worker / 5-thread pools** (`paper_writer_with_plotting.py:117-158`,
  `plotting_agent.py`). Stages run sequentially; the wall-clock cost is dwarfed
  by the model turns, and sequential execution makes resume meaningful.

## What the rewrite added

None of these existed in the Python:

* Stage-level state and resume — any exception restarted from the outline.
* Schema validation of every artifact — each was read with `.get()` and a
  default, so a malformed outline silently degraded the paper.
* `citation_integrity` — the Python handed `citation_map.json` to the writer as
  "reference truth" and never checked what came back.
* `bibliography_provenance`, `literature_dedup`, `citation_floor`,
  `figure_render`, `template_compatibility`, `latex_assembly`,
  `no_unresolved_markers`.
* A relevance gate on retrieval (`src/relevance.ts`).
* Digest locks over `source/` and `template/`, refusing resume on change.
* Git checkpoints with machine-readable `PO-*` trailers.
* Per-stage token and cost telemetry.
