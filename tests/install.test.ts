import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./fixtures.js";

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

describe("local installer", () => {
  it("returns success after a direct working-copy install", async () => {
    const cwd = scratchDir("po-install-");
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    writeFileSync(join(cwd, "package.json"), '{"name":"paper-orchestra"}\n', "utf8");
    executable(join(bin, "node"), 'if [ "$1" = "-p" ]; then echo 20; else exit 0; fi');
    executable(join(bin, "npm"), "exit 0");
    executable(join(bin, "paper-orchestra"), 'echo "2.0.0"');

    const result = await execa("bash", [join(process.cwd(), "scripts", "install.sh")], {
      cwd,
      env: { ...process.env, PATH: `${bin}:/bin:/usr/bin` },
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Installed 2.0.0");
  });
});
