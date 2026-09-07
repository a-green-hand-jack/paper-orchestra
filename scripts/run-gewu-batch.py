#!/usr/bin/env python3
"""Run the authorized all-solution Gewu queue with four workers and no automatic relaunches."""
import argparse
import fcntl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
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
DEFAULT_TIMEOUT_MULTIPLIER = "1.5"


def now():
    return datetime.now(timezone.utc).isoformat()


def active_worker_outputs():
    """Return output directories currently mounted by acceptance workers."""
    result = subprocess.run(
        ["docker", "ps", "--filter", "name=po-acceptance-", "--format", "{{.ID}}"],
        cwd=ROOT, check=False, capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError("cannot inspect active Docker workers before stale recovery")
    outputs = {}
    for container_id in result.stdout.splitlines():
        inspect = subprocess.run(
            ["docker", "inspect", "--format", "{{json .Mounts}}", container_id],
            cwd=ROOT, check=False, capture_output=True, text=True,
        )
        if inspect.returncode:
            raise RuntimeError(f"cannot inspect active Docker worker {container_id}")
        for mount in json.loads(inspect.stdout):
            if mount.get("Destination") == "/output" and mount.get("Source"):
                outputs[Path(mount["Source"]).resolve()] = container_id
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume", action="store_true",
                        help="resume a stopped existing batch in place, preserving cumulative budgets")
    parser.add_argument(
        "--recover-stale", action="store_true",
        help=("with --resume, recover state left running by a dead launcher; "
              "refuses while any worker bound to this batch is active"),
    )
    parser.add_argument(
        "--recover-incomplete", action="store_true",
        help="with --resume, restart paused outputs that have no resumable run or submission",
    )
    parser.add_argument("--project", action="append", dest="project_ids",
                        help="run one project id; repeat to create a bounded queue")
    parser.add_argument("--shard-index", type=int, help="zero-based shard number")
    parser.add_argument("--shard-count", type=int, help="total number of deterministic shards")
    parser.add_argument(
        "--timeout-multiplier", default=os.environ.get("PO_BATCH_TIMEOUT_MULTIPLIER", DEFAULT_TIMEOUT_MULTIPLIER),
        help="scale every stage timeout; resumes update the persisted multiplier without resetting usage",
    )
    args = parser.parse_args()
    if args.recover_stale and not args.resume:
        parser.error("--recover-stale requires --resume")
    try:
        timeout_multiplier = float(args.timeout_multiplier)
    except (TypeError, ValueError):
        parser.error("--timeout-multiplier must be a positive number")
    if not timeout_multiplier > 0:
        parser.error("--timeout-multiplier must be a positive number")
    output = args.output.absolute()
    if os.getuid() == 0:
        parser.error("run as a non-root user with Docker access")
    if (output.parent != ROOT / "docker-output" or "," in str(output)
            or output.name in {".", ".."}):
        parser.error("output must be a dedicated direct child of repository docker-output")
    if output.resolve() != output or output.is_symlink():
        parser.error("output and its ancestors must not be symlinked")
    if (args.resume and not output.is_dir()) or (not args.resume and output.exists()):
        parser.error("use --resume for an existing batch; otherwise output must be new")
    if os.environ.get("PO_ALLOW_PAID") != "1":
        parser.error("PO_ALLOW_PAID=1 is required")
    for name in ("PO_MODEL", "PO_TEXT_CONFIG_FILE", "PO_OAUTH_PROVIDER_FILE",
                 "PO_TEXT_AUTH_FILE", "PO_CODEX_AUTH_FILE"):
        if not os.environ.get(name):
            parser.error(f"missing {name}")
    subprocess.run(["python3", "scripts/prepare-gewu-batch.py", "verify"], cwd=ROOT, check=True)
    manifest_path = ROOT / "datasets/gewu-batch-1838e5e40878/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    all_projects = manifest["projects"]
    if len(all_projects) < 1 or len({p["id"] for p in all_projects}) != len(all_projects):
        raise ValueError("Expected a non-empty unique current-solution queue")
    for project in all_projects:
        policy = project.get("field_policy")
        if (Path(project["id"]).name != project["id"] or project["id"] in {".", ".."}
                or project["status"] not in {"ready", "blocked"}
                or not isinstance(policy, dict)
                or policy.get("research_domain") not in {"mathematics", "physics", "natural-sciences", "ai-ml"}
                or policy.get("template_id") not in {"annals-mathematics", "physical-review-letters", "nature-portfolio", "iclr2026"}):
            raise ValueError("Invalid project identity/status")
    if args.project_ids and (args.shard_index is not None or args.shard_count is not None):
        parser.error("use --project or --shard-index/--shard-count, not both")
    if (args.shard_index is None) != (args.shard_count is None):
        parser.error("--shard-index and --shard-count must be supplied together")
    if args.shard_count is not None and (args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count):
        parser.error("shard index must be in [0, shard-count)")
    requested_ids = set(args.project_ids or [])
    if args.shard_count is not None:
        requested_ids = {p["id"] for n, p in enumerate(all_projects) if n % args.shard_count == args.shard_index}
    elif args.resume and not requested_ids:
        prior = output / "batch-status.json"
        if prior.is_file() and not prior.is_symlink():
            requested_ids = {p["id"] for p in json.loads(prior.read_text()).get("projects", [])}
    unknown = requested_ids - {p["id"] for p in all_projects}
    if unknown:
        parser.error("unknown project id(s): " + ", ".join(sorted(unknown)))
    projects = [p for p in all_projects if not requested_ids or p["id"] in requested_ids]
    if not projects:
        parser.error("selected queue is empty")
    protected = [Path(p[key]).resolve() for p in projects for key in ("materials", "brief")]
    protected += [Path(os.environ[key]).resolve() for key in (
        "PO_MATERIALS_DIR", "PO_BRIEF_FILE", "PO_TEXT_CONFIG_FILE", "PO_MODEL_KEY_FILE",
        "PO_OAUTH_PROVIDER_FILE", "PO_TEXT_AUTH_FILE", "PO_CODEX_AUTH_FILE",
        "PO_LKM_KEY_FILE", "PO_BOHR_CONFIG_DIR", "PO_HF_HOME", "PO_HF_TOKEN_FILE")
        if os.environ.get(key)]
    if any(output == p or output in p.parents or p in output.parents for p in protected):
        parser.error("output overlaps an input, provider, or credential mount")
    if not args.resume:
        output.mkdir(mode=0o700)
    # Keep this descriptor alive for the entire batch, including the image build.
    batch_lock = os.fdopen(os.open(output / ".batch.lock",
                                  os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "r+")
    try:
        fcntl.flock(batch_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error("another launcher holds the batch lock")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + f"-{os.getpid()}"
    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    state = {
        "started_at": now(), "status": "building", "concurrency": 4,
        "dataset": manifest["dataset"], "revision": manifest["revision"],
        "completed_prior": manifest["completed"], "limits_per_project": LIMITS,
        "timeout_multiplier": timeout_multiplier,
        "model": os.environ["PO_MODEL"], "automatic_project_relaunches": 0,
        "internal_revision_policy": "Standard pipeline revisions/retries within the same cumulative budget.",
        "cost_note": "Known-cost ceiling only; unreported provider charges are not zero.",
        "selection": {"project_ids": [p["id"] for p in projects],
                      "shard_index": args.shard_index, "shard_count": args.shard_count},
        "projects": [{"id": p["id"], "title": p["title"],
                      "research_domain": p["field_policy"]["research_domain"],
                      "target_venue": p["field_policy"]["target_venue"],
                      "template_id": p["field_policy"]["template_id"],
                      "status": "queued" if p["status"] == "ready" else "blocked",
                      "reason": p["reason"], "output": str(output / p["id"])} for p in projects],
    }
    if args.resume:
        status_path = output / "batch-status.json"
        if status_path.resolve() != status_path:
            parser.error("batch status must not be symlinked")
        prior_status = status_path.read_bytes()
        state = json.loads(prior_status)
        stale_candidate = state.get("status") in {"running", "building"} or any(
            p.get("status") == "running" for p in state["projects"]
        )
        if stale_candidate and not args.recover_stale:
            parser.error("original batch is running/building; stop it gracefully and wait first")
        if (state.get("dataset") != manifest["dataset"]
                or state.get("revision") != manifest["revision"]
                or state.get("completed_prior") != manifest["completed"]
                or state.get("limits_per_project") != LIMITS
                or state.get("concurrency") != 4
                or state.get("model") != os.environ["PO_MODEL"]
                or state.get("output", str(output)) != str(output)
                or state.get("manifest_sha256", manifest_hash) != manifest_hash
                or [p["id"] for p in state["projects"]] != [p["id"] for p in projects]):
            parser.error("original batch does not match the verified manifest, model, or limits")
        for project, record in zip(projects, state["projects"]):
            directory = output / project["id"]
            if (record.get("output") != str(directory) or directory.resolve() != directory
                    or record.get("title") != project["title"]
                    or record.get("research_domain") != project["field_policy"]["research_domain"]
                    or record.get("target_venue") != project["field_policy"]["target_venue"]
                    or record.get("template_id") != project["field_policy"]["template_id"]
                    or record.get("reason") != project["reason"]
                    or record.get("status") not in ({"queued", "paused", "completed", "blocked", "running"}
                                                        if args.recover_stale else
                                                       {"queued", "paused", "completed", "blocked"})
                    or (record["status"] == "blocked") != (project["status"] == "blocked")):
                parser.error(f"original project/output binding mismatch: {project['id']}")
        if stale_candidate:
            active = active_worker_outputs()
            collisions = [
                (record["id"], active[Path(record["output"]).resolve()])
                for record in state["projects"]
                if Path(record["output"]).resolve() in active
            ]
            if collisions:
                details = ", ".join(f"{project_id} ({container_id})"
                                    for project_id, container_id in collisions)
                parser.error("cannot recover stale batch while bound workers are active: " + details)
            for record in state["projects"]:
                if record["status"] == "running":
                    record.update(
                        status="paused",
                        error_type="StaleBatchRecovery",
                        error="previous launcher exited before recording the worker result",
                        finished_at=now(),
                    )
            state.update(
                status="stale_recovered",
                stale_recovered_at=now(),
                stale_recovery_policy="no launcher lock and no active worker bound to this batch",
            )
        with (output / f"batch-status-before-{stamp}.json").open("xb") as archive:
            archive.write(prior_status)
        state.update(status="building", resumed_at=now(), timeout_multiplier=timeout_multiplier)
        state.pop("finished_at", None)
    state.update(manifest_sha256=manifest_hash, output=str(output))
    lock = threading.Lock()

    def save():
        temporary = output / "batch-status.json.tmp"
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(output / "batch-status.json")

    save()
    build_dir = output / f"image-build-{stamp}"
    env = {**os.environ, **LIMITS, "PO_OUTPUT_DIR": str(build_dir)}
    env["PO_TIMEOUT_MULTIPLIER"] = str(timeout_multiplier)
    env.pop("PO_DOCKER_SKIP_BUILD", None)
    env["PO_DOCKER_IMAGE"] = "paper-orchestra:gewu-batch-" + stamp.lower()
    with (output / f"build-{stamp}.log").open("x") as log:
        result = subprocess.run(["node", "scripts/docker-e2e.mjs", "build"], cwd=ROOT,
                                env=env, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        state.update(status="build_failed", finished_at=now())
        save()
        raise SystemExit(result.returncode)
    build = json.loads((build_dir / "acceptance.json").read_text())
    state.update(status="running", image_id=build["image_id"])
    save()
    env.update(PO_DOCKER_IMAGE=build["image_id"], PO_DOCKER_SKIP_BUILD="1")

    def work(pair):
        project, record = pair
        if project["status"] == "blocked":
            return
        worker_env = {**env, "PO_OUTPUT_DIR": record["output"],
                      "PO_MATERIALS_DIR": project["materials"], "PO_BRIEF_FILE": project["brief"],
                      "PO_TEMPLATE": project["field_policy"]["template_id"]}
        if args.resume:
            worker_env["PO_RESUME_TIMEOUT_MULTIPLIER"] = str(timeout_multiplier)
        try:
            directory = Path(record["output"])
            acceptance = directory / "acceptance.json"
            mode = "run"
            if args.resume:
                for path in (acceptance, directory / "workspace/.po-run/run.json",
                             directory / "workspace/.po-run/budget.json"):
                    if path.resolve() != path:
                        raise ValueError("symlinked resume evidence/workspace")
                report = json.loads(acceptance.read_text()) if acceptance.exists() else {}
                if report and report.get("output") != str(directory):
                    raise ValueError("acceptance output binding mismatch")
                if report.get("manuscript_accepted") is True:
                    workspace = directory / "workspace"
                    completed_run = json.loads((workspace / ".po-run/run.json").read_text())
                    submission = workspace / "submission"
                    submission_status = json.loads((submission / "submission-status.json").read_text())
                    if (completed_run.get("status") != "completed" or report.get("ok") is not True
                            or report.get("runtime", {}).get("ok") is not True
                            or report.get("runtime", {}).get("submission_ready") is not True
                            or report.get("recompile", {}).get("ok") is not True
                            or submission_status.get("status") != "completed"
                            or not all((submission / name).is_file() for name in
                                       ("main.tex", "references.bib", "final.pdf", "final_paper.pdf", "README.md"))):
                        raise ValueError("accepted report does not match completed workspace/submission evidence")
                    with lock:
                        record.update(status="completed", acceptance=str(acceptance),
                                      acceptance_reused_at=now())
                        save()
                    return
                if record["status"] == "completed":
                    raise ValueError("completed project has no accepted report; refusing rerun")
                run_path = directory / "workspace/.po-run/run.json"
                if run_path.is_file():
                    mode = "resume"
                    run = json.loads(run_path.read_text())
                    ledger_path = run_path.with_name("budget.json")
                    ledger_bytes = ledger_path.read_bytes()
                    ledger = json.loads(ledger_bytes)
                    cap = ledger["limits"]["max_total_tokens"]
                    if (ledger["run_id"] != run["run_id"] or not isinstance(cap, int)
                            or not 0 <= cap <= 16000000
                            or run["scope"].get("max_total_tokens") != cap
                            or ledger.get("token_limit_increases")):
                        raise ValueError("ledger identity/original token cap mismatch")
                    for field in ("max_total_tokens", "max_total_cost", "max_model_calls",
                                  "max_image_calls", "max_operation_calls", "max_run_minutes"):
                        expected = float(LIMITS["PO_" + field.upper()])
                        if ledger["limits"].get(field) != expected or run["scope"].get(field) != expected:
                            raise ValueError(f"persisted budget differs from authorization: {field}")
                    evidence = {"at": now(), "output": str(directory), "run_id": run["run_id"],
                                "ledger_sha256": hashlib.sha256(ledger_bytes).hexdigest(),
                                "limits": ledger["limits"], "totals": ledger["totals"],
                                "budget_policy": "persisted-scope; no reset or increase"}
                    with (output / f"{project['id']}-budget-before-{stamp}.json").open("x") as snapshot:
                        json.dump(evidence, snapshot, indent=2)
                        snapshot.write("\n")
                    with lock:
                        record["budget_before_resume"] = evidence
                    # Absence of this knob makes the harness use only persisted scope.
                    worker_env.pop("PO_MAX_TOTAL_TOKENS", None)
                elif directory.exists() or record["status"] != "queued":
                    if not args.recover_incomplete:
                        raise ValueError("no resumable run; refusing to reset existing/incomplete output")
                    worker_env["PO_ALLOW_INCOMPLETE_RESTART"] = "1"
            with lock:
                for key in ("finished_at", "exit_code", "error", "error_type"):
                    record.pop(key, None)
                record.update(status="running", started_at=now(), launch_mode=mode)
                save()
            with (output / f"{project['id']}-{stamp}.log").open("x") as log:
                result = subprocess.run(["node", "scripts/docker-e2e.mjs", mode], cwd=ROOT,
                                        env=worker_env, stdout=log, stderr=subprocess.STDOUT)
            report = json.loads(acceptance.read_text()) if acceptance.exists() else {}
            passed = result.returncode == 0 and report.get("manuscript_accepted") is True
            with lock:
                record.update(status="completed" if passed else "paused",
                              exit_code=result.returncode, finished_at=now(),
                              acceptance=str(acceptance))
                save()
        except Exception as error:
            with lock:
                record.update(status="paused", error_type=type(error).__name__,
                              error=str(error), finished_at=now())
                save()

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(work, zip(projects, state["projects"])))
    state.update(status="finished_with_blockers" if any(p["status"] != "completed" for p in state["projects"])
                 else "completed", finished_at=now())
    save()
    report_result = subprocess.run(
        ["python3", "scripts/report-gewu-batch.py", "--output", str(output)],
        cwd=ROOT, check=False, capture_output=True, text=True,
    )
    state["report"] = {
        "path": str(output / "batch-report.json"),
        "generated": report_result.returncode == 0,
    }
    save()
    print(json.dumps({"status": state["status"], "output": str(output)}), flush=True)


if __name__ == "__main__":
    main()
