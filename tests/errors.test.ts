import { describe, expect, it } from "vitest";
import { UserFacingError, ValidationFailedError } from "../src/errors.js";
import { UnsafePathError } from "../src/files.js";
import { StateError } from "../src/state/store.js";

describe("error taxonomy", () => {
  it("treats a refused resume as user-facing, not a crash", () => {
    // Regression: StateError used to escape the CLI's handler and print a raw
    // stack trace for the entirely expected "source/ changed" outcome.
    expect(new StateError("refusing to resume")).toBeInstanceOf(UserFacingError);
  });

  it("treats an unsafe import path as user-facing", () => {
    // A symlink in supplied material is an operator decision, not a bug.
    expect(new UnsafePathError("refusing symlink")).toBeInstanceOf(UserFacingError);
  });

  it("exits 1 by default and 2 for validation failure", () => {
    expect(new UserFacingError("x").exitCode).toBe(1);
    expect(new ValidationFailedError("x").exitCode).toBe(2);
  });

  it("keeps its name for log grepping", () => {
    expect(new StateError("x").name).toBe("StateError");
    expect(new UnsafePathError("x").name).toBe("UnsafePathError");
  });
});
