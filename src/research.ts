import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GeneratedMaterialsMapSchema, GeneratedResearchClaimSchema, MaterialEntrySchema, OutlineSchema, ResearchProvenanceSchema } from "./artifacts.js";
import { isManuscriptPath, safeSourcePath } from "./input-extraction.js";
import { ARTIFACTS } from "./paths.js";
import type { Check } from "./state/schema.js";
import { z } from "zod";

/** Validate research links, including optional outline.reading supplements, without mutating triage. */
export function validateResearch(workspace: string): Check {
  const issues: string[] = [];
  try {
    const map = GeneratedMaterialsMapSchema.parse(JSON.parse(readFileSync(safeSourcePath(workspace, ARTIFACTS.materialsMap), "utf8")));
    const manifestPath = ".brain/input-manifest.json";
    const manifest = existsSync(join(workspace, manifestPath)) ? z.array(z.object({
      source: z.string(), imported: z.string().optional(), normalized: z.string().optional(),
      role: z.string(), status: z.string(),
    })).parse(JSON.parse(readFileSync(safeSourcePath(workspace, manifestPath), "utf8"))) : undefined;
    // Identity is established by admission metadata, never basename/suffix guessing.
    // A bounded summary shares an origin with its CSV, not its contents or quotes.
    const origins = new Map<string, string>();
    for (const entry of manifest ?? []) {
      if (!["research", "figure"].includes(entry.role) || entry.status === "excluded") continue;
      const original = `source/${entry.imported ?? entry.source}`;
      for (const view of [original, ...(entry.normalized ? [entry.normalized] : [])]) {
        if (origins.has(view) && origins.get(view) !== original) throw new Error(`ambiguous source identity in input-manifest.json: ${view}`);
        origins.set(view, original);
      }
    }
    const origin = (path: string) => origins.get(path) ?? path;
    const hasSource = (paths: readonly string[], path: string) => paths.some((candidate) => origin(candidate) === origin(path));
    const ids = new Set<string>();
    const unique = (id: string) => {
      if (ids.has(id)) issues.push(`duplicate research ID: ${id}`);
      ids.add(id);
    };
    for (const entry of [...map.reading, ...map.facts, ...map.methods, ...map.experiments,
      ...map.results, ...map.research_claims, ...map.requirements]) unique(entry.id);
    const methods = new Map(map.methods.map((entry) => [entry.id, entry]));
    const experiments = new Map(map.experiments.map((entry) => [entry.id, entry]));
    const results = new Map(map.results.map((entry) => [entry.id, entry]));
    const evidence = new Map([...map.methods, ...map.results].map((entry) => [entry.id, entry]));
    const claims = new Map(map.research_claims.map((entry) => [entry.id, entry]));
    type ResearchLinks = Pick<z.infer<typeof GeneratedResearchClaimSchema>, "evidence_ids" | "method_ids" | "experiment_ids" | "provenance" | "evidence_paths">;
    // Follow typed edges only: result -> experiment/method, experiment -> method.
    // Never infer results from a shared method or from matching source filenames.
    const closure = (entry: Partial<ResearchLinks>) => {
      const evidenceIds = new Set(entry.evidence_ids ?? []);
      const methodIds = new Set(entry.method_ids ?? []);
      const experimentIds = new Set(entry.experiment_ids ?? []);
      const refs = [...(entry.provenance ?? [])];
      for (const id of evidenceIds) {
        if (methods.has(id)) methodIds.add(id);
        const result = results.get(id);
        if (!result) continue;
        refs.push(...result.provenance);
        for (const method of result.method_ids) methodIds.add(method);
        for (const experiment of result.experiment_ids) experimentIds.add(experiment);
      }
      for (const id of experimentIds) {
        const experiment = experiments.get(id);
        if (!experiment) continue;
        refs.push(...experiment.provenance);
        for (const method of experiment.method_ids) methodIds.add(method);
      }
      for (const id of methodIds) {
        evidenceIds.add(id);
        refs.push(...(methods.get(id)?.provenance ?? []));
      }
      return { evidenceIds, methodIds, experimentIds, provenance: refs,
        paths: [...new Set([...(entry.evidence_paths ?? []), ...refs.map((ref) => ref.source_path)])] };
    };
    const reading = new Map(map.reading.map((entry) => [entry.path, entry]));
    const indexedSources = new Map<string, typeof map.reading[number]>();
    for (const entry of map.reading) {
      const key = origin(entry.path);
      if (indexedSources.has(key)) issues.push(`${entry.id}: source identity already indexed as ${indexedSources.get(key)!.id}; retain one stable source ID`);
      indexedSources.set(key, entry);
    }
    const indexedRead = (path: string) => (reading.get(path) ?? indexedSources.get(origin(path)))?.status === "read";
    const coverage = new Map(map.coverage.map((entry) => [entry.path, entry]));
    if (coverage.size !== map.coverage.length) issues.push("coverage paths must be unique");
    if (reading.size !== map.reading.length) issues.push("reading paths must be unique");
    const links = (owner: string, refs: string[], allowed: ReadonlyMap<string, unknown>) => {
      if (new Set(refs).size !== refs.length) issues.push(`${owner}: repeated relationship ID`);
      for (const id of refs) if (!allowed.has(id)) issues.push(`${owner}: unknown or wrong-type relationship ${id}`);
    };
    const source = (path: string, absent = false, inventory = false): string | undefined => {
      if (!/^(source\/|\.brain\/input\/)/.test(path) && path !== ".brain/raw/data_analysis.json") {
        throw new Error(`not a permitted research source: ${path}`);
      }
      if (path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`unsafe research path: ${path}`);
      }
      if (!inventory && isManuscriptPath(path)) throw new Error(`inherited manuscript is not research evidence: ${path}`);
      if (!inventory && manifest && path !== ".brain/raw/data_analysis.json" && !manifest.some((entry) =>
        ["research", "figure"].includes(entry.role) && entry.status !== "excluded" &&
        (path === `source/${entry.imported ?? entry.source}` || path === entry.normalized))) {
        throw new Error(`source is not admitted research evidence in input-manifest.json: ${path}`);
      }
      if (absent) {
        // Missing/excluded inventory paths may not exist, but may not traverse symlinks either.
        let current = resolve(workspace);
        for (const part of path.split("/")) {
          if (lstatSync(current).isSymbolicLink()) throw new Error(`unsafe research path: ${path}`);
          current = join(current, part);
          try {
            if (lstatSync(current).isSymbolicLink()) throw new Error(`unsafe research path: ${path}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        }
      }
      return safeSourcePath(workspace, path);
    };
    const provenance = (owner: string, refs: z.infer<typeof ResearchProvenanceSchema>[], supported: boolean, isRead = indexedRead) => {
      if (supported && refs.length === 0) issues.push(`${owner}: read evidence requires provenance`);
      for (const ref of refs) {
        const file = source(ref.source_path)!;
        if (supported && !isRead(ref.source_path)) issues.push(`${owner}: evidence source must be indexed as read: ${ref.source_path}`);
        // Do not test an original-file quote against its mirror or partial summary.
        if (ref.quote && !readFileSync(file, "utf8").includes(ref.quote)) issues.push(`${owner}: quote not found in ${ref.source_path}`);
      }
    };
    for (const entry of map.coverage) source(entry.path, entry.status === "missing" || entry.status === "excluded", entry.status !== "read");
    for (const entry of map.reading) {
      source(entry.path, entry.status === "missing" || entry.status === "excluded", entry.status !== "read");
      if (coverage.get(entry.path)?.status !== entry.status) issues.push(`${entry.id}: reading status must match coverage`);
    }
    for (const entry of [...map.methods, ...map.experiments, ...map.results, ...map.research_claims]) {
      provenance(entry.id, entry.provenance, entry.status === "read");
    }
    for (const experiment of map.experiments) {
      links(experiment.id, experiment.method_ids, methods);
      if (experiment.status === "read" && experiment.method_ids.some((id) => methods.get(id)?.status !== "read")) issues.push(`${experiment.id}: recorded experiment depends on unread method evidence`);
    }
    for (const result of map.results) {
      links(result.id, result.method_ids, methods);
      links(result.id, result.experiment_ids, experiments);
      if (closure({ evidence_ids: [result.id] }).methodIds.size === 0) issues.push(`${result.id}: result must identify its method directly or through an experiment`);
      if (result.status === "read" && result.method_ids.some((id) => methods.get(id)?.status !== "read")) issues.push(`${result.id}: result depends on unread method evidence`);
      if (result.kind === "measured" && result.experiment_ids.length === 0) issues.push(`${result.id}: measured result requires a recorded experiment`);
      if (result.kind === "derived" && !result.derivation) issues.push(`${result.id}: derived result requires the supplied calculation and operands`);
      for (const id of result.experiment_ids) {
        const experiment = experiments.get(id);
        if (experiment && result.method_ids.length && !experiment.method_ids.some((method) => result.method_ids.includes(method))) issues.push(`${result.id}: experiment ${id} has no linked result method`);
        if (result.status === "read" && experiment?.status !== "read") issues.push(`${result.id}: result depends on an experiment that is not read`);
      }
    }
    for (const claim of map.research_claims) {
      links(claim.id, claim.method_ids, methods);
      links(claim.id, claim.experiment_ids, experiments);
      links(claim.id, claim.evidence_ids, evidence);
      for (const path of claim.evidence_paths) source(path);
      const effective = closure(claim);
      for (const id of effective.evidenceIds) {
        const entry = evidence.get(id);
        if (!entry) continue;
        if (claim.status === "read" && entry.status !== "read") issues.push(`${claim.id}: unsupported evidence ${id} has status ${entry.status}`);
      }
      for (const id of effective.experimentIds) if (claim.status === "read" && experiments.get(id)?.status !== "read") issues.push(`${claim.id}: experiment ${id} is not read`);
    }
    for (const fact of map.facts) {
      provenance(fact.id, [{ source_path: fact.source_path, locator: "verbatim fact", quote: fact.quote }], true);
      links(fact.id, fact.result_ids, results);
      for (const id of fact.result_ids) {
        const result = results.get(id);
        if (result && (result.status !== "read" || result.kind === "conceptual" || !hasSource(result.provenance.map((ref) => ref.source_path), fact.source_path))) issues.push(`${fact.id}: fact must link recorded numeric evidence from the same source`);
      }
    }
    if ((!map.experiments.length || !map.results.some((entry) => entry.kind === "measured" && entry.status === "read")) && !map.no_measurements_reason) {
      issues.push("no_measurements_reason is required without recorded experiments/measurements; conceptual research does not require fabricated experiments");
    }
    // Outlines do not exist during triage; once present, both versions must preserve the graph.
    for (const path of [ARTIFACTS.outline, ARTIFACTS.outlineV1]) {
      if (!existsSync(join(workspace, path))) continue;
      const outline = OutlineSchema.parse(JSON.parse(readFileSync(safeSourcePath(workspace, path), "utf8")));
      // A later reader can index new supporting files or explicitly read an old
      // unread source. These scoped records cannot rename triage source IDs.
      const outlineSources = new Map(indexedSources);
      const addedSourceIds = new Set<string>();
      const addedOrigins = new Set<string>();
      const additions = z.array(MaterialEntrySchema.required({ id: true, status: true })).parse(outline.reading ?? []);
      for (const entry of additions) {
        source(entry.path, entry.status === "missing" || entry.status === "excluded", entry.status !== "read");
        const key = origin(entry.path);
        const existing = indexedSources.get(key);
        if ((existing && existing.id !== entry.id) || (ids.has(entry.id) && existing?.id !== entry.id) ||
          addedSourceIds.has(entry.id) || addedOrigins.has(key)) issues.push(`${path}: ${entry.id} changes or duplicates a stable source ID`);
        addedSourceIds.add(entry.id);
        addedOrigins.add(key);
        outlineSources.set(key, entry);
      }
      const outlineRead = (sourcePath: string) => outlineSources.get(origin(sourcePath))?.status === "read";
      const requirementIds = new Set<string>();
      for (const requirement of outline.requirements) {
        if (!requirement.id || requirementIds.has(requirement.id)) issues.push(`${path}: requirements need unique stable IDs`);
        if (requirement.id) requirementIds.add(requirement.id);
      }
      const outlineIds = new Set<string>();
      const outlineClaims = new Map(claims);
      for (const rawClaim of outline.research_claims) {
        const claim = GeneratedResearchClaimSchema.parse(rawClaim);
        if (!claim.id || !claims.has(claim.id)) issues.push(`${path}: outline claim must reuse a materials claim ID`);
        else {
          if (outlineIds.has(claim.id)) issues.push(`${path}: duplicate claim ${claim.id}`);
          outlineIds.add(claim.id);
          outlineClaims.set(claim.id, claim);
          const original = claims.get(claim.id)!;
          const originalLinks = closure(original);
          const effective = closure(claim);
          links(`${path}: ${claim.id}`, claim.evidence_ids, evidence);
          links(`${path}: ${claim.id}`, claim.method_ids, methods);
          links(`${path}: ${claim.id}`, claim.experiment_ids, experiments);
          if ([...originalLinks.evidenceIds].some((id) => !effective.evidenceIds.has(id))) issues.push(`${path}: ${claim.id} must retain materials evidence IDs`);
          if (claim.status !== original.status || [...effective.methodIds].some((id) => !originalLinks.methodIds.has(id)) ||
            [...effective.experimentIds].some((id) => !originalLinks.experimentIds.has(id)) ||
            [...originalLinks.methodIds].some((id) => !effective.methodIds.has(id)) ||
            [...originalLinks.experimentIds].some((id) => !effective.experimentIds.has(id))) issues.push(`${path}: ${claim.id} changes materials status or relationships`);
          provenance(`${path}: ${claim.id}`, claim.provenance, claim.status === "read", outlineRead);
          for (const sourcePath of claim.evidence_paths) {
            source(sourcePath);
            if (!hasSource(originalLinks.paths, sourcePath) &&
              (!outlineRead(sourcePath) || !hasSource(effective.provenance.map((ref) => ref.source_path), sourcePath))) {
              issues.push(`${path}: ${claim.id} supplemental evidence requires an indexed read source and explicit provenance: ${sourcePath}`);
            }
          }
          for (const id of effective.evidenceIds) {
            const entry = evidence.get(id);
            if (entry && claim.status === "read" && entry.status !== "read") issues.push(`${path}: ${claim.id} uses evidence ${id} that is not read`);
          }
          for (const id of effective.experimentIds) if (claim.status === "read" && experiments.get(id)?.status !== "read") issues.push(`${path}: ${claim.id} uses experiment ${id} that is not read`);
        }
      }
      const planEvidence = (item: { claim_ids?: string[]; evidence_ids?: string[] }, quantityIds: string[] = []) => closure({
        evidence_ids: [...new Set([...(item.evidence_ids ?? []), ...quantityIds,
          ...(item.claim_ids ?? []).flatMap((id) => [...closure(outlineClaims.get(id) ?? {}).evidenceIds])])],
      }).evidenceIds;
      const linkedSource = (id: string, sourcePath: string, claimIds: string[]) => {
        if (hasSource(closure({ evidence_ids: [id] }).paths, sourcePath)) return true;
        return claimIds.some((claimId) => {
          const claim = outlineClaims.get(claimId);
          if (!claim) return false;
          const effective = closure(claim);
          return effective.evidenceIds.has(id) && hasSource(effective.paths, sourcePath);
        });
      };
      const planIds = new Set<string>();
      for (const item of [...outline.plotting_plan.map((entry) => ({ ...entry, id: entry.figure_id })),
        ...outline.table_plan.map((entry) => ({ ...entry, id: entry.table_id })),
        ...outline.section_plan.map((entry) => ({ ...entry, id: entry.section_id }))]) {
        const owner = `${path}: ${item.id ?? "section without ID"}`;
        if (!item.id || planIds.has(item.id) || ids.has(item.id) || addedSourceIds.has(item.id)) issues.push(`${owner}: missing or duplicate plan ID`);
        if (item.id) planIds.add(item.id);
        links(owner, item.claim_ids ?? [], claims);
        links(owner, item.evidence_ids ?? [], evidence);
        for (const id of item.claim_ids ?? []) {
          const claim = outlineClaims.get(id);
          if (claim?.status !== "read") issues.push(`${owner}: claim ${id} is not supported/read`);
        }
        for (const id of planEvidence(item)) if (evidence.get(id)?.status !== "read") issues.push(`${owner}: evidence ${id} is not read`);
      }
      for (const table of outline.table_plan) {
        for (const path of [...table.source_paths, ...table.rows.flatMap((row) => row.source_paths)]) source(path);
        const effective = planEvidence(table);
        if (!table.claim_ids?.length || !effective.size) issues.push(`${table.table_id}: table requires claim and effective evidence IDs`);
        for (const sourcePath of [...table.source_paths, ...table.rows.flatMap((row) => row.source_paths)]) {
          if (![...effective].some((id) => linkedSource(id, sourcePath, table.claim_ids ?? []))) issues.push(`${table.table_id}: source ${sourcePath} is not linked to table evidence`);
        }
      }
      for (const figure of outline.plotting_plan) {
        for (const path of figure.data_source) source(path);
        const effective = planEvidence(figure, (figure.quantities ?? []).flatMap((quantity) => quantity.evidence_ids));
        if (!figure.claim_ids?.length || !effective.size) issues.push(`${figure.figure_id}: figure requires claim and effective evidence IDs`);
        for (const id of effective) if (evidence.get(id)?.status !== "read") issues.push(`${figure.figure_id}: evidence ${id} is not read`);
        // data_source is itself an explicit supporting-source link. Numeric
        // quantities additionally bind their named file to a particular evidence ID.
        for (const sourcePath of figure.data_source) if (!outlineRead(sourcePath)) issues.push(`${figure.figure_id}: source ${sourcePath} is not indexed as read`);
        if (figure.expected_math && !figure.math_source) issues.push(`${figure.figure_id}: expected_math requires supplied math provenance`);
        if (figure.math_source !== undefined) provenance(`${figure.figure_id}.math_source`, [ResearchProvenanceSchema.parse(figure.math_source)], true, outlineRead);
        if (figure.plot_type === "plot" && !figure.quantities?.length) issues.push(`${figure.figure_id}: numeric plot requires quantity bindings`);
        for (const quantity of figure.quantities ?? []) {
          source(quantity.source_path);
          links(figure.figure_id, quantity.evidence_ids, evidence);
          if (!figure.data_source.includes(quantity.source_path)) issues.push(`${figure.figure_id}: quantity source absent from data_source`);
          for (const id of quantity.evidence_ids) {
            if (!linkedSource(id, quantity.source_path, figure.claim_ids ?? [])) issues.push(`${figure.figure_id}: quantity ${quantity.quantity} has unrelated evidence ${id}`);
          }
          if (quantity.expected_math && !quantity.math_source) issues.push(`${figure.figure_id}: expected_math requires supplied math provenance`);
          if (quantity.math_source) provenance(figure.figure_id, [quantity.math_source], true, outlineRead);
        }
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return { name: "research_integrity", passed: issues.length === 0, advisory: false,
    detail: issues.length ? issues.join("; ") : "Research IDs, safe source provenance and effective typed-link closure are valid (not a scientific-proof check)." };
}
