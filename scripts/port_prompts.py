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

HEADER = """<!--
Ported from {source} by scripts/port_prompts.py.

Do not hand-edit the body unless you also update the Python reference, which
remains the behavioural source of truth for prompt content. Rerun the script
to regenerate.

Controller-substituted placeholders: {placeholders}
-->

"""


def main() -> int:
    out_dir = pathlib.Path("assets/commands")
    out_dir.mkdir(parents=True, exist_ok=True)
    failures = []

    for name, (source, prompt, placeholders) in SOURCES.items():
        body = prompt.replace("{{", "{").replace("}}", "}").strip()

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
