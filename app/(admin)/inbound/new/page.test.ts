// REGRESSION-1 — New Receive PO dropdown must only show tablet POs.
//
// History: commit 2136cf0 added status filtering but lost the is_tablet_po
// gate, causing all POs to appear in the dropdown. These tests guard against
// that regression recurring.
//
// We read page.tsx / receive-wizard.tsx as source text rather than executing
// them so we don't need a React/JSX transform in the vitest node environment.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RECEIVABLE_PO_STATUSES } from "@/lib/production/raw-bag-intake";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "page.tsx"), "utf8");
const wizardSrc = readFileSync(resolve(here, "receive-wizard.tsx"), "utf8");

describe("REGRESSION-1 · new-receive PO filter", () => {
  it("applies isTabletPo filter — non-tablet POs must be excluded", () => {
    expect(src).toMatch(/isTabletPo/);
  });

  it("uses eq(purchaseOrders.isTabletPo, true)", () => {
    expect(src).toMatch(/eq\s*\(\s*purchaseOrders\.isTabletPo\s*,\s*true\s*\)/);
  });

  it("uses inArray for status filtering — not notInArray", () => {
    expect(src).toMatch(/inArray\s*\(/);
    expect(src).not.toMatch(/notInArray\s*\(/);
  });

  it("references RECEIVABLE_PO_STATUSES (not a hardcoded CLOSED/CANCELLED list)", () => {
    expect(src).toMatch(/RECEIVABLE_PO_STATUSES/);
    // The old regression used notInArray with these two statuses hardcoded.
    expect(src).not.toMatch(/notInArray.*CLOSED.*CANCELLED/s);
  });

  it("wraps both filters in and()", () => {
    expect(src).toMatch(/and\s*\(/);
  });

  it("imports RECEIVABLE_PO_STATUSES from raw-bag-intake", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/production\/raw-bag-intake["']/);
  });
});

// UI-POLISH-4 — legacy wizard title and supervisor-fallback labeling.
describe("UI-POLISH-4 · legacy wizard labeling", () => {
  it("wizard title is 'Legacy receive wizard', not 'New receive'", () => {
    expect(wizardSrc).toMatch(/title="Legacy receive wizard"/);
    expect(wizardSrc).not.toMatch(/title="New receive"/);
  });

  it("wizard amber banner says 'legacy wizard'", () => {
    expect(wizardSrc).toMatch(/legacy wizard/i);
  });

  it("wizard links to /receiving/raw-bags for pills", () => {
    expect(wizardSrc).toMatch(/\/receiving\/raw-bags/);
  });

  it("wizard links to /inbound/packaging-materials for packaging", () => {
    expect(wizardSrc).toMatch(/\/inbound\/packaging-materials/);
  });
});

describe("REGRESSION-1 · RECEIVABLE_PO_STATUSES constant", () => {
  it("is exactly [OPEN, RECEIVING]", () => {
    expect(RECEIVABLE_PO_STATUSES).toEqual(["OPEN", "RECEIVING"]);
  });

  it("does not include DRAFT", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("DRAFT");
  });

  it("does not include CLOSED or CANCELLED", () => {
    expect(RECEIVABLE_PO_STATUSES).not.toContain("CLOSED");
    expect(RECEIVABLE_PO_STATUSES).not.toContain("CANCELLED");
  });
});
