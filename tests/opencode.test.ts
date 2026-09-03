import { describe, expect, it } from "vitest";
import { tuiAttachArgs } from "../src/opencode.js";

describe("native TUI attachment", () => {
  it("attaches the native OpenCode TUI to the controller server and workspace", () => {
    expect(tuiAttachArgs({ serverUrl: "http://127.0.0.1:4321" }, "/runs/paper")).toEqual([
      "attach",
      "http://127.0.0.1:4321",
      "--dir",
      "/runs/paper",
    ]);
  });
});
