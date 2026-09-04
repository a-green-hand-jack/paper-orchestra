import { readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { walkFiles } from "./files.js";

/**
 * Finding a conventional artifact inside an input we do not control.
 *
 * The rest of the pipeline asks questions like "did the author supply a
 * bibliography" and "did the author supply figures". Those used to be answered
 * by reading one hard-coded path -- `source/references.bib`,
 * `source/figures/`. That is only correct when the author hands us a directory
 * shaped exactly the way we imagined, and the whole point of a single flexible
 * input is that they do not: pointing at a repository puts the materials one
 * level down, and the lookup silently answers "no". A run then pays for
 * retrieval it did not need and cites papers the author never chose, or
 * publishes none of the seven figures they drew, with a green check either way.
 *
 * So the lookup has to search. Searching, in turn, needs a notion of which
 * files in a tree are the AUTHOR'S, because a real input contains other
 * people's files too, and several of them are named exactly like the thing we
 * are looking for. This module is that notion, in one place, so bibliography,
 * figures and template discovery all draw the boundary identically.
 */

/**
 * Directory names whose contents are somebody else's source.
 *
 * Shared with template discovery, which needs the same judgement for the same
 * reason: a vendored dependency can contain a complete paper, a bibliography,
 * and a directory of figures.
 */
export const FOREIGN_DIRS: ReadonlySet<string> = new Set([
  "code", "src", "vendor", "third_party", "thirdparty", "external", "deps",
  "submodules", "examples", "example", "tests", "test", "docs",
]);

/**
 * Files that mark a directory as the root of a software package.
 *
 * Only a NESTED package counts. The input root having a manifest is the normal
 * case -- users point us at their research repository -- so treating that as
 * foreign would treat every real input as foreign.
 *
 * This exclusion is not hypothetical. One corpus input vendors an entire
 * paper-writing tool under `paper_orchestra/`, whose `templates/cvpr2025/` and
 * `templates/iclr2025/` each ship a `references.bib`, and whose `assets/` and
 * `frontend/examples/` each ship a `.png`. That task's author supplied NO
 * bibliography, so the correct answer is "none" and the run should pay for
 * retrieval. A search that merely preferred the author's copy would find the
 * vendored one when there is no author copy to prefer -- which is exactly what
 * an earlier attempt at this did, silently adopting a 60-entry example
 * bibliography as the paper's own.
 */
export const PACKAGE_MANIFESTS: ReadonlySet<string> = new Set([
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "package.json",
  "cargo.toml", "go.mod", "pom.xml", "build.gradle", "gemfile", "cmakelists.txt",
  "pubspec.yaml", "composer.json",
]);

/** Is any ancestor directory of `rel` one of somebody else's? */
export function underForeignDir(rel: string): boolean {
  return dirname(rel).split(sep).some((part) => FOREIGN_DIRS.has(part.toLowerCase()));
}

/**
 * Is `rel` inside a package nested within `root`?
 *
 * Walks the ancestors between the file and the root, exclusive of the root
 * itself, looking for a manifest.
 */
export function underNestedPackage(root: string, rel: string): boolean {
  const parts = dirname(rel).split(sep).filter((part) => part && part !== ".");
  for (let depth = 1; depth <= parts.length; depth += 1) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, ...parts.slice(0, depth)));
    } catch {
      continue;
    }
    if (entries.some((entry) => PACKAGE_MANIFESTS.has(entry.toLowerCase()))) return true;
  }
  return false;
}

/** Is this path the author's own, rather than a vendored dependency's? */
export function isAuthored(root: string, rel: string): boolean {
  return !underForeignDir(rel) && !underNestedPackage(root, rel);
}

/** Directory depth, used to prefer what the author left where they would look for it. */
export function depthOf(rel: string): number {
  return rel.split(sep).length - 1;
}

/**
 * Every file under `root` that belongs to the author.
 *
 * `onUnsafe: "skip"` rather than the throwing default: this walks an already
 * imported tree, where symlinks were never copied, and a search that refuses
 * to answer because of one odd entry is worse than one that passes over it.
 */
export function authoredFiles(root: string): string[] {
  return walkFiles(root, { onUnsafe: "skip" }).filter((rel) => isAuthored(root, rel));
}

/**
 * The author's file matching `predicate`, shallowest first, or null.
 *
 * `rank` breaks ties among equally shallow matches; higher wins. Without one,
 * ties fall to path order, which is stable but arbitrary -- fine when the
 * question is "is there one", not fine when two candidates differ in kind.
 */
export function findAuthoredFile(
  root: string,
  predicate: (rel: string) => boolean,
  rank?: (rel: string) => number,
): string | null {
  const matches = authoredFiles(root).filter(predicate);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (rank) {
      const difference = rank(b) - rank(a);
      if (difference !== 0) return difference;
    }
    return depthOf(a) - depthOf(b) || a.localeCompare(b);
  });
  return matches[0] as string;
}

/**
 * The author's directory whose basename satisfies `predicate`, or null.
 *
 * Derived from the file walk rather than a directory walk of its own, so an
 * empty directory is never returned: a `figures/` holding nothing is not a
 * supply of figures, and answering "yes" for it would publish zero figures
 * while reporting that the author provided some.
 */
export function findAuthoredDirectory(
  root: string,
  predicate: (basename: string) => boolean,
): string | null {
  const dirs = new Set<string>();
  for (const rel of authoredFiles(root)) {
    let dir = dirname(rel);
    while (dir && dir !== ".") {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const matches = [...dirs].filter((dir) => {
    const base = dir.split(sep).pop();
    return base !== undefined && predicate(base.toLowerCase());
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  return matches[0] as string;
}
