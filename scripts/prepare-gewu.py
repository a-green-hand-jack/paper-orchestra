#!/usr/bin/env python3
"""Prepare the pinned Issue48 raw-only Gewu task. Never launches a model.

Uses hf's authenticated cache, not credentials on the command line. This
snapshot exposes individual files: archives are rejected, never extracted.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

REPO = "Jack-Jieke-Wu/Gewu-Solutions"
REVISION = "576302afd4bc95cd3b3ed809f4822c611a1ea95f"
SOLUTION = "lewton-agent_kerrDeflection-solution__57b47284"
ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "datasets/gewu-issue48"
BASELINE_COMMIT = "71a190f32f558767c2f75cac5bf9cd07d226a83e"
FILES = {
    "README.md", "README_kerr_arbitrary.md", "README_kerr_axis.md",
    "problem.yaml", "docs/evaluation-rubric.md",
    "kerr_axis_fit.csv", "kerr_axis_ks.csv", "kerr_axis_quadrature.csv",
    "kerr_general_cubic_check.csv", "kerr_general_cubic_residuals.csv",
    "kerr_ray_results.csv", "kerr_ray_results_high.csv",
    "kerr_axis_quadrature.py", "kerr_general_cubic_check.py", "kerr_ray_numeric.py",
    "kerr_axis_fit_run.txt", "kerr_axis_ks_run.txt", "kerr_axis_quadrature_run.txt",
    "kerr_general_cubic_check_run.txt", "kerr_ray_run.txt",
    "run_verified_nb_final_audit_run.txt",
}
BRIEF = """# Gewu Issue48: A New Kerr Weak-Deflection Paper

Write a NEW English research paper from the supplied raw numerical materials.
This is a writing evaluation, not a reconstruction of any existing paper.
Do not open, fetch, reconstruct, or quote any finished paper, TeX manuscript,
extracted paper text, bibliography, or prebuilt figure from the source solution
or its linked references. Links to those files in the research notes are NOT
permission to retrieve them. Do not run new simulations or expand the research.
Lightweight CSV analysis, numerical consistency checks, and plotting are allowed.
For independent literature use bibliographic metadata only, not full papers.

Deliver a freshly compiled 6-12 page PDF (including references) and a standalone
LaTeX source with bibliography and figures. Use an appropriate physics venue
template, selected autonomously; do not imply acceptance by that venue.
Include Abstract, Introduction, Methods, Results, Discussion, Limitations,
Conclusion, and References. Cite at least five real, relevant sources retrieved
independently with auditable identifiers; never fabricate references.

Define the incoming direction n, asymptotic impact vector B, b=|B|, spin triad,
signed beta_b/beta_c convention, and geometrized units. Explain how the supplied
Cartesian Kerr-Schild integration tests a cubic inverse-impact expansion; keep
the asymptotic impact distinct from the turning radius. Report M=1, a=0.7,
Rfac=5000, DOP853, rtol=2e-11, and the 12-point b=80..1160 grid.
Use all five orientation groups (axis-b, equatorial-c, parallel-n, oblique,
generic) in kerr_general_cubic_check.csv. Include a table of the b^4 residual
ranges for both components, computed from those rows and cross-checked against
kerr_general_cubic_residuals.csv. Report generic beta_b's range to two decimals
(-308.62 to -289.17) and beta_c's (-57.17 to -52.00).

Generate at least two NEW figures with provenance and passing visual reviews:
one quantitative plot directly from the supplied CSVs (code route, vector PDF),
and one conceptual impact/spin-triad diagram (text_to_image route, identify the
image provider/model). Never use image generation for quantitative results.
The conceptual image must not invent empirical observations. Explain residual
scaling without claiming finite-grid agreement proves an asymptotic theorem.
Discuss finite-distance, integration tolerance, fitting/truncation uncertainty,
the lack of new independent runs, and the weak-field/non-near-critical scope.
Preserve disagreement between fitted and theoretical coefficients rather than
claiming exact numerical agreement. Distinguish prior supplied audit evidence
from checks performed during this writing run.

Submission: /workspace/submission/main.tex, references.bib, final_paper.pdf,
figures/, and submission-status.json. A partial draft is not a passing result.
Keep the full pipeline workspace for provenance. Do not modify input files.
The fixed verifier checks completion, PDF/page/text structure, numeric anchors,
bibliography count, and both generation routes. Human scientific/visual review
is still required; automated reward is not certification of submission quality.
"""

VERIFIER = r'''#!/usr/bin/env python3
"""Fixed pre-run mechanical/grounding gates; not a scientific peer reviewer."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--workspace", type=Path, default=Path("/workspace"))
p.add_argument("--logs", type=Path, default=Path("/logs/verifier"))
a = p.parse_args()
a.logs.mkdir(parents=True, exist_ok=True)
checks = {}
def check(name, fn):
    try:
        checks[name] = bool(fn())
    except Exception:
        checks[name] = False
def load(path):
    return json.loads(path.read_text())
s = a.workspace / "submission"
w = a.workspace / "po-run-harbor"
pdf = s / "final_paper.pdf"
check("completed_submission", lambda: load(s / "submission-status.json")["status"] == "completed")
check("new_pdf", lambda: pdf.read_bytes().startswith(b"%PDF-") and pdf.stat().st_size > 10000)
check("latex_source", lambda: "\\begin{document}" in (s / "main.tex").read_text())
check("references", lambda: len(re.findall(r"@\w+\s*\{", (s / "references.bib").read_text())) >= 5)
check("input_unchanged", lambda: all(hashlib.sha256((a.workspace / name).read_bytes()).hexdigest() == sha
    for name, sha in load(Path(__file__).with_name("input-hashes.json")).items()))
def compile_source():
    build = a.logs.resolve() / "build"
    build.mkdir(exist_ok=True)
    result = subprocess.run(["latexmk", "-pdf", "-no-shell-escape", "-interaction=nonstopmode",
        "-halt-on-error", "-outdir=" + str(build), "main.tex"], cwd=s,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
    (a.logs / "compile.log").write_bytes(result.stdout)
    return result.returncode == 0 and (build / "main.pdf").is_file()
check("standalone_compilation", compile_source)
text = ""
try:
    info = subprocess.check_output(["pdfinfo", str(pdf)], text=True, stderr=subprocess.DEVNULL)
    checks["pages_6_to_12"] = 6 <= int(re.search(r"Pages:\s+(\d+)", info)[1]) <= 12
    text = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], text=True,
                                   stderr=subprocess.DEVNULL).lower().replace("\u2212", "-")
except (OSError, subprocess.CalledProcessError, TypeError):
    checks["pages_6_to_12"] = False
checks["sections"] = all(x in text for x in ["abstract", "introduction", "methods", "results",
    "discussion", "limitations", "conclusion", "references"])
checks["numeric_anchors"] = all(x in text for x in ["308.62", "289.17", "57.17", "52.00", "1160", "5000"])
checks["scope_and_method"] = all(x in text for x in ["dop853", "weak", "finite", "impact", "generic", "equatorial"])
def figures():
    rows = load(w / ".brain/raw/plotting_results.json")
    if isinstance(rows, dict):
        rows = rows.get("results", [])
    routes = set()
    for row in rows:
        if not row.get("image_path") or not row.get("generation_provenance"):
            continue
        history = row.get("critic_history", [])
        if not history or not history[-1].get("passed"):
            continue
        routes.add(row.get("render_route"))
    return {"code", "text_to_image"} <= routes and len(list((s / "figures").glob("*"))) >= 2
check("new_figures_both_routes", figures)
passed = all(checks.values())
(a.logs / "reward.txt").write_text("1.0\n" if passed else "0.0\n")
(a.logs / "checks.json").write_text(json.dumps({"checks": checks,
    "human_review_required": True}, indent=2) + "\n")
print(json.dumps(checks, indent=2))
raise SystemExit(0 if passed else 1)
'''


def hf(*args):
    # Never pass or print tokens, auth files, environment dumps, or verbose HTTP.
    result = subprocess.run(["hf", *args, "--format", "json"],
                            check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def put(path, data):
    if isinstance(data, str):
        data = data.encode()
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink():
            raise ValueError(f"refusing symlink: {ancestor}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() != data:
        raise ValueError(f"refusing to overwrite changed asset: {path}")
    path.write_bytes(data)


def prepare():
    if subprocess.run(["git", "check-ignore", "-q", str(DEST / "manifest.json")],
                      cwd=ROOT).returncode:
        raise ValueError("datasets/gewu-issue48 must be gitignored")
    for path in [DEST, *DEST.parents]:
        if path.is_symlink():
            raise ValueError(f"refusing symlink ancestor: {path}")
    tree = hf("datasets", "list", REPO, "--recursive", "--revision", REVISION)
    entries = [f for f in tree if "size" in f and f["path"].startswith(SOLUTION + "/")]
    indexed = {f["path"].split("/", 1)[1]: f for f in entries}
    if not FILES <= indexed.keys():
        raise ValueError("pinned raw allowlist is incomplete")
    if sum(indexed[f]["size"] for f in FILES) > 250_000:
        raise ValueError("selected input exceeds 250 KB budget")
    records = []
    downloaded = {}
    for name in sorted(FILES | {"../MANIFEST.md", "../README.md"}):
        metadata = name.startswith("../")
        remote = name[3:] if metadata else f"{SOLUTION}/{name}"
        # No extractall, archives, links, arbitrary paths, or implicit snapshots.
        path = PurePosixPath(remote)
        if path.is_absolute() or ".." in path.parts or "\\" in remote:
            raise ValueError("unsafe remote path")
        cached = Path(hf("download", REPO, remote, "--type", "dataset",
                         "--revision", REVISION)["path"])
        data = cached.read_bytes()
        remote_entry = next(f for f in tree if f.get("path") == remote)
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if blob != remote_entry["blob_id"]:
            raise ValueError(f"remote Git blob hash mismatch: {remote}")
        downloaded[name] = data
        local = Path("provenance") / remote if metadata else Path("input") / name
        put(DEST / local, data)
        records.append({"remote": remote, "local": str(local), "decision": "include",
                        "bytes": len(data), "sha256": digest(data), "git_blob_sha1": blob})
    for name, entry in sorted(indexed.items()):
        if name not in FILES:
            records.append({"remote": entry["path"], "decision": "exclude",
                "reason": "raw-only allowlist: no papers, extracted prose, bib, figures, archives, or unused support",
                "bytes": entry["size"], "git_blob_sha1": entry["blob_id"],
                "sha256": None, "hash_note": "remote metadata only; excluded content never downloaded/read"})
    audit = downloaded["run_verified_nb_final_audit_run.txt"].decode()
    assert "ALL_CHECKS_PASS = True" in audit and "DERIVATION_CHECKS_PASS = True" in audit
    assert "kerrDeflection-solution @ 57b47284" in downloaded["../MANIFEST.md"].decode()
    rows = list(csv.DictReader(io.StringIO(downloaded["kerr_general_cubic_check.csv"].decode())))
    assert len(rows) == 60 and len({r["orientation"] for r in rows}) == 5
    assert min(float(r["b"]) for r in rows) == 80 and max(float(r["b"]) for r in rows) == 1160
    summary = list(csv.DictReader(io.StringIO(downloaded["kerr_general_cubic_residuals.csv"].decode())))
    for row in summary:
        group = [r for r in rows if r["orientation"] == row["orientation"]]
        for component in ("b", "c"):
            vals = [float(r[f"b4_residual_{component}"]) for r in group]
            assert abs(min(vals) - float(row[f"min_b4_residual_{component}"])) < 1e-8
            assert abs(max(vals) - float(row[f"max_b4_residual_{component}"])) < 1e-8
    task = DEST / "benchmark/gewu-kerr-no-assets"
    put(task / "instruction.md", BRIEF)
    put(task / "tests/verify.py", VERIFIER)
    put(task / "tests/input-hashes.json", json.dumps({name: digest(downloaded[name])
        for name in sorted(FILES)}, indent=2) + "\n")
    put(task / "tests/test.sh", "#!/bin/bash\nset -euo pipefail\npython3 /tests/verify.py\n")
    put(task / "task.toml", '''version = "1.0"
[metadata]
name = "gewu-kerr-no-assets"
description = "Issue48 new paper from pinned raw Kerr numerical evidence"
[agent]
timeout_sec = 14400
[verifier]
timeout_sec = 120
[environment]
build_timeout_sec = 1200
cpus = 2
memory_mb = 8192
storage_mb = 16384
''')
    put(task / "environment/Dockerfile", '''FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y bash ca-certificates curl git python3 python3-numpy python3-scipy python3-matplotlib poppler-utils latexmk texlive-latex-extra texlive-fonts-recommended texlive-science && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY input/ /workspace/
''')
    for name in sorted(FILES):
        put(task / "environment/input" / name, downloaded[name])
    generated = []
    for path in sorted(task.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            generated.append({"path": str(path.relative_to(DEST)), "sha256": digest(path.read_bytes())})
    manifest = {"dataset": REPO, "revision": REVISION, "solution": SOLUTION,
        "source_commit": "57b47284", "source_url": "https://git.gewu-lab.ai/lewton-agent/kerrDeflection-solution",
        "selection": {"manifest_status": "accepted", "problem_yaml_status": "candidate",
            "raw_validation": "PASSED", "evidence": ["ALL_CHECKS_PASS = True", "DERIVATION_CHECKS_PASS = True"],
            "caveat": "PASSED describes supplied raw audits, not a verified live journal status"},
        "no_assets": True, "archives_extracted": 0, "models_run": False,
        "raw_validation": {"rows": len(rows), "orientations": 5, "csv_summary_consistent": True},
        "files": records, "frozen_task_files": generated}
    put(DEST / "manifest.json", json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"input": str(DEST / "input"), "brief": str(task / "instruction.md"),
        "benchmark": str(task), "downloaded_bytes": sum(r.get("bytes", 0) for r in records if r["decision"] == "include"),
        "raw_checks": "PASSED", "model_run": False}, indent=2))


def prepare_baseline():
    """An immutable code export, not a checkout/worktree or a model run."""
    snapshot = DEST / "baseline-code"
    if subprocess.run(["git", "check-ignore", "-q", str(snapshot / "package.json")], cwd=ROOT).returncode:
        raise ValueError("baseline-code must be ignored")
    archive = subprocess.run(["git", "archive", "--format=tar", BASELINE_COMMIT],
                             cwd=ROOT, capture_output=True, check=True).stdout
    if len(archive) > 32 * 1024 * 1024:
        raise ValueError("baseline code archive exceeds 32 MiB")
    files = []
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = tar.getmembers()
        if sum(member.size for member in members) > 32 * 1024 * 1024:
            raise ValueError("baseline expanded code exceeds 32 MiB")
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or "\\" in member.name:
                raise ValueError("unsafe baseline archive path")
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise ValueError("baseline archive contains a link or special file")
            if path.name in {".env", "auth.json"} or path.parts[0] in {".git", "datasets"}:
                raise ValueError("baseline archive contains forbidden state/data")
        # No extractall: validate every member first, then write only regular
        # source files through the same no-symlink/no-overwrite boundary.
        for member in members:
            if not member.isfile():
                continue
            data = tar.extractfile(member).read()
            target = snapshot / member.name
            put(target, data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            files.append({"path": member.name, "sha256": digest(data)})
    provenance = {"commit": BASELINE_COMMIT, "kind": "git-archive-build-only",
                  "archive_sha256": digest(archive), "files": files,
                  "models_run": False, "worktree_created": False, "branch_created": False}
    put(DEST / "baseline-provenance.json", json.dumps(provenance, indent=2) + "\n")
    if digest((snapshot / "package-lock.json").read_bytes()) != digest((ROOT / "package-lock.json").read_bytes()):
        raise ValueError("baseline dependency lock differs; cannot reuse the current node_modules")
    if not (ROOT / "node_modules/.bin/tsc").exists():
        raise ValueError("existing TypeScript dependency environment is unavailable")
    result = subprocess.run(["npm", "run", "build"], cwd=snapshot, capture_output=True, text=True)
    (DEST / "baseline-build.log").write_text(result.stdout + result.stderr)
    result.check_returncode()
    help_result = subprocess.run(["node", str(snapshot / "dist/cli.js"), "write", "--help"],
                                 capture_output=True, check=True, text=True)
    put(DEST / "baseline-write-help.txt", help_result.stdout)
    print(json.dumps({"baseline": str(snapshot), "commit": BASELINE_COMMIT,
                      "build": "passed", "model_run": False,
                      "dependency_reuse": "unchanged package-lock; ancestor node_modules",
                      "provenance": str(DEST / "baseline-provenance.json")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-only", action="store_true",
                        help="export and build pinned pre-Issue48 code; no HF download or model")
    args = parser.parse_args()
    if args.baseline_only:
        prepare_baseline()
    else:
        prepare()
