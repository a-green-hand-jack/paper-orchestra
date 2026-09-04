import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Candidate } from "./artifacts.js";
import { SOURCE_DIR } from "./paths.js";
import { statKind } from "./files.js";

/**
 * Ingestion of a bibliography the author supplied, instead of one we retrieved.
 *
 * "I already have my bibliography, don't go searching" is an ordinary situation,
 * and on that path retrieval is worse than unnecessary: it costs money and
 * returns a set of papers unrelated to the one the manuscript must cite from.
 *
 * The parser is deliberately tolerant. A real bibliography is machine-merged
 * from several tools and is not clean: `pwb-0001`'s 114 entries include a stray
 * comma on its own line before a field, mixed-case entry types (`@ARTICLE`),
 * and abstracts that embed a whole `\documentclass{...}\begin{document}` block.
 * BibTeX itself accepts all of that, so refusing it here would reject a file
 * that compiles -- and the point of this path is to use the author's file as it
 * is, not to grade it.
 */

/** One entry, with its body left raw so field extraction stays in one place. */
export interface BibEntry {
  /** Lowercased entry type: `article`, `inproceedings`, `misc`, ... */
  readonly type: string;
  readonly key: string;
  readonly body: string;
}

/**
 * Split a BibTeX file into entries by matching braces.
 *
 * Brace matching rather than a line or `@`-delimited split, because an abstract
 * containing LaTeX has balanced braces of its own and a naive split truncates
 * the entry in the middle of one.
 */
export function parseBibEntries(bib: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const opener = /@([a-zA-Z]+)\s*\{\s*([^,\s}]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(bib)) !== null) {
    let depth = 1;
    let at = match.index + match[0].length;
    while (at < bib.length && depth > 0) {
      const char = bib[at];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      at += 1;
    }
    entries.push({
      type: (match[1] ?? "").toLowerCase(),
      key: match[2] ?? "",
      body: bib.slice(match.index + match[0].length, Math.max(at - 1, 0)),
    });
    // Continue after this entry so a nested `@` inside an abstract cannot be
    // mistaken for the start of another record.
    opener.lastIndex = at;
  }
  return entries;
}

/** One field's value: `{braced}`, `"quoted"`, or bare. */
export function bibField(body: string, name: string): string | null {
  const anchor = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*`, "is").exec(body);
  if (!anchor) return null;
  const start = anchor.index + anchor[0].length;
  const first = body[start];
  if (first === "{") {
    let depth = 1;
    let at = start + 1;
    while (at < body.length && depth > 0) {
      if (body[at] === "{") depth += 1;
      else if (body[at] === "}") depth -= 1;
      at += 1;
    }
    return collapse(body.slice(start + 1, Math.max(at - 1, start + 1)));
  }
  if (first === '"') {
    const close = body.indexOf('"', start + 1);
    if (close < 0) return null;
    return collapse(body.slice(start + 1, close));
  }
  const bare = /[^,\n]+/.exec(body.slice(start));
  return bare ? collapse(bare[0]) : null;
}

/** BibTeX treats a newline inside a value as a space; so must we. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** `Doe, John and Roe, Jane` -> `["Doe, John", "Roe, Jane"]`. */
export function bibAuthors(body: string): string[] {
  const raw = bibField(body, "author");
  if (!raw) return [];
  return raw
    .split(/\s+and\s+/i)
    .map((name) => name.replace(/[{}]/g, "").trim())
    .filter((name) => name.length > 0);
}

/** Where the entry appeared: a journal, a proceedings, a publisher, or nothing. */
function bibVenue(body: string): string {
  for (const name of ["journal", "booktitle", "publisher", "school", "howpublished"]) {
    const value = bibField(body, name);
    if (value) return value;
  }
  return "";
}

/**
 * The supplied bibliography, or null when this run has to retrieve one.
 *
 * A fact about the filesystem: the file is under `source/`, so it is already
 * covered by `source_digest` and made read-only at prepare time. That is what
 * lets the provenance validator branch on this predicate rather than on a field
 * inside `.brain/`, which the agent it validates can write.
 *
 * "Non-trivial" is one parsable entry -- the same reasoning as the triage
 * router: whether the author handed us a bibliography is a question about the
 * filesystem, and a bar on entry count or quality would make an expensive
 * routing decision depend on something no user can predict.
 */
export function suppliedBibliography(workspace: string): string | null {
  const rel = join(SOURCE_DIR, "references.bib");
  const abs = join(workspace, rel);
  if (!existsSync(abs) || statKind(abs) !== "file") return null;
  const entries = parseBibEntries(readFileSync(abs, "utf8"));
  return entries.length > 0 ? rel : null;
}

/**
 * Candidate records for a supplied bibliography.
 *
 * Written so the files downstream reads have one shape whatever the origin --
 * the same reason `triage.json` is written on both of its paths. It is NOT the
 * evidence for provenance on this path: checking the bibliography against
 * records derived from it would be circular. The evidence is the digest-locked
 * `source/references.bib` itself, which `bibliographyProvenance` compares
 * against directly.
 *
 * `relevance` stays 0 because nothing scored these entries, and the field is
 * only ever used for ordering. Filtering them by topic would be wrong on this
 * path: the author chose the bibliography, so dropping from it is not ours to do.
 */
export function toSuppliedCandidates(bib: string, ingestedAt: string): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const entry of parseBibEntries(bib)) {
    // A duplicate key is not addressable by BibTeX either -- it resolves to the
    // first definition -- so mirroring that is the honest reading of the file.
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const year = bibField(entry.body, "year");
    candidates.push({
      citation_key: entry.key,
      title: bibField(entry.body, "title") ?? entry.key,
      provider: "supplied",
      // The key is the entry's identifier within the file it came from, which
      // is what "re-fetch and audit this record" means on this path.
      provider_id: entry.key,
      retrieved_at: ingestedAt,
      authors: bibAuthors(entry.body),
      venue: bibVenue(entry.body),
      year: year ?? null,
      abstract: bibField(entry.body, "abstract") ?? "",
      doi: bibField(entry.body, "doi") ?? "",
      relevance: 0,
      anchor: null,
      // No query produced this entry. An empty list says exactly that, and
      // keeps per-query precision measurable without a special case: a supplied
      // bibliography contributes nothing to those numbers because it cost nothing.
      matched_queries: [],
    });
  }
  return candidates;
}

/**
 * How to describe the bibliography's origin to the writing model.
 *
 * A placeholder rather than prose in the command markdown, because the sentence
 * that used to be there unconditionally -- "every one has been retrieved and
 * screened for relevance to THIS paper's subject; they are ordered with the
 * most relevant first" -- is false of a supplied bibliography. Nothing screened
 * it, nothing ordered it, and a prompt that asserts a property the artifact does
 * not have is the class of defect #30 exists to remove, not to add to.
 */
export function bibliographyOriginNote(workspace: string): string {
  if (suppliedBibliography(workspace)) {
    return (
      "They are the author's own fixed bibliography, supplied with the materials. " +
      "They are NOT ordered by relevance and were NOT screened for it, so judge each " +
      "one on its abstract. The bibliography is closed: cite from it, and do not add " +
      "an entry to references.bib for any reason."
    );
  }
  return (
    "Every one has been retrieved and screened for relevance to THIS paper's " +
    "subject; they are ordered with the most relevant first."
  );
}
