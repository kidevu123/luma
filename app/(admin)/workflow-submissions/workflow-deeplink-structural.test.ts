// SIMPLIFY-A — "Finalize workflow" from closeout must land ON the bag, not an
// unfiltered 85-row list. Structural (DB paths need Postgres).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pageSrc = repo("app/(admin)/workflow-submissions/page.tsx");
const tableSrc = repo("app/(admin)/workflow-submissions/workflow-table.tsx");
const rowsSrc = repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx");

describe("workflow deep-link (?bag=)", () => {
  it("page parses ?bag= and filters by inventoryBags.id", () => {
    expect(pageSrc).toMatch(/sp\["bag"\]/);
    expect(pageSrc).toMatch(/eq\(inventoryBags\.id,/);
  });
  it("table auto-expands the deep-linked bag row", () => {
    expect(tableSrc).toMatch(/autoExpandBagId/);
  });
  it("closeout rows deep-link workflows by bag and lot issuance by bagId", () => {
    expect(rowsSrc).toMatch(/\/workflow-submissions\?bag=/);
    expect(rowsSrc).toMatch(/\/finished-lots\/new\?bagId=/);
    expect(rowsSrc).not.toMatch(/href: "\/workflow-submissions", label: "Open workflows"/);
  });
});
