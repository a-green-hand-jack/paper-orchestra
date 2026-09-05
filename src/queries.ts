import type { Outline } from "./artifacts.js";

/**
 * Turn an outline into a prioritized list of retrieval queries.
 *
 * Ported in substance from `literature_review_agent.py:_collect_search_tasks`
 * (:211-266), but ordered by value rather than by document position, because
 * retrieval here has a hard call budget and each call costs money.
 *
 * `citation_hints` come first: the outline prompt requires one for every
 * dataset, metric, optimizer and architecture the paper mentions, so these are
 * the queries that decide whether `citation_integrity` can pass at all. Broad
 * introduction directions come last -- they improve framing, but a manuscript
 * survives thin framing and does not survive an unresolvable \cite key.
 */
/**
 * How many distinct sources the outline's own plan asks for.
 *
 * Counts the citation hints and resolved candidates the plan attaches to its
 * sections -- the things it said would each need supporting. Used as a FLOOR
 * under whatever `citation_target` the model proposes, so a stage cannot
 * quietly excuse its successor from citing the work its own plan called for.
 *
 * Deliberately not `collectQueries`: that includes search directions and
 * methodology clusters, which are retrieval phrasings rather than claims
 * needing a source.
 */
export function plannedCitationCount(outline: Outline): number {
  const seen = new Set<string>();
  const add = (values: readonly string[] | undefined): void => {
    for (const value of values ?? []) {
      const key = value.trim().toLowerCase().replace(/\s+/g, " ");
      if (key) seen.add(key);
    }
  };
  for (const section of outline.section_plan) {
    for (const subsection of section.subsections) {
      add(subsection.citation_hints);
      add(subsection.citation_candidates);
    }
  }
  const plan = outline.intro_related_work_plan;
  add(plan.introduction_strategy.citation_candidates);
  for (const subsection of plan.related_work_strategy.subsections) {
    add(subsection.citation_candidates);
  }
  return seen.size;
}

export function collectQueries(outline: Outline): string[] {
  const hints: string[] = [];
  const limitations: string[] = [];
  const clusters: string[] = [];
  const directions: string[] = [];

  for (const section of outline.section_plan) {
    for (const subsection of section.subsections) {
      for (const hint of subsection.citation_hints ?? []) {
        if (hint.trim()) hints.push(hint.trim());
      }
    }
  }

  const plan = outline.intro_related_work_plan;
  for (const subsection of plan.related_work_strategy.subsections) {
    for (const query of subsection.limitation_search_queries) {
      if (query.trim()) limitations.push(query.trim());
    }
    const cluster = [subsection.methodology_cluster, subsection.sota_investigation_mission]
      .filter((part) => part && part.trim())
      .join(" ");
    if (cluster.trim()) clusters.push(cluster.trim());
  }

  for (const direction of plan.introduction_strategy.search_directions) {
    if (direction.trim()) directions.push(direction.trim());
  }

  // Deduplicate while preserving priority order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of [...hints, ...limitations, ...clusters, ...directions]) {
    const fingerprint = query.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(query);
  }
  return out;
}

/**
 * A citation hint is often phrased as prose for a human searcher
 * ("research paper or technical report introducing 'AdamW'"). LKM does better
 * with the subject than with the instruction wrapper.
 */
export function tidyQuery(query: string): string {
  return query
    // The outline prompt mandates "research paper or technical report
    // introducing '<X>'" for anti-hallucination, so the wrapper can name
    // several document kinds joined by "or" before the subject appears.
    .replace(
      /^\s*(?:a\s+)?(?:research\s+paper|technical\s+report|paper|report)(?:\s+or\s+(?:a\s+)?(?:research\s+paper|technical\s+report|paper|report))*\s+introducing\s*/i,
      "",
    )
    .replace(/^\s*find\s+/i, "")
    .replace(/["'“”]/g, "")
    .trim()
    .slice(0, 300);
}

export interface QueryDecision {
  readonly original: string;
  readonly query: string | null;
  readonly action: "kept" | "contextualized" | "dropped";
  readonly reason: string;
}

export interface QueryPlan {
  readonly queries: string[];
  readonly decisions: QueryDecision[];
}

function outlineStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) outlineStrings(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      outlineStrings(entry, out);
    }
  }
  return out;
}

function fingerprint(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Concepts whose standalone LKM queries repeatedly returned another field's papers. */
function isGenericConcept(query: string): boolean {
  const normalized = fingerprint(query);
  return [
    /^(?:jaccard(?: index)?|f1? score|f score)(?: metric)?$/,
    /^(?:adamw|adam)(?: optimizer)?$/,
    /^(?:transformer )?cross attention$/,
  ].some((pattern) => pattern.test(normalized));
}

function isShortAcronym(query: string): boolean {
  return /^[A-Z][A-Z0-9-]{1,7}$/.test(query.trim());
}

function acronymContext(acronym: string, outline: Outline): string | null {
  const candidates = outlineStrings(outline).filter((value) => {
    const words = value.match(/[A-Za-z0-9]+/g) ?? [];
    return (
      words.length >= 4 &&
      new RegExp(`\\b${acronym}\\b`).test(value) &&
      fingerprint(tidyQuery(value)) !== fingerprint(acronym)
    );
  });
  if (candidates.length === 0) return null;

  // Prefer a nearby explicit expansion, then the shortest domain-bearing
  // sentence/query. This turns `GAVS` into the outline's own contextual query
  // instead of asking a general-science index to guess which acronym we mean.
  candidates.sort((a, b) => {
    const aExpanded = new RegExp(`\\([^)]*\\b${acronym}\\b[^)]*\\)`).test(a) ? 0 : 1;
    const bExpanded = new RegExp(`\\([^)]*\\b${acronym}\\b[^)]*\\)`).test(b) ? 0 : 1;
    return aExpanded - bExpanded || a.length - b.length;
  });
  return tidyQuery(candidates[0] as string);
}

/**
 * Build the paid LKM call plan before spending anything.
 *
 * Query admission is deliberately narrower than literature admission. The
 * relevance gate protects the bibliography after retrieval; this plan avoids
 * paying for calls already known to be ambiguous and expands short acronyms
 * with context already present in the outline.
 */
export function planQueries(outline: Outline): QueryPlan {
  const decisions: QueryDecision[] = [];
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const original of collectQueries(outline)) {
    const tidied = tidyQuery(original);
    if (!tidied) continue;
    if (isGenericConcept(tidied)) {
      decisions.push({
        original,
        query: null,
        action: "dropped",
        reason: "generic concept is ambiguous in the general-science index",
      });
      continue;
    }

    const contextual = isShortAcronym(tidied) ? acronymContext(tidied, outline) : null;
    const query = contextual && fingerprint(contextual) !== fingerprint(tidied) ? contextual : tidied;
    const key = fingerprint(query);
    if (seen.has(key)) {
      decisions.push({
        original,
        query: null,
        action: "dropped",
        reason: "duplicates an earlier optimized query",
      });
      continue;
    }
    seen.add(key);
    queries.push(query);
    decisions.push({
      original,
      query,
      action: query === tidied ? "kept" : "contextualized",
      reason: query === tidied ? "specific query" : `expanded short acronym ${tidied} from outline context`,
    });
  }

  return { queries, decisions };
}
