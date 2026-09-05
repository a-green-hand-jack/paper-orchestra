import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

if (process.argv[2] === "--controller-fixture") await installFixtureModules();
const { ARTIFACTS } = await import("../dist/paths.js");
const { OutlineSchema, MaterialsMapSchema } = await import("../dist/artifacts.js");
const { validateStage } = await import("../dist/validation.js");
const { retrieveForLiterature } = await import("../dist/literature-controller.js");
const { runResult } = await import("../dist/automation.js");
const { publishTables, tableCoverage } = await import("../dist/presentation.js");
const { manuscriptReadiness } = await import("../dist/manuscript-review.js");
const { computeLockDigests, createRunState, readRunState, writeRunState } = await import("../dist/state/store.js");
const { ScopeSchema } = await import("../dist/state/schema.js");
const { prepareBrainInput, materialsFitWhole } = await import("../dist/input.js");
const { digestFile, digestValue } = await import("../dist/files.js");

function put(dir, rel, value) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
}
const read = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const scope = (plan = ["triage", "outline"]) => ScopeSchema.parse({
  plan, use_plotting: true, bibliography_mode: "seed", research_cutoff: "2026-09",
  venue: "fixture", network_policy: "offline", max_lkm_calls: 0,
});
function fixture(t) {
  const dir = mkdtempSync("/tmp/opencode/po-controller-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of ["source", "template", ".brain/input", ".brain/raw", ".brain/manuscript", ".po-run"]) {
    mkdirSync(join(dir, rel), { recursive: true });
  }
  put(dir, "source/results.json", { accuracy: 81.2 });
  put(dir, "template/main.tex", "\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n");
  return dir;
}
function stateFor(dir, plan = ["triage", "outline"], overrides = {}) {
  return writeRunState(dir, { ...createRunState({
    runId: "controller-fixture", runBranch: "fixture", mode: "autonomous", headless: true,
    scope: { ...scope(plan), ...overrides }, ...computeLockDigests(dir), defaultModel: { providerID: "fixture", modelID: "local" },
    stageModels: {}, opencodeVersion: "fixture", timeoutMultiplier: 1,
  }), status: "prepared" });
}
const outline = () => OutlineSchema.parse({ section_plan: [{ section_title: "Results" }] });
const materials = () => MaterialsMapSchema.parse({
  materials_considered: 1, reading: [{ path: "source/results.md", contributes: "Measured accuracy" }],
  facts: [], unresolved: ["Only one measurement; uncertainty was not supplied."],
  coverage: [{ path: "source/results.md", status: "read", reason: "Read the measurement" }],
});
function check(dir, stage, name, runScope = scope()) {
  const checks = validateStage(dir, stage, runScope);
  const found = checks.find((entry) => entry.name === name);
  assert.ok(found, `${stage} must execute ${name}; got ${checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

// The child imports the real dist controller after installing an ESM SDK seam.
// No source rewriting, provider processes, paid calls, or repository commits.
async function installFixtureModules() {
  const { register } = await import("node:module");
  const dist = new URL("../dist/", import.meta.url);
  const mocks = {
    "@opencode-ai/sdk/v2": "export const createOpencodeServer = (...a) => globalThis.fixtureSDK.server(...a); export const createOpencodeClient = (...a) => globalThis.fixtureSDK.client(...a);",
    [new URL("checkpoints.js", dist).href]: "export const initGit = async () => {}; export const checkpoint = async (input) => { globalThis.fixtureCheckpoints.push(input); return 'fixture-checkpoint'; };",
    [new URL("figures.js", dist).href]: `export * from ${JSON.stringify(new URL("figures.js?actual", dist).href)}; export const plottingAvailable = async () => ({ok:true,detail:'fixture'}); export const renderFigure = (...a) => globalThis.fixtureRender(...a);`,
    [new URL("latexbuild.js", dist).href]: `export * from ${JSON.stringify(new URL("latexbuild.js?actual", dist).href)}; export const renderPdfPages = (...a) => globalThis.fixtureRasterize(...a);`,
    [new URL("imagegen.js", dist).href]: "export const IMAGE_ADAPTER_ENV = 'PO_TEST_NO_IMAGE_ADAPTER'; export const textToImageCapability = async () => { throw Error('Unexpected image capability request'); }; export const generateTextImage = async () => { throw Error('Network image generation forbidden in test'); };",
  };
  const loader = `const mocks = ${JSON.stringify(mocks)};
    export async function resolve(specifier, context, next) {
      const resolved = mocks[specifier] ? specifier : (await next(specifier, context)).url;
      if (mocks[resolved]) return {url:'data:text/javascript,' + encodeURIComponent(mocks[resolved]), shortCircuit:true};
      return next(specifier, context);
    }`;
  register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
}

async function controllerChild(scenario, dir) {
  const dist = new URL("../dist/", import.meta.url);
  const plotting = scenario.startsWith("plotting");
  const cache = scenario.startsWith("plotting-cache-");
  let interruptSecondFigure = cache;
  if (!plotting && scenario !== "table-remediation") {
    rmSync(join(dir, "source/results.json"));
    put(dir, "source/results.md", "Measured accuracy: 81.2 percent.\n");
    await prepareBrainInput(dir);
    assert.equal(materialsFitWhole(dir), true, "fixture must exercise the small-input branch");
  }
  globalThis.fetch = async () => { throw new Error("Network forbidden in controller fixture"); };
  globalThis.fixtureCheckpoints = [];
  const prompts = [], sessions = new Map(), renders = [];
  let posture, closed = 0;
  // OpenCode edit rules use last matching pattern; enforce the server config,
  // rather than importing permissionsFor and testing an unused policy object.
  const editAction = (path) => {
    const rules = posture.edit;
    if (typeof rules === "string") return rules;
    let action = "ask";
    for (const [pattern, value] of Object.entries(rules)) {
      const regex = new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (regex.test(path)) action = value;
    }
    return action;
  };
  const agentWrite = (path, value) => {
    assert.equal(editAction(path), "allow", `controller's server permissions deny legitimate writer output ${path}`);
    put(dir, path, value);
  };
  globalThis.fixtureSDK = {
    server: async (options) => {
      posture = options.config.permission;
      for (const path of [ARTIFACTS.materialsMap, ARTIFACTS.outline, ARTIFACTS.outlineV1]) {
        assert.equal(editAction(path), "allow", `writer needs ${path}`);
      }
      for (const path of [ARTIFACTS.candidates, ARTIFACTS.citationMap, ARTIFACTS.references,
        ".brain/manuscript/review.json", ".brain/manuscript/tables/main.tex", "source/results.json"]) {
        assert.equal(editAction(path), "deny", `writer must not own ${path}`);
      }
      return { url: "http://fixture.invalid", close: () => closed++ };
    },
    client: ({ directory }) => {
      assert.equal(directory, dir);
      return { event: { subscribe: async () => ({ stream: (async function* () {})() }) }, session: {
        create: async ({ title }) => {
          if (scenario === "table-remediation" && title === "paper-orchestra plotting") {
            assert.equal(readRunState(dir).stages.literature.status, "completed");
            assert.equal(readRunState(dir).stages.literature.remediations, 1);
            assert.equal(read(dir, ARTIFACTS.outlineV1).table_plan[0].rows[0].values[0], 81.2);
          }
          const id = `session-${sessions.size}`;
          sessions.set(id, { stage: title.replace("paper-orchestra ", ""), busy: false, reply: "" });
          return { data: { id } };
        },
        promptAsync: async (options) => {
          const session = sessions.get(options.sessionID);
          const text = options.parts[0].text;
          prompts.push({ stage: session.stage, text, parts: options.parts });
          session.busy = true;
          session.reply = "The requested stage is complete.";
          if (session.stage === "triage" && scenario !== "missing-triage") agentWrite(ARTIFACTS.materialsMap, materials());
          if (session.stage === "outline") agentWrite(ARTIFACTS.outline, outline());
          if (session.stage === "literature" && scenario === "table-remediation") {
            const correcting = prompts.filter((entry) => entry.stage === "literature").length > 1;
            assert.equal(renders.length, 0, "numeric correction must happen before plotting");
            assert.equal(existsSync(join(dir, ".brain/manuscript/tables/accuracy.tex")), false);
            if (correcting) {
              assert.match(text, /table_plan/);
              assert.match(text, /Correct table_plan in outline_v1\.json/);
              assert.match(text, /actual source columns and supported operations/);
            }
            const plan = read(dir, ARTIFACTS.outline);
            plan.table_plan = [{ table_id: "accuracy", title: "Accuracy", caption: "Recorded accuracy",
              section: "Results", columns: ["Accuracy"], source_paths: ["source/results.json"],
              column_verification: [{ selector: "/accuracy", operation: "direct" }],
              rows: [{ label: "Method", values: [correcting ? 81.2 : 99], source_paths: ["source/results.json"] }] }];
            agentWrite(ARTIFACTS.outlineV1, plan);
            agentWrite(ARTIFACTS.updatedTemplate, "% fixture template\n".repeat(40));
            const numeric = check(dir, "literature", "table_plan", readRunState(dir).scope);
            assert.equal(numeric.passed, correcting, numeric.detail);
            if (!correcting) {
              assert.equal(numeric.advisory, false);
              assert.match(numeric.detail, /99/);
            }
          }
          if (session.stage === "plotting") {
            session.reply = options.parts.some((part) => part.type === "file")
              ? '{"passed":true,"suggestions":""}'
              : '```python\n# Local rendering is mocked at the execution boundary.\n```\nCaption: Recorded accuracy.';
          }
          return { data: true };
        },
        status: async () => ({ data: Object.fromEntries([...sessions].map(([id, session]) => {
          const type = session.busy ? "busy" : "idle"; session.busy = false; return [id, { type }];
        })) }),
        messages: async ({ sessionID }) => ({ data: [{ info: { role: "assistant", cost: 0, tokens: { input: 1, output: 1 } },
          parts: [{ type: "text", text: sessions.get(sessionID).reply }] }] }),
      } };
    },
  };
  globalThis.fixtureRender = async (options) => {
    renders.push(options);
    if (interruptSecondFigure && options.figureId === "second") {
      throw new Error("fixture interruption after first reviewed figure");
    }
    assert.deepEqual(options.dataFiles, [
      { path: join(dir, "source/results.json"), name: "0-results.json" },
      { path: join(dir, ".brain/input/results.json"), name: "1-results.json" },
    ]);
    for (const file of options.dataFiles) assert.ok(existsSync(file.path));
    const imagePath = join(options.workDir, "render.pdf");
    put(dir, imagePath.slice(dir.length + 1), Buffer.alloc(4096, 1));
    return { ok: true, imagePath, bytes: 4096, error: null };
  };
  globalThis.fixtureRasterize = async (pdf, reviewDir, count) => {
    assert.ok(pdf.endsWith("render.pdf"));
    assert.equal(count, 1);
    const preview = join(reviewDir, "page-1.png");
    put(dir, preview.slice(dir.length + 1), Buffer.alloc(4096, 1));
    return [preview];
  };
  const { runController } = await import(new URL("controller.js", dist));
  const { prepareWorkspace } = await import(new URL("commands/prepare.js", dist));
  if (scenario === "plotting") {
    // Exercise preparation's omitted usePlotting option, not a hand-written true.
    const raw = join(dir, "raw"), template = join(dir, "kit"), workspace = join(dir, "prepared");
    put(dir, "raw/results.json", { accuracy: 81.2 });
    put(dir, "kit/main.tex", "\\documentclass{article}\n\\begin{document}\n\\end{document}");
    const prepared = await prepareWorkspace({ workspace, rawMaterials: raw, templateDir: template,
      mode: "autonomous", headless: true, researchCutoff: "2026-09", networkPolicy: "offline",
      defaultModel: null, stageModels: {}, timeoutMultiplier: 1, maxLkmCalls: 0, until: "plotting" });
    assert.equal(prepared.state.scope.use_plotting, true);
    // Use the controller fixture's locked tree for a plotting-only resumed run.
    put(dir, ".brain/input/results.json", { accuracy: 81.2 });
    const plan = OutlineSchema.parse({ ...outline(), plotting_plan: [{ figure_id: "accuracy", title: "Accuracy",
      data_source: ["source/results.json", ".brain/input/results.json"], objective: "Plot recorded values" }] });
    put(dir, ARTIFACTS.outline, plan); put(dir, ARTIFACTS.outlineV1, plan);
    const state = stateFor(dir, ["plotting"]);
    state.scope.use_plotting = prepared.state.scope.use_plotting;
    writeRunState(dir, state);
  } else if (plotting || scenario === "table-remediation") {
    put(dir, ".brain/input/results.json", { accuracy: 81.2 });
    const plan = OutlineSchema.parse({ ...outline(), plotting_plan: [{ figure_id: "accuracy", title: "Accuracy",
      data_source: ["source/results.json", ".brain/input/results.json"], objective: "Plot recorded values" }] });
    if (cache) plan.plotting_plan.push({ ...plan.plotting_plan[0], figure_id: "second" });
    if (scenario === "plotting-traversal") {
      plan.plotting_plan[0].data_source = ["source/../.brain/raw/references.bib"];
      put(dir, ARTIFACTS.references, "@article{Protected,title={Controller owned}}\n");
    }
    put(dir, ARTIFACTS.outline, plan); put(dir, ARTIFACTS.outlineV1, plan);
    if (scenario === "table-remediation") {
      put(dir, "source/references.bib", "@article{AuthorKey,title={Author supplied research},year={2024}}\n");
      stateFor(dir, ["literature", "plotting"], { bibliography_mode: "closed" });
    } else stateFor(dir, ["plotting"]);
  } else stateFor(dir);
  if (scenario === "plotting-traversal") {
    const original = readFileSync(join(dir, ARTIFACTS.references), "utf8");
    await assert.rejects(runController({ workspace: dir, headless: true, onEvent() {} }),
      /figure data must name an imported source: source\/\.\.\/\.brain\/raw\/references\.bib/);
    assert.equal(prompts.length, 0, "reject the original path before generation or review");
    assert.equal(renders.length, 0, "a renderer must never receive the normalized protected path");
    assert.equal(readFileSync(join(dir, ARTIFACTS.references), "utf8"), original);
    assert.equal(readRunState(dir).status, "failed");
    assert.equal(readRunState(dir).stages.plotting.status, "failed");
  } else if (cache) {
    await assert.rejects(runController({ workspace: dir, headless: true, onEvent() {} }),
      /fixture interruption after first reviewed figure/);
    const cached = read(dir, ARTIFACTS.plottingResults);
    assert.equal(cached.length, 1, "first figure must be persisted before the second finishes");
    const plan = read(dir, ARTIFACTS.outlineV1);
    const image = join(dir, ".brain/manuscript", cached[0].image_path);
    assert.equal(cached[0].plan_sha256, digestValue(plan.plotting_plan[0]));
    assert.equal(cached[0].image_sha256, digestFile(image));
    assert.equal(cached[0].critic_history.at(-1).passed, true);
    assert.deepEqual(read(dir, ARTIFACTS.figuresInfo), [{ name: "accuracy.pdf", caption: "Recorded accuracy." }]);
    assert.equal(readRunState(dir).stages.plotting.status, "failed");
    if (scenario === "plotting-cache-plan") {
      plan.plotting_plan[0].objective = "Show accuracy with revised presentation";
      put(dir, ARTIFACTS.outlineV1, plan);
      assert.notEqual(cached[0].plan_sha256, digestValue(plan.plotting_plan[0]));
    }
    if (scenario === "plotting-cache-image") {
      writeFileSync(image, Buffer.alloc(4096, 2));
      assert.notEqual(cached[0].image_sha256, digestFile(image));
    }
    if (scenario === "plotting-cache-feedback") {
      cached[0].image_sha256 = null;
      cached[0].critic_history.push({ origin: "manuscript_review", passed: false,
        suggestions: "Redraw the axis with readable labels" });
      put(dir, ARTIFACTS.plottingResults, cached);
    }
    interruptSecondFigure = false;
    renders.length = 0; prompts.length = 0;
    const resumed = await runController({ workspace: dir, headless: true, onEvent() {} });
    assert.equal(resumed.status, "completed");
    const matching = scenario === "plotting-cache-match";
    assert.deepEqual(renders.map((entry) => entry.figureId), matching ? ["second"] : ["accuracy", "second"]);
    assert.equal(prompts.filter((entry) => !entry.parts.some((part) => part.type === "file")).length, matching ? 1 : 2);
    assert.equal(prompts.filter((entry) => entry.parts.some((part) => part.type === "file")).length, matching ? 1 : 2);
    const results = read(dir, ARTIFACTS.plottingResults);
    assert.equal(results.length, 2);
    if (matching) assert.deepEqual(results[0], cached[0], "reuse the reviewed record without regeneration");
    assert.equal(results[0].plan_sha256, digestValue(plan.plotting_plan[0]));
    assert.equal(results[0].image_sha256, digestFile(image));
    if (scenario === "plotting-cache-feedback") {
      assert.ok(Number.isInteger(results[0].critic_history.find((entry) => entry.origin === "manuscript_review").round));
      assert.ok(prompts.some((entry) => entry.text?.includes("Redraw the axis with readable labels")));
    }
    assert.ok(validateStage(dir, "plotting", resumed.scope).every((entry) => entry.passed));
  } else if (scenario === "missing-triage") {
    await assert.rejects(runController({ workspace: dir, headless: true, onEvent() {} }), /triage.*failed validation/);
    const failed = readRunState(dir);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stages.triage.status, "failed");
    assert.equal(failed.stages.outline.status, "pending");
    assert.ok(prompts.filter((entry) => entry.stage === "triage").length > 1, "missing output must reach bounded remediation");
  } else {
    const result = await runController({ workspace: dir, headless: true, onEvent() {} });
    assert.equal(result.status, "completed");
    assert.equal(readRunState(dir).status, "completed");
    assert.equal(runResult(dir, result).submission_ready, false);
    if (scenario === "plotting" || scenario === "table-remediation") {
      assert.equal(renders.length, 1);
      const generation = prompts.find((entry) => entry.stage === "plotting");
      assert.match(generation.text, /source\/results\.json -> data\/0-results\.json/);
      assert.match(generation.text, /\.brain\/input\/results\.json -> data\/1-results\.json/);
      assert.equal(prompts.filter((entry) => entry.parts.some((part) => part.type === "file")).length, 1);
      const results = read(dir, ARTIFACTS.plottingResults);
      assert.equal(results[0].image_path, "figures/accuracy.pdf");
      assert.equal(results[0].critic_history[0].passed, true);
      assert.deepEqual(read(dir, ARTIFACTS.figuresInfo), [{ name: "accuracy.pdf", caption: "Recorded accuracy." }]);
      assert.ok(validateStage(dir, "plotting", result.scope).every((entry) => entry.passed));
      if (scenario === "table-remediation") {
        assert.deepEqual(prompts.map((entry) => entry.stage), ["literature", "literature", "plotting", "plotting"]);
        assert.equal(result.stages.literature.remediations, 1);
        assert.match(readFileSync(join(dir, ".brain/manuscript/tables/accuracy.tex"), "utf8"), /Method & 81\.2/);
        assert.equal(check(dir, "literature", "table_plan", result.scope).passed, true);
      }
    } else {
      assert.deepEqual(prompts.map((entry) => entry.stage), ["triage", "outline"]);
      assert.match(prompts[0].text, /results\.md/);
      assert.ok(existsSync(join(dir, ARTIFACTS.materialsMap)));
      assert.ok(existsSync(join(dir, ARTIFACTS.outline)));
      assert.notEqual(result.stages.triage.session_id, result.stages.outline.session_id);
    }
    assert.ok(globalThis.fixtureCheckpoints.some((entry) => entry.stage === "run" && entry.status === "completed"));
  }
  assert.equal(closed, cache ? 2 : 1, "controller must close its runtime on failure and success");
}

if (process.argv[2] === "--controller-fixture") {
  await controllerChild(process.argv[3], process.argv[4]);
} else {
  for (const [scenario, title] of [
    ["permissions", "actual controller sends usable writer permissions to SDK and completes triage/outline"],
    ["missing-triage", "universal triage cannot complete on an assistant claim without materials output"],
    ["plotting", "default plotting reaches generated route with exact collision-safe dataFiles mapping"],
    ["plotting-traversal", "original figure data_source traversal into controller bibliography is rejected before generation"],
    ["plotting-cache-match", "resume reuses persisted reviewed figure when plan_sha256 and image_sha256 match"],
    ["plotting-cache-plan", "resume regenerates reviewed figure when plan_sha256 changes"],
    ["plotting-cache-image", "resume regenerates reviewed figure when image_sha256 changes"],
    ["plotting-cache-feedback", "manuscript feedback preserves valid critic history and reaches code regeneration"],
    ["table-remediation", "literature remediates actionable numeric table_plan failure before plotting publishes tables"],
  ]) test(title, (t) => {
    const dir = fixture(t);
    // A harmless local version executable satisfies preflight/prepare without
    // starting the installed OpenCode CLI or discovering user credentials.
    for (const binary of ["opencode", "git", "pdftoppm"]) {
      put(dir, `bin/${binary}`, "#!/bin/sh\nprintf 'fixture-version\\n'\n");
      chmodSync(join(dir, "bin", binary), 0o755);
    }
    const child = spawnSync(process.execPath, [import.meta.filename, "--controller-fixture", scenario, dir], {
      cwd: dir, encoding: "utf8", timeout: 30000,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "data"), TMPDIR: dir },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `controller fixture ${scenario}:\n${child.stdout}\n${child.stderr}`);
  });

  test("seed bibliography published from cached retrieval passes actual literature provenance validation", async (t) => {
    const dir = fixture(t);
    const seed = "@article{AuthorKey,title={Author supplied research},year={2024}}\n";
    put(dir, "source/references.bib", seed);
    put(dir, ARTIFACTS.outline, outline());
    put(dir, ARTIFACTS.outlineV1, outline());
    put(dir, ARTIFACTS.updatedTemplate, "% template\n".repeat(40));
    put(dir, ".po-run/literature-cache.json", { callsMade: 1, initialCallsMade: 1, completedQueries: [], cache: {}, pending: [],
      candidates: [{ citation_key: "RetrievedKey", title: "Measured research", provider: "bohrium_lkm", provider_id: "fixture-id",
        retrieved_at: "2026-01-01", authors: ["Researcher"], venue: "", year: "2024", abstract: "Measured evidence",
        doi: "", relevance: 0.9, anchor: null, matched_queries: [] }] });
    const state = { scope: { ...scope(["literature"]), max_lkm_calls: 1 } };
    assert.equal(await retrieveForLiterature({ workspace: dir, onEvent() {} }, state), 2);
    assert.ok(readFileSync(join(dir, ARTIFACTS.references), "utf8").startsWith(seed));
    assert.deepEqual(Object.keys(read(dir, ARTIFACTS.citationMap)).sort(), ["AuthorKey", "RetrievedKey"]);
    const provenance = check(dir, "literature", "bibliography_provenance", state.scope);
    assert.equal(provenance.passed, true, provenance.detail);
    put(dir, ARTIFACTS.references, readFileSync(join(dir, ARTIFACTS.references), "utf8") + "@article{Invented,title={Not retrieved}}\n");
    assert.equal(check(dir, "literature", "bibliography_provenance", state.scope).passed, false);
  });

  test("small-input universal triage still validates missing files and fabricated quotes", async (t) => {
    const dir = fixture(t);
    rmSync(join(dir, "source/results.json"));
    put(dir, "source/results.md", "Measured accuracy: 81.2 percent.\n");
    await prepareBrainInput(dir);
    assert.equal(materialsFitWhole(dir), true);
    put(dir, ARTIFACTS.materialsMap, materials());
    assert.ok(validateStage(dir, "triage", scope()).every((entry) => entry.passed));
    const map = materials();
    map.reading[0].path = "source/invented.json";
    put(dir, ARTIFACTS.materialsMap, map);
    assert.equal(check(dir, "triage", "materials_provenance").passed, false);
    map.reading[0].path = "source/results.md";
    map.facts = [{ source_path: "source/results.md", quote: "Accuracy is 99.9", statement: "Accuracy is 99.9" }];
    put(dir, ARTIFACTS.materialsMap, map);
    assert.equal(check(dir, "triage", "materials_grounding").passed, false);
  });

  test("final validateStage includes the independent manuscript review blocker", (t) => {
    const dir = fixture(t);
    put(dir, ARTIFACTS.finalTex, "\\documentclass{article}\n\\begin{document}Results\\end{document}");
    const expected = manuscriptReadiness(dir);
    assert.equal(expected.passed, false);
    assert.deepEqual(check(dir, "refinement", expected.name), expected);
  });

  test("final validateStage includes table omission and stale provenance checks", (t) => {
    const dir = fixture(t);
    put(dir, ARTIFACTS.outlineV1, { ...outline(), table_plan: [{ table_id: "accuracy", title: "Accuracy",
      caption: "Recorded accuracy", section: "Results", columns: ["Accuracy"], source_paths: ["source/results.json"],
      rows: [{ label: "Method", values: [81.2], source_paths: ["source/results.json"] }] }] });
    assert.equal(publishTables(dir), 1);
    put(dir, ARTIFACTS.finalTex, "% \\input{tables/accuracy}\nResults omit the planned table.");
    const expected = tableCoverage(dir, ARTIFACTS.finalTex);
    assert.equal(expected.passed, false);
    assert.deepEqual(check(dir, "refinement", expected.name), expected);
    put(dir, ARTIFACTS.finalTex, "\\input{tables/accuracy}");
    assert.equal(check(dir, "refinement", expected.name).passed, true);
    put(dir, "source/results.json", { accuracy: 99 });
    assert.equal(check(dir, "refinement", expected.name).passed, false);
  });

  test("runResult distinguishes prepared and completed short plans from submission readiness", (t) => {
    const dir = fixture(t);
    const prepared = stateFor(dir);
    // Existing filenames must not turn a partial/prepared run into a submission.
    put(dir, ARTIFACTS.finalTex, "stale manuscript"); put(dir, ARTIFACTS.finalPdf, "stale PDF");
    put(dir, ".brain/manuscript/review.json", { ready: true });
    const before = runResult(dir, prepared);
    assert.equal(before.ok, true); assert.equal(before.plan_completed, false); assert.equal(before.submission_ready, false);
    assert.equal(before.next_stage, "triage");
    const completed = structuredClone(prepared);
    completed.status = "completed";
    for (const stage of completed.scope.plan) completed.stages[stage].status = "completed";
    const after = runResult(dir, completed);
    assert.equal(after.ok, true); assert.equal(after.plan_completed, true); assert.equal(after.submission_ready, false);
    assert.equal(after.next_stage, null);
    assert.equal(after.artifacts.final_pdf, join(dir, ARTIFACTS.finalPdf));
  });
}
