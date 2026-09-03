import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { UserFacingError } from "./errors.js";
import { assertInside, ensureDir, walkFiles } from "./files.js";
import { assertArchiveSafe } from "./input.js";
import { templateAdapter, venueDefinition, type CcfAVenueKey, type TemplateAdapter } from "./venue-catalog.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface AdaptVenueOptions {
  readonly id: string;
  readonly sourceDirectory: string;
  /** Exact official kit/CFP URL supplied for a manual adapter. */
  readonly sourceUrl: string | null;
  readonly destination: string;
  readonly entrypoint: string;
  readonly adapter: TemplateAdapter | null;
  readonly venueKey: string | null;
  readonly year: number | null;
}

export interface InstalledVenue {
  readonly id: string;
  readonly directory: string;
  readonly sourceDigest: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireEmptyDestination(destination: string): string {
  const resolved = resolve(destination);
  if (existsSync(resolved)) {
    throw new UserFacingError(`destination already exists: ${resolved}`);
  }
  return resolved;
}

function adapterGuidance(adapter: TemplateAdapter | null, venueKey: string | null, year: number | null): string {
  const venue = venueKey ? venueDefinition(venueKey) : undefined;
  const title = adapter?.title ?? venue?.title ?? "Custom official author kit";
  const instructions = adapter?.authorInstructionsUrl ?? venue?.authoringResourceUrl ?? "";
  const identity = adapter?.id ?? (venueKey && year ? `${venueKey}${year}` : "custom");
  const lines = [
    `# ${title}`,
    "",
    `Template identity: \`${identity}\``,
    "",
    "This directory was normalized from a user-supplied official author kit. The upstream style files remain unmodified; `template.tex` is a copy of the kit entrypoint so PaperOrchestra can import it consistently.",
    "",
    "Before submitting, verify page limits, anonymity, supplements, ethics, artifacts, and the current author instructions for the selected edition.",
  ];
  if (instructions) lines.push("", `Official authoring resource: ${instructions}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Turn an official author-kit directory into PaperOrchestra's stable local
 * template shape without editing its styles. Callers must explicitly name the
 * entrypoint because conference kits disagree on its filename and layout.
 */
export function adaptVenueKit(options: AdaptVenueOptions): InstalledVenue {
  const destination = requireEmptyDestination(options.destination);
  const sourceDirectory = resolve(options.sourceDirectory);
  if (!existsSync(sourceDirectory)) {
    throw new UserFacingError(`official author-kit directory does not exist: ${sourceDirectory}`);
  }

  // Reject symlinks and special files before cpSync follows anything.
  const sourceFiles = walkFiles(sourceDirectory);
  const entrypoint = assertInside(sourceDirectory, options.entrypoint);
  if (!sourceFiles.includes(relative(sourceDirectory, entrypoint))) {
    throw new UserFacingError(`author-kit entrypoint is not a regular file: ${options.entrypoint}`);
  }
  if (!entrypoint.toLowerCase().endsWith(".tex")) {
    throw new UserFacingError(`author-kit entrypoint must be a .tex file: ${options.entrypoint}`);
  }
  if (options.sourceUrl && !options.sourceUrl.startsWith("https://")) {
    throw new UserFacingError("official author-kit source URL must use https://");
  }

  ensureDir(dirname(destination));
  cpSync(sourceDirectory, destination, { recursive: true, dereference: false, errorOnExist: true });
  copyFileSync(entrypoint, join(destination, "template.tex"));
  writeFileSync(
    join(destination, "template-metadata.json"),
    `${JSON.stringify(
      {
        id: options.id,
        venue_key: options.venueKey,
        year: options.year,
        adapted_at: new Date().toISOString(),
        source: options.adapter?.source ?? "user-supplied-official-kit",
        source_url:
          options.sourceUrl ??
          (options.adapter?.source.kind === "official-archive" ? options.adapter.source.archiveUrl : null),
        author_instructions_url:
          options.adapter?.authorInstructionsUrl ??
          (options.venueKey ? venueDefinition(options.venueKey)?.authoringResourceUrl : null),
        source_entrypoint: options.entrypoint,
        provenance: options.adapter?.provenance ?? "User-supplied official author kit.",
        verified_at: options.adapter?.verifiedAt ?? null,
        license_status: options.adapter?.licenseStatus ?? "user-supplied",
        build: options.adapter?.build ?? null,
        constraints: options.adapter?.constraints ?? null,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(destination, "guidelines.md"), adapterGuidance(options.adapter, options.venueKey, options.year));

  return { id: options.id, directory: destination, sourceDigest: sha256(join(destination, "template.tex")) };
}

/** Download a checksum-pinned official kit only when the user asks for it. */
export async function installOfficialVenue(id: string, destination: string): Promise<InstalledVenue> {
  const adapter = templateAdapter(id);
  if (!adapter) throw new UserFacingError(`unknown template adapter "${id}"`);
  if (adapter.source.kind !== "official-archive") {
    throw new UserFacingError(
      `${id} is not a direct-download adapter. Read its instructions with \`paper-orchestra templates info ${id}\`.`,
    );
  }

  const temporary = mkdtempSync(join(tmpdir(), "paper-orchestra-venue-"));
  try {
    const archive = join(temporary, "author-kit.zip");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(adapter.source.archiveUrl, { redirect: "follow", signal: abort.signal });
    } catch (error) {
      const detail = abort.signal.aborted ? `timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s` : (error as Error).message;
      throw new UserFacingError(`could not download ${id} official author kit: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new UserFacingError(`could not download ${id} official author kit: HTTP ${response.status}`);
    }
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const actual = sha256(archive);
    if (actual !== adapter.source.sha256) {
      throw new UserFacingError(
        `${id} author-kit checksum mismatch: expected ${adapter.source.sha256}, got ${actual}. Refusing to install it.`,
      );
    }

    const extracted = join(temporary, "extracted");
    ensureDir(extracted);
    await assertArchiveSafe(archive, extracted);
    await execa("unzip", ["-qq", archive, "-d", extracted]);
    const sourceDirectory = join(extracted, adapter.source.sourceRoot);
    if (!existsSync(sourceDirectory)) {
      throw new UserFacingError(
        `${id} author kit did not contain the expected directory ${adapter.source.sourceRoot}`,
      );
    }
    return adaptVenueKit({
      id: adapter.id,
      sourceDirectory,
      sourceUrl: adapter.source.archiveUrl,
      destination,
      entrypoint: adapter.source.entrypoint,
      adapter,
      venueKey: adapter.venueKey,
      year: adapter.year,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Validate an edition id before normalizing a manually downloaded CCF-A kit. */
export function manualCcfAdapter(
  id: string,
  venueKey: string,
  year: number,
): { venueKey: CcfAVenueKey; year: number } {
  const venue = venueDefinition(venueKey);
  if (!venue) throw new UserFacingError(`unknown CCF-A venue key "${venueKey}"`);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new UserFacingError(`venue year must be a four-digit year, got "${year}"`);
  }
  const expected = `${venueKey.replace(/-/g, "")}${year}`;
  if (id !== expected) {
    throw new UserFacingError(`manual CCF-A adapter id must be "${expected}", got "${id}"`);
  }
  return { venueKey: venue.key, year };
}
