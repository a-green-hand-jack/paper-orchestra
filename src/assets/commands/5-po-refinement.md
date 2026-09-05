<!-- Source of truth. No controller placeholders. -->

Revise this run's complete manuscript using its actual content and PDF review.
Write the full revised LaTeX directly to `.brain/manuscript/final_paper.tex`.
Do not return artifact code blocks, a response letter, or an editorial worklog.

## Inputs

Read `.brain/manuscript/review.json` and `.brain/manuscript/raw_draft.tex`.
When `.brain/manuscript/final_paper.tex` exists, read and revise that latest version
rather than resetting to the original draft. Also read `.brain/raw/outline_v1.json`,
`.brain/raw/citation_map.json`, `.brain/raw/materials.json`, the actual source and
extracted results needed to check claims, the commissioning brief, and available
guidelines, figure/table artifacts and build report listed in the workspace contract.
Do not assume an unlisted PDF, feedback file or change history exists.

The controller supplies review JSON with this shape:
```json
{
  "version": 1,
  "manuscript_sha256": "sha256 of the reviewed LaTeX",
  "pdf_sha256": "sha256 of the reviewed PDF",
  "ready": false,
  "summary": "Content and rendered-page assessment",
  "findings": [{"severity": "blocking", "location": "Section 4, page 5, Table 2",
    "problem": "Metric units are missing", "action": "Add the recorded units"}],
  "reviewed_pages": 8
}
```
Severity is `blocking` or `advisory`. Hashes bind review to the reviewed files;
the controller checks freshness and supplies real rendered-page review. You must
not edit the review, forge its hashes, or change `ready` to pass a gate.

## Revision

Address each finding at its stated location, prioritizing blocking findings.
Improve the argument, method completeness, experimental explanation, literature
positioning, figures/tables, and brief compliance as required by the findings.
Repair page-level clipping, overlap, unreadable figures, awkward breaks and
excess whitespace through source/layout changes without concealing content.
Preserve sound existing content and the selected venue's style.
Generated figures remain controller-owned. When the controller reports regeneration,
inspect and include the updated image rather than responding to the old pixels.
Never substitute an inline LaTeX picture, TikZ diagram or other rendering route for
a required text-to-image figure, or leave its generated asset undisplayed.

Reopen actual results before changing numbers. Keep captions, tables, numeric
charts and prose consistent, preserving units, splits and precision. Use only
exact permitted citation keys. A requested measurement that has not been found
must first be sought in the available materials; an available calculation is
not a new experiment, but use controller-verified results rather than mental
arithmetic. Never invent an experiment, datum, citation or author declaration.
Check image-provider and model names against `.brain/raw/plotting_results.json`,
not the outline's proposed generation prompt. If the exact image model was not
reported by the executor, preserve that uncertainty rather than asserting a version.

If a finding requires genuinely missing experiments or unavailable permissions,
do not silently ignore it or claim resolution. State the supported research
limitation accurately in the manuscript and explain the remaining blocker in
your closing message. The controller must retain an unready result until the
requirement is resolved; do not weaken requirements to manufacture success.

Keep LaTeX complete and compilable with stable packages, matching environments
and correct figure/table paths. Remove placeholders. Follow applicable anonymity,
length and required-section rules. Never copy inherited finished manuscript prose.

Audit the generated author and declaration blocks as well as the scientific body.
When author metadata is absent, retain or produce an anonymous review manuscript,
removing placeholder affiliations/emails rather than requesting author completion.
Omit unsupported optional personal declarations and remove "to be completed by
authors", TODOs and sample boilerplate. Never invent funding, ethics approval or
COI claims, including assertions of their absence. A required authoritative
declaration without supporting information remains an actual blocker; do not
silently remove its requirement or claim resolution. Keep brief-required sections.

Remove scientific prose about PaperOrchestra scaffolds/workspaces, pipeline
execution and automatic venue selection, including claims of being prepared for
Nature because auto chose it. This does not remove explicit research-provenance
requirements: preserve an accurate statement that no new simulations were performed
when the brief requires it, along with other factual research boundaries.

The controller recompiles and reviews the revision; writing a final filename or
saying "ready" does not establish submission readiness.
