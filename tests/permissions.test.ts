import { describe, expect, it } from "vitest";
import { permissionsFor } from "../src/permissions.js";

describe("permission posture", () => {
  it("denies everything mechanical, because the controller owns that work", () => {
    const posture = permissionsFor("autonomous");
    expect(posture.bash).toBe("deny");
    expect(posture.webfetch).toBe("deny");
    expect(posture.websearch).toBe("deny");
    expect(posture.external_directory).toBe("deny");
  });

  it("allows reading inputs and writing artifacts", () => {
    const posture = permissionsFor("autonomous");
    expect(posture.read).toBe("allow");
    expect(posture.edit).toBe("allow");
  });

  it("denies delegation, whose children can strand a headless parent", () => {
    expect(permissionsFor("autonomous").task).toBe("deny");
  });

  it("denies questions in autonomous mode and allows them collaboratively", () => {
    expect(permissionsFor("autonomous").question).toBe("deny");
    expect(permissionsFor("collaborative").question).toBe("allow");
  });

  it("never leaves a permission set to ask", () => {
    // An `ask` is indistinguishable from a hang in a headless run: the session
    // stays busy until the stage budget expires, and the resulting error blames
    // the timeout rather than the prompt. This is exactly how a literature
    // stage burned its full 30 minutes fifty seconds after finishing its work.
    for (const mode of ["autonomous", "collaborative"] as const) {
      for (const [key, value] of Object.entries(permissionsFor(mode))) {
        expect(value, `${mode}/${key}`).not.toBe("ask");
      }
    }
  });

  it("enumerates every permission key the schema defines", () => {
    // An unset key falls back to OpenCode's default, and for several of them
    // that default is `ask`.
    const posture = permissionsFor("autonomous");
    for (const key of [
      "read", "edit", "glob", "grep", "list", "bash", "task",
      "external_directory", "todowrite", "question", "webfetch", "websearch",
      "lsp", "doom_loop", "skill",
    ]) {
      expect(posture, key).toHaveProperty(key);
    }
  });
});
