import { describe, it, expect } from "vitest";
import {
  parseRollCountInput,
  parseDecimalKgInput,
  sanitizeRollCountTyping,
  resizeRollRows,
} from "./roll-receive-input";

describe("ROLL-INTAKE-NUMBER-INPUT-FIX-1 — roll count parsing", () => {
  it("accepts 1 and 8 as valid counts", () => {
    expect(parseRollCountInput("1")).toEqual({ ok: true, value: 1 });
    expect(parseRollCountInput("8")).toEqual({ ok: true, value: 8 });
  });

  it("rejects empty count", () => {
    expect(parseRollCountInput("").ok).toBe(false);
    expect(parseRollCountInput("   ").ok).toBe(false);
  });

  it("rejects non-integer and out-of-range counts", () => {
    expect(parseRollCountInput("8.5").ok).toBe(false);
    expect(parseRollCountInput("0").ok).toBe(false);
    expect(parseRollCountInput("51").ok).toBe(false);
  });

  it("sanitizeRollCountTyping strips non-digits and allows empty", () => {
    expect(sanitizeRollCountTyping("18x")).toBe("18");
    expect(sanitizeRollCountTyping("")).toBe("");
  });

  it("resizeRollRows grows from 1 to 8 without append-to-1 behavior", () => {
    const rows = resizeRollRows([{ id: 1 }], 8, () => ({ id: 0 }));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ id: 1 });
  });
});

describe("ROLL-INTAKE-NUMBER-INPUT-FIX-1 — decimal kg parsing", () => {
  it("accepts common kg decimals", () => {
    expect(parseDecimalKgInput("5.2")).toEqual({ ok: true, value: 5.2 });
    expect(parseDecimalKgInput("8.75")).toEqual({ ok: true, value: 8.75 });
    expect(parseDecimalKgInput("0.35")).toEqual({ ok: true, value: 0.35 });
  });

  it("rejects empty and non-positive weights", () => {
    expect(parseDecimalKgInput("").ok).toBe(false);
    expect(parseDecimalKgInput("0").ok).toBe(false);
    expect(parseDecimalKgInput("-1").ok).toBe(false);
  });
});
