import { execa } from "execa";
import type { Check } from "./state/schema.js";
import { textToImageCapability } from "./imagegen.js";

async function which(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execa("which", [binary]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function version(binary: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execa(binary, [...args]);
    return (stdout || stderr).split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

function check(name: string, passed: boolean, detail: string): Check {
  // Environment requirements are never advisory: a missing pdflatex is not
  // something a run can proceed past.
  return { name, passed, detail, advisory: false };
}

/**
 * A capability probe: reported, but never a reason to fail.
 *
 * Kept distinct from a requirement because a machine with no Python plotting
 * environment can still write a paper with `--use-plotting` off, and failing
 * there would be a false alarm. Rendered as `warn` when unmet, so an unmet
 * probe does not read as `ok`.
 */
export interface Probe {
  readonly name: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

/** A required binary: absent means some stage cannot run at all. */
async function requireBinary(name: string, binary: string, why: string): Promise<Check> {
  const path = await which(binary);
  return check(
    name,
    path !== null,
    path !== null ? path : `\`${binary}\` not found on PATH; needed for ${why}`,
  );
}

/**
 * Report the environment a run depends on.
 *
 * Split into hard requirements and capability probes. `doctor` exits non-zero
 * only on the former, because a machine without a Python plotting environment
 * can still write a paper with `--use-plotting` off, and failing there would be
 * a false alarm.
 */
export async function runDoctor(): Promise<{ checks: Check[]; probes: Probe[]; ok: boolean }> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0] ?? "0");
  checks.push(
    check(
      "node>=20",
      major >= 20,
      major >= 20 ? process.version : `${process.version} is below the required v20`,
    ),
  );

  const opencodePath = await which("opencode");
  const opencodeVersion = opencodePath ? await version("opencode", ["--version"]) : null;
  checks.push(
    check(
      "opencode",
      opencodePath !== null,
      opencodePath ? `${opencodeVersion ?? "unknown version"} at ${opencodePath}` : "not on PATH",
    ),
  );

  checks.push(await requireBinary("git", "git", "workspace checkpoints"));
  checks.push(await requireBinary("pdflatex", "pdflatex", "manuscript assembly"));
  checks.push(await requireBinary("bibtex", "bibtex", "bibliography compilation"));
  checks.push(await requireBinary("pdftotext", "pdftotext", "importing PDF source material"));

  const providers = await listOpencodeProviders();
  checks.push(
    check(
      "opencode providers",
      providers.length > 0,
      providers.length > 0
        ? providers.join(", ")
        : "no authenticated providers; run `opencode auth login`",
    ),
  );

  const probes: Probe[] = [];

  const pdftoppm = await which("pdftoppm");
  probes.push({
    name: "pdftoppm (visual review)",
    satisfied: pdftoppm !== null,
    detail: pdftoppm
      ? `${pdftoppm} - refinement can review rendered pages`
      : "absent - refinement will skip visual review of the compiled PDF",
  });

  const matplotlib = await version("python3", [
    "-c",
    "import matplotlib; print('matplotlib ' + matplotlib.__version__)",
  ]);
  probes.push({
    name: "python3 + matplotlib (plotting)",
    satisfied: matplotlib !== null,
    detail:
      matplotlib ??
      "not importable in the system python - `--use-plotting` needs a provisioned venv",
  });

  const imageAdapter = await textToImageCapability();
  probes.push({
    name: "image provider adapter (text-to-image)",
    satisfied: imageAdapter.ok,
    detail: imageAdapter.detail,
  });

  return { checks, probes, ok: checks.every((c) => c.passed) };
}

/**
 * Authenticated OpenCode providers, read from OpenCode's own auth store.
 *
 * Only provider names are read, never credential values, so `doctor` output is
 * safe to paste into an issue.
 */
export async function listOpencodeProviders(): Promise<string[]> {
  const home = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  const authFile = `${home}/opencode/auth.json`;
  try {
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    return Object.keys(parsed).sort();
  } catch {
    return [];
  }
}

let cachedOpencodeVersion: string | null = null;

/**
 * The OpenCode CLI version, recorded in run state and checkpoint trailers.
 * Memoized: the binary cannot change mid-process, and spawning it per call
 * makes workspace preparation noticeably slower for no benefit.
 */
export async function opencodeVersion(): Promise<string> {
  cachedOpencodeVersion ??= (await version("opencode", ["--version"])) ?? "unknown";
  return cachedOpencodeVersion;
}
