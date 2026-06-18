// PARTIAL-UNIQUE-LUMA-OP-v1.4.10 — source-level contract tests for
// the migration 0067 swap that replaces the global UNIQUE index on
// zoho_production_output_ops.luma_operation_id with a partial unique
// index scoped to non-voided rows.
//
// Pattern mirrors lib/zoho/overs-resolution-contract.test.ts — assert
// migration SQL shape, journal registration, schema mirror, and the
// upsert lookup contract directly against source so the partial-
// uniqueness contract can't drift without a test failing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const RAW_SQL = read(
  "drizzle/0067_zoho_prod_output_ops_partial_unique_luma_op.sql",
);
// Strip `-- …` line comments so prose in the header ("no DROP TABLE",
// "no DELETE FROM", "doesn't UPDATE …") doesn't fool the destructive-
// statement guards below. We only want to scan executable SQL.
const SQL = RAW_SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const JOURNAL = JSON.parse(read("drizzle/meta/_journal.json")) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const SCHEMA = read("lib/db/schema.ts");
const UPSERT_QUERIES = read("lib/db/queries/zoho-production-output.ts");

describe("migration 0067 — partial unique on luma_operation_id (shape)", () => {
  it("drops the prior global unique index by name", () => {
    expect(SQL).toMatch(
      /DROP INDEX IF EXISTS\s+"zoho_prod_output_ops_luma_op_unique"/,
    );
  });

  it("recreates the index as PARTIAL UNIQUE on luma_operation_id WHERE voided_at IS NULL", () => {
    // CREATE UNIQUE INDEX … ON zoho_production_output_ops (luma_operation_id) WHERE voided_at IS NULL
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+"zoho_prod_output_ops_luma_op_unique"[\s\S]*ON\s+"zoho_production_output_ops"\s*\(\s*"luma_operation_id"\s*\)[\s\S]*WHERE\s+"voided_at"\s+IS\s+NULL/,
    );
  });

  it("preserves the same index name so the schema-mirror reference is unchanged", () => {
    // Both the DROP and the CREATE refer to the same identifier.
    const matches = SQL.match(/zoho_prod_output_ops_luma_op_unique/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT drop tables, drop columns, rename, or truncate", () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bRENAME\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("does NOT delete or modify any data rows", () => {
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bUPDATE\s+"?zoho_production_output_ops"?\b/i);
  });
});

describe("migration 0067 — journal registration", () => {
  it("registers idx=66, tag=0067_zoho_prod_output_ops_partial_unique_luma_op", () => {
    const last = JOURNAL.entries[JOURNAL.entries.length - 1];
    expect(last).toBeTruthy();
    expect(last?.idx).toBe(66);
    expect(last?.tag).toBe(
      "0067_zoho_prod_output_ops_partial_unique_luma_op",
    );
  });

  it("uses a strictly-greater 'when' than the previous entry", () => {
    const n = JOURNAL.entries.length;
    expect(n).toBeGreaterThanOrEqual(2);
    const last = JOURNAL.entries[n - 1]!;
    const prev = JOURNAL.entries[n - 2]!;
    expect(last.when).toBeGreaterThan(prev.when);
  });
});

describe("schema mirror — uniqueIndex predicate", () => {
  it("zoho_prod_output_ops_luma_op_unique carries a WHERE voided_at IS NULL predicate", () => {
    // The mirror declaration sits inside the zoho_production_output_ops
    // pgTable. Scan the lumaOperationId uniqueIndex line range.
    expect(SCHEMA).toMatch(
      /uniqueIndex\(\s*"zoho_prod_output_ops_luma_op_unique"\s*\)[\s\S]{0,200}\.on\(\s*t\.lumaOperationId\s*\)[\s\S]{0,200}\.where\(\s*sql`voided_at IS NULL`\s*\)/,
    );
  });
});

describe("upsert lookup — still targets active rows only", () => {
  // The whole point of the partial index is so the existing upsert
  // (which already filters by isNull(voidedAt)) can INSERT new active
  // rows even when an old voided row carries the same luma_operation_id.
  // The upsert MUST NOT widen its lookup, otherwise it would attempt
  // to "revive" the voided row instead — which would silently lose
  // audit history. Pin the contract.
  it("upsertZohoProductionOutputPreviewOp filters by isNull(voidedAt)", () => {
    expect(UPSERT_QUERIES).toMatch(/upsertZohoProductionOutputPreviewOp/);
    // Find the function block and assert it contains an isNull(voidedAt)
    // filter — the precise existence-check we rely on.
    const fnStart = UPSERT_QUERIES.indexOf(
      "export async function upsertZohoProductionOutputPreviewOp",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = UPSERT_QUERIES.slice(fnStart, fnStart + 4000);
    expect(fnSlice).toMatch(/isNull\(\s*zohoProductionOutputOps\.voidedAt\s*\)/);
  });

  it("upsert function makes NO use of a retry-suffixed luma_operation_id (no fallback in app code)", () => {
    // The fix lives in the DB constraint, not in app-level ID rotation.
    expect(UPSERT_QUERIES).not.toMatch(/:retry[-:]/);
    expect(UPSERT_QUERIES).not.toMatch(/retry-\$\{/);
  });
});
