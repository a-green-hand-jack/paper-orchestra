#!/usr/bin/env python3
"""Summarize per-repository Gewu writing evidence without reading manuscript text.

The report is deliberately mechanical: it records which task reached a
submission-ready state, which task is blocked by missing evidence, and which
task needs a resume or review. It never treats a model self-report as a paper
completion signal.
"""
import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "datasets/gewu-batch-1838e5e40878/manifest.json"


def load_json(path):
    if not path.is_file() or path.is_symlink():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def production_check(project, workspace):
    policy = project.get("field_policy", {})
    target = policy.get("production_target")
    if not isinstance(target, dict):
        return False, "production target missing from the task manifest"
    if policy.get("template_id") == "nature-portfolio":
        return False, "generic Nature Portfolio scaffold is not a concrete journal/article-type template"
    metadata = load_json(workspace / "template" / "template-metadata.json")
    expected = {"official-system-package"}
    if policy.get("template_id") in {"iclr2026", "iclr2025"}:
        expected.add("official-kit")
    if not isinstance(metadata, dict) or metadata.get("official") is not True \
            or metadata.get("source_kind") not in expected:
        return False, "selected template lacks accepted official provenance"
    build = load_json(workspace / ".brain" / "raw" / "build.json")
    pages = build.get("pages") if isinstance(build, dict) else None
    tex_path = workspace / "submission" / "main.tex"
    if not isinstance(pages, int) or not tex_path.is_file():
        return False, "controller page count or final TeX is missing"
    tex = tex_path.read_text(encoding="utf-8", errors="replace")
    without_comments = re.sub(r"(^|[^\\])%.*$", r"\1", tex, flags=re.MULTILINE)
    prose = re.sub(r"\\[A-Za-z@]+\s*(\[[^]]*\])?(\{[^}]*\})?", " ", without_comments)
    words = sum(bool(re.search(r"[A-Za-z]", token)) for token in prose.split())
    headings = [re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
                for value in re.findall(r"\\section\*?\s*\{([^}]*)\}", tex)]

    def has_heading(required):
        required = required.lower()
        aliases = {
            "main results": r"main result|result", "proofs": r"proof",
            "examples": r"example", "limitations": r"limitation",
            "methods": r"method", "data availability": r"data availability|data and code",
            "code availability": r"code availability|data and code",
        }
        return any((re.search(aliases[required], heading) if required in aliases
                    else heading == required or required in heading) for heading in headings)

    missing = [section for section in target.get("required_sections", []) if not has_heading(section)]
    problems = []
    if pages < target.get("minimum_pages", 0):
        problems.append(f"{pages} pages < {target['minimum_pages']}")
    if words < target.get("minimum_body_words", 0):
        problems.append(f"{words} body words < {target['minimum_body_words']}")
    if missing:
        problems.append("missing sections: " + ", ".join(missing))
    return not problems, "; ".join(problems) if problems else f"{pages} pages, {words} body words, official template"
def status_for(project, record, output):
    if project["status"] == "blocked":
        return "blocked", project["reason"]
    if not record:
        return "queued", "no batch status record"
    acceptance = load_json(output / "acceptance.json")
    runtime = acceptance.get("runtime") if isinstance(acceptance, dict) else None
    workspace = output / "workspace"
    run = load_json(workspace / ".po-run" / "run.json")
    submission = load_json(workspace / "submission" / "submission-status.json")
    required = all((workspace / "submission" / name).is_file() for name in (
        "main.tex", "references.bib", "final.pdf", "final_paper.pdf", "README.md"))
    production_ok, production_detail = production_check(project, workspace)
    if (record.get("status") == "completed" and isinstance(acceptance, dict)
            and acceptance.get("manuscript_accepted") is True
            and isinstance(runtime, dict) and runtime.get("submission_ready") is True
            and isinstance(run, dict) and run.get("status") == "completed"
            and isinstance(submission, dict) and submission.get("status") == "completed"
            and required and production_ok):
        return "paper-ready", "mechanical submission, official-template, production-length and independent recompile evidence present"
    if record.get("status") == "completed" and not production_ok:
        return "needs-resume", "production contract failed: " + production_detail
    if record.get("status") in {"paused", "failed"}:
        return "needs-resume", (record.get("error") or "batch attempt did not reach paper-ready")[:500]
    return "running-or-incomplete", "output exists but the complete acceptance evidence is not present"


def build_report(manifest, batch_status, output):
    records = {row.get("id"): row for row in (batch_status or {}).get("projects", [])}
    rows = []
    for project in manifest["projects"]:
        record = records.get(project["id"])
        status, reason = status_for(project, record, output / project["id"])
        rows.append({
            "id": project["id"],
            "catalog_title": project.get("catalog_title"),
            "research_domain": project["field_policy"]["research_domain"],
            "target_venue": project["field_policy"]["target_venue"],
            "template_id": project["field_policy"]["template_id"],
            "input_status": project["status"],
            "paper_status": status,
            "reason": reason,
            "batch_status": record.get("status") if record else None,
        })
    counts = {}
    for row in rows:
        counts[row["paper_status"]] = counts.get(row["paper_status"], 0) + 1
    return {
        "schema_version": 1,
        "dataset": manifest["dataset"],
        "revision": manifest["revision"],
        "selection": (batch_status or {}).get("selection"),
        "counts": counts,
        "projects": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--check", action="store_true", help="exit nonzero if any ready task is not paper-ready")
    args = parser.parse_args()
    output = args.output.absolute()
    manifest_path = args.manifest.absolute()
    manifest = load_json(manifest_path)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("projects"), list):
        parser.error("manifest is missing or invalid")
    batch_status = load_json(output / "batch-status.json")
    report = build_report(manifest, batch_status, output)
    (output / "batch-report.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [f"# Gewu batch report", "", f"Dataset: `{report['dataset']}`", f"Revision: `{report['revision']}`", ""]
    lines.append("| Paper status | Count |")
    lines.append("|---|---:|")
    for key, count in sorted(report["counts"].items()):
        lines.append(f"| `{key}` | {count} |")
    lines.extend(["", "| Repository | Domain | Target | Template | Status | Reason |", "|---|---|---|---|---|---|"])
    for row in report["projects"]:
        reason = row["reason"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| `{row['id']}` | {row['research_domain']} | {row['target_venue']} | `{row['template_id']}` | `{row['paper_status']}` | {reason} |")
    (output / "batch-report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"report": str(output / "batch-report.json"), "counts": report["counts"]}))
    if args.check and any(row["input_status"] == "ready" and row["paper_status"] != "paper-ready" for row in report["projects"]):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
