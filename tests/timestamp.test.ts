import { describe, expect, it } from "vitest";
import { compactStamp } from "../src/timestamp.js";

describe("compactStamp", () => {
  it("is fourteen digits with no separators", () => {
    const stamp = compactStamp(new Date("2026-09-02T08:02:53.123Z"));
    expect(stamp).toBe("20260902080253");
  });

  it("never leaks the millisecond separator into a run id", () => {
    // Slicing the ISO string at offset 15 used to land inside the fraction and
    // leave a trailing "." in run ids and workspace directory names.
    for (const ms of [0, 5, 50, 999]) {
      const stamp = compactStamp(new Date(Date.UTC(2026, 8, 2, 8, 2, 53, ms)));
      expect(stamp).toMatch(/^\d{14}$/);
    }
  });
});
