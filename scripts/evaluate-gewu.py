#!/usr/bin/env python3
"""Map a local CLI trial to the frozen Harbor verifier. Never invokes a model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "datasets/gewu-issue48"
DEPENDENCIES = {".tex", ".bib", ".bbl", ".sty", ".cls", ".bst", ".bbx", ".cbx",
                ".lbx", ".clo", ".def", ".cfg", ".fd", ".ltx", ".rtx", ".png",
                ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".otf", ".ttf", ".tfm",
                ".pfb", ".enc", ".map"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def regular(path):
    if path.is_symlink() or any(p.is_symlink() for p in path.parents) or not path.is_file():
        raise ValueError(f"not a regular non-symlink file: {path}")
    return path


def copy(source, target):
    regular(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def map_submission(workspace, destination):
    """Only filename/layout adaptation. Never fabricate artifacts or reviews."""
    exported = workspace / "submission"
    manuscript = workspace / ".brain/manuscript"
    mappings = []
    destination.mkdir(parents=True)
    if exported.is_dir():
        roots = [exported]
        mode = "cli_export"
    else:
        # The pre-Issue48 CLI has no portable export. Apply the same dependency
        # closure and bibliography-path adaptation as the new CLI export.
        roots = [workspace / "template", manuscript]
        mode = "legacy_layout"
    for source_root in roots:
        if not source_root.exists():
            continue
        for path in sorted(source_root.rglob("*")):
            rel = path.relative_to(source_root)
            if path.suffix.lower() not in DEPENDENCIES or any(p.startswith(".") for p in rel.parts):
                continue
            if re.search(r"(?:secret|credential|token|auth)(?:[._-]|$)", str(rel), re.I):
                continue
            if source_root.name == "template" and rel == Path("template.tex"):
                continue
            copy(path, destination / rel)
            mappings.append({"source": str(path), "destination": str(rel), "sha256": sha(path)})
    if mode == "legacy_layout":
        for source, name in [(manuscript / "final_paper.tex", "main.tex"),
                             (manuscript / "final_paper.pdf", "final_paper.pdf"),
                             (workspace / ".brain/raw/references.bib", "references.bib")]:
            if source.is_file():
                copy(source, destination / name)
                mappings.append({"source": str(source), "destination": name, "sha256": sha(source)})
        if not (destination / "main.tex").exists() and (manuscript / "raw_draft.tex").is_file():
            copy(manuscript / "raw_draft.tex", destination / "main.tex")
        for path in destination.rglob("*.tex"):
            text = path.read_text()
            def rewrite(match):
                refs = []
                for ref in match[2].split(","):
                    value = ref.strip()
                    if value in {"../raw/references", "../raw/references.bib",
                                 ".brain/raw/references", ".brain/raw/references.bib"}:
                        value = "references.bib" if value.endswith(".bib") else "references"
                    refs.append(value)
                return match[1] + ",".join(refs) + match[3]
            adapted = re.sub(r"(\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{)([^{}]+)(\})", rewrite, text)
            if adapted != text:
                path.write_text(adapted)
                mappings.append({"destination": str(path.relative_to(destination)),
                                 "adaptation": "portable bibliography path only", "sha256": sha(path)})
    canonical, alias = destination / "final_paper.pdf", destination / "final.pdf"
    if canonical.is_file() and alias.is_file() and sha(canonical) != sha(alias):
        raise ValueError("final.pdf and final_paper.pdf disagree; refusing to choose a result")
    if not canonical.exists() and alias.is_file():
        copy(alias, canonical)
        mappings.append({"source": str(exported / "final.pdf"),
                         "destination": "final_paper.pdf", "sha256": sha(canonical)})
    return mode, mappings


def evaluate(args):
    workspace = args.workspace.absolute()
    raw = args.input.absolute()
    output = args.output.absolute()
    if output == workspace or workspace in output.parents or output == raw or raw in output.parents:
        raise ValueError("evaluation output must be outside the trial and raw input")
    if any(p.is_symlink() for p in [output, *output.parents]):
        raise ValueError("symlinked evaluation output")
    output.mkdir(parents=True, exist_ok=False)
    report = {"version": 1, "workspace": str(workspace), "raw_input": str(raw),
              "output": str(output), "status": "error", "model_invoked": False,
              "scientific_criteria_changed": False, "human_review_required": True}
    code = 2
    try:
        manifest_path = DATA / "manifest.json"
        manifest = json.loads(regular(manifest_path).read_text())
        report["manifest_sha256"] = sha(manifest_path)
        report["sample_acceptance"] = manifest["selection"]
        task = DATA / "benchmark/gewu-kerr-no-assets"
        # Refuse changed criteria rather than updating the frozen manifest.
        for item in manifest["frozen_task_files"]:
            path = DATA / item["path"]
            if sha(regular(path)) != item["sha256"]:
                raise ValueError(f"frozen benchmark changed: {path}")
        verifier = task / "tests/verify.py"
        report["verifier_sha256"] = sha(verifier)
        report["brief_sha256"] = sha(task / "instruction.md")
        state_path = workspace / ".po-run/run.json"
        state_bytes = regular(state_path).read_bytes()
        state = json.loads(state_bytes)
        report["run_state"] = state.get("status")
        report["run_id"] = state.get("run_id")
        report["configuration"] = {key: state.get(key) for key in
            ["default_model", "stage_models", "scope", "versions", "source_digest", "template_digest"]}
        report["brief_matches"] = sha(regular(workspace / "source/BRIEF.md")) == report["brief_sha256"]
        hashes = json.loads((task / "tests/input-hashes.json").read_text())
        report["unexpected_raw_files"] = sorted(str(p.relative_to(raw)) for p in raw.rglob("*")
            if not p.is_dir() and str(p.relative_to(raw)) not in hashes)
        report["raw_input_matches"] = all(sha(regular(raw / name)) == value for name, value in hashes.items())
        source = workspace / "source"
        report["unexpected_imported_files"] = sorted(str(p.relative_to(source)) for p in source.rglob("*")
            if not p.is_dir() and str(p.relative_to(source)) not in {*hashes, "BRIEF.md"})
        report["imported_source_mismatches"] = [name for name, value in hashes.items()
            if (source / name).exists() and sha(regular(source / name)) != value]
        report["not_imported_by_cli"] = [name for name in hashes if not (source / name).exists()]
        if (not report["brief_matches"] or not report["raw_input_matches"] or report["imported_source_mismatches"]
                or report["unexpected_raw_files"] or report["unexpected_imported_files"]):
            raise ValueError("trial does not match the frozen raw input and brief")
        if state.get("status") not in {"completed", "failed", "interrupted"}:
            report["status"] = "pending"
            report["reason"] = "trial is not terminal; no manuscript was inspected or exported"
        else:
            mapped = output / "workspace"
            mapped.mkdir()
            for name in hashes:
                copy(raw / name, mapped / name)
            mode, mappings = map_submission(workspace, mapped / "submission")
            report["mapping_mode"] = mode
            report["mapping"] = mappings
            plotting = workspace / ".brain/raw/plotting_results.json"
            if plotting.exists():
                copy(plotting, mapped / "po-run-harbor/.brain/raw/plotting_results.json")
            sub = mapped / "submission"
            completed = (state.get("status") == "completed" and (sub / "main.tex").is_file()
                         and (sub / "final_paper.pdf").is_file()
                         and (workspace / ".brain/manuscript/final_paper.tex").is_file())
            status = {"status": "completed" if completed else "partial", "run_state": state.get("status"),
                      "mapping_mode": mode, "source_workspace": str(workspace)}
            (sub / "submission-status.json").write_text(json.dumps(status, indent=2) + "\n")
            if state_path.read_bytes() != state_bytes:
                raise ValueError("trial changed during export; rerun evaluation when it is idle")
            logs = output / "verifier"
            command = [sys.executable, str(verifier), "--workspace", str(mapped), "--logs", str(logs)]
            report["verifier_command"] = command
            result = subprocess.run(command, text=True, capture_output=True, timeout=120)
            (output / "verifier.stdout.txt").write_text(result.stdout)
            (output / "verifier.stderr.txt").write_text(result.stderr)
            checks = json.loads((logs / "checks.json").read_text())
            report.update(checks)
            report["verifier_exit_code"] = result.returncode
            report["reward"] = float((logs / "reward.txt").read_text())
            report["status"] = "passed" if result.returncode == 0 and all(checks["checks"].values()) else "failed"
            code = 0 if report["status"] == "passed" else 1
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        report["status"] = "error"
        report["reason"] = str(error)
    (output / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--input", type=Path, default=DATA / "input")
    parser.add_argument("--output", type=Path, default=DATA / "evaluations" /
                        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    raise SystemExit(evaluate(parser.parse_args()))
