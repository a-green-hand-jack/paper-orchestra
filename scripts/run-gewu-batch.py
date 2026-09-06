#!/usr/bin/env python3
"""Run the authorized Gewu queue with four workers and no automatic relaunches."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import threading

ROOT = Path(__file__).resolve().parent.parent
LIMITS = {
    "PO_MAX_TOTAL_TOKENS": "16000000", "PO_MAX_MODEL_CALLS": "80",
    "PO_MAX_IMAGE_CALLS": "12", "PO_MAX_OPERATION_CALLS": "64",
    "PO_MAX_RUN_MINUTES": "120", "PO_MAX_TOTAL_COST": "100",
    "PO_MAX_LKM_CALLS": "10", "PO_TARGET_CITATIONS": "5",
    "PO_TIMEOUT_SECONDS": "7500",
}


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.absolute()
    if output.parent != ROOT / "docker-output" or output.exists():
        parser.error("output must be a new direct child of repository docker-output")
    if output.parent.resolve() != output.parent:
        parser.error("output parent must not be symlinked")
    if os.environ.get("PO_ALLOW_PAID") != "1":
        parser.error("PO_ALLOW_PAID=1 is required")
    for name in ("PO_MODEL", "PO_TEXT_CONFIG_FILE", "PO_OAUTH_PROVIDER_FILE",
                 "PO_TEXT_AUTH_FILE", "PO_CODEX_AUTH_FILE"):
        if not os.environ.get(name):
            parser.error(f"missing {name}")
    subprocess.run(["python3", "scripts/prepare-gewu-batch.py", "verify"], cwd=ROOT, check=True)
    manifest_path = ROOT / "datasets/gewu-batch/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    projects = manifest["projects"]
    if len(projects) != 38 or len({p["id"] for p in projects}) != 38:
        raise ValueError("Expected 38 unique remaining projects")
    for project in projects:
        if Path(project["id"]).name != project["id"] or project["status"] not in {"ready", "blocked"}:
            raise ValueError("Invalid project identity/status")
    output.mkdir(mode=0o700)
    state = {
        "started_at": now(), "status": "building", "concurrency": 4,
        "dataset": manifest["dataset"], "revision": manifest["revision"],
        "completed_prior": manifest["completed"], "limits_per_project": LIMITS,
        "model": os.environ["PO_MODEL"], "automatic_project_relaunches": 0,
        "internal_revision_policy": "Standard pipeline revisions/retries within the same cumulative budget.",
        "cost_note": "Known-cost ceiling only; unreported provider charges are not zero.",
        "projects": [{"id": p["id"], "title": p["title"],
                      "status": "queued" if p["status"] == "ready" else "blocked",
                      "reason": p["reason"], "output": str(output / p["id"])} for p in projects],
    }
    lock = threading.Lock()

    def save():
        temporary = output / "batch-status.json.tmp"
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(output / "batch-status.json")

    save()
    env = {**os.environ, **LIMITS, "PO_OUTPUT_DIR": str(output / "image-build")}
    env.pop("PO_DOCKER_SKIP_BUILD", None)
    env["PO_DOCKER_IMAGE"] = "paper-orchestra:gewu-batch-" + output.name.lower()
    with (output / "build.log").open("x") as log:
        result = subprocess.run(["node", "scripts/docker-e2e.mjs", "build"], cwd=ROOT,
                                env=env, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        state.update(status="build_failed", finished_at=now())
        save()
        raise SystemExit(result.returncode)
    build = json.loads((output / "image-build/acceptance.json").read_text())
    state.update(status="running", image_id=build["image_id"])
    save()
    env.update(PO_DOCKER_IMAGE=build["image_id"], PO_DOCKER_SKIP_BUILD="1")

    def work(pair):
        project, record = pair
        if project["status"] == "blocked":
            return
        with lock:
            record.update(status="running", started_at=now())
            save()
        worker_env = {**env, "PO_OUTPUT_DIR": record["output"],
                      "PO_MATERIALS_DIR": project["materials"], "PO_BRIEF_FILE": project["brief"]}
        try:
            with (output / (project["id"] + ".log")).open("x") as log:
                result = subprocess.run(["node", "scripts/docker-e2e.mjs", "run"], cwd=ROOT,
                                        env=worker_env, stdout=log, stderr=subprocess.STDOUT)
            acceptance = Path(record["output"]) / "acceptance.json"
            report = json.loads(acceptance.read_text()) if acceptance.exists() else {}
            passed = result.returncode == 0 and report.get("manuscript_accepted") is True
            with lock:
                record.update(status="completed" if passed else "paused",
                              exit_code=result.returncode, finished_at=now(),
                              acceptance=str(acceptance))
                save()
        except Exception as error:
            with lock:
                record.update(status="paused", error_type=type(error).__name__, finished_at=now())
                save()

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(work, zip(projects, state["projects"])))
    state.update(status="finished_with_blockers" if any(p["status"] != "completed" for p in state["projects"])
                 else "completed", finished_at=now())
    save()
    print(json.dumps({"status": state["status"], "output": str(output)}), flush=True)


if __name__ == "__main__":
    main()
