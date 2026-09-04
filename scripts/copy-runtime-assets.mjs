#!/usr/bin/env node
/**
 * Copy the hand-written runtime files into the build output.
 *
 * `assets/` and `templates/` live under `src/` because they are source: the
 * six stage prompts and the three bundled LaTeX templates are hand-edited and
 * have no generator. But `tsc` compiles `.ts` and copies nothing else, so
 * without this step `dist/` holds code that cannot find its own prompts, and
 * the published package ships none of them.
 *
 * They land beside the compiled modules rather than above them, so
 * `assetRoot()` and `templateRoot()` resolve them next to the file asking --
 * one lookup that is right whether the package is installed globally, linked,
 * or run out of a clone.
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const name of ["assets", "templates"]) {
  const from = join(root, "src", name);
  if (!existsSync(from)) {
    console.error(`copy-runtime-assets: src/${name} is missing`);
    process.exit(1);
  }
  cpSync(from, join(root, "dist", name), { recursive: true, dereference: true });
}
