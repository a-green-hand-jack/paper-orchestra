import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./state/schema.js";

const GIT_NAME = "PaperOrchestra Agent";
const GIT_EMAIL = "paper-orchestra@localhost";

/** Field and record separators for `git log` output parsing. */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa("git", [...args], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: GIT_NAME,
      GIT_AUTHOR_EMAIL: GIT_EMAIL,
      GIT_COMMITTER_NAME: GIT_NAME,
      GIT_COMMITTER_EMAIL: GIT_EMAIL,
    },
  });
  return stdout;
}

/**
 * Initialize the workspace as a git repository on its own run branch.
 *
 * Idempotent: `write` calls it on every start, including a resume, so the
 * absence of `.git` is never a reason a resume fails.
 */
export async function initGit(workspace: string, runBranch: string): Promise<void> {
  if (!existsSync(join(workspace, ".git"))) {
    await git(workspace, ["init", "--quiet", "--initial-branch", runBranch]);
    await git(workspace, ["config", "user.name", GIT_NAME]);
    await git(workspace, ["config", "user.email", GIT_EMAIL]);
    return;
  }
  const current = await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (current !== runBranch) {
    const exists = await git(workspace, [
      "rev-parse",
      "--verify",
      "--quiet",
      runBranch,
    ]).catch(() => "");
    await git(workspace, exists ? ["checkout", runBranch] : ["checkout", "-b", runBranch]);
  }
}

export interface CheckpointInput {
  readonly workspace: string;
  readonly runId: string;
  readonly stage: string;
  readonly status: string;
  readonly mode: string;
  readonly sessionId?: string | null;
  readonly model?: string | null;
  readonly checks?: readonly Check[];
}

function validationSummary(checks: readonly Check[] | undefined): string {
  if (!checks || checks.length === 0) return "none";
  const failed = checks.filter((c) => !c.passed);
  return failed.length === 0
    ? `${checks.length} passed`
    : `${checks.length - failed.length}/${checks.length} passed; failed: ${failed
        .map((c) => c.name)
        .join(", ")}`;
}

/**
 * Commit the workspace as a checkpoint.
 *
 * `--allow-empty` is deliberate: a stage that produced no diff (a validation
 * pass on already-correct artifacts, a gate resolution) still belongs in the
 * timeline. Without it the git log would silently omit exactly the transitions
 * an operator needs when reconstructing what a run did.
 */
export async function checkpoint(input: CheckpointInput): Promise<string> {
  const { workspace } = input;
  await git(workspace, ["add", "-A"]);

  const body = [
    `PO-Run: ${input.runId}`,
    `PO-Stage: ${input.stage}`,
    `PO-Status: ${input.status}`,
    `PO-Mode: ${input.mode}`,
    `PO-Session: ${input.sessionId ?? "none"}`,
    `PO-Model: ${input.model ?? "unknown"}`,
    `PO-Validation: ${validationSummary(input.checks)}`,
    `PO-Timestamp: ${new Date().toISOString()}`,
  ].join("\n");

  await git(workspace, [
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    `PO: ${input.stage} - ${input.status}`,
    "-m",
    body,
  ]);

  return git(workspace, ["rev-parse", "HEAD"]);
}

export interface Trailers {
  readonly run?: string;
  readonly stage?: string;
  readonly status?: string;
  readonly mode?: string;
  readonly session?: string;
  readonly model?: string;
  readonly validation?: string;
  readonly timestamp?: string;
}

/**
 * Parse `PO-*` trailers out of a commit message. Tolerant by design: an
 * unrecognized or missing trailer yields an absent field rather than throwing,
 * so `status` can still print history written by a different version.
 */
export function parseTrailers(message: string): Trailers {
  const out: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const match = /^PO-([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      out[match[1].toLowerCase()] = match[2].trim();
    }
  }
  return out as Trailers;
}

export interface CheckpointRecord extends Trailers {
  readonly sha: string;
  readonly subject: string;
}

/** Read the checkpoint timeline, newest first. */
export async function checkpointHistory(
  workspace: string,
  limit = 50,
): Promise<CheckpointRecord[]> {
  if (!existsSync(join(workspace, ".git"))) return [];
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  const raw = await git(workspace, ["log", `-${limit}`, `--format=${format}`]).catch(() => "");

  const records: CheckpointRecord[] = [];
  for (const entry of raw.split(RECORD_SEP)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [sha, subject, body] = trimmed.split(FIELD_SEP);
    if (!sha || subject === undefined) continue;
    records.push({ sha, subject, ...parseTrailers(body ?? "") });
  }
  return records;
}
