import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("migration 0057 zoho production output v1206", () => {
  it("registers in drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0057_zoho_production_output_v1206")).toBe(
      true,
    );
  });

  it("creates source allocation table and op metadata columns", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0057_zoho_production_output_v1206.sql"),
      "utf8",
    );
    expect(sql).toContain("zoho_production_output_source_allocations");
    expect(sql).toContain("product_family");
    expect(sql).toContain("zoho_receive_id");
    expect(sql).toContain("human_review_required");
  });
});
