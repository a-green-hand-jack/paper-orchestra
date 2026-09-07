/**
 * The template is also a submission contract.  Keeping this mapping in code
 * prevents a venue name from being a cosmetic label while the prompts use a
 * generic writing style.
 */
export type ResearchDomain = "mathematics" | "physics" | "natural-sciences" | "ai-ml";

export interface ResearchPolicy {
  readonly domain: ResearchDomain;
  readonly targetVenue: string;
  readonly writingStyle: string;
  readonly templateId: string;
  readonly source: "bundled-scaffold" | "official-kit";
}

const POLICIES: readonly ResearchPolicy[] = [
  {
    domain: "mathematics",
    targetVenue: "Annals of Mathematics",
    writingStyle: "formal theorem/lemma/proof style with explicit hypotheses, claims, and proof-status boundaries",
    templateId: "annals-mathematics",
    source: "bundled-scaffold",
  },
  {
    domain: "physics",
    targetVenue: "Physical Review Letters",
    writingStyle: "physics letter style: compact motivation, model/conventions, quantitative results, uncertainty, and limitations",
    templateId: "physical-review-letters",
    source: "bundled-scaffold",
  },
  {
    domain: "natural-sciences",
    targetVenue: "Nature Portfolio (journal selected in the brief)",
    writingStyle: "Nature community style: accessible significance, concise results, methods, data/code availability, and explicit limitations",
    templateId: "nature-portfolio",
    source: "bundled-scaffold",
  },
  {
    domain: "ai-ml",
    targetVenue: "International Conference on Learning Representations (ICLR)",
    writingStyle: "ICLR style: precise problem statement, method, reproducible experiments, ablations, limitations, and responsible-use discussion",
    templateId: "iclr2026",
    source: "official-kit",
  },
];

export function researchPolicyForTemplate(templateId: string): ResearchPolicy | undefined {
  const normalized = templateId.trim();
  if (normalized === "iclr2025") return { ...POLICIES.find((p) => p.domain === "ai-ml")!, templateId: normalized };
  return POLICIES.find((policy) => policy.templateId === normalized);
}

export function researchPolicyForDomain(domain: ResearchDomain): ResearchPolicy {
  return POLICIES.find((policy) => policy.domain === domain)!;
}

export function researchPolicies(): readonly ResearchPolicy[] {
  return POLICIES;
}
