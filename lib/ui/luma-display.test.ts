import { describe, expect, it } from "vitest";
import {
  formatBlistersPerKg,
  formatDateTimeEst,
  formatKgPerCycle,
  formatWeightKg,
  LUMA_TIMEZONE,
  toDateInputValue,
} from "./luma-display";

describe("luma-display", () => {
  it("uses America/New_York timezone", () => {
    expect(LUMA_TIMEZONE).toBe("America/New_York");
  });

  it("formatDateTimeEst includes timezone abbreviation", () => {
    const s = formatDateTimeEst("2026-06-05T17:20:13.000Z");
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/EST|EDT/);
  });

  it("formatWeightKg shows kg not grams", () => {
    expect(formatWeightKg(8080)).toBe("8.08 kg");
    expect(formatWeightKg(null)).toBe("—");
  });

  it("formatKgPerCycle converts grams to kg", () => {
    expect(formatKgPerCycle(2.4816)).toBe("0.002482 kg/cycle");
    expect(formatKgPerCycle(625)).toBe("0.6250 kg/cycle");
  });

  it("formatBlistersPerKg", () => {
    expect(formatBlistersPerKg(0.625)).toBe("1600.0 blisters/kg");
  });

  it("toDateInputValue accepts Date objects for date inputs", () => {
    expect(toDateInputValue(new Date("2026-06-04T20:12:00.000Z"))).toMatch(
      /^2026-06-0[34]$/,
    );
    expect(toDateInputValue("2026-06-04T20:12:00.000Z")).toBe("2026-06-04");
    expect(toDateInputValue(null)).toBeNull();
  });
});
