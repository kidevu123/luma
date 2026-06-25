// RECEIVING-HARDENING-v1.5.11 — behavioral contract for the existing-batch
// reuse path in createRawBagIntakeAtomic.
//
// These tests pin the structural patterns the v1.5.11 hardening relies on:
//
//   - lookup keys on (kind, batch_number) — NOT on tablet_type_id
//     (the v1.5.9 fix; re-pinned here so a regression cannot remove it)
//   - cross-product mismatch returns a user-visible friendly error
//   - quantity updates use SQL-level atomic increments against the column
//     references, NOT JS read-modify-write math
//   - new-batch INSERT branch still writes a `batch.create` audit row
//   - reuse branch writes a `batch.qty_increment` audit row (Phase C)
//   - mapIntakePersistenceError surfaces a specific message for
//     `receives_name_unique` duplicate-name races (Phase F)
//
// We follow the same source-text-contract style as
// lib/db/queries/batches.test.ts (the file that pins the v1.5.9 comment),
// because the dominant test pattern in this directory exercises the
// patterns rather than running the real transaction. That avoids spinning
// up a Postgres in CI while still failing fast on regressions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "raw-bag-intake.ts"), "utf8");

describe("RECEIVING-HARDENING-v1.5.11 · existing-batch reuse lookup", () => {
  it("looks up tablet batches by (kind, batch_number) only", () => {
    // The v1.5.9 fix removed tabletTypeId from the lookup. Re-pinned here.
    expect(src).toMatch(
      /eq\s*\(\s*batches\.kind\s*,\s*"TABLET"\s*\)\s*,\s*eq\s*\(\s*batches\.batchNumber\s*,\s*lot\s*\)/,
    );
  });

  it("explains the lookup posture in a comment", () => {
    expect(src).toMatch(/Unique index is \(kind, batch_number\)/);
  });

  it("returns a user-facing cross-product error when tablet types differ", () => {
    expect(src).toMatch(/already registered to a different tablet type/);
    // The error message must explicitly point operators at remediation.
    expect(src).toMatch(/Select the matching product/);
  });

  it("non-existent batch falls through to the insert/new-batch branch", () => {
    // The insert branch is the only place that constructs the values block
    // with a fresh statusChangedById. Keep that pattern intact.
    expect(src).toMatch(/\.insert\(batches\)\s*\.values\(/);
    expect(src).toMatch(/statusChangedById:\s*actor\.id/);
  });
});

describe("RECEIVING-HARDENING-v1.5.11 · atomic quantity increment (Phase B)", () => {
  it("imports the `sql` template helper from drizzle-orm", () => {
    expect(src).toMatch(/from\s+["']drizzle-orm["']/);
    expect(src).toMatch(/\bsql\b/);
  });

  it("qtyReceived increment is column-relative, not a JS-precomputed total", () => {
    // The unsafe pattern looked like:
    //   qtyReceived: existingBatch.qtyReceived + lotDeclared
    // Under READ COMMITTED two concurrent intakes could both read the same
    // baseline and both overwrite with stale totals. The atomic SQL form
    // increments against the live column, so concurrent updates compose.
    expect(src).toMatch(
      /qtyReceived:\s*sql`\$\{batches\.qtyReceived\}\s*\+\s*\$\{[^}]+\}`/,
    );
    expect(src).not.toMatch(/qtyReceived:\s*existingBatch\.qtyReceived\s*\+/);
  });

  it("qtyOnHand increment is column-relative, not a JS-precomputed total", () => {
    expect(src).toMatch(
      /qtyOnHand:\s*sql`\$\{batches\.qtyOnHand\}\s*\+\s*\$\{[^}]+\}`/,
    );
    expect(src).not.toMatch(/qtyOnHand:\s*existingBatch\.qtyOnHand\s*\+/);
  });

  it("the increment update still scopes to the existing batch by id", () => {
    expect(src).toMatch(/\.where\(eq\(batches\.id,\s*existingBatch\.id\)\)/);
  });
});

describe("RECEIVING-HARDENING-v1.5.11 · audit row on reuse (Phase C)", () => {
  it("writes a `batch.qty_increment` audit row on the reuse path", () => {
    expect(src).toMatch(/action:\s*"batch\.qty_increment"/);
  });

  it("the reuse-path audit targets the Batch and uses the existing batch id", () => {
    // Pin the surrounding shape so removing targetType/targetId fails this test.
    expect(src).toMatch(
      /action:\s*"batch\.qty_increment"[\s\S]*?targetType:\s*"Batch"/,
    );
    expect(src).toMatch(
      /action:\s*"batch\.qty_increment"[\s\S]*?targetId:\s*existingBatch\.id/,
    );
  });

  it("the reuse-path audit records the delta quantity added", () => {
    expect(src).toMatch(
      /action:\s*"batch\.qty_increment"[\s\S]*?deltaQuantity:\s*lotDeclared/,
    );
  });

  it("does NOT remove or rename the existing `batch.create` audit on new batches", () => {
    expect(src).toMatch(/action:\s*"batch\.create"/);
  });
});

describe("RECEIVING-HARDENING-v1.5.11 · receive-name duplicate mapping (Phase F)", () => {
  it("mapIntakePersistenceError has a specific branch for receives_name_unique", () => {
    expect(src).toMatch(/receives_name_unique/);
  });

  it("the receive-name branch yields the friendlier refresh-and-retry copy", () => {
    expect(src).toMatch(
      /Another receive was created for this PO at the same time\. Refresh and try again so Luma can assign the next receive number\./,
    );
  });

  it("does NOT remove the existing generic duplicate-record fallback", () => {
    expect(src).toMatch(/A duplicate record blocked this save\./);
  });

  it("does NOT remove the existing internal_receipt and bag_qr branches", () => {
    expect(src).toMatch(/internal_receipt/);
    expect(src).toMatch(/bag_qr/);
  });
});
