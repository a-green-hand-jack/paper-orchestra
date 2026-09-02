import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UserFacingError } from "./errors.js";

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

/**
 * A directory for `--template`, from either a venue name or a path.
 *
 * A path is anything that looks like one -- absolute, or containing a
 * separator -- so `cvpr2025` is a venue and `./my-template` is a path even if a
 * venue happened to share its name. Being explicit here avoids the surprise of
 * a local directory silently shadowing a bundled venue.
 */
export function resolveTemplate(value: string): string {
  const looksLikePath =
    isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".");

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

  const bundled = join(templateRoot(), value);
  if (existsSync(join(bundled, "template.tex"))) return bundled;

  const available = bundledVenues();
  throw new UserFacingError(
    `unknown venue "${value}". Available: ${available.join(", ") || "none found"}. ` +
      "To use a template of your own, pass a path (e.g. ./my-template).",
  );
}
