import { execa } from "execa";
import { UserFacingError } from "./errors.js";
import type { Candidate } from "./artifacts.js";

/**
 * Literature retrieval over Bohrium LKM (Literature Knowledge Mining).
 *
 * Retrieval is controller-owned and mechanical: the agent has `webfetch` and
 * `websearch` denied, so it cannot invent a source it did not receive. Every
 * candidate carries the provider and the provider's own id, which is what
 * `bibliography_provenance` checks.
 *
 * LKM replaces the Python's Gemini `GoogleSearch` discovery step, which needed
 * model-side web access, and its Semantic Scholar enrichment, which needs an
 * API key this environment does not have.
 */

const BOHR_BIN = "bohr";
const CALL_TIMEOUT_MS = 120_000;

/** Fixed price per LKM call, in CNY. Published by the CLI's own docs. */
export const LKM_CALL_PRICE_CNY = 0.05;

interface LkmPaper {
  id?: string;
  en_title?: string;
  zh_title?: string;
  en_abstract?: string;
  authors?: string;
  doi?: string;
  publication_name?: string;
  cover_date_start?: string;
  publication_date?: string;
}

/**
 * Run one `bohr lkm search`.
 *
 * `bohr` wraps its payload in an `{ok, data}` envelope and may emit progress
 * lines before it, so the last parseable JSON document wins.
 */
async function lkmSearch(query: string, topK: number, scopes: string): Promise<LkmPaper[]> {
  let stdout: string;
  try {
    const result = await execa(
      BOHR_BIN,
      [
        "lkm",
        "search",
        query,
        "--top-k",
        String(topK),
        "--scopes",
        scopes,
        "--yes",
        "-o",
        "json",
      ],
      { timeout: CALL_TIMEOUT_MS },
    );
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new UserFacingError(
        "the `bohr` CLI is not on PATH. Install it with " +
          "`npm i -g @dptech-corp/bohr-cli`, then `bohr auth login`.",
      );
    }
    // A single failed query degrades the candidate set; it must not abort a
    // stage that other queries can still populate.
    return [];
  }

  const payload = parseEnvelope(stdout);
  if (!payload) return [];
  const papers = (payload.papers ?? {}) as Record<string, LkmPaper>;
  return Object.values(papers);
}

function parseEnvelope(stdout: string): Record<string, unknown> | null {
  // Scan from the end: progress documents precede the real payload.
  const starts: number[] = [];
  for (let at = 0; at < stdout.length; at += 1) {
    if (stdout[at] === "{") starts.push(at);
  }
  for (let at = starts.length - 1; at >= 0; at -= 1) {
    try {
      const parsed = JSON.parse(stdout.slice(starts[at] as number)) as {
        ok?: boolean;
        data?: Record<string, unknown>;
      };
      if (parsed.data) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}

/** Title normalization for dedup: `literature_review_agent.py:_normalize_title`. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const STOPWORDS = new Set([
  "the", "a", "an", "in", "on", "at", "for", "to", "of", "and", "is", "are",
  "with", "by", "study",
]);

/**
 * Citation key: `{FirstAuthorLastName}{Year}{TwoTitleWords}`.
 *
 * Ported from `literature_review_agent.py:507-538`, including its fallbacks:
 * an unknown author becomes `Unknown` and a missing year becomes `2024`, so a
 * record with thin metadata still yields a usable key rather than being lost.
 * LKM leaves `authors` empty more often than Semantic Scholar did, so that
 * path is load-bearing here.
 */
export function citationKey(authors: string, year: string | null, title: string): string {
  const firstAuthor = authors.split("|")[0]?.trim() ?? "";
  const lastName = firstAuthor ? (firstAuthor.split(/\s+/).pop() ?? "") : "Unknown";
  const cleanAuthor = capitalize(lastName.replace(/[^a-zA-Z]/g, "")) || "Unknown";
  const yearStr = year && /^\d{4}$/.test(year) ? year : "2024";
  const meaningful = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .map(capitalize);
  const titlePart = meaningful.slice(0, 2).join("") || "Paper";
  return `${cleanAuthor}${yearStr}${titlePart}`;
}

function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : "";
}

/**
 * Whether a paper predates the research cutoff.
 *
 * Ported from `literature_review_agent.py:385-424`, and it earns its keep: LKM
 * has no date filter flag and its corpus contains papers well past any given
 * cutoff, so without this a 2026 paper would be cited as prior work by a
 * manuscript targeting a 2025 venue.
 */
export function isWithinCutoff(dateStr: string | null, cutoff: string): boolean {
  if (!cutoff) return true;
  const [cutYear, cutMonth = 12] = cutoff.split("-").map(Number) as [number, number?];
  if (!dateStr) return true;

  const parts = dateStr.split("-").map(Number);
  const year = parts[0];
  if (year === undefined || Number.isNaN(year)) return true;
  if (year > cutYear) return false;
  if (year < cutYear) return true;

  const month = parts[1];
  if (month === undefined || Number.isNaN(month)) return true;
  return month <= (cutMonth ?? 12);
}

function paperYear(paper: LkmPaper): string | null {
  const date = paper.cover_date_start || paper.publication_date || "";
  const match = /^(\d{4})/.exec(date);
  return match?.[1] ?? null;
}

/** Trailing separators LKM leaves on venue names, e.g. "Machine Learning _ ". */
function cleanVenue(venue: string): string {
  return venue.replace(/\s*_\s*$/, "").replace(/\s*_\s*/g, " - ").trim();
}

interface CrossrefWork {
  author?: Array<{ given?: string; family?: string; name?: string }>;
  "container-title"?: string[];
  issued?: { "date-parts"?: number[][] };
}

interface DataciteWork {
  creators?: Array<{ name?: string; givenName?: string; familyName?: string }>;
  publisher?: string;
  publicationYear?: number;
}

interface Metadata {
  authors: string[];
  venue: string | null;
  year: string | null;
}

/**
 * LKM mints a synthetic identifier under an unregistered prefix for records
 * with no real DOI, so those cannot be resolved anywhere and are not worth a
 * request.
 */
const SYNTHETIC_DOI_PREFIX = "10.0410/";

/** arXiv DOIs are registered with DataCite, not Crossref, which 404s on them. */
function isArxivDoi(doi: string): boolean {
  return /^10\.48550\//i.test(doi);
}

export function isResolvableDoi(doi: string): boolean {
  return Boolean(doi) && !doi.startsWith(SYNTHETIC_DOI_PREFIX);
}

const USER_AGENT =
  "paper-orchestra/2.0 (https://github.com/a-green-hand-jack/paper-orchestra)";

/**
 * One metadata request, retrying on 429.
 *
 * Both registries rate-limit, and a 429 is not a missing record: treating it as
 * one silently drops a resolvable paper. At concurrency 6 a third of requests
 * came back 429 on a real run, which is what left 86 of 96 records without
 * authors.
 */
async function fetchJson(url: string, attempts = 3): Promise<unknown | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return null;
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

async function crossrefMetadata(doi: string): Promise<Metadata | null> {
  const payload = (await fetchJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  )) as { message?: CrossrefWork } | null;
  const work = payload?.message;
  if (!work) return null;
  return {
    authors: (work.author ?? [])
      .map((a) => a.name ?? `${a.given ?? ""} ${a.family ?? ""}`.trim())
      .filter(Boolean),
    venue: (work["container-title"] ?? [])[0] ?? null,
    year: work.issued?.["date-parts"]?.[0]?.[0]
      ? String(work.issued["date-parts"][0]![0])
      : null,
  };
}

/**
 * Normalize a personal name to "Given Family".
 *
 * DataCite commonly supplies only a combined `name` in "Family, Given" order.
 * The citation key takes the first author's LAST whitespace-separated token as
 * the surname, so leaving that order alone yields keys built from given names
 * -- an arXiv record for Seon, Juhyeong keyed as `Juhyeong2024...`. Flipping on
 * the comma makes DataCite agree with Crossref, which supplies the parts
 * separately, and BibTeX parses "Juhyeong Seon" correctly either way.
 */
export function normalizePersonName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.includes(",")) return trimmed;
  const [family = "", given = ""] = trimmed.split(",", 2).map((part) => part.trim());
  // A trailing suffix like "Jr." is not a given name; keep such names as-is.
  if (!given || /^(jr|sr|ii|iii|iv)\.?$/i.test(given)) return trimmed;
  return `${given} ${family}`.trim();
}

async function dataciteMetadata(doi: string): Promise<Metadata | null> {
  const payload = (await fetchJson(
    `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
  )) as { data?: { attributes?: DataciteWork } } | null;
  const work = payload?.data?.attributes;
  if (!work) return null;
  return {
    authors: (work.creators ?? [])
      .map((c) =>
        c.givenName || c.familyName
          ? `${c.givenName ?? ""} ${c.familyName ?? ""}`.trim()
          : normalizePersonName(c.name ?? ""),
      )
      .filter(Boolean),
    venue: work.publisher ?? null,
    year: work.publicationYear ? String(work.publicationYear) : null,
  };
}

/**
 * Fill in authors, venue and year from the DOI registries.
 *
 * LKM returns an abstract or authors but, in practice, rarely both: on a real
 * 96-source run every record that survived the abstract filter had an empty
 * `authors` field, producing 96 citation keys all beginning `Unknown` and a
 * bibliography with no author names at all. That is not a submission-ready
 * reference list.
 *
 * Requests are made by the controller, never the agent, so this does not widen
 * what the model can reach.
 */
export async function enrichMetadata(
  records: MutableCandidate[],
  options: { concurrency?: number; onProgress?: (line: string) => void } = {},
): Promise<{ enriched: number; unresolvable: number; failed: number }> {
  // Deliberately low: both registries 429 readily, and a retry storm is slower
  // than simply not provoking one.
  const concurrency = options.concurrency ?? 2;
  let enriched = 0;
  let unresolvable = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const record = records[cursor];
      cursor += 1;
      if (!record) return;

      if (!isResolvableDoi(record.doi)) {
        unresolvable += 1;
        continue;
      }

      const metadata = isArxivDoi(record.doi)
        ? await dataciteMetadata(record.doi)
        : await crossrefMetadata(record.doi);

      if (!metadata) {
        failed += 1;
        continue;
      }
      if (metadata.authors.length > 0) record.authors = metadata.authors;
      if (metadata.venue) record.venue = metadata.venue;
      if (metadata.year) record.year = metadata.year;
      enriched += 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  options.onProgress?.(
    `   metadata: enriched ${enriched}, no usable doi ${unresolvable}, unresolved ${failed}`,
  );
  return { enriched, unresolvable, failed };
}

/** A candidate before its citation key is assigned. */
export interface MutableCandidate {
  title: string;
  provider: "bohrium_lkm";
  provider_id: string;
  retrieved_at: string;
  authors: string[];
  venue: string;
  year: string | null;
  abstract: string;
  doi: string;
}

export interface RetrievalOptions {
  readonly queries: readonly string[];
  readonly cutoff: string;
  readonly topK?: number;
  readonly scopes?: string;
  readonly maxCalls: number;
  readonly onProgress?: (line: string) => void;
  /** Enrich via Crossref by DOI. On by default; disable only for tests. */
  readonly enrich?: boolean;
}

export interface RetrievalResult {
  readonly candidates: Candidate[];
  readonly callsMade: number;
  readonly dropped: { anachronistic: number; noAbstract: number; duplicate: number };
}

/**
 * Retrieve, deduplicate and key a candidate set.
 *
 * Deduplication is by normalized title across the whole run, not per query, so
 * overlapping queries converge on one record with one citation key. Keys are
 * de-collided by appending `a`, `b`, ... exactly as the Python does at
 * bibtex-generation time.
 */
export async function retrieveLiterature(options: RetrievalOptions): Promise<RetrievalResult> {
  const topK = options.topK ?? 10;
  const scopes = options.scopes ?? "abstract,conclusion";
  const byTitle = new Map<string, MutableCandidate>();
  const dropped = { anachronistic: 0, noAbstract: 0, duplicate: 0 };
  let callsMade = 0;

  for (const query of options.queries) {
    if (callsMade >= options.maxCalls) break;
    callsMade += 1;
    options.onProgress?.(
      `   lkm ${callsMade}/${Math.min(options.queries.length, options.maxCalls)}: ` +
        `${query.slice(0, 68)}`,
    );

    for (const paper of await lkmSearch(query, topK, scopes)) {
      const title = (paper.en_title || paper.zh_title || "").trim();
      if (!title) continue;

      const normalized = normalizeTitle(title);
      if (byTitle.has(normalized)) {
        dropped.duplicate += 1;
        continue;
      }

      const date = paper.cover_date_start || paper.publication_date || null;
      if (!isWithinCutoff(date, options.cutoff)) {
        dropped.anachronistic += 1;
        continue;
      }

      const abstract = (paper.en_abstract ?? "").trim();
      if (!abstract) {
        // The Python drops abstract-less records because the writer is given
        // abstracts as its evidence; a title alone invites citing by relevance.
        dropped.noAbstract += 1;
        continue;
      }

      byTitle.set(normalized, {
        title,
        provider: "bohrium_lkm",
        provider_id: paper.id ?? paper.doi ?? normalized,
        retrieved_at: new Date().toISOString(),
        authors: (paper.authors ?? "").split("|").map((a) => a.trim()).filter(Boolean),
        venue: cleanVenue(paper.publication_name ?? ""),
        year: paperYear(paper),
        abstract: abstract.slice(0, 1500),
        doi: paper.doi ?? "",
      });
    }
  }

  const records = [...byTitle.values()];

  // Enrich BEFORE keying: a citation key embeds the first author's surname, so
  // assigning keys from LKM's empty author field would bake `Unknown` into
  // every key and no later enrichment could undo it without rewriting the
  // manuscript's \cite commands.
  if (options.enrich !== false) {
    await enrichMetadata(records, { onProgress: options.onProgress });
  }

  return { candidates: assignCitationKeys(records), callsMade, dropped };
}

/**
 * Assign de-collided citation keys.
 *
 * Suffixes are appended `a`, `b`, ... exactly as the Python does at
 * bibtex-generation time (`literature_review_agent.py:540-551`). Sorting by
 * title first makes the assignment deterministic, so re-running retrieval over
 * the same corpus yields the same keys.
 */
export function assignCitationKeys(records: readonly MutableCandidate[]): Candidate[] {
  const used = new Set<string>();
  const out: Candidate[] = [];

  for (const record of [...records].sort((a, b) => a.title.localeCompare(b.title))) {
    const base = citationKey(record.authors.join(" | "), record.year, record.title);
    let key = base;
    if (used.has(key)) {
      let suffix = "a";
      while (used.has(`${key}${suffix}`)) {
        suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
      }
      key = `${key}${suffix}`;
    }
    used.add(key);
    out.push({ ...record, citation_key: key });
  }
  return out;
}

/**
 * Characters that survive NFKD as non-ASCII but have a plain Latin equivalent.
 * NFKD splits accents off their base letter, but these have no decomposition.
 */
const LATIN_FALLBACKS: Record<string, string> = {
  "\u0142": "l", "\u0141": "L", // ł Ł
  "\u00f8": "o", "\u00d8": "O", // ø Ø
  "\u0111": "d", "\u0110": "D", // đ Đ
  "\u00df": "ss",                // ß
  "\u00e6": "ae", "\u00c6": "AE",
  "\u0153": "oe", "\u0152": "OE",
  "\u00fe": "th", "\u00de": "Th",
  "\u0131": "i",                 // ı
  "\u2013": "-", "\u2014": "-", "\u2010": "-", // en/em dash, hyphen
  "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
  "\u2026": "...",
};

/**
 * Make a value safe to typeset with pdflatex.
 *
 * Two independent hazards, both of which only surfaced once the generated
 * bibliography actually reached the build -- before that, LaTeX was reading the
 * template's placeholder file and this function was never exercised on real
 * data:
 *
 *  * LaTeX special characters. An LKM record's DOI like
 *    `10.1007/978-3-030-53736-4_18` produces `! Missing $ inserted.`, and an
 *    ampersand or percent in a title is just as fatal.
 *  * Non-Latin text. The corpus is multilingual, so author lists contain
 *    Cyrillic and accented Latin. The conference templates load neither
 *    `inputenc` nor `fontenc`, and they are digest-locked inputs we must not
 *    modify, so the bibliography has to arrive already typesettable.
 *
 * Accents are folded to their base letter rather than escaped, because the
 * alternative -- emitting `\'a` style sequences -- still depends on font
 * encoding we cannot guarantee. Characters with no Latin equivalent are
 * dropped: a slightly lossy author name in a generated draft is a far better
 * outcome than a manuscript that does not compile.
 */
export function toLatexSafe(value: string): string {
  let out = value.normalize("NFKD");

  // Drop combining marks left behind by the decomposition (á -> a + U+0301).
  out = out.replace(/[\u0300-\u036f]/g, "");

  out = [...out].map((char) => LATIN_FALLBACKS[char] ?? char).join("");

  // Anything still outside ASCII has no Latin form we can render.
  out = out.replace(/[^\x20-\x7e]/g, "");

  // Escape what LaTeX would otherwise interpret. Backslash first, or the
  // escapes we add would themselves be escaped.
  out = out.replace(/\\/g, " ");
  out = out.replace(/([&%$#_{}])/g, "\\$1");
  out = out.replace(/~/g, "\\textasciitilde{}");
  out = out.replace(/\^/g, "\\textasciicircum{}");

  return out.replace(/\s+/g, " ").trim();
}

/** Escape a value for a BibTeX field. */
function bibValue(value: string): string {
  return toLatexSafe(value);
}

/**
 * Render BibTeX. `@article` when a journal-like venue is known, else
 * `@inproceedings`, matching the Python's choice.
 */
/**
 * Drop author names that carry no Latin letters after folding.
 *
 * A fully non-Latin name reduces to punctuation ("Е. М. Иванов" becomes ". ."),
 * and a reference list rendering that is worse than one with the author
 * omitted. BibTeX also renders a letterless author badly rather than harmlessly.
 */
function usableAuthors(authors: readonly string[]): string[] {
  return authors.map(bibValue).filter((name) => /[A-Za-z]/.test(name));
}

export function toBibtex(candidates: readonly Candidate[]): string {
  const entries = candidates.map((candidate) => {
    const venue = bibValue(candidate.venue);
    const kind = /journal|transactions|international journal/i.test(venue)
      ? "article"
      : "inproceedings";
    const field = kind === "article" ? "journal" : "booktitle";
    const lines = [
      `@${kind}{${candidate.citation_key},`,
      `  title = {${bibValue(candidate.title)}},`,
    ];
    const authors = usableAuthors(candidate.authors);
    if (authors.length > 0) {
      lines.push(`  author = {${authors.join(" and ")}},`);
    }
    if (venue) lines.push(`  ${field} = {${venue}},`);
    if (candidate.year) lines.push(`  year = {${candidate.year}},`);
    if (candidate.doi) lines.push(`  doi = {${bibValue(candidate.doi)}},`);
    lines.push("}");
    return lines.join("\n");
  });
  return `${entries.join("\n\n")}\n`;
}

/** The `citation_map.json` the writer stages read as reference truth. */
export function toCitationMap(candidates: readonly Candidate[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const candidate of candidates) {
    out[candidate.citation_key] = {
      citation_key: candidate.citation_key,
      title: candidate.title,
      authors: candidate.authors,
      venue: candidate.venue,
      year: candidate.year,
      abstract: candidate.abstract,
    };
  }
  return out;
}
