<!-- Source of truth. No controller placeholders. -->

Complete the research paper and write the entire LaTeX document directly to
`.brain/manuscript/raw_draft.tex`. Do not return the document in chat.

Read `.brain/raw/outline_v1.json`, `.brain/raw/updated_template.tex`,
`.brain/raw/citation_map.json`, `.brain/raw/materials.json`, actual source and
extracted result files, and `.brain/manuscript/figures/info.json`. Read the brief,
template guidelines and controller-produced tables when present in the read list.
Preserve useful Introduction and Related Work written by this run's literature
stage, adjusting them for consistency. Never preserve or copy an inherited finished
manuscript. Templates provide style and structure only; replace all sample prose.

## Complete Content

Follow the outline's requirements, claims and section plan. Explain the research
problem, contributions, implementation, supported mathematical formulation,
experimental setup, actual comparisons, and what the results mean. Include
recorded ablations when available, never fabricate them. State limitations and
research boundaries accurately. Do not undertake or promise new experiments.
Missing critical evidence remains a blocker, not an invitation to invent details.

Follow stable claim IDs through outline `claim_ids`/`evidence_ids` to materials
methods, experiments, results and exact source provenance. Do not replace those
relationships with vague "the source confirms" wording. Conceptual original
research may have no measurements: respect `no_measurements_reason`, describe
the supplied proposal/derivation honestly and do not demand exhaustive proof or
fabricate evaluations. Missing readable evidence or necessary computation should
be a typed read/extract/analyze request, not a prose claim that a tool ran.

Use only exact citation-map keys and claims supported by the recorded source
content. Do not invent authors, affiliations, funding, ethics approvals or other
declarations. Follow the locked CLI choices, brief and applicable venue rules for
length, anonymity and mandatory sections.

When author metadata is absent, produce an anonymous review manuscript. Replace
placeholder author names with a template-compatible anonymous author block in the
generated TeX and remove placeholder affiliations and emails. Do not preserve those
placeholders under the rule to preserve the preamble; keep the document class and
formatting intact. Omit unsupported optional personal declarations instead of
writing TODOs, "to be completed by authors", or sample funding/ethics/COI boilerplate.
Do not assert "no conflicts" or "no funding" without authoritative support. Keep
brief-required sections. If a required declaration lacks authoritative information,
report the actual blocker without inventing its content or claiming readiness.

Write about the research, not the writing system or its workspace. Do not describe
PaperOrchestra scaffolds or justify a Nature submission because automatic selection
chose a template. Preserve explicitly required research provenance, including an
accurate statement that no new simulations were performed when the brief requires it.

## Tables And Figures

Every required `table_plan` entry must appear in its intended section, with a
caption, stable label and textual interpretation. Include the controller-produced
table files listed as inputs using `\input{tables/<table_id>.tex}`; do not retype
or mentally recalculate their values. If a required table artifact is absent,
report the blocker rather than bypassing numeric verification with a handwritten table.
The plan's `column_verification` binds numeric columns to actual CSV headers or
JSON pointers and supported operations. Row labels are separate from those columns.
Range cells report min/max endpoints, not invented intervals. A small verified
table is better than fabricated breadth, but do not silently drop required evidence.
Check row/column alignment, units, splits, baselines and recorded precision.
Use booktabs when supported by the preamble. Unavailable data is not zero.
Never invent values or run new experiments to fill a table.

Inspect the actual figures listed in `figures/info.json`. Use their exact filenames
and read the controller-owned `.brain/raw/plotting_results.json` for generation
provenance. Never copy a provider/model guessed in an outline generation prompt.
If provenance marks the exact image model as unverified, state the actual executor
and that qualification rather than asserting a model version as fact. Use paths
including extensions under `figures/`. Reference and explain each provided figure,
with readable sizing and honest captions. Conceptual GPT diagrams are illustrations
of the method, not measurements. Numeric charts must reflect actual results.
Do not assert content absent from an image. Keep figures and tables near their
discussion, with appendices placed according to the venue rules.

Read quantity metadata in the figure plan and `figures/info.json` when present:
selectors, transformations, units, axis types, linked evidence and supplied
`expected_math`/`math_source`. Match captions and interpretation to the actual
bindings and rendered figure. Never guess an equation or silently reinterpret a
log axis, transformed quantity or unit. Request controller regeneration when an
artifact is wrong; stop the turn and inspect operation-results.json before using
the replacement. Do not edit controller-owned figure metadata to claim a repair.

## LaTeX

Preserve the document class and necessary preamble. Keep environments balanced,
resolve cross-references, and leave no sample abstract, TODO or placeholder text.
Do not change `cleveref` to the nonexistent `cleverref` package. The controller
compiles the document and checks it; your closing message cannot declare readiness.
