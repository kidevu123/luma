import { describe, it, expect } from "vitest";
import { z } from "zod";
import { formatZodError } from "./format-zod-error";

describe("SIMPLIFY-B: formatZodError", () => {
  const schema = z.object({ repairStartingBalanceQty: z.coerce.number().int().nonnegative() });

  it("prefixes the field label", () => {
    const r = schema.safeParse({ repairStartingBalanceQty: -1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodError(r.error, { repairStartingBalanceQty: "Starting balance" });
      expect(msg.startsWith("Starting balance: ")).toBe(true);
    }
  });

  it("falls back to the raw path when unlabeled, and to a generic message with no issues", () => {
    const r = schema.safeParse({ repairStartingBalanceQty: -1 });
    if (!r.success) {
      expect(formatZodError(r.error)).toMatch(/^repairStartingBalanceQty: /);
    }
    expect(formatZodError(new z.ZodError([]))).toBe("Invalid input.");
  });

  it("zero passes the nonnegative schema (the 6337-46 case)", () => {
    expect(schema.safeParse({ repairStartingBalanceQty: 0 }).success).toBe(true);
  });
});
