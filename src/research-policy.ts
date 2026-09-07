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
  readonly source: "official-system" | "official-kit" | "journal-specific-required";
  /** Internal production floor; this is deliberately not presented as a venue rule. */
  readonly productionTarget: {
    readonly minimumPages: number;
    readonly minimumBodyWords: number;
    readonly requiredSections: readonly string[];
    readonly note: string;
  };
}

const POLICIES: readonly ResearchPolicy[] = [
  {
    domain: "mathematics",
    targetVenue: "Annals of Mathematics",
    writingStyle: "formal theorem/lemma/proof style with explicit hypotheses, claims, and proof-status boundaries",
    templateId: "annals-mathematics",
    source: "official-system",
    productionTarget: {
      minimumPages: 8,
      minimumBodyWords: 3500,
      requiredSections: ["Introduction", "Background", "Main Results", "Proofs", "Examples", "Limitations", "Conclusion"],
      note: "Internal article-length floor for a substantive mathematics manuscript; Annals itself does not impose a fixed minimum page count.",
    },
  },
  {
    domain: "physics",
    targetVenue: "Physical Review Letters",
    writingStyle: "physics letter style: compact motivation, model/conventions, quantitative results, uncertainty, and limitations",
    templateId: "physical-review-letters",
    source: "official-system",
    productionTarget: {
      minimumPages: 4,
      minimumBodyWords: 2500,
      requiredSections: ["Introduction", "Model", "Methods", "Results", "Discussion", "Limitations", "Conclusion"],
      note: "Internal substantive-letter floor; PRL's official Letter limit is a maximum of 3750 words for the core text.",
    },
  },
  {
    domain: "natural-sciences",
    targetVenue: "Nature Portfolio (journal selected in the brief)",
    writingStyle: "Nature community style: accessible significance, concise results, methods, data/code availability, and explicit limitations",
    templateId: "nature-portfolio",
    source: "journal-specific-required",
    productionTarget: {
      minimumPages: 6,
      minimumBodyWords: 2500,
      requiredSections: ["Introduction", "Results", "Discussion", "Methods", "Data Availability", "Code Availability", "Limitations", "Conclusion"],
      note: "Nature Portfolio has no single universal template; a concrete journal and article type must be selected before submission.",
    },
  },
  {
    domain: "ai-ml",
    targetVenue: "International Conference on Learning Representations (ICLR)",
    writingStyle: "ICLR style: precise problem statement, method, reproducible experiments, ablations, limitations, and responsible-use discussion",
    templateId: "iclr2026",
    source: "official-kit",
    productionTarget: {
      minimumPages: 8,
      minimumBodyWords: 3000,
      requiredSections: ["Introduction", "Related Work", "Method", "Experiments", "Limitations", "Conclusion"],
      note: "Internal full-paper floor; the ICLR main-text limit is edition-specific and references/appendices are handled separately.",
    },
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
