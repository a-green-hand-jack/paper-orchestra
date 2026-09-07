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


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "datasets/gewu-batch-1838e5e40878/manifest.json"


def load_json(path):
    if not path.is_file() or path.is_symlink():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


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
    if (record.get("status") == "completed" and isinstance(acceptance, dict)
            and acceptance.get("manuscript_accepted") is True
            and isinstance(runtime, dict) and runtime.get("submission_ready") is True
            and isinstance(run, dict) and run.get("status") == "completed"
            and isinstance(submission, dict) and submission.get("status") == "completed"
            and required):
        return "paper-ready", "mechanical submission and independent recompile evidence present"
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
