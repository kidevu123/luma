import { describe, it, expect } from "vitest";
import { pickLatestPerTarget } from "./audit-log";

describe("SIMPLIFY-B: pickLatestPerTarget", () => {
  it("keeps only the newest row per targetId", () => {
    const rows = [
      { targetId: "a", createdAt: new Date("2026-01-01"), v: 1 },
      { targetId: "a", createdAt: new Date("2026-02-01"), v: 2 },
      { targetId: "b", createdAt: new Date("2026-01-15"), v: 3 },
    ];
    const m = pickLatestPerTarget(rows);
    expect(m.get("a")?.v).toBe(2);
    expect(m.get("b")?.v).toBe(3);
    expect(m.size).toBe(2);
  });
  it("ignores null targetIds and handles empty input", () => {
    expect(pickLatestPerTarget([]).size).toBe(0);
    expect(pickLatestPerTarget([{ targetId: null, createdAt: new Date(), v: 1 }]).size).toBe(0);
  });
});
