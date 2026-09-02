#!/usr/bin/env python3
"""Port the Python system prompts into OpenCode command markdown, faithfully.

The prompts are the accumulated product of a lot of tuning, so they are copied
rather than rewritten. One mechanical transform is applied: doubled braces
(`{{`/`}}`) are collapsed to single braces, while the genuine placeholders
listed in PLACEHOLDERS survive for the controller to substitute.

For the outline and literature prompts the collapse is simply `.format()`
semantics -- they are `.format()`ed in the Python, so doubled braces are how a
literal brace is written.

For the section-writing and content-refinement prompts the collapse is a BUG
FIX. Those prompts are never `.format()`ed (section_writing_agent.py:57,
content_refinement_agent.py:51), so their doubled braces reach the model
verbatim. Three sites are affected:

  * section_writing_agent.py:78 instructs the model about
    `\\usepackage[capitalize]{{cleveref}}`, which is not the valid LaTeX it is
    telling the model to preserve.
  * content_refinement_agent.py:60,73 wrap the REQUIRED JSON output example in
    `{{`/`}}`, so the model is shown malformed JSON while being told to return
    JSON. That response is re-parsed at content_refinement_agent.py:305 and the
    reflection loop breaks when parsing fails, so this defect plausibly causes
    those breaks.

Collapsing also matters downstream: the `no_unresolved_markers` validator
treats `{{...}}` in a manuscript as an unresolved placeholder, so seeding the
model's context with doubled braces invites output our own validator rejects.

Run from the repository root. Rerunning is safe and idempotent.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from methods.prompts import (  # noqa: E402
    content_refinement_agent,
    literature_review_agent,
    outline_agent,
    section_writing_agent,
)

# name -> (source path, prompt text, placeholders the controller substitutes)
SOURCES = {
    "1-po-outline": (
        "methods/prompts/outline_agent.py",
        outline_agent.outline_agent_system_prompt,
        ["cutoff_date"],
    ),
    "2-po-literature": (
        "methods/prompts/literature_review_agent.py",
        literature_review_agent.literature_review_agent_writter_prompt,
        ["cutoff_date", "paper_count", "min_cite_paper_count"],
    ),
    "4-po-section-writing": (
        "methods/prompts/section_writing_agent.py",
        section_writing_agent.section_writing_agent_prompt,
        [],
    ),
    "5-po-refinement": (
        "methods/prompts/content_refinement_agent.py",
        content_refinement_agent.content_refinement_agent_system_prompt,
        [],
    ),
}

# Deliberate divergences from the Python, applied after the brace collapse.
#
# name -> list of (exact text to find, replacement, why).
#
# A patch is not a rewrite: each one must match EXACTLY once, or the script
# fails rather than silently producing a prompt nobody reviewed. This is the
# mechanism for a prompt rule that paper-orchestra has outgrown, so the
# generated file stays reproducible instead of being hand-edited and then
# clobbered by the next run.
PATCHES = {
    "2-po-literature": [
        (
            """- You have access to the abstract of {paper_count} collected papers.
- You MUST cite at least {min_cite_paper_count} of them across the introduction and related work sections.""",
            """- You have access to the abstract of {paper_count} collected papers. Every one has
  been retrieved and screened for relevance to THIS paper's subject; they are ordered
  with the most relevant first.
- You MUST cite at least {min_cite_paper_count} distinct papers across the introduction
  and related work sections.
- Do NOT try to cite all of them. Prefer the smallest set that genuinely supports your
  claims: a citation must back the specific sentence it is attached to. A paragraph
  where every sentence carries three references is worse than one where the right
  sentence carries one.
- If a collected paper does not support any claim you are actually making, leave it
  uncited. An unused entry in the bibliography costs nothing; an unsupported citation
  costs the paper its credibility.""",
            "the Python cited 90% of whatever retrieval returned "
            "(literature_review_agent.py:492-494), a rule that only holds when every hit "
            "is on-topic. Against LKM's general-science corpus it forced the off-domain "
            "tail into the manuscript, and two measured runs cited 84 of 94 and 67 of 74 "
            "sources in ~2150 words -- one citation per 25 words. The floor is now a "
            "target capped by availability, enforced by the `citation_floor` validator at "
            "both drafting and refinement. See issue #3.",
        ),
    ],
}

HEADER = """<!--
Ported from {source} by scripts/port_prompts.py.

Do not hand-edit the body. The Python reference plus this script's PATCHES table
are together the source of truth; rerun the script to regenerate.

Controller-substituted placeholders: {placeholders}
-->

"""


def main() -> int:
    out_dir = pathlib.Path("assets/commands")
    out_dir.mkdir(parents=True, exist_ok=True)
    failures = []

    for name, (source, prompt, placeholders) in SOURCES.items():
        body = prompt.replace("{{", "{").replace("}}", "}").strip()

        # Apply the deliberate divergences. Each must match exactly once: a
        # patch that silently stops matching would revert a considered change
        # back to the Python's behaviour without anyone noticing.
        for find, replace, _why in PATCHES.get(name, []):
            if body.count(find) != 1:
                failures.append(
                    f"{name}: patch matched {body.count(find)} times, expected exactly 1"
                )
                continue
            body = body.replace(find, replace)

        # Every declared placeholder must survive the collapse, or the
        # controller will substitute nothing and the model will see a raw
        # `{cutoff_date}`.
        for placeholder in placeholders:
            if "{" + placeholder + "}" not in body:
                failures.append(f"{name}: placeholder {{{placeholder}}} missing after transform")

        # Nothing may still be doubled: `no_unresolved_markers` rejects
        # `{{...}}` in a manuscript, so it must not appear in a prompt either.
        if "{{" in body or "}}" in body:
            failures.append(f"{name}: doubled braces survived the transform")

        target = out_dir / f"{name}.md"
        target.write_text(
            HEADER.format(
                source=source,
                placeholders=", ".join("{" + p + "}" for p in placeholders) or "none",
            )
            + body
            + "\n"
        )
        print(f"{target}  {len(body):>6} chars  placeholders: {placeholders or 'none'}")

    for failure in failures:
        print(f"ERROR  {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
