#!/usr/bin/env node
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "paper-orchestra-official-kits-"));
const adapters = ["cvpr2026", "iclr2026"];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
}

try {
  for (const id of adapters) {
    const directory = join(temporary, id);
    console.log(`Installing ${id} from its official checksum-pinned source...`);
    run(process.execPath, ["dist/cli.js", "templates", "install", id, directory], root);

    // `template` is a special TeX job name on some installations. The runtime
    // normally compiles a generated `manuscript.tex`, so a neutral smoke name
    // checks the same source without triggering that TeX quirk.
    copyFileSync(join(directory, "template.tex"), join(directory, "smoke.tex"));
    run("pdflatex", ["-interaction=nonstopmode", "smoke.tex"], directory);
    const aux = readFileSync(join(directory, "smoke.aux"), "utf8");
    if (aux.includes("\\bibdata")) run("bibtex", ["smoke"], directory);
    run("pdflatex", ["-interaction=nonstopmode", "smoke.tex"], directory);
    run("pdflatex", ["-interaction=nonstopmode", "smoke.tex"], directory);
    if (!existsSync(join(directory, "smoke.pdf"))) {
      throw new Error(`${id} did not produce smoke.pdf`);
    }
    console.log(`${id} compiled successfully.`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
