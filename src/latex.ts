/** Pure LaTeX text analysis. Kept separate from compilation so it is testable. */

/**
 * Citation keys actually used by a manuscript.
 *
 * Handles the whole `\cite` family (`\citep`, `\citet`, `\citeauthor`, ...),
 * optional arguments (`\citep[see][]{key}`) and comma-separated key lists,
 * because a manuscript that cites correctly in any of those forms must not be
 * reported as citing nothing.
 */
export function citedKeys(tex: string): string[] {
  const keys = new Set<string>();
  const pattern = /\\[Cc]ite[a-zA-Z]*\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;
  for (const match of tex.matchAll(pattern)) {
    for (const key of (match[1] ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys].sort();
}

/** Entry keys defined by a BibTeX file. */
export function bibKeys(bib: string): string[] {
  const keys = new Set<string>();
  for (const match of bib.matchAll(/@[a-zA-Z]+\s*\{\s*([^,\s}]+)/g)) {
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/** Graphics included by the manuscript, without extensions normalized away. */
export function includedGraphics(tex: string): string[] {
  const found = new Set<string>();
  for (const match of tex.matchAll(
    /\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g,
  )) {
    const path = match[1]?.trim();
    if (path) found.add(path);
  }
  return [...found].sort();
}

/**
 * Add the graphics package when a manuscript uses figures but its template
 * does not load it. Several official templates intentionally omit `graphicx`
 * from their minimal preambles, which otherwise makes `\\includegraphics`
 * print its arguments as text while still leaving a partial PDF behind.
 */
export function ensureGraphicxPackage(tex: string): string {
  if (includedGraphics(tex).length === 0) return tex;
  if (/\\(?:use|Require)package\s*(?:\[[^\]]*\]\s*)?\{[^}]*\bgraphicx\b[^}]*\}/.test(tex)) {
    return tex;
  }

  const documentClass = /^\\documentclass\s*(?:\[[^\]]*\]\s*)?\{[^}]+\}[^\n]*(?:\r?\n|$)/m.exec(tex);
  if (!documentClass || documentClass.index === undefined) return tex;

  const insertion = documentClass.index + documentClass[0].length;
  return `${tex.slice(0, insertion)}\\usepackage{graphicx}\n${tex.slice(insertion)}`;
}

/**
 * Placeholders a finished manuscript must not contain.
 *
 * `{{...}}` is the template-substitution marker, and the TODO form is what the
 * Python's prompts tell the model to leave behind when it cannot resolve
 * something. Either one in a final manuscript means the run reported success
 * over an unfinished document.
 */
export function unresolvedMarkers(tex: string): string[] {
  const found: string[] = [];
  for (const match of tex.matchAll(/\{\{[^}]*\}\}/g)) {
    if (match[0]) found.push(match[0]);
  }
  for (const match of tex.matchAll(/%\s*TODO\([^)]*\)[^\n]*/g)) {
    if (match[0]) found.push(match[0].trim());
  }
  // Both the bundled and official CVPR kits ship prose that describes how an
  // abstract should be written. It is valid LaTeX, so compilation alone cannot
  // distinguish it from a completed abstract. Treat those known scaffolds as
  // unresolved content rather than delivering a polished-looking blank paper.
  for (const match of tex.matchAll(/^\s*Abstract here\.\s*$/gim)) {
    if (match[0]) found.push(match[0].trim());
  }
  for (const match of tex.matchAll(/The\s+ABSTRACT\s+is\s+to\s+be\s+fully\s+justified\s+italicized\s+text/gi)) {
    if (match[0]) found.push(match[0].replace(/\s+/g, " "));
  }
  return found;
}

/** The `\documentclass` argument, if the manuscript declares one. */
export function documentClass(tex: string): string | null {
  const match = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/.exec(tex);
  return match?.[1]?.trim() ?? null;
}

/** Style packages the manuscript loads via `\usepackage`. */
export function usedPackages(tex: string): string[] {
  const found = new Set<string>();
  for (const match of tex.matchAll(/\\usepackage\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
    for (const name of (match[1] ?? "").split(",")) {
      const trimmed = name.trim();
      if (trimmed) found.add(trimmed);
    }
  }
  return [...found].sort();
}

/**
 * Options a manuscript passes to one `\usepackage`, or null when the package is
 * not loaded at all. An empty array means the package is loaded bare.
 *
 * `usedPackages` deliberately discards the option list, which is where the
 * anonymity switch of several venues lives: CVPR anonymizes only under
 * `\usepackage[review]{cvpr}`, and `documentClass` matches an option list only
 * to throw it away. Without this, no check could see the difference between a
 * double-blind submission and one carrying an author block.
 */
export function packageOptions(tex: string, pkg: string): string[] | null {
  const pattern = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\]\s*)?\{([^}]+)\}/g;
  let options: string[] | null = null;
  for (const match of tex.matchAll(pattern)) {
    const names = (match[2] ?? "").split(",").map((name) => name.trim());
    if (!names.includes(pkg)) continue;
    const parsed = (match[1] ?? "")
      .split(",")
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    // A package loaded more than once contributes the union of its options,
    // which is what LaTeX itself does.
    options = options ? [...new Set([...options, ...parsed])] : parsed;
  }
  return options;
}

/**
 * Package options that turn a venue style file's anonymous mode on.
 *
 * Kept as a named set rather than comparing every option, so the check states
 * what it is about. Broader template drift is `templateCompatibility`'s job.
 */
export const ANONYMITY_OPTIONS: readonly string[] = ["review", "anonymous", "blind", "doubleblind"];

/**
 * Commands that switch a style file OUT of anonymous mode.
 *
 * ICLR's `\iclrfinalcopy` is the camera-ready switch: without it the title
 * block renders "Anonymous authors" and ignores `\author` entirely
 * (`iclr2025_conference.sty:28-31`, `:87-101`). A manuscript that adds one has
 * de-anonymized itself even though the template never asked for it.
 */
export const FINAL_COPY_COMMANDS: readonly string[] = ["\\iclrfinalcopy", "\\cvprfinalcopy"];

/** Final-copy switches the manuscript calls outside of a comment. */
export function finalCopyCommands(tex: string): string[] {
  const withoutComments = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  return FINAL_COPY_COMMANDS.filter((command) => {
    // `command` holds one real backslash; a regex needs it doubled. The
    // trailing guard keeps `\iclrfinalcopyx` from matching `\iclrfinalcopy`.
    const escaped = command.replace(/\\/g, "\\\\");
    return new RegExp(`${escaped}(?![a-zA-Z])`).test(withoutComments);
  });
}

/** Rough word count of body prose, used for page-budget checks. */
export function wordCount(tex: string): number {
  const withoutComments = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  const withoutCommands = withoutComments.replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?(\{[^}]*\})?/g, " ");
  return withoutCommands.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
}
