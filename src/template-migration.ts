import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserFacingError } from "./errors.js";
import { paths } from "./paths.js";
import { computeLockDigests, updateRunState } from "./state/store.js";
import type { RunState } from "./state/schema.js";

const BUNDLED_TEMPLATE_IDS = new Set([
  "annals-mathematics",
  "physical-review-letters",
  "nature-portfolio",
  "iclr2025",
  "iclr2026",
]);

/**
 * Repair workspaces prepared before the bundled template entrypoint was
 * preserved by the importer.  This is deliberately narrow: it only adds a
 * missing conventional entrypoint for a known bundled policy template, records
 * the digest transition, and never overwrites an existing user/template file.
 */
export function repairBundledTemplateEntrypoint(workspace: string, state: RunState): RunState {
  const templateId = state.scope.template_id;
  if (!templateId || !BUNDLED_TEMPLATE_IDS.has(templateId)) return state;
  const destination = join(paths(workspace).template, "template.tex");
  if (existsSync(destination)) return state;

  const bundledId = templateId === "iclr2026" ? "iclr2025" : templateId;
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const source = join(packageRoot, "templates", bundledId, "template.tex");
  if (!existsSync(source) || realpathSync(source) !== source) {
    throw new UserFacingError(`cannot repair missing bundled template entrypoint for ${templateId}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o444);

  const before = state.template_digest;
  const after = computeLockDigests(workspace).templateDigest;
  const audit = join(paths(workspace).runDir, "template-migration.json");
  writeFileSync(audit, JSON.stringify({
    schema_version: 1,
    kind: "bundled-template-entrypoint-repair",
    run_id: state.run_id,
    template_id: templateId,
    source: `templates/${bundledId}/template.tex`,
    destination: "template/template.tex",
    old_template_digest: before,
    new_template_digest: after,
    reason: "legacy prepared workspace omitted the selected bundled template entrypoint",
    migrated_at: new Date().toISOString(),
  }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  return updateRunState(workspace, (current) => ({ ...current, template_digest: after }));
}
