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
