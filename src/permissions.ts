/**
 * The permission posture for a run.
 *
 * This lives in one place and is passed DIRECTLY to `createOpencodeServer`,
 * because a workspace `opencode.json` is not enough: OpenCode resolves project
 * config from the server process's own working directory, not from the
 * per-request `directory`. On a real run that meant every permission here was
 * silently ignored, the effective `external_directory` rule stayed at the
 * default `ask`, and a headless literature stage hung on an unanswerable
 * prompt until its 30-minute budget expired -- 50 seconds after the model had
 * finished writing every artifact correctly.
 *
 * Every key in the schema is enumerated on purpose. An unset key falls back to
 * OpenCode's default, and for several of them that default is `ask`, which is
 * indistinguishable from a hang in headless mode.
 */
export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionPosture {
  readonly [key: string]: PermissionAction | Record<string, PermissionAction>;
}

export function permissionsFor(mode: "autonomous" | "collaborative"): PermissionPosture {
  return {
    // The agent reads inputs and writes artifacts. `edit` covers write and
    // patch; there are no separate keys for those.
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: {
      "*": "allow",
      "source/**": "deny",
      ".brain/input/**": "deny",
      ".brain/input*.json": "deny",
      ".brain/raw/references.bib": "deny",
      ".brain/raw/candidates.json": "deny",
      ".brain/raw/citation_map.json": "deny",
      ".brain/raw/query_plan.json": "deny",
      ".brain/raw/build.json": "deny",
      ".brain/raw/data_analysis.json": "deny",
      ".brain/raw/plotting_results.json": "deny",
      ".brain/manuscript/figures/**": "deny",
      ".brain/manuscript/review.json": "deny",
      ".brain/manuscript/tables/**": "deny",
      ".po-run/**": "deny",
      "submission/**": "deny",
    },
    todowrite: "allow",

    // Everything mechanical belongs to the controller: LaTeX compilation,
    // figure scripts and literature retrieval. Denying them is what makes a
    // stage's completion a fact about the filesystem rather than a claim.
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",

    // The workspace is the whole world for a stage. Reaching outside it would
    // escape the digest-locked inputs.
    external_directory: "deny",

    // Delegation would spawn a child whose own permission prompts can strand a
    // headless parent, and the plan is fixed by the controller anyway.
    task: "deny",

    // A question in autonomous mode has nobody to answer it. Collaborative
    // runs pause at gates instead, which is where a human is expected.
    question: mode === "collaborative" ? "allow" : "deny",

    lsp: "deny",
    skill: "deny",
    doom_loop: "deny",
  };
}
