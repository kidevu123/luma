// Regression guard for digest 3511293824 — the Traceability lookup (/recall)
// server render must not crash when a search matches raw bags but no finished
// lot. Structural, since the page is a server component that pulls @/lib/db
// (no Postgres harness in the default vitest run).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(
  join(process.cwd(), "app/(admin)/recall/page.tsx"),
  "utf8",
);

describe("recall page — no unguarded finished-lot access", () => {
  it("never dereferences finishedLots[0]!.id (the crash)", () => {
    expect(pageSrc).not.toMatch(/finishedLots\[0\]!\.id/);
    expect(pageSrc).not.toMatch(/finishedLots\[0\]!/);
  });

  it("derives the export-bar lot id through the null-safe helper", () => {
    expect(pageSrc).toMatch(/firstFinishedLotId/);
    expect(pageSrc).toMatch(/firstLotId=\{passport \? firstFinishedLotId\(passport\) : null\}/);
  });

  it("ExportBar accepts a nullable lot id and hides the labels link when absent", () => {
    expect(pageSrc).toMatch(/firstLotId: string \| null/);
    expect(pageSrc).toMatch(/firstLotId \? \(/);
  });

  it("keeps CSV export available even without a finished lot (raw-bag-only match)", () => {
    // The CSV export links are unconditional; only the labels link is gated.
    expect(pageSrc).toMatch(/Export CSV \(customer-safe\)/);
    expect(pageSrc).toMatch(/Print labels \(first matched lot\)/);
  });
});
