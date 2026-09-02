import type { Outline } from "./artifacts.js";
import { tidyQuery } from "./queries.js";

/**
 * Relevance scoring for retrieved literature.
 *
 * LKM indexes scientific claims across all of science, so a query written for a
 * computer-vision paper matches papers in agriculture, gastroenterology and
 * pharmacology that use the same word. On four real runs the retrieved sets
 * contained, among the accepted candidates, `Leaf Only SAM`, `Lung Segmentation
 * in Chest X-ray Images`, `Gastric Antral Vascular Ectasia (GAVE)` and
 * `The Effect of Damaging Electric Muscle Contraction on Mitochondrial Health`.
 * All real, all correctly attributed, none citable by the manuscript.
 *
 * Scoring is controller-owned and needs no model call and no web access, which
 * keeps the anti-fabrication guarantee intact: this only ever REMOVES entries
 * from a set the controller itself retrieved.
 *
 * Two independent axes decide admission, because neither alone is sufficient —
 * a fact measured, not assumed:
 *
 *  * `topical` — TF-IDF cosine between the candidate and the paper's own
 *    vocabulary. Sorts the four real runs almost perfectly, with the domain
 *    papers at the top and the medical and agricultural noise in the tail.
 *  * `anchor` — whether the candidate is the specific artifact an outline
 *    citation hint named. This axis is REQUIRED, not a refinement: `Segment
 *    Anything` scores 0.030 and `PVT v2` scores 0.023 against an audio-visual
 *    segmentation paper, both squarely inside the noise band, because their
 *    abstracts share little vocabulary with it. A similarity threshold alone
 *    deletes the two citations such a manuscript most needs.
 */

/** Weights for the fields a candidate is scored on. Titles carry the topic. */
const TITLE_WEIGHT = 3;
const VENUE_WEIGHT = 1;
const ABSTRACT_WEIGHT = 1;

/**
 * Admission threshold, as a fraction of the best-scoring candidate.
 *
 * Relative rather than absolute because the cosine's scale depends on the
 * pool's composition; across four real runs the top score ranged 0.196-0.254
 * while the junk tail stayed below a tenth of it.
 */
export const RELEVANCE_FRACTION = 0.1;

const STOPWORDS = new Set(
  (
    "the a an in on at for to of and or is are was were with by as from that this these those it its " +
    "we our us they their he she his her you your be been being have has had do does did but if then " +
    "than so such not no nor only own same too very can will just should now also into over under " +
    "between during before after above below out off up down again further once here there when where " +
    "why how all any both each few more most other some via using use used based paper study research " +
    "approach method methods model models new novel toward towards introducing report technical find " +
    "identify build"
  ).split(/\s+/),
);

/**
 * Tokenize into unigrams plus adjacent bigrams.
 *
 * Bigrams matter more than they look: `audio visual`, `video object` and
 * `segment anything` are the phrases that separate this paper's neighbourhood
 * from the general corpus, and unigrams alone treat `segmentation` in
 * `leaf segmentation` and in `audio-visual segmentation` as the same evidence.
 */
export function tokenize(text: string): string[] {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  const out = [...words];
  for (let at = 0; at + 1 < words.length; at += 1) {
    out.push(`${words[at]}_${words[at + 1]}`);
  }
  return out;
}

type Bag = Map<string, number>;

function bagOf(parts: ReadonlyArray<readonly [string, number]>): Bag {
  const bag: Bag = new Map();
  for (const [text, weight] of parts) {
    for (const term of tokenize(text)) bag.set(term, (bag.get(term) ?? 0) + weight);
  }
  return bag;
}

/**
 * The paper's own vocabulary, weighted by how directly a field states the topic.
 *
 * Built from the outline rather than the source materials because the outline
 * is the model's own distillation of them and is already schema-validated, so
 * this cannot be thrown off by an unparsed experimental log.
 */
export function topicProfile(outline: Outline): Bag {
  const parts: Array<readonly [string, number]> = [];
  const plan = outline.intro_related_work_plan;

  parts.push([plan.introduction_strategy.hook_hypothesis, 3]);
  parts.push([plan.introduction_strategy.problem_gap_hypothesis, 3]);
  parts.push([plan.related_work_strategy.overview, 2]);

  for (const subsection of plan.related_work_strategy.subsections) {
    parts.push([subsection.subsection_title, 3]);
    parts.push([subsection.methodology_cluster, 2]);
    parts.push([subsection.limitation_hypothesis, 1]);
    parts.push([subsection.bridge_to_our_method, 1]);
    for (const query of subsection.limitation_search_queries) parts.push([query, 1]);
  }
  for (const direction of plan.introduction_strategy.search_directions) {
    parts.push([direction, 1]);
  }
  for (const section of outline.section_plan) {
    parts.push([section.section_title, 1]);
    for (const subsection of section.subsections) {
      parts.push([subsection.subsection_title, 2]);
      for (const bullet of subsection.content_bullets) parts.push([bullet, 1]);
    }
  }
  return bagOf(parts);
}

/**
 * The specific artifacts the outline's citation hints name.
 *
 * The outline prompt requires a hint for every dataset, metric, optimizer and
 * architecture the paper mentions, phrased as "research paper or technical
 * report introducing '<X>'". `tidyQuery` already reduces that to `<X>`, so the
 * hints are exactly the list of things the manuscript structurally must cite.
 */
export function anchorNames(outline: Outline): string[] {
  const names = new Set<string>();
  for (const section of outline.section_plan) {
    for (const subsection of section.subsections) {
      for (const hint of subsection.citation_hints ?? []) {
        const name = tidyQuery(hint);
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

function normalizeTokens(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The subject of a title: everything before the first colon or dash.
 *
 * `PVT v2: Improved baselines with Pyramid Vision Transformer` is about PVT v2;
 * `Panoptic Segmentation Using Mask2Former with Swin Transformers` is not about
 * Mask2Former. Taking the head is what separates the paper that introduces an
 * artifact from a paper that merely applies it.
 */
export function titleHead(title: string): string[] {
  const head = String(title ?? "").split(/:|\s[–—-]{1,2}\s/)[0] ?? "";
  return normalizeTokens(head);
}

/** Whether either token sequence is a whole-token prefix of the other. */
function isTokenPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at += 1) {
    if (a[at] !== b[at]) return false;
  }
  return true;
}

/**
 * Whether a title is the paper introducing one of the named artifacts.
 *
 * Prefix matching runs in both directions because the hint and the real title
 * disagree on length in both directions: the hint `Segment Anything Model`
 * against the title `Segment Anything`, and the hint `Mask2Former` against
 * `Mask2Former for Video Instance Segmentation`.
 *
 * Comparing whole tokens rather than substrings is load-bearing. `GAVS` (an
 * audio-visual segmentation method) and `GAVE` (Gastric Antral Vascular
 * Ectasia) both appeared in one real run, as did `SAMA` alongside `SAM`.
 */
export function matchesAnchor(title: string, anchors: readonly string[]): string | null {
  const head = titleHead(title);
  if (head.length === 0) return null;
  for (const anchor of anchors) {
    const tokens = normalizeTokens(anchor);
    if (tokens.length > 0 && isTokenPrefix(head, tokens)) return anchor;
  }
  return null;
}

/** The minimum a candidate needs to be scored at all. */
export interface Scoreable {
  readonly title: string;
  readonly venue: string;
  readonly abstract: string;
}

export interface Judgement<T> {
  readonly candidate: T;
  /** TF-IDF cosine against the topic profile, in [0, 1]. */
  readonly topical: number;
  /** The outline citation hint this candidate answers, if any. */
  readonly anchor: string | null;
  readonly admitted: boolean;
}

export interface GateResult<T> {
  readonly admitted: T[];
  readonly rejected: Array<Judgement<T>>;
  readonly judgements: Array<Judgement<T>>;
  /** How many entries were kept only because they answer a citation hint. */
  readonly anchorRescued: number;
}

/**
 * Rank a candidate pool and drop the off-domain tail.
 *
 * Inverse document frequency is computed over the pool itself, which is the
 * right frame: a term every candidate shares is not evidence of relevance
 * WITHIN this pool, while a term only the agriculture papers use is exactly the
 * signal that separates them. Cosine, rather than plain overlap, is what makes
 * a candidate whose content is mostly off-profile score low even when it does
 * mention a profile term.
 *
 * The returned order is by descending relevance, so the writer sees the
 * strongest sources first even among those admitted.
 */
export function gateByRelevance<T extends Scoreable>(
  candidates: readonly T[],
  outline: Outline,
  options: { fraction?: number } = {},
): GateResult<T> {
  const fraction = options.fraction ?? RELEVANCE_FRACTION;
  const profile = topicProfile(outline);
  const anchors = anchorNames(outline);

  const bags = candidates.map((candidate) =>
    bagOf([
      [candidate.title, TITLE_WEIGHT],
      [candidate.venue, VENUE_WEIGHT],
      [candidate.abstract, ABSTRACT_WEIGHT],
    ]),
  );

  const total = bags.length;
  const documentFrequency = new Map<string, number>();
  for (const bag of bags) {
    for (const term of bag.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  // The +0.5 keeps a term seen in every document from collapsing to exactly
  // zero weight, which would discard the domain's own core vocabulary.
  const idf = (term: string): number =>
    Math.log(1 + total / ((documentFrequency.get(term) ?? 0) + 0.5));

  const cosine = (doc: Bag): number => {
    let dot = 0;
    let docNorm = 0;
    let profileNorm = 0;
    for (const [term, weight] of doc) {
      const value = weight * idf(term);
      docNorm += value * value;
      dot += value * (profile.get(term) ?? 0) * idf(term);
    }
    for (const [term, weight] of profile) {
      const value = weight * idf(term);
      profileNorm += value * value;
    }
    if (docNorm === 0 || profileNorm === 0) return 0;
    return dot / Math.sqrt(docNorm * profileNorm);
  };

  const scored = candidates.map((candidate, at) => ({
    candidate,
    topical: cosine(bags[at] as Bag),
    anchor: matchesAnchor(candidate.title, anchors),
  }));

  const best = scored.reduce((max, entry) => Math.max(max, entry.topical), 0);
  const threshold = best * fraction;

  const judgements: Array<Judgement<T>> = scored
    .map((entry) => ({
      ...entry,
      admitted: entry.topical >= threshold || entry.anchor !== null,
    }))
    .sort((a, b) => b.topical - a.topical);

  return {
    admitted: judgements.filter((j) => j.admitted).map((j) => j.candidate),
    rejected: judgements.filter((j) => !j.admitted),
    judgements,
    anchorRescued: judgements.filter((j) => j.admitted && j.topical < threshold).length,
  };
}
