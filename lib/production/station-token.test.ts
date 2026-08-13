import { describe, it, expect } from "vitest";
import { isStationTokenShape } from "./station-token";

describe("isStationTokenShape", () => {
  it("accepts a v4-shaped uuid in any case", () => {
    expect(isStationTokenShape("a3f1c2d4-5b6e-4f7a-8b9c-0d1e2f3a4b5c")).toBe(true);
    expect(isStationTokenShape("A3F1C2D4-5B6E-4F7A-8B9C-0D1E2F3A4B5C")).toBe(true);
  });
  it("rejects junk, near-misses, and injection shapes", () => {
    for (const bad of ["", "not-a-token", "a3f1c2d4-5b6e-4f7a-8b9c", "a3f1c2d45b6e4f7a8b9c0d1e2f3a4b5c", "'; DROP TABLE stations; --"]) {
      expect(isStationTokenShape(bad)).toBe(false);
    }
  });
});
