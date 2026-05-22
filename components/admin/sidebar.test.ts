// WORKFLOW-UX-1 — sidebar invariants.
//
// Server-component scan: sidebar.tsx is a "use client" file, so we
// parse the source as text and assert the structural contract — the
// workflow-first section layout, the floor-language labels, and the
// preservation of every shipped route.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

// ─── Section headings present ────────────────────────────────────────────

describe("WORKFLOW-UX-1 · sidebar sections", () => {
  it("registers an Operations section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Operations"/);
  });
  it("registers an Oversight section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Oversight"/);
  });
  it("registers a Configure section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Configure"/);
  });
  it("registers an Advanced section, collapsed by default", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Advanced"/);
    expect(sidebarSrc).toMatch(/collapsedByDefault:\s*true/);
  });
});

// ─── Operations entrypoints + labels ────────────────────────────────────

describe("WORKFLOW-UX-1 · Operations entries", () => {
  function offsetOf(s: string): number {
    return sidebarSrc.indexOf(s);
  }
  function inOperations(s: string): boolean {
    const start = offsetOf('heading: "Operations"');
    const next = offsetOf('heading: "Oversight"');
    const at = offsetOf(s);
    return start > -1 && at > start && at < next;
  }

  it("Receiving hub entry exists in Operations and points at /inbound", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Receiving"/);
    expect(inOperations('label: "Receiving"')).toBe(true);
    const receivingAt = sidebarSrc.indexOf('label: "Receiving"');
    const slice = sidebarSrc.slice(Math.max(0, receivingAt - 200), receivingAt);
    expect(slice).toMatch(/href:\s*"\/inbound"/);
  });
  it("Start production entry exists + points at /production/start (not /qr-cards)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Start production"/);
    expect(inOperations('label: "Start production"')).toBe(true);
    const startAt = sidebarSrc.indexOf('label: "Start production"');
    const slice = sidebarSrc.slice(Math.max(0, startAt - 200), startAt);
    expect(slice).toMatch(/href:\s*"\/production\/start"/);
  });
  it("Pack-out entry exists in Operations (not 'Packaging output' or 'Packaging / pack-out')", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Pack-out"/);
    expect(inOperations('label: "Pack-out"')).toBe(true);
  });
  it("QC review entry exists in Operations", () => {
    expect(sidebarSrc).toMatch(/label:\s*"QC review"/);
    expect(inOperations('label: "QC review"')).toBe(true);
  });
  it("Find lot / batch is in Oversight (not Operations)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Find lot \/ batch"/);
    expect(inOperations('label: "Find lot / batch"')).toBe(false);
  });
  it("Live floor is in Advanced (not Operations)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Live floor"/);
    expect(inOperations('label: "Live floor"')).toBe(false);
  });
});

// ─── Database-style pages must not be in the primary operator section ──

describe("WORKFLOW-UX-1 · DB-style labels stay out of Operations", () => {
  function notInOperations(label: string): boolean {
    const start = sidebarSrc.indexOf('heading: "Operations"');
    const next = sidebarSrc.indexOf('heading: "Oversight"');
    const at = sidebarSrc.indexOf(`label: "${label}"`);
    if (at === -1) return true; // label not in sidebar at all
    return at < start || at > next;
  }

  it("'Bag genealogy' is not an Operations label", () => {
    expect(notInOperations("Bag genealogy")).toBe(true);
  });
  it("'Finished lots' is not an Operations label", () => {
    expect(notInOperations("Finished lots")).toBe(true);
  });
  it("'Material reconciliation' is not an Operations label", () => {
    expect(notInOperations("Material reconciliation")).toBe(true);
  });
  it("'Roll variance' is not an Operations label", () => {
    expect(notInOperations("Roll variance")).toBe(true);
  });
  it("'PO reconciliation' is not an Operations label", () => {
    expect(notInOperations("PO reconciliation")).toBe(true);
  });
  it("'Product requirements' is not an Operations label", () => {
    expect(notInOperations("Product requirements")).toBe(true);
  });
  it("'Active rolls' is not an Operations label", () => {
    expect(notInOperations("Active rolls")).toBe(true);
  });
  it("'Batches' is not an Operations label", () => {
    expect(notInOperations("Batches")).toBe(true);
  });
});

// ─── Routes present — every current sidebar destination is linked ────────

describe("WORKFLOW-UX-1 · all sidebar routes present", () => {
  const currentRoutes = [
    "/dashboard",
    "/floor-board",
    "/inbound",
    "/batches",
    "/finished-lots",
    "/recall",
    "/reports",
    "/metrics",
    "/genealogy",
    "/qc-review",
    "/material-reconciliation",
    "/operator-productivity",
    "/packaging-output",
    "/packaging-inventory",
    "/product-packaging-requirements",
    "/active-rolls",
    "/roll-variance",
    "/material-alerts",
    "/po-reconciliation",
    "/workflow-submissions",
    "/settings",
    "/production/start",
    "/products",
    "/invoice-allocations",
    "/zoho-operations",
    "/packaging-receipts",
    "/production-capacity",
  ];
  for (const route of currentRoutes) {
    it(`${route} is linked from the sidebar`, () => {
      expect(sidebarSrc).toMatch(new RegExp(`href:\\s*"${route.replace(/\//g, "\\/")}"`));
    });
  }
});

// ─── Receiving hub ───────────────────────────────────────────────────────

describe("WORKFLOW-UX-1 · receiving hub", () => {
  it("Receiving hub consolidates raw-bags and packaging-materials under /inbound", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/inbound"/);
    expect(sidebarSrc).toMatch(/label:\s*"Receiving"/);
  });
});

describe("TABLETTRACKER-STANDARD-RESET-1 · workflow center sidebar", () => {
  function inOversight(s: string): boolean {
    const start = sidebarSrc.indexOf('heading: "Oversight"');
    const next = sidebarSrc.indexOf('heading: "Configure"');
    const at = sidebarSrc.indexOf(s);
    return start > -1 && at > start && at < next;
  }

  it("workflow-submissions is linked from the sidebar", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/workflow-submissions"/);
  });
  it("Workflows label is in Oversight (not Operations)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Workflows"/);
    expect(inOversight('label: "Workflows"')).toBe(true);
  });
  it("/workflow-submissions is NOT in the Advanced section", () => {
    const advancedAt = sidebarSrc.indexOf('heading: "Advanced"');
    const at = sidebarSrc.indexOf('href: "/workflow-submissions"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(advancedAt);
  });
});

describe("WORKFLOW-CLEANUP-2 · Start production routing", () => {
  it("Start production points to /production/start", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/production\/start"/);
  });

  it("Batches stays under Advanced (not in Operations)", () => {
    const opsAt = sidebarSrc.indexOf('heading: "Operations"');
    const oversightAt = sidebarSrc.indexOf('heading: "Oversight"');
    const batchesAt = sidebarSrc.indexOf('label: "Batches"');
    expect(batchesAt).toBeGreaterThan(-1);
    // Batches must be outside the Operations → Oversight window.
    expect(batchesAt < opsAt || batchesAt > oversightAt).toBe(true);
  });
});

// ─── Data-honesty banned phrases stay clean ─────────────────────────────

describe("WORKFLOW-UX-1 · banned-phrase guard", () => {
  it("does not introduce QC banned phrases", () => {
    expect(sidebarSrc).not.toMatch(/production loss/i);
    expect(sidebarSrc).not.toMatch(/supplier shortage/i);
  });
});

describe("COMMERCIAL-TRACE-5 · invoice allocations link", () => {
  it("Invoice allocations is linked from the sidebar", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Invoice allocations"/);
    expect(sidebarSrc).toMatch(/href:\s*"\/invoice-allocations"/);
  });
  it("Invoice allocations is in Advanced (collapsed section)", () => {
    const advancedAt = sidebarSrc.indexOf('heading: "Advanced"');
    const labelAt = sidebarSrc.indexOf('label: "Invoice allocations"');
    expect(labelAt).toBeGreaterThan(-1);
    expect(labelAt).toBeGreaterThan(advancedAt);
  });
});
