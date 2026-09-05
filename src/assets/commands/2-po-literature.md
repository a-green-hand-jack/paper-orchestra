<!-- Source of truth. Placeholders: {cutoff_date}, {paper_count}, {min_cite_paper_count}, {bibliography_origin}, {bibliography_mode}. -->

Write the Introduction and Related Work from the paper's research and citation plan.
Read `.brain/raw/outline.json`, `.brain/raw/citation_map.json`,
`.brain/raw/references.bib`, `.brain/raw/materials.json`, the actual materials
needed to check contributions, and `template/template.tex`. Apply the brief and
any available template guidelines. Never use inherited finished manuscript prose.

The controller provides {paper_count} candidate papers. {bibliography_origin}
Bibliography mode is `{bibliography_mode}`: `seed` permits controller-managed
gap retrieval; `closed` restricts the bibliography to the supplied collection.
Neither mode permits you to invent entries, fetch papers yourself, or write the
controller-owned bibliography or citation map.

Use only exact keys in `.brain/raw/citation_map.json`. Read the recorded abstracts
before asserting what a source says. The requested introduction/related-work
coverage is {min_cite_paper_count} distinct sources; every citation must support
its nearby claim. Never pad irrelevant citations to satisfy a count. The user's
minimum of relevant citations remains mandatory across the manuscript; resolving
an individual gap does not lower that minimum or the explicit citation target.

## Citation Gaps And Resolutions

`citation_gaps` is only for unmet support for external prior-work claims actually
asserted in the paper, expressed as specific search queries. It is not a list of
original contributions, missing new experiments or unanswerable research questions.
Before requesting another search, identify the external claim and its location,
and check whether the collected records already support it. Mere topic similarity
is not support. The controller decides whether authorized, budgeted retrieval can
fill a genuine gap.

Do not demand an independently published identical formula or a universal correctness
proof for the supplied original research. Describe an original supplied formula as
a supplied tested result when the materials record those tests, with their actual
scope; otherwise describe the derivation or proposal and its evidence boundaries.
Cite relevant foundations for external methods, but do not require their original
papers to prove every constraint or special case in the supplied implementation.
Do not misattribute an original result to a background citation.

A gap may be resolved by a directly supporting citation or by narrowing/removing
the unsupported external comparison. This must not remove requested research
outcomes, required sections or the minimum citation target. Apply every revision
to `.brain/raw/updated_template.tex` and the corresponding claims in the updated
outline. Keep `citation_gaps` limited to genuinely unresolved external claims.
Do not erase an unmet user requirement or relabel it resolved merely to stop searches.

Record actual resolutions in optional `citation_gap_resolutions`, an array of
`{query, resolution, detail}` objects. Preserve existing audit entries. `query`
copies the original gap query; `resolution` is exactly `cited` or `claim_narrowed`.
For `cited`, detail must name the exact allowed citation key, the supported claim
and its location. For `claim_narrowed`, detail must give the concrete revised claim
(or identify the removed comparison) and its section/paragraph location, explaining
why the missing external support is no longer required. A generic statement like
"claim softened" without the actual edit and location is not a resolution.

Budget exhaustion is not success and does not resolve a gap. Do not fake citations,
repeatedly request an identical unanswerable proof search, or declare readiness
because no retrieval calls remain. If required support or the user's minimum of
relevant citations cannot be met honestly, retain the unmet requirement and report
the actual blocker. Clearing inappropriate proof-search requests alone does not
establish that the paper is ready.

Respect the research cutoff {cutoff_date}. Do not assert superiority over a cited
method without a recorded comparison. Distinguish context from evaluated baselines.
Check hypotheses about prior-work limitations and qualify unsupported claims.

## Table Provenance

Preserve table plans and their numeric verification metadata in `outline_v1.json`.
When repairing a table, read its actual source files; never change recorded values
just to satisfy checking or drop required research outcomes. Row labels are separate
from columns: `values` and any `column_verification` must match the column count.
For heterogeneous rows, use **row.cell_verification**, aligned with that row's values.
Each non-null object completely overrides its column default; null inherits it,
then automatic inference if no default exists. A three-entry column specification
for two columns is still invalid; do not shift entries or guess their meaning.

Compact exact row example for two columns (`Value`, `Note`), valid only if the
original log contains the stated third coefficient:
```json
{"label":"Third alpha_z coefficient","values":[40.7070301858,"Recorded fit"],
 "source_paths":["source/kerr_axis_ks_run.txt"],
 "cell_verification":[{"selector":"text:alpha_z coefficients:","operation":"direct","index":2,"decimals":10},null]}
```

Verification objects contain only `selector`, required `operation`, optional
`decimals`, `ddof`, `index`. Structured selectors are exact CSV/TSV headers or JSON
pointers (including indexed or `*` array segments). Supported operations are
`direct`, `min`, `max`, `mean`, `std`, `range`, `mean_std`; `std`/`mean_std` require
`ddof: 0` (population) or `ddof: 1` (sample). Do not invent unsupported transforms.

`text:<literal line prefix>` supports ONLY `direct` extraction from the original
plain `source/*.txt`/`.log` research files named in that row's `source_paths`, never
a finished paper, Markdown summary or normalized-text substitute. It matches from
the start of exactly one original line, preserving whitespace; no regex or broad
number search. `index` is the zero-based numeric token AFTER that prefix, not a line
occurrence; omit it only when one numeric token follows. Missing, repeated or
non-finite matches fail. `index` is invalid for structured selectors. `decimals`
allows 0 to 100 fixed-point display places, including small scientific-notation
values; trailing zeros are immaterial, but synthetic measured precision is forbidden.
Use different cell selectors for different metrics sharing a column. This checks
numeric field provenance, not a generalized formal proof of the research.

Write exactly these two files directly with editing tools:
- `.brain/raw/outline_v1.json`: preserve the complete outline, including
  requirements, research claims, plotting and table plans. Replace subsection
  `citation_hints` with resolved `citation_candidates` arrays of exact keys;
  attach candidates to introduction and related-work plans as appropriate.
- `.brain/raw/updated_template.tex`: a complete LaTeX document with independently
  written Introduction and Related Work. Preserve the template's formatting,
  packages and section structure; remove sample/inherited research prose rather
  than treating it as content. Leave other sections as empty structural scaffolds
  for the section writer, not sample instructions or a finished source manuscript.

Do not return fenced artifact contents in chat. When author metadata is absent,
use an anonymous review author block in the generated document, not the template's
placeholder names, affiliations or emails. Formatting preservation does not require
preserving placeholder metadata or unsupported optional personal declarations.
Never invent funding, ethics approval or COI statements. A required authoritative
declaration without evidence is an actual blocker, not sample prose to retain.
Keep brief-required sections and research provenance; do not put template-selection
rationale or references to PaperOrchestra scaffolds/workspaces into scientific prose.
