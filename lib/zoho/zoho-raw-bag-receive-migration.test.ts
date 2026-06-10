import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("migrations 0058/0059 zoho raw bag receives", () => {
  it("registers in drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(
      journal.entries.some((e) => e.tag === "0058_zoho_raw_bag_receive_enums"),
    ).toBe(true);
    expect(
      journal.entries.some((e) => e.tag === "0059_zoho_raw_bag_receives"),
    ).toBe(true);
  });

  it("defines reconciliation and receive status enums", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0058_zoho_raw_bag_receive_enums.sql"),
      "utf8",
    );
    expect(sql).toContain("zoho_raw_bag_receive_status");
    expect(sql).toContain("RECONCILIATION_REQUIRED");
    expect(sql).toContain("RECEIVED_BY_LUMA");
  });

  it("registers reconciliation audit migration 0060", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(
      journal.entries.some(
        (e) => e.tag === "0060_zoho_raw_bag_receive_reconciliation_audit",
      ),
    ).toBe(true);

    const sql = readFileSync(
      join(process.cwd(), "drizzle/0060_zoho_raw_bag_receive_reconciliation_audit.sql"),
      "utf8",
    );
    expect(sql).toContain("reconciled_at");
    expect(sql).toContain("reconciliation_note");
    expect(sql).toContain("zoho_raw_bag_receives_zoho_pr_unique");
  });

  it("creates durable per-bag receive table with idempotency key", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0059_zoho_raw_bag_receives.sql"),
      "utf8",
    );
    expect(sql).toContain("zoho_raw_bag_receives");
    expect(sql).toContain("inventory_bag_id");
    expect(sql).toContain("zoho_receive_idempotency_key");
    expect(sql).toContain("zoho_raw_bag_receives_bag_unique");
  });
});
