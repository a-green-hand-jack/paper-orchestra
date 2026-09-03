import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UserFacingError } from "./errors.js";
import { templateAdapter, TEMPLATE_ADAPTERS, type TemplateAdapter } from "./venue-catalog.js";

/**
 * Resolve `--template` to a directory.
 *
 * The CLI is meant to be installed globally and run from the directory holding
 * the research materials, where a relative path like `templates/cvpr2025` means
 * nothing. So a bare venue name resolves against the templates bundled with the
 * package, while an explicit path still works for a template of your own.
 */

/** Locate the packaged `templates/` directory, however the package is installed. */
export function templateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", "templates"),
    resolve(here, "..", "..", "templates"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new UserFacingError(
    `cannot locate the bundled templates/ directory from ${here}. ` +
      "Pass an explicit path with --template instead.",
  );
}

/** Venue names shipped with the package. */
export function bundledVenues(): string[] {
  let root: string;
  try {
    root = templateRoot();
  } catch {
    return [];
  }
  return readdirSync(root)
    .filter((name) => {
      const dir = join(root, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "template.tex"));
    })
    .sort();
}

/** Every explicit venue edition or documented external adapter. */
export function templateAdapters(): readonly TemplateAdapter[] {
  return TEMPLATE_ADAPTERS;
}

/**
 * A directory for `--template`, from either a venue name or a path.
 *
 * A path is anything that looks like one -- absolute, or containing a
 * separator -- so `cvpr2025` is a venue and `./my-template` is a path even if a
 * venue happened to share its name. Being explicit here avoids the surprise of
 * a local directory silently shadowing a bundled venue.
 */
export function looksLikeTemplatePath(value: string): boolean {
  return isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".");
}

export function resolveTemplate(value: string): string {
  const looksLikePath = looksLikeTemplatePath(value);

  if (looksLikePath) {
    const dir = resolve(value);
    if (!existsSync(dir)) {
      throw new UserFacingError(`no such template directory: ${dir}`);
    }
    if (!existsSync(join(dir, "template.tex"))) {
      throw new UserFacingError(
        `${dir} is not a LaTeX template: it has no template.tex. ` +
          `Bundled venues: ${bundledVenues().join(", ") || "none found"}.`,
      );
    }
    return dir;
  }

  const adapter = templateAdapter(value);
  if (adapter && adapter.source.kind !== "bundled") {
    if (adapter.source.kind === "official-archive") {
      throw new UserFacingError(
        `${adapter.id} is an official-download adapter, not a bundled author kit. ` +
          `Run \`paper-orchestra templates install ${adapter.id} ./templates/${adapter.id}\`, then ` +
          `pass \`--template ./templates/${adapter.id}\`. Official instructions: ${adapter.authorInstructionsUrl}`,
      );
    }
    throw new UserFacingError(
      `${adapter.id} requires a locally downloaded official author kit. ` +
        `Read \`paper-orchestra templates info ${adapter.id}\`, normalize it with ` +
        "`paper-orchestra templates adapt`, then pass the resulting directory with `--template`.",
    );
  }

  const bundled = join(templateRoot(), value);
  if (existsSync(join(bundled, "template.tex"))) return bundled;

  const available = bundledVenues();
  throw new UserFacingError(
    `unknown venue "${value}". Available: ${available.join(", ") || "none found"}. ` +
      "To use a template of your own, pass a path (e.g. ./my-template).",
  );
}
