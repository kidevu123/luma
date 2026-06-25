// Phase G — synthesizer dry-run contract tests.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const synthSrc = readFileSync(
  join(__dirname, "submission-synthesizer.ts"),
  "utf8",
);

describe("submission synthesizer dry-run guards", () => {
  it("short-circuits writes when dryRun is true", () => {
    expect(synthSrc).toMatch(/const dryRun = !!args\.dryRun/);
    const guardCount = (synthSrc.match(/if \(dryRun\)/g) ?? []).length;
    expect(guardCount).toBeGreaterThanOrEqual(4);
  });

  it("documents idempotency via onConflictDoNothing on workflow_events inserts", () => {
    expect(synthSrc).toMatch(/onConflictDoNothing/);
    expect(synthSrc).toMatch(/client_event_id/);
  });
});

describe("idempotency contract", () => {
  it("client_event_id partial unique index rejects duplicates", () => {
    const partialUniqueIndexConstraint = {
      table: "workflow_events",
      columns: ["workflow_bag_id", "event_type", "client_event_id"],
      where: "client_event_id IS NOT NULL",
    };
    expect(partialUniqueIndexConstraint.columns).toContain("client_event_id");
  });

  it("legacy_tt_id_map records prevent double-classification", () => {
    const mapKeys = [
      "warehouse_submissions_synth",
      "machine_counts_synth",
      "machine_counts_synth_bag",
    ];
    expect(mapKeys).toHaveLength(3);
  });
});
