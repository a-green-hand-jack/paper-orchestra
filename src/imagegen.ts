import { execa } from "execa";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { UserFacingError } from "./errors.js";
import { MIN_FIGURE_BYTES } from "./figures.js";

export const IMAGE_ADAPTER_ENV = "PAPER_ORCHESTRA_IMAGE_ADAPTER";
const IMAGE_TIMEOUT_MS = 300_000;
const SUPPORTED_OUTPUTS = new Set([".png", ".jpg", ".jpeg", ".pdf"]);

export interface TextToImageRequest {
  readonly figureId: string;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly workDir: string;
}

export interface TextToImageResult {
  readonly imagePath: string;
  readonly bytes: number;
  readonly provenance: {
    readonly provider: string;
    readonly model: string;
    readonly prompt: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function textToImageCapability(
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; detail: string } {
  const adapter = env[IMAGE_ADAPTER_ENV]?.trim();
  return adapter
    ? { ok: true, detail: `image adapter ${adapter}` }
    : {
        ok: false,
        detail:
          `text-to-image was selected but ${IMAGE_ADAPTER_ENV} is not set. ` +
          "Set it to an executable adapter that accepts one JSON request on stdin and returns " +
          "provider, model, output_path, and optional parameters as JSON.",
      };
}

/**
 * Invoke an explicit provider adapter instead of baking one vendor's API into
 * the writing runtime. The JSON boundary is intentionally small so a local
 * script, hosted image service, or another agent can all implement it.
 */
export async function generateTextImage(
  request: TextToImageRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextToImageResult> {
  const capability = textToImageCapability(env);
  if (!capability.ok) throw new UserFacingError(capability.detail);
  const adapter = env[IMAGE_ADAPTER_ENV] as string;

  rmSync(request.workDir, { recursive: true, force: true });
  mkdirSync(request.workDir, { recursive: true });

  const payload = {
    version: 1,
    figure_id: request.figureId,
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    output_dir: request.workDir,
  };
  const result = await execa(adapter, [], {
    cwd: request.workDir,
    env,
    input: JSON.stringify(payload),
    timeout: IMAGE_TIMEOUT_MS,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new UserFacingError(
      `image adapter exited ${result.exitCode}: ${(result.stderr || "no error output").slice(-600)}`,
    );
  }

  let response: Record<string, unknown>;
  try {
    response = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new UserFacingError("image adapter returned invalid JSON");
  }
  const provider = typeof response.provider === "string" ? response.provider.trim() : "";
  const model = typeof response.model === "string" ? response.model.trim() : "";
  const outputPath = typeof response.output_path === "string" ? response.output_path.trim() : "";
  if (!provider || !model || !outputPath) {
    throw new UserFacingError(
      "image adapter response must contain non-empty provider, model, and output_path strings",
    );
  }

  const imagePath = resolve(request.workDir, outputPath);
  const rel = relative(request.workDir, imagePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UserFacingError("image adapter output_path must remain inside its requested output_dir");
  }
  if (!SUPPORTED_OUTPUTS.has(extname(imagePath).toLowerCase())) {
    throw new UserFacingError("image adapter output must be PNG, JPEG, or PDF");
  }
  if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
    throw new UserFacingError(`image adapter reported ${outputPath}, but that file does not exist`);
  }
  const bytes = statSync(imagePath).size;
  if (bytes < MIN_FIGURE_BYTES) {
    throw new UserFacingError(`image adapter output is only ${bytes} bytes and appears blank or truncated`);
  }

  return {
    imagePath,
    bytes,
    provenance: {
      provider,
      model,
      prompt: request.prompt,
      parameters:
        response.parameters && typeof response.parameters === "object"
          ? (response.parameters as Record<string, unknown>)
          : { aspect_ratio: request.aspectRatio },
    },
  };
}
