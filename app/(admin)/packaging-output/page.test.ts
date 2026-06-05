// Production output queue — receipt display wiring.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const pageSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "page.tsx"),
  "utf8",
);

describe("packaging-output page receipt wiring", () => {
  it("COALESCEs inventory internal receipt over legacy workflow denorm", () => {
    expect(pageSrc).toMatch(
      /COALESCE\(\$\{inventoryBags\.internalReceiptNumber\},\s*\$\{workflowBags\.receiptNumber\}\)/,
    );
    expect(pageSrc).toMatch(
      /leftJoin\(inventoryBags,\s*eq\(inventoryBags\.id,\s*workflowBags\.inventoryBagId\)\)/,
    );
  });

  it("labels finalized bags without lots as admin review exceptions", () => {
    expect(pageSrc).toContain(
      "Full-bag packaging normally creates and releases the finished lot automatically.",
    );
    expect(pageSrc).toContain("Finalized — needs lot review");
    expect(pageSrc).toContain("Review / issue lot");
  });
});
