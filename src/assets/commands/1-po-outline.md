<!-- Source of truth. Controller placeholder: {cutoff_date}. -->

Plan an independent research paper for the selected venue. Write one valid JSON
object directly to `.brain/raw/outline.json`, not into the conversation.

Read the commissioning brief when supplied, `.brain/raw/materials.json`, the
actual source and extracted results it indexes, `template/template.tex`, and
template guidelines when present. A materials map is navigation, not a substitute
for opening code, configurations, results and notes. Never read or reuse an
inherited finished manuscript, including PDF, LaTeX body or extracted equivalents.
The template provides formatting and structure, never research prose.

## Requirements And Research

Record `requirements` as objects with `requirement`, `source` (one of `cli`,
`brief`, `template`, `inferred`), and `verification` strings. Explicit locked CLI
options win over the brief, which wins over inferred preferences. Follow applicable
venue rules, page limits, anonymity and required sections. Record conflicts rather
than silently discarding a requirement. Never invent author identities or declarations.

Missing author metadata means an anonymous review manuscript, not an author-filling
task. Do not plan placeholder author details or sections saying "to be completed
by authors". Omit unsupported optional personal declarations; do not infer funding,
ethics approval or absence of conflicts from silence. Keep brief-required sections.
If a venue or brief requires an authoritative declaration that is unavailable,
record the actual blocker in `requirements`, including what evidence is needed for
verification. Do not resolve it with boilerplate or silently mark it optional.
Plan scientific content, not prose about the pipeline, scaffold or automatic venue
choice. Preserve explicit research-provenance requirements such as no new simulations.

Record `research_claims` as objects with `claim`, `evidence_paths` (nonempty array
of actual workspace-relative files), and `limitations` (array of strings). Connect
the method implementation, experiment configuration and results. Distinguish
supported contributions from hypotheses and missing evidence. Do not plan new
experiments or invent evaluations against literature-only baselines.

## Citation Plan

Set `citation_target` to the number of distinct sources the argument actually
needs, not a fixed quota. Identify sources for datasets, baselines, metrics,
architectures and prior-work claims that will appear in the paper. Do not pad
citations or propose irrelevant searches. Respect the cutoff {cutoff_date}.

`citation_gaps` is only for unmet support for external prior-work claims actually
asserted in the paper, expressed as specific search queries. It is not a list of
original contributions, missing new experiments or unanswerable research questions.
Do not demand an independently published identical formula or a universal correctness
proof for the supplied original research. Describe an original supplied formula as
a supplied tested result when the materials record those tests, with their actual
scope; otherwise describe the derivation or proposal and its evidence boundaries.
Cite external methodological foundations where relevant, without pretending those
sources establish every detail of the original result.

A gap may be resolved by a directly supporting citation or by narrowing/removing
the unsupported external comparison. This must not remove requested research
outcomes, required sections or the minimum citation target. An explicit user minimum
of relevant citations remains mandatory; do not pad irrelevant citations or lower it.
Budget exhaustion is not success and does not resolve a gap. If required support
or the citation minimum cannot be met honestly, report the actual blocker.

Optional `citation_gap_resolutions` is an audit array of `{query, resolution, detail}`.
`query` copies the original gap query; `resolution` is `cited` or `claim_narrowed`.
For `cited`, detail must name the exact allowed citation key, the supported claim
and its location. For `claim_narrowed`, detail must give the concrete revised claim
(or identify the removed comparison) and its section/paragraph location, explaining
why external support is no longer missing. Apply the revision in the section plan;
do not merely declare the gap resolved. Preserve this audit for the literature stage.

Preserve the established `intro_related_work_plan` shape:
- `introduction_strategy`: `hook_hypothesis`, `problem_gap_hypothesis`, `search_directions`.
- `related_work_strategy`: `overview`, `subsections`.
- Each related-work subsection: `subsection_title`, `methodology_cluster`,
  `sota_investigation_mission`, `limitation_hypothesis`, `limitation_search_queries`,
  `bridge_to_our_method`.

Search directions and limitation queries are arrays of strings. Other fields
above are strings. Treat alleged limitations of prior work as hypotheses to check,
not facts. A literature gap never licenses making up a citation.

## Figures

Populate `plotting_plan` with figure objects retaining these fields:
`figure_id`, `title`, `plot_type`, `render_route`, `data_source`, `objective`,
`generation_prompt`, `aspect_ratio`.

Use unique filename-safe IDs such as `fig_method`. `plot_type` is `plot` or
`diagram`; `render_route` is `code`, `text_to_image` or `auto`. Numeric charts must
use `code` and actual result file paths in `data_source`. GPT text-to-image is
for conceptual method/architecture diagrams, never numerical charts or simulated
experimental images. Its `generation_prompt` must specify only supported modules,
connections, labels and visual hierarchy. Use a W:H aspect ratio such as `16:9`.
If automatic plotting is disabled, leave `plotting_plan` empty and plan around
supplied figures. Missing figure inputs must not turn into invented evidence.

## Tables

Plan necessary main results, baseline comparisons and recorded ablations in
`table_plan`, independently of the figure-generation flag. Read the actual result
files. Choose a small, well-grounded table covering the needed evidence rather than
a large speculative table. Rows contain source-backed data, not instructions for a
later writer to guess. Never invent a baseline, run, column or value to fill space.
The controller produces table files from this plan; writers include those files.

Each table has `table_id` (unique filename-safe ID), `title`, `caption`, `section`,
`columns` (nonempty ordered string array, including units), `rows`, `source_paths`
(nonempty array of actual workspace-relative files), and `calculation` (string,
empty for direct measurements). Each row has `label`, `values` (ordered strings,
finite numbers or null), and nonempty `source_paths`. Row labels are separate from
columns; each values array must have exactly as many entries as columns. Null
means unavailable, not zero. Keep recorded precision unless explicitly rounding.

Use optional `column_verification` to make numeric provenance unambiguous. When
present, it has exactly one entry per column, excluding the row label. Each entry
is null (automatic inference, not a verification bypass) or an object containing
only `selector`, `operation`, `decimals`, `ddof`, `index`. `operation` is required and is
exactly `direct`, `min`, `max`, `mean`, `std`, `range`, or `mean_std`.

For heterogeneous metrics sharing a value column, use **row.cell_verification**:
an optional array with exactly one entry per row value, excluding the row label.
A non-null cell object completely overrides that column's specification (no field
merging); null inherits the column default, then automatic inference if no default
exists. Column defaults, when present, must STILL match the number of columns:
three entries for two columns are invalid even when every row has cell overrides.
Never change recorded values to pass checking, or drop required research outcomes.

- Read real JSON/CSV/TSV files or original plain `.txt`/`.log` research logs in each
  row's `source_paths`. Do not cite a Markdown summary or invent a source filename.
- `selector` is an exact CSV/TSV header (e.g. `energy`) or a JSON pointer such as
  `/runs/*/energy` or `/runs/0/energy`. Escape JSON keys with `~0` for `~` and `~1`
  for `/`. Selectors are paths, never formulas, JSONPath filters or code.
- CSV header selection uses the exact row label when it occurs in the records;
  if none match, all records are considered. An explicit JSON pointer selects
  directly from the row's source files and does NOT filter by row label. Scope
  source files or use indexed pointers to avoid mixing methods, splits or units.
- `direct` needs a single distinct recorded value. For repeated observations use
  the appropriate supported operation. `range` means the minimum and maximum
  endpoints, not their difference; format the cell as `"1.20 to 3.40"`.
- `mean_std` cells use `"2.30 +/- 0.40"`. For `std` and `mean_std`, set `ddof`
  explicitly: 0 for population or 1 for sample; enough measurements must exist.
- For a directly recorded log scalar, use `{"selector":"text:<literal line prefix>",
  "operation":"direct","index":0}`. The controller requires exactly ONE matching
  line across the original `source/*.txt`/`.log` files in that row's `source_paths`.
  Prefixes must match from the start of the original line, including whitespace;
  they are not regexes, substrings or searches for a desired number. `index` is a
  zero-based numeric token AFTER the prefix, not a line occurrence. Omit it only
  if exactly one numeric token follows the prefix. An absent, repeated, non-finite
  or out-of-range match fails. No Markdown/normalized-text substitute or aggregation
  over log lines is supported. `index` is invalid for JSON/CSV selectors.
- Optional `decimals` is an integer from 0 to 100 for fixed-point display rounding,
  including tiny scientific-notation measurements that need more than 12 places.
  It may exceed the digits written in a numeric JSON value (trailing zeros are
  immaterial). Preserve supported precision; it does not authorize changing units,
  inventing significant digits, or changing a measurement to satisfy the verifier.
- `calculation` may remain empty with explicit metadata. Vague calculation prose
  is not sufficient. Unsupported transforms (including ratios, weighted means,
  differences and unit conversions) cannot be made valid by describing them.
  Keep only justified, verifiable cells; never guess a derived result. If needed
  evidence cannot be verified, record the gap instead of fabricating a table.

Example table entry:
```json
{
  "table_id": "tab_main", "title": "Main results",
  "caption": "Recorded evaluation on the held-out split.", "section": "Experiments",
  "columns": ["Accuracy (%)", "Latency (ms)"],
  "rows": [{"label": "Method A", "values": [81.2, null],
    "source_paths": ["source/results/metrics.json"]}],
  "source_paths": ["source/results/metrics.json"], "calculation": "",
  "column_verification": [{"selector": "/accuracy", "operation": "direct"}, null]
}
```

For a source CSV with an actual `energy` header and repeated measurements, a range
column may use `{"selector":"energy","operation":"range","decimals":2}`.
Only report endpoints that match that selected data; example numbers are not evidence.

Heterogeneous-row example for `columns: ["Value", "Note"]`, only if the original
log actually records `40.7070301858` as the third value after this exact prefix:
```json
{"label":"Third alpha_z coefficient","values":[40.7070301858,"Recorded fit"],
 "source_paths":["source/kerr_axis_ks_run.txt"],
 "cell_verification":[{"selector":"text:alpha_z coefficients:","operation":"direct","index":2,"decimals":10},null]}
```
Another row may select a different literal prefix or CSV field in the SAME value
column. Correct the per-cell metadata, not the recorded scientific result. This
checks direct numeric field provenance, not a generalized formal proof of the research.

## Sections And Output

Preserve `section_plan` as an array of `{section_title, subsections}`. Each
subsection has a string `subsection_title` plus `content_bullets` and `citation_hints`
arrays of strings. Reference precise evidence, planned figure/table IDs and claims in
the bullets. Include adequate method details, actual experimental setup and
results, limitations, and all required sections. Use mathematics only when
supported by the materials. Do not force an experimental structure on a theory paper.

Write these top-level keys: `citation_target`, `plotting_plan`, `table_plan`,
`research_claims`, `requirements`, `intro_related_work_plan`, `section_plan`.
Use `citation_gaps` only as defined above; include `citation_gap_resolutions` when
there are actual resolutions to audit.
Empty arrays are appropriate only when the research genuinely needs no entries.
