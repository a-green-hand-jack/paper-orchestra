import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bibliographyOriginNote,
  bibAuthors,
  bibField,
  parseBibEntries,
  suppliedBibliography,
  toSuppliedCandidates,
} from "../src/bibliography.js";
import { ARTIFACTS, SOURCE_DIR } from "../src/paths.js";
import { CandidatesSchema, CitationMapSchema } from "../src/artifacts.js";
import { toCitationMap } from "../src/literature.js";
import { validateStage, validators } from "../src/validation.js";
import { citedKeys } from "../src/latex.js";
import { buildStagePrompt } from "../src/prompts.js";
import { installRuntimeAssets } from "../src/assets.js";
import {
  MESSY_BIBLIOGRAPHY,
  makeRawMaterialsWithBibliography,
  prepared,
  tamper,
} from "./fixtures.js";
import type { Scope } from "../src/state/schema.js";

function put(workspace: string, rel: string, body: string): void {
  writeFileSync(join(workspace, rel), body);
}

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    idea_filename: "idea_sparse.md",
    experimental_log_filename: "experimental_log.md",
    use_plotting: false,
    research_cutoff: "2026-01",
    plan: ["triage", "outline", "literature", "plotting", "section_writing", "refinement"],
    max_lkm_calls: 40,
    target_citations: 20,
    ...overrides,
  } as Scope;
}

/**
 * A workspace whose literature stage has already run on the supplied path, set
 * up the way the controller sets it up. Kept in one place so a test asserts
 * about the validators rather than about its own scaffolding.
 */
async function afterSuppliedIngestion(bib = MESSY_BIBLIOGRAPHY) {
  const { workspace } = await prepared({
    rawMaterials: makeRawMaterialsWithBibliography(bib),
  });
  const candidates = toSuppliedCandidates(bib, new Date().toISOString());
  put(workspace, ARTIFACTS.references, bib);
  put(workspace, ARTIFACTS.candidates, JSON.stringify(candidates));
  put(workspace, ARTIFACTS.citationMap, JSON.stringify(toCitationMap(candidates)));
  return { workspace, candidates };
}

describe("parsing a real bibliography", () => {
  it("matches braces, so an abstract containing LaTeX does not truncate the entry", () => {
    const entries = parseBibEntries(MESSY_BIBLIOGRAPHY);
    expect(entries.map((e) => e.key)).toEqual([
      "vqa",
      "llava",
      "liu2023visualinstructiontuning",
      "math",
    ]);
    // The nested `\begin{document}...\end{document}` sits inside the abstract;
    // a naive split on `}` or on blank lines would have ended the entry early
    // and lost the rest of it.
    expect(bibField(entries[0]!.body, "abstract")).toContain("0.25 M images");
    expect(bibField(entries[0]!.body, "year")).toBe("2015");
  });

  it("accepts a mixed-case entry type, because BibTeX does", () => {
    expect(parseBibEntries("@ARTICLE{k, title={T}}").map((e) => e.type)).toEqual(["article"]);
  });

  it("reads a field that follows a stray comma, because real files have them", () => {
    // `pwb-0001` has a lone `,` on its own line before `abstract = {...}` in
    // most entries. Refusing it would reject a file that compiles.
    const entry = parseBibEntries(MESSY_BIBLIOGRAPHY)[0]!;
    expect(bibField(entry.body, "abstract")).not.toBeNull();
  });

  it("splits authors on `and` and drops the braces around a name", () => {
    expect(bibAuthors("author={Liu, Haotian and {Li}, Chunyuan}")).toEqual([
      "Liu, Haotian",
      "Li, Chunyuan",
    ]);
  });

  it("collapses a value that wraps across lines, as BibTeX does", () => {
    expect(bibField("title={A very\n  long title}", "title")).toBe("A very long title");
  });

  it("reads a quoted and a bare value", () => {
    expect(bibField('title="Quoted"', "title")).toBe("Quoted");
    expect(bibField("year=2015,\n", "year")).toBe("2015");
  });

  it("does not mistake an `@` inside an abstract for the next entry", () => {
    const bib = "@misc{a,\n  title={T},\n  abstract={mail me at a@b.com or @cite}\n}\n";
    expect(parseBibEntries(bib).map((e) => e.key)).toEqual(["a"]);
  });
});

describe("candidates built from a supplied bibliography", () => {
  it("produces schema-valid records with a supplied provenance", () => {
    const candidates = toSuppliedCandidates(MESSY_BIBLIOGRAPHY, "2026-09-04T00:00:00Z");
    const parsed = CandidatesSchema.safeParse(candidates);
    expect(parsed.success).toBe(true);
    expect(candidates.every((c) => c.provider === "supplied")).toBe(true);
    expect(candidates.every((c) => c.provider_id === c.citation_key)).toBe(true);
    // Nothing scored these, and no query produced them. Saying so is what keeps
    // per-query retrieval precision measurable without a special case.
    expect(candidates.every((c) => c.relevance === 0)).toBe(true);
    expect(candidates.every((c) => c.matched_queries.length === 0)).toBe(true);
  });

  it("carries an entry that has no year rather than dropping it", () => {
    // The author's file is the fixed bibliography. An incomplete entry is still
    // one the manuscript is allowed to cite.
    const math = toSuppliedCandidates(MESSY_BIBLIOGRAPHY, "t").find((c) => c.citation_key === "math");
    expect(math?.year).toBeNull();
    expect(math?.title).toContain("MATH Dataset");
  });

  it("reports the venue the file actually gives, however wrong it looks", () => {
    // `journal={Sort}` is really in `pwb-0001`. Faithfulness beats correction:
    // we are not the authority on the author's bibliography.
    const math = toSuppliedCandidates(MESSY_BIBLIOGRAPHY, "t").find((c) => c.citation_key === "math");
    expect(math?.venue).toBe("Sort");
  });

  it("keeps the first of two entries sharing a key, as BibTeX resolves it", () => {
    const bib = "@misc{dup, title={First}}\n@misc{dup, title={Second}}\n";
    const candidates = toSuppliedCandidates(bib, "t");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.title).toBe("First");
  });

  it("yields a citation map the schema accepts", () => {
    const map = toCitationMap(toSuppliedCandidates(MESSY_BIBLIOGRAPHY, "t"));
    expect(CitationMapSchema.safeParse(map).success).toBe(true);
    expect(Object.keys(map)).toHaveLength(4);
  });
});

describe("detecting a supplied bibliography", () => {
  it("finds one the author put in the materials", async () => {
    const { workspace } = await prepared({
      rawMaterials: makeRawMaterialsWithBibliography(),
    });
    expect(suppliedBibliography(workspace)).toBe(join(SOURCE_DIR, "references.bib"));
  });

  it("is null when the materials carry no bibliography", async () => {
    const { workspace } = await prepared();
    expect(suppliedBibliography(workspace)).toBeNull();
  });

  it("ignores the empty bibliography a template ships", async () => {
    // Templates carry a `references.bib` of their own, under `template/`. It is
    // the venue's example file, not the author's library, and an empty one must
    // never route a run away from retrieval.
    const { workspace } = await prepared();
    expect(existsSync(join(workspace, "template", "references.bib"))).toBe(true);
    expect(suppliedBibliography(workspace)).toBeNull();
  });

  it("is null for a file with no parsable entry", async () => {
    const { workspace } = await prepared({
      rawMaterials: makeRawMaterialsWithBibliography("% a comment and nothing else\n"),
    });
    expect(suppliedBibliography(workspace)).toBeNull();
  });

  it("routes on one entry, making no judgement about quality", async () => {
    // The same reasoning as the triage router: whether the author handed us a
    // bibliography is a question about the filesystem. A bar on entry count
    // would make a spend decision depend on something no user can predict.
    const { workspace } = await prepared({
      rawMaterials: makeRawMaterialsWithBibliography("@misc{only, title={One}}\n"),
    });
    expect(suppliedBibliography(workspace)).not.toBeNull();
  });
});

describe("provenance for a supplied bibliography", () => {
  it("traces every entry to the digest-locked source file", async () => {
    const { workspace } = await afterSuppliedIngestion();
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("source/references.bib");
  });

  it("passes with no candidates.json at all, since it is not the evidence", async () => {
    // Deriving candidates.json from the bibliography and then checking the
    // bibliography against it would be circular. The evidence is `source/`.
    const { workspace } = await afterSuppliedIngestion();
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(true);
  });

  it("fails when the model adds an entry the author did not supply", async () => {
    const { workspace } = await afterSuppliedIngestion();
    put(
      workspace,
      ARTIFACTS.references,
      `${MESSY_BIBLIOGRAPHY}\n@article{invented2026, title={A Paper That Does Not Exist}}\n`,
    );
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("invented2026");
  });

  it("cannot be switched off by editing the writable artifact", async () => {
    // `candidates.json` lives under `.brain/`, which the agent may write. If the
    // branch were decided by `provider: "supplied"` in there, a model could
    // fabricate a bibliography and then relabel its own records to excuse it.
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{invented2026, title={Nope}}\n");
    put(
      workspace,
      ARTIFACTS.candidates,
      JSON.stringify([
        {
          citation_key: "somethingelse",
          title: "Real",
          provider: "supplied",
          provider_id: "somethingelse",
          retrieved_at: "2026-09-04T00:00:00Z",
        },
      ]),
    );
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("invented2026");
  });

  it("still requires candidates.json on the retrieval path", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{Key0, title={Paper}}\n");
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("candidates.json");
  });

  it("notices a supplied bibliography that was tampered with after prepare", async () => {
    // `verifyLocks` is the primary guard, but the validator must not silently
    // accept a rewritten source either: the two entries stop matching.
    const { workspace } = await afterSuppliedIngestion();
    tamper(join(workspace, SOURCE_DIR, "references.bib"), "@misc{different, title={X}}\n");
    expect(validators.bibliographyProvenance(workspace).passed).toBe(false);
  });
});

describe("duplicates in a supplied bibliography", () => {
  it("are reported without failing the stage", async () => {
    // `pwb-0001` really does list seven papers twice. Dedup targets our own
    // retrieval merge, not the author's library, and the external grader does
    // not care -- so failing here would reject a file BibTeX accepts.
    const { workspace } = await afterSuppliedIngestion();
    const check = validators.literatureDedup(workspace);
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("llava");
    expect(check.detail).toContain("liu2023visualinstructiontuning");
    expect(check.detail).toContain("more than once");
  });

  it("still fail the stage when they came from retrieval", async () => {
    const { workspace } = await prepared();
    put(
      workspace,
      ARTIFACTS.citationMap,
      JSON.stringify({
        a: { citation_key: "a", title: "Visual Instruction Tuning" },
        b: { citation_key: "b", title: "Visual instruction tuning" },
      }),
    );
    const check = validators.literatureDedup(workspace);
    expect(check.passed).toBe(false);
  });
});

describe("the citation floor counts what the bibliography holds", () => {
  it("uses the supplied bibliography's entries as availability", async () => {
    const { workspace } = await afterSuppliedIngestion();
    // Four entries, so the floor is capped at four rather than the target of 20.
    put(workspace, ARTIFACTS.finalTex, "\\cite{vqa} \\cite{llava}");
    const short = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(short.passed).toBe(false);
    expect(short.detail).toContain("at least 4");

    put(workspace, ARTIFACTS.finalTex, "\\cite{vqa} \\cite{llava} \\cite{math} \\cite{liu2023visualinstructiontuning}");
    const full = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(full.passed).toBe(true);
    expect(full.detail).toContain("of 4 available");
  });

  it("does not let a truncated citation map lower the floor", async () => {
    // The floor used to be counted from `citation_map.json`, so emptying that
    // file dropped the floor to zero and any manuscript passed.
    const { workspace } = await afterSuppliedIngestion();
    put(workspace, ARTIFACTS.citationMap, "{}");
    put(workspace, ARTIFACTS.finalTex, "\\cite{vqa}");
    const check = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("at least 4");
  });
});

describe("the literature stage on the supplied path", () => {
  it("passes its checks once the controller has ingested the bibliography", async () => {
    const { workspace } = await afterSuppliedIngestion();
    put(workspace, ARTIFACTS.outlineV1, JSON.stringify({ title: "T", sections: [] }));
    put(
      workspace,
      ARTIFACTS.updatedTemplate,
      `\\documentclass{article}\n\\begin{document}\n${"Body. ".repeat(60)}\n\\end{document}\n`,
    );
    const failed = validateStage(workspace, "literature", scope()).filter((c) => !c.passed);
    // outline_v1 and updated_template are the model's work and are asserted
    // elsewhere; what matters here is that nothing about the bibliography fails.
    expect(failed.map((c) => c.name)).not.toContain("bibliography_provenance");
    expect(failed.map((c) => c.name)).not.toContain("literature_dedup");
  });

  it("keeps the bibliography byte-identical to the author's file", async () => {
    // Re-serializing from the parsed records loses every abstract along with
    // pages, volume and entry-type nuance: `pwb-0001` goes from 189 KB to
    // 39 KB. The grader compiles what we ship, and the author's file already
    // compiles, so the only safe transformation is none.
    const { workspace } = await afterSuppliedIngestion();
    expect(readFileSync(join(workspace, ARTIFACTS.references), "utf8")).toBe(
      readFileSync(join(workspace, SOURCE_DIR, "references.bib"), "utf8"),
    );
  });

  it("leaves every supplied key citable by the manuscript", async () => {
    const { workspace, candidates } = await afterSuppliedIngestion();
    const tex = candidates.map((c) => `\\cite{${c.citation_key}}`).join(" ");
    put(workspace, ARTIFACTS.rawDraft, `${"Body. ".repeat(120)}\n${tex}`);
    expect(validators.citationIntegrity(workspace, ARTIFACTS.rawDraft).passed).toBe(true);
    expect(citedKeys(tex)).toHaveLength(candidates.length);
  });
});

describe("what the writing model is told about the bibliography", () => {
  it("does not claim a supplied bibliography was screened or ranked", async () => {
    // The sentence used to be unconditional prose in the command markdown. On
    // this path nothing retrieved these papers, nothing scored them, and their
    // order is the order of the author's file -- so asserting otherwise would
    // send the model to the top of a list that means nothing.
    const { workspace } = await prepared({
      rawMaterials: makeRawMaterialsWithBibliography(),
    });
    const note = bibliographyOriginNote(workspace);
    expect(note).toContain("NOT ordered by relevance");
    expect(note).toContain("closed");
    expect(note).not.toContain("most relevant first");
  });

  it("keeps the retrieval wording when there is no supplied bibliography", async () => {
    const { workspace } = await prepared();
    expect(bibliographyOriginNote(workspace)).toContain("most relevant first");
  });

  it("substitutes into the literature prompt, leaving no placeholder behind", async () => {
    const { workspace, state } = await prepared({
      rawMaterials: makeRawMaterialsWithBibliography(),
    });
    // The installed copy, not the repository's, since that is the file the
    // controller actually reads at run time.
    installRuntimeAssets(workspace, state);
    const built = buildStagePrompt(workspace, "literature", scope(), {
      paper_count: "4",
      min_cite_paper_count: "4",
      bibliography_origin: bibliographyOriginNote(workspace),
    });
    // The header comment is the prompt's own declaration of what the controller
    // owes it; every name in that list must be gone from the assembled text.
    const declared = /Controller-substituted placeholders: (.+)/
      .exec(readFileSync(join(workspace, ".opencode", "commands", "2-po-literature.md"), "utf8"))?.[1];
    expect(declared).toContain("bibliography_origin");
    for (const token of declared!.split(",").map((t) => t.trim())) {
      expect(built).not.toContain(token);
    }
    expect(built).toContain("do not add an entry to references.bib");
  });
});
