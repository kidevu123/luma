import { describe, it, expect } from "vitest";
import { formatFloorTimeEastern, formatElapsedSeconds } from "./floor-time";

describe("formatFloorTimeEastern", () => {
  it("renders UTC midnight as 7:00 PM Eastern (winter, UTC-5)", () => {
    // 2026-01-15 00:00 UTC = 2026-01-14 19:00 EST (UTC-5)
    const d = new Date("2026-01-15T00:00:00.000Z");
    expect(formatFloorTimeEastern(d)).toBe("7:00 PM");
  });

  it("renders UTC 11:00 as 7:00 AM Eastern (summer, UTC-4)", () => {
    // 2026-07-15 11:00 UTC = 2026-07-15 07:00 EDT (UTC-4)
    const d = new Date("2026-07-15T11:00:00.000Z");
    expect(formatFloorTimeEastern(d)).toBe("7:00 AM");
  });

  it("accepts ISO string input as well as Date", () => {
    const result = formatFloorTimeEastern("2026-01-15T00:00:00.000Z");
    expect(result).toBe("7:00 PM");
  });

  it("pads minutes with two digits", () => {
    // 2026-01-15 20:05 UTC = 3:05 PM EST
    const d = new Date("2026-01-15T20:05:00.000Z");
    expect(formatFloorTimeEastern(d)).toMatch(/3:05 PM/);
  });
});

describe("formatElapsedSeconds", () => {
  it("returns '0s' for zero input", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
  });

  it("returns seconds only for sub-minute values", () => {
    expect(formatElapsedSeconds(45)).toBe("45s");
  });

  it("returns 'm:ss' for values under an hour", () => {
    expect(formatElapsedSeconds(90)).toBe("1m 30s");
  });

  it("pads seconds to two digits in minute display", () => {
    expect(formatElapsedSeconds(65)).toBe("1m 05s");
  });

  it("returns 'h m ss' for values of an hour or more", () => {
    expect(formatElapsedSeconds(3661)).toBe("1h 1m 01s");
  });

  it("clamps negative inputs to 0s", () => {
    expect(formatElapsedSeconds(-10)).toBe("0s");
  });

  it("floors fractional seconds", () => {
    expect(formatElapsedSeconds(59.9)).toBe("59s");
  });

  it("handles exactly 3600 as 1h 0m 00s", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h 0m 00s");
  });

  it("handles exactly 60 as 1m 00s", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 00s");
  });

  it("handles large values (8 hours)", () => {
    expect(formatElapsedSeconds(8 * 3600)).toBe("8h 0m 00s");
  });
});
