/**
 * Catalog of venues PaperOrchestra can prepare for.
 *
 * A venue is not a template: a venue stays stable while its author kit changes
 * every year. `TemplateAdapter` records one immutable edition. Keeping these
 * concepts separate prevents a mutable alias such as `cvpr` from silently
 * changing an existing project's formatting contract.
 */

export const CCF_A_VENUE_KEYS = [
  "ppopp",
  "fast",
  "dac",
  "hpca",
  "micro",
  "sc",
  "asplos",
  "isca",
  "usenix-atc",
  "eurosys",
  "hpdc",
  "sigcomm",
  "mobicom",
  "infocom",
  "nsdi",
  "ccs",
  "eurocrypt",
  "ieee-sp",
  "crypto",
  "usenix-security",
  "ndss",
  "pldi",
  "popl",
  "fse",
  "sosp",
  "oopsla",
  "ase",
  "icse",
  "issta",
  "osdi",
  "fm",
  "sigmod",
  "kdd",
  "icde",
  "sigir",
  "vldb",
  "stoc",
  "soda",
  "cav",
  "focs",
  "lics",
  "acm-mm",
  "siggraph",
  "ieee-vr",
  "ieee-vis",
  "aaai",
  "neurips",
  "acl",
  "cvpr",
  "iccv",
  "icml",
  "ijcai",
  "cscw",
  "chi",
  "ubicomp",
  "uist",
  "www",
  "rtss",
] as const;

export type CcfAVenueKey = (typeof CCF_A_VENUE_KEYS)[number];

const MATH_EDITION_KEYS = ["isit", "colt", "aistats"] as const;
type MathEditionKey = (typeof MATH_EDITION_KEYS)[number];

export type TemplateSource =
  | { readonly kind: "bundled"; readonly directory: string }
  | {
      readonly kind: "official-archive";
      readonly archiveUrl: string;
      readonly sha256: string;
      /** Directory inside the archive that should become the local template root. */
      readonly sourceRoot: string;
      /** Main source file relative to sourceRoot. It is copied to template.tex. */
      readonly entrypoint: string;
    }
  | {
      readonly kind: "manual";
      readonly reason: string;
      /** A user-provided official kit must contain this file, selected at adapt time. */
      readonly entrypointRequired: true;
    };

export interface VenueDefinition {
  readonly key: CcfAVenueKey;
  readonly title: string;
  readonly category: string;
  /** The publisher's authoring resource, not a claim that a generic class is sufficient. */
  readonly authoringResourceUrl: string;
  readonly verifiedAt: string;
  readonly publicationModel: "proceedings" | "journal-first";
  readonly lifecycle: "active" | "retired";
  readonly notes: readonly string[];
}

export interface TemplateAdapter {
  readonly id: string;
  /** CCF-A key when applicable; ICLR and journal families are external to that list. */
  readonly venueKey: string | null;
  readonly title: string;
  readonly year: number | null;
  readonly category: string;
  readonly authorInstructionsUrl: string;
  /** Date on which the official instructions / immutable source were checked. */
  readonly verifiedAt: string;
  readonly licenseStatus: "redistributable" | "download-only" | "project-authored";
  readonly provenance: string;
  readonly source: TemplateSource;
  readonly build: { readonly engine: "pdflatex"; readonly bibliography: "bibtex" | "none" };
  readonly constraints: {
    readonly anonymity: "double-blind" | "single-blind" | "open" | "varies";
    readonly mainTextPages: number | null;
    readonly referencesCountTowardLimit: boolean | null;
    readonly appendix: "main-pdf" | "supplement" | "varies";
    readonly ethics: "required" | "conditional" | "optional" | "varies";
    readonly artifacts: "required" | "conditional" | "optional" | "varies";
    readonly notes: readonly string[];
  };
}

const ACM = "https://www.acm.org/publications/proceedings-template";
const IEEE = "https://conferences.ieeeauthorcenter.ieee.org/write-your-paper/authoring-tools-and-templates/";
const USENIX = "https://www.usenix.org/conferences/author-resources/paper-templates";
const LNCS = "https://www.springer.com/gp/computer-science/lncs/conference-proceedings-guidelines";
const SIAM = "https://www.siam.org/publications/proceedings/";
const SIGPLAN = "https://www.sigplan.org/Resources/Author/";

function ccf(
  key: CcfAVenueKey,
  title: string,
  category: string,
  authoringResourceUrl: string,
  notes: readonly string[] = [],
  lifecycle: VenueDefinition["lifecycle"] = "active",
): VenueDefinition {
  return {
    key,
    title,
    category,
    authoringResourceUrl,
    verifiedAt: "2026-09-03",
    publicationModel: "proceedings",
    lifecycle,
    notes,
  };
}

/** All 58 conferences in the CCF seventh-edition A list (verified 2026-09-03). */
export const CCF_A_VENUES: readonly VenueDefinition[] = [
  ccf("ppopp", "PPoPP", "Architecture / parallel / storage", SIGPLAN),
  ccf("fast", "USENIX FAST", "Architecture / parallel / storage", USENIX),
  ccf("dac", "Design Automation Conference", "Architecture / parallel / storage", IEEE),
  ccf("hpca", "IEEE HPCA", "Architecture / parallel / storage", IEEE),
  ccf("micro", "IEEE/ACM MICRO", "Architecture / parallel / storage", IEEE),
  ccf("sc", "SC", "Architecture / parallel / storage", "https://sc26.supercomputing.org/program/papers/", [
    "Use the exact yearly paper kit and required artifact material.",
  ]),
  ccf("asplos", "ASPLOS", "Architecture / parallel / storage", SIGPLAN),
  ccf("isca", "ISCA", "Architecture / parallel / storage", IEEE),
  ccf("usenix-atc", "USENIX ATC", "Architecture / parallel / storage", USENIX, [
    "USENIX ATC ended after 2025; never fabricate a 2026 edition adapter.",
  ], "retired"),
  ccf("eurosys", "EuroSys", "Architecture / parallel / storage", "https://2026.eurosys.org/cfp.html"),
  ccf("hpdc", "HPDC", "Architecture / parallel / storage", ACM),
  ccf("sigcomm", "SIGCOMM", "Networks", ACM),
  ccf("mobicom", "MobiCom", "Networks", ACM),
  ccf("infocom", "INFOCOM", "Networks", IEEE),
  ccf("nsdi", "NSDI", "Networks", USENIX),
  ccf("ccs", "ACM CCS", "Security", ACM),
  ccf("eurocrypt", "EUROCRYPT", "Security", LNCS),
  ccf("ieee-sp", "IEEE Symposium on Security and Privacy", "Security", IEEE),
  ccf("crypto", "CRYPTO", "Security", LNCS),
  ccf("usenix-security", "USENIX Security", "Security", USENIX),
  ccf("ndss", "NDSS", "Security", "https://www.ndss-symposium.org/ndss-paper-submission/"),
  ccf("pldi", "PLDI", "Software / systems / programming languages", SIGPLAN),
  ccf("popl", "POPL", "Software / systems / programming languages", SIGPLAN),
  ccf("fse", "FSE", "Software / systems / programming languages", ACM),
  ccf("sosp", "SOSP", "Software / systems / programming languages", ACM),
  ccf("oopsla", "OOPSLA / PACMPL", "Software / systems / programming languages", SIGPLAN),
  ccf("ase", "ASE", "Software / systems / programming languages", IEEE),
  ccf("icse", "ICSE", "Software / systems / programming languages", IEEE),
  ccf("issta", "ISSTA", "Software / systems / programming languages", ACM),
  ccf("osdi", "OSDI", "Software / systems / programming languages", USENIX),
  ccf("fm", "FM", "Software / systems / programming languages", LNCS),
  ccf("sigmod", "SIGMOD", "Databases / data mining / information retrieval", ACM),
  ccf("kdd", "SIGKDD", "Databases / data mining / information retrieval", ACM),
  ccf("icde", "ICDE", "Databases / data mining / information retrieval", IEEE),
  ccf("sigir", "SIGIR", "Databases / data mining / information retrieval", ACM),
  ccf("vldb", "VLDB / PVLDB", "Databases / data mining / information retrieval", "https://www.vldb.org/pvldb/"),
  ccf("stoc", "STOC", "Theory", ACM),
  ccf("soda", "SODA", "Theory", SIAM),
  ccf("cav", "CAV", "Theory", LNCS),
  ccf("focs", "FOCS", "Theory", IEEE),
  ccf("lics", "LICS", "Theory", ACM),
  ccf("acm-mm", "ACM Multimedia", "Graphics / multimedia", ACM),
  ccf("siggraph", "SIGGRAPH", "Graphics / multimedia", ACM, [
    "SIGGRAPH often has a journal-first production workflow; follow the exact CFP.",
  ]),
  ccf("ieee-vr", "IEEE VR", "Graphics / multimedia", IEEE),
  ccf("ieee-vis", "IEEE VIS", "Graphics / multimedia", "https://tc.computer.org/vgtc/publications/conference/"),
  ccf("aaai", "AAAI", "Artificial intelligence", "https://aaai.org/conference/aaai/aaai-26/submission-instructions/"),
  ccf("neurips", "NeurIPS", "Artificial intelligence", "https://neurips.cc/Conferences/2026/CallForPapers"),
  ccf("acl", "ACL", "Artificial intelligence", "https://github.com/acl-org/acl-style-files"),
  ccf("cvpr", "CVPR", "Artificial intelligence", "https://cvpr.thecvf.com/Conferences/2026/AuthorGuidelines"),
  ccf("iccv", "ICCV", "Artificial intelligence", "https://iccv.thecvf.com/Conferences/2025/AuthorGuidelines", [
    "ICCV is biennial; the latest available edition is ICCV 2025.",
  ]),
  ccf("icml", "ICML", "Artificial intelligence", "https://icml.cc/Conferences/2026/AuthorInstructions"),
  ccf("ijcai", "IJCAI", "Artificial intelligence", "https://2026.ijcai.org/ijcai-ecai-2026-call-for-papers-main-track/"),
  ccf("cscw", "CSCW", "HCI / ubiquitous computing", ACM),
  ccf("chi", "CHI", "HCI / ubiquitous computing", "https://chi2026.acm.org/chi-publication-formats/"),
  ccf("ubicomp", "UbiComp", "HCI / ubiquitous computing", ACM),
  ccf("uist", "UIST", "HCI / ubiquitous computing", ACM),
  ccf("www", "The Web Conference", "Cross-disciplinary / emerging", ACM),
  ccf("rtss", "RTSS", "Cross-disciplinary / emerging", IEEE),
];

export const TEMPLATE_ADAPTERS: readonly TemplateAdapter[] = [
  {
    id: "cvpr2025",
    venueKey: "cvpr",
    title: "CVPR 2025",
    year: 2025,
    category: "Artificial intelligence",
    authorInstructionsUrl: "https://github.com/cvpr-org/author-kit",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Legacy bundle retained for reproducible existing workspaces.",
    source: { kind: "bundled", directory: "cvpr2025" },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "double-blind", mainTextPages: 8, referencesCountTowardLimit: false, appendix: "supplement",
      ethics: "conditional", artifacts: "optional", notes: [],
    },
  },
  {
    id: "iclr2025",
    venueKey: "iclr",
    title: "ICLR 2025",
    year: 2025,
    category: "Artificial intelligence",
    authorInstructionsUrl: "https://github.com/ICLR/Master-Template",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Legacy bundle retained for reproducible existing workspaces.",
    source: { kind: "bundled", directory: "iclr2025" },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "double-blind", mainTextPages: null, referencesCountTowardLimit: null, appendix: "main-pdf",
      ethics: "conditional", artifacts: "optional", notes: [],
    },
  },
  {
    id: "cvpr2026",
    venueKey: "cvpr",
    title: "CVPR 2026",
    year: 2026,
    category: "Artificial intelligence",
    authorInstructionsUrl: "https://cvpr.thecvf.com/Conferences/2026/AuthorGuidelines",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "CVPR official author-kit tag CVPR2026-v1(latex), commit 12909ae437f6dbc7435069cfdb4ca44c18e6a02f, verified 2026-09-03.",
    source: {
      kind: "official-archive",
      archiveUrl: "https://github.com/cvpr-org/author-kit/archive/refs/tags/CVPR2026-v1%28latex%29.zip",
      sha256: "ef672bf4ad1c6801237b957d57b0087d4412e7dee01ad3b512abe82960c6466c",
      sourceRoot: "author-kit-CVPR2026-v1-latex-",
      entrypoint: "main.tex",
    },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "double-blind", mainTextPages: 8, referencesCountTowardLimit: false, appendix: "supplement",
      ethics: "conditional", artifacts: "optional", notes: [],
    },
  },
  {
    id: "iclr2026",
    venueKey: "iclr",
    title: "ICLR 2026",
    year: 2026,
    category: "Artificial intelligence",
    authorInstructionsUrl: "https://iclr.cc/Conferences/2026/AuthorGuide",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "ICLR official Master-Template commit a28d335b0d46a3c39b205704a65faf41c9748433, verified 2026-09-03.",
    source: {
      kind: "official-archive",
      archiveUrl: "https://github.com/ICLR/Master-Template/raw/a28d335b0d46a3c39b205704a65faf41c9748433/iclr2026.zip",
      sha256: "b6d63b29992e153f804bb6d170c57db156c011b5bedf96a9f31d58813b909acf",
      sourceRoot: "iclr2026",
      entrypoint: "iclr2026_conference.tex",
    },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "double-blind", mainTextPages: 9, referencesCountTowardLimit: false, appendix: "main-pdf",
      ethics: "conditional", artifacts: "optional", notes: [],
    },
  },
  {
    id: "nature-portfolio",
    venueKey: null,
    title: "Nature Portfolio authoring scaffold",
    year: null,
    category: "Natural sciences",
    authorInstructionsUrl: "https://www.nature.com/nature/for-authors/initial-submission",
    verifiedAt: "2026-09-03",
    licenseStatus: "project-authored",
    provenance: "Project-authored scaffold. It is not a Nature official LaTeX template.",
    source: { kind: "bundled", directory: "nature-portfolio" },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies",
      mainTextPages: null,
      referencesCountTowardLimit: null,
      appendix: "varies",
      ethics: "varies",
      artifacts: "varies",
      notes: ["Select a target Nature Portfolio journal and review its own author instructions before submission."],
    },
  },
  {
    id: "science-family",
    venueKey: null,
    title: "Science family official-kit adapter",
    year: null,
    category: "Natural sciences",
    authorInstructionsUrl: "https://www.science.org/content/page/preparing-manuscripts-using-latex",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "AAAS source files are not bundled until their redistribution terms are verified.",
    source: { kind: "manual", reason: "Download the selected journal's official kit, then adapt it locally.", entrypointRequired: true },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies", mainTextPages: null, referencesCountTowardLimit: null, appendix: "varies",
      ethics: "varies", artifacts: "varies", notes: [],
    },
  },
  {
    id: "siam-proceedings",
    venueKey: null,
    title: "SIAM proceedings adapter",
    year: null,
    category: "Mathematics",
    authorInstructionsUrl: SIAM,
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Use the current SIAM proceedings macro selected by the target event.",
    source: { kind: "manual", reason: "SIAM macro/version is conference-specific.", entrypointRequired: true },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies", mainTextPages: null, referencesCountTowardLimit: null, appendix: "varies",
      ethics: "varies", artifacts: "varies", notes: [],
    },
  },
  {
    id: "isit2026",
    venueKey: null,
    title: "ISIT 2026 adapter",
    year: 2026,
    category: "Mathematics / information theory",
    authorInstructionsUrl: IEEE,
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Use the official IEEE kit required by the ISIT 2026 CFP.",
    source: { kind: "manual", reason: "Obtain the kit linked by the ISIT 2026 author instructions.", entrypointRequired: true },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies", mainTextPages: null, referencesCountTowardLimit: null, appendix: "varies",
      ethics: "varies", artifacts: "varies", notes: [],
    },
  },
  {
    id: "colt2026",
    venueKey: null,
    title: "COLT 2026 adapter",
    year: 2026,
    category: "Mathematics / learning theory",
    authorInstructionsUrl: "https://learningtheory.org/",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Use the current COLT/PMLR author kit.",
    source: { kind: "manual", reason: "COLT author kits are edition-specific.", entrypointRequired: true },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies", mainTextPages: null, referencesCountTowardLimit: null, appendix: "varies",
      ethics: "varies", artifacts: "varies", notes: [],
    },
  },
  {
    id: "aistats2026",
    venueKey: null,
    title: "AISTATS 2026 adapter",
    year: 2026,
    category: "Mathematics / statistics",
    authorInstructionsUrl: "https://aistats.org/",
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "Use the current AISTATS/PMLR author kit.",
    source: { kind: "manual", reason: "AISTATS author kits are edition-specific.", entrypointRequired: true },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies", mainTextPages: null, referencesCountTowardLimit: null, appendix: "varies",
      ethics: "varies", artifacts: "varies", notes: [],
    },
  },
];

export function venueDefinition(key: string): VenueDefinition | undefined {
  return CCF_A_VENUES.find((venue) => venue.key === key);
}

export function templateAdapter(id: string): TemplateAdapter | undefined {
  return TEMPLATE_ADAPTERS.find((adapter) => adapter.id === id);
}

/** Return a documented manual CCF-A adapter when an exact edition ID is supplied. */
export function manualCcfTemplateAdapterForId(id: string): TemplateAdapter | undefined {
  const match = /^([a-z]+)(\d{4})$/.exec(id);
  if (!match) return undefined;
  const [, compactKey, yearText] = match;
  const venue = CCF_A_VENUES.find((candidate) => candidate.key.replace(/-/g, "") === compactKey);
  const year = Number(yearText);
  if (!venue || (venue.lifecycle === "retired" && year > 2025)) return undefined;
  return manualCcfTemplateAdapter(venue.key, year);
}

/** Edition-specific adapters for the mathematics venues named in Issue #8. */
export function manualMathTemplateAdapterForId(id: string): TemplateAdapter | undefined {
  const match = /^(isit|colt|aistats)(\d{4})$/.exec(id);
  if (!match) return undefined;
  const key = match[1] as MathEditionKey;
  const year = Number(match[2]);
  if (year < 2000 || year > 2100) return undefined;
  const details: Record<MathEditionKey, { title: string; category: string; instructions: string }> = {
    isit: {
      title: "ISIT",
      category: "Mathematics / information theory",
      instructions: IEEE,
    },
    colt: {
      title: "COLT",
      category: "Mathematics / learning theory",
      instructions: "https://learningtheory.org/",
    },
    aistats: {
      title: "AISTATS",
      category: "Mathematics / statistics",
      instructions: "https://aistats.org/",
    },
  };
  const detail = details[key];
  return {
    id,
    venueKey: null,
    title: `${detail.title} ${year} official-kit adapter`,
    year,
    category: detail.category,
    authorInstructionsUrl: detail.instructions,
    verifiedAt: "2026-09-03",
    licenseStatus: "download-only",
    provenance: "User-supplied exact edition kit; no generic mathematics style is substituted for a target event.",
    source: {
      kind: "manual",
      reason: "Download the exact kit linked by the target event's author instructions, then adapt it locally.",
      entrypointRequired: true,
    },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies",
      mainTextPages: null,
      referencesCountTowardLimit: null,
      appendix: "varies",
      ethics: "varies",
      artifacts: "varies",
      notes: ["Rules are edition and track specific; inspect the supplied official kit and current call for papers."],
    },
  };
}

/**
 * Describe a locally acquired, edition-specific CCF-A author kit. This does
 * not assert that a kit exists for the supplied year; `templates adapt` still
 * requires the user to provide the exact kit linked from the venue's CFP.
 */
export function manualCcfTemplateAdapter(venueKey: CcfAVenueKey, year: number): TemplateAdapter {
  const venue = venueDefinition(venueKey);
  if (!venue) throw new Error(`unknown CCF-A venue key: ${venueKey}`);
  const id = `${venue.key.replace(/-/g, "")}${year}`;
  return {
    id,
    venueKey: venue.key,
    title: `${venue.title} ${year} official-kit adapter`,
    year,
    category: venue.category,
    authorInstructionsUrl: venue.authoringResourceUrl,
    verifiedAt: venue.verifiedAt,
    licenseStatus: "download-only",
    provenance: "User-supplied exact edition kit; source files are never substituted with a publisher-wide generic style.",
    source: {
      kind: "manual",
      reason: "Download the exact kit linked by the target edition's official CFP, then adapt it locally.",
      entrypointRequired: true,
    },
    build: { engine: "pdflatex", bibliography: "bibtex" },
    constraints: {
      anonymity: "varies",
      mainTextPages: null,
      referencesCountTowardLimit: null,
      appendix: "varies",
      ethics: "varies",
      artifacts: "varies",
      notes: ["Inspect the supplied edition's current author instructions; this adapter does not infer venue rules."],
    },
  };
}

/** Throw on accidental duplicate ids or a partial CCF-A catalog at build/test time. */
export function assertVenueCatalog(): void {
  if (CCF_A_VENUES.length !== 58 || new Set(CCF_A_VENUES.map((venue) => venue.key)).size !== 58) {
    throw new Error("CCF-A catalog must contain each of the 58 venues exactly once");
  }
  for (const venue of CCF_A_VENUES) {
    if (!venue.authoringResourceUrl.startsWith("https://") || !/^\d{4}-\d{2}-\d{2}$/.test(venue.verifiedAt)) {
      throw new Error(`CCF-A venue ${venue.key} has incomplete authoring provenance`);
    }
  }
  const ids = TEMPLATE_ADAPTERS.map((adapter) => adapter.id);
  if (new Set(ids).size !== ids.length) throw new Error("template adapter ids must be unique");
  for (const adapter of TEMPLATE_ADAPTERS) {
    if (!adapter.authorInstructionsUrl.startsWith("https://")) {
      throw new Error(`template adapter ${adapter.id} has no HTTPS author-instructions URL`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(adapter.verifiedAt)) {
      throw new Error(`template adapter ${adapter.id} has an invalid verification date`);
    }
  }
}

assertVenueCatalog();
