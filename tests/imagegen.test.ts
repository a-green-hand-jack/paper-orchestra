import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

function codexScript(dir: string): string {
  const path = join(dir, "codex");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }",
      "if (args[0] === 'features' && args[1] === 'list') { console.log('image_generation stable true'); process.exit(0); }",
      "if (args[0] !== 'exec') process.exit(2);",
      "const threadId = 'fake-thread';",
      "const outputDir = path.join(process.env.CODEX_HOME, 'generated_images', threadId);",
      "fs.mkdirSync(outputDir, {recursive:true});",
      "fs.writeFileSync(path.join(outputDir, 'generated.png'), Buffer.alloc(4096, 1));",
      "fs.writeFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify(args));",
      "console.log(JSON.stringify({type:'thread.started',thread_id:threadId}));",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({generated_image_path:path.join(outputDir, 'generated.png')})}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

describe("text-to-image provider adapter", () => {
  it("reports actionable setup when neither Codex nor an adapter is configured", async () => {
    const capability = await textToImageCapability({ PATH: "" });
    expect(capability.ok).toBe(false);
    expect(capability.detail).toContain(IMAGE_ADAPTER_ENV);
  });

  it("uses ChatGPT OAuth Codex image generation by default", async () => {
    const dir = scratchDir("po-codex-image-");
    codexScript(dir);
    const codexHome = join(dir, "codex-home");
    const log = join(dir, "codex-args.json");
    const result = await generateTextImage(
      {
        figureId: "architecture",
        prompt: "A precise scientific architecture diagram",
        aspectRatio: "16:9",
        workDir: join(dir, "output"),
      },
      {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        CODEX_HOME: codexHome,
        CODEX_FAKE_LOG: log,
      },
    );

    expect(result.bytes).toBe(4096);
    expect(result.imagePath).toMatch(/generated\.png$/);
    expect(result.provenance).toMatchObject({
      provider: "openai-codex-oauth",
      model: "gpt-image-2",
      prompt: "A precise scientific architecture diagram",
      parameters: {
        aspect_ratio: "16:9",
        auth: "chatgpt_oauth",
        image_generation: "built_in",
      },
    });
    const args = JSON.parse(readFileSync(log, "utf8")) as string[];
    expect(args).toContain("read-only");
    expect(args).toContain("image_generation");
    expect(args.at(-1)).toContain("A precise scientific architecture diagram");
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
