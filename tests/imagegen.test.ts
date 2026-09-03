import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateTextImage,
  IMAGE_ADAPTER_ENV,
  textToImageCapability,
} from "../src/imagegen.js";
import { scratchDir } from "./fixtures.js";

function adapterScript(dir: string): string {
  const path = join(dir, "image-adapter.mjs");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const request = JSON.parse(input);",
      "const output = path.join(request.output_dir, 'generated.png');",
      "fs.writeFileSync(output, Buffer.alloc(4096, 1));",
      "process.stdout.write(JSON.stringify({provider:'fixture',model:'image-v1',output_path:output,parameters:{seed:7}}));",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

describe("text-to-image provider adapter", () => {
  it("reports actionable setup when no adapter is configured", () => {
    const capability = textToImageCapability({});
    expect(capability.ok).toBe(false);
    expect(capability.detail).toContain(IMAGE_ADAPTER_ENV);
  });

  it("records provider, model, prompt, parameters, and output", async () => {
    const dir = scratchDir("po-image-adapter-");
    const adapter = adapterScript(dir);
    const result = await generateTextImage(
      {
        figureId: "architecture",
        prompt: "A precise scientific architecture diagram",
        aspectRatio: "16:9",
        workDir: join(dir, "output"),
      },
      { ...process.env, [IMAGE_ADAPTER_ENV]: adapter },
    );
    expect(result.bytes).toBe(4096);
    expect(result.imagePath).toMatch(/generated\.png$/);
    expect(result.provenance).toMatchObject({
      provider: "fixture",
      model: "image-v1",
      prompt: "A precise scientific architecture diagram",
      parameters: { seed: 7 },
    });
  });
});
