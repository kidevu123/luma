// WORKFLOW-UX-1 — sidebar invariants.
//
// Server-component scan: sidebar.tsx is a "use client" file, so we
// parse the source as text and assert the structural contract — the
// workflow-first section layout, the floor-language labels, and the
// preservation of every previously-shipped route.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

// ─── Section headings present ────────────────────────────────────────────

describe("WORKFLOW-UX-1 · sidebar sections", () => {
  it("registers a Floor work section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Floor work"/);
  });
  it("registers a Management section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Management"/);
  });
  it("registers a Configuration section", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Configuration"/);
  });
  it("registers an Advanced section, collapsed by default", () => {
    expect(sidebarSrc).toMatch(/heading:\s*"Advanced"/);
    expect(sidebarSrc).toMatch(/collapsedByDefault:\s*true/);
  });
});

// ─── Floor-work entrypoints + labels ────────────────────────────────────

describe("WORKFLOW-UX-1 · Floor work entries", () => {
  function offsetOf(s: string): number {
    return sidebarSrc.indexOf(s);
  }
  function inFloorWork(s: string): boolean {
    const start = offsetOf('heading: "Floor work"');
    const next = offsetOf('heading: "Management"');
    const at = offsetOf(s);
    return start > -1 && at > start && at < next;
  }

  it("Live floor entry exists", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Live floor"/);
    expect(inFloorWork('label: "Live floor"')).toBe(true);
  });
  it("Receiving hub entry exists in Floor work and points at /inbound", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Receiving"/);
    expect(inFloorWork('label: "Receiving"')).toBe(true);
    const receivingAt = sidebarSrc.indexOf('label: "Receiving"');
    const slice = sidebarSrc.slice(Math.max(0, receivingAt - 200), receivingAt);
    expect(slice).toMatch(/href:\s*"\/inbound"/);
  });
  it("Start production entry exists + points at /production/start (not /qr-cards)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Start production"/);
    expect(inFloorWork('label: "Start production"')).toBe(true);
    // The Start production link must NOT point at /qr-cards (which is
    // QR card management, a DB-table-style page).
    const startAt = sidebarSrc.indexOf('label: "Start production"');
    const slice = sidebarSrc.slice(Math.max(0, startAt - 200), startAt);
    expect(slice).toMatch(/href:\s*"\/production\/start"/);
  });
  it("Packaging / pack-out entry exists (not 'Packaging output')", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Packaging \/ pack-out"/);
    expect(inFloorWork('label: "Packaging / pack-out"')).toBe(true);
  });
  it("QC review entry exists in Floor work (not Production intelligence)", () => {
    expect(sidebarSrc).toMatch(/label:\s*"QC review"/);
    expect(inFloorWork('label: "QC review"')).toBe(true);
  });
  it("Lookup receipt / batch entry exists + replaces 'Recall lookup'", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Lookup receipt \/ batch"/);
    expect(inFloorWork('label: "Lookup receipt / batch"')).toBe(true);
    // The old label is gone.
    expect(sidebarSrc).not.toMatch(/label:\s*"Recall lookup"/);
  });
});

// ─── Database-style pages must not be in the primary operator section ──

describe("WORKFLOW-UX-1 · DB-style labels stay out of Floor work", () => {
  function notInFloorWork(label: string): boolean {
    const start = sidebarSrc.indexOf('heading: "Floor work"');
    const next = sidebarSrc.indexOf('heading: "Management"');
    const at = sidebarSrc.indexOf(`label: "${label}"`);
    if (at === -1) return true; // label not in sidebar at all
    return at < start || at > next;
  }

  it("'Bag genealogy' is not a Floor-work label", () => {
    expect(notInFloorWork("Bag genealogy")).toBe(true);
  });
  it("'Finished lots' is not a Floor-work label", () => {
    expect(notInFloorWork("Finished lots")).toBe(true);
  });
  it("'QR cards' is not a Floor-work label (label belongs to Advanced; the Floor-work entry uses 'Start production')", () => {
    expect(notInFloorWork("QR cards")).toBe(true);
  });
  it("'Material reconciliation' is not a Floor-work label", () => {
    expect(notInFloorWork("Material reconciliation")).toBe(true);
  });
  it("'Roll variance' is not a Floor-work label", () => {
    expect(notInFloorWork("Roll variance")).toBe(true);
  });
  it("'PO reconciliation' is not a Floor-work label", () => {
    expect(notInFloorWork("PO reconciliation")).toBe(true);
  });
  it("'Product requirements' is not a Floor-work label", () => {
    expect(notInFloorWork("Product requirements")).toBe(true);
  });
  it("'Active rolls' is not a Floor-work label", () => {
    expect(notInFloorWork("Active rolls")).toBe(true);
  });
  it("'Batches' is not a Floor-work label", () => {
    expect(notInFloorWork("Batches")).toBe(true);
  });
});

// ─── Routes preserved — every prior sidebar destination still has at
//     least one Link in the source, just possibly under a different
//     section heading.

describe("WORKFLOW-UX-1 · no routes deleted from the sidebar", () => {
  const previouslyShippedRoutes = [
    "/dashboard",
    "/floor-board",
    "/inbound",
    "/batches",
    "/finished-lots",
    "/qr-cards",
    "/recall",
    "/reports",
    "/metrics",
    "/genealogy",
    "/qc-review",
    "/material-reconciliation",
    "/operator-productivity",
    "/packaging-output",
    "/standards",
    "/packaging-inventory",
    "/product-packaging-requirements",
    "/active-rolls",
    "/roll-variance",
    "/material-alerts",
    "/po-reconciliation",
    "/workflow-validation",
    "/settings",
  ];
  for (const route of previouslyShippedRoutes) {
    it(`${route} is still linked from the sidebar`, () => {
      expect(sidebarSrc).toMatch(new RegExp(`href:\\s*"${route.replace(/\//g, "\\/")}"`));
    });
  }
});

// ─── New routes added in this phase ─────────────────────────────────────

describe("WORKFLOW-UX-1 · new sidebar entries", () => {
  it("Receiving hub consolidates raw-bags and packaging-materials under /inbound", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/inbound"/);
    expect(sidebarSrc).toMatch(/label:\s*"Receiving"/);
  });
  it("integrations gets a direct entry", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Integrations"/);
    expect(sidebarSrc).toMatch(/href:\s*"\/settings\/integrations\/zoho"/);
  });
});

describe("TABLETTRACKER-STANDARD-RESET-1 · workflow center sidebar", () => {
  function inFloorWork(s: string): boolean {
    const start = sidebarSrc.indexOf('heading: "Floor work"');
    const next = sidebarSrc.indexOf('heading: "Management"');
    const at = sidebarSrc.indexOf(s);
    return start > -1 && at > start && at < next;
  }

  it("workflow-submissions is linked from the sidebar", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/workflow-submissions"/);
  });
  it("Workflow submissions label is in Floor work", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Workflow submissions"/);
    expect(inFloorWork('label: "Workflow submissions"')).toBe(true);
  });
  it("/workflow-submissions is NOT in the DB-style Advanced section", () => {
    const advancedAt = sidebarSrc.indexOf('heading: "Advanced"');
    const at = sidebarSrc.indexOf('href: "/workflow-submissions"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(advancedAt);
  });
});

describe("WORKFLOW-CLEANUP-2 · Start production vs QR card management", () => {
  it("Start production points to /production/start", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/production\/start"/);
  });

  it("QR card management lives under Advanced (collapsed) with /qr-cards route", () => {
    const advancedAt = sidebarSrc.indexOf('heading: "Advanced"');
    const qrLabelAt = sidebarSrc.indexOf('label: "QR card management"');
    expect(advancedAt).toBeGreaterThan(-1);
    expect(qrLabelAt).toBeGreaterThan(advancedAt);
  });

  it("Lookup receipt / batch only appears once in primary workflow", () => {
    // Count occurrences of the literal label in the sidebar source.
    const matches = sidebarSrc.match(/label:\s*"Lookup receipt \/ batch"/g);
    expect(matches?.length).toBe(1);
  });

  it("Batches stays under Advanced (not in Floor work)", () => {
    const floorAt = sidebarSrc.indexOf('heading: "Floor work"');
    const mgmtAt = sidebarSrc.indexOf('heading: "Management"');
    const batchesAt = sidebarSrc.indexOf('label: "Batches"');
    expect(batchesAt).toBeGreaterThan(-1);
    // Batches must be AFTER Management (i.e. in Advanced).
    expect(batchesAt < floorAt || batchesAt > mgmtAt).toBe(true);
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
  it("Invoice allocations is linked under Management (not Floor work)", () => {
    const floorAt = sidebarSrc.indexOf('heading: "Floor work"');
    const mgmtAt = sidebarSrc.indexOf('heading: "Management"');
    const configAt = sidebarSrc.indexOf('heading: "Configuration"');
    const labelAt = sidebarSrc.indexOf('label: "Invoice allocations"');
    expect(labelAt).toBeGreaterThan(-1);
    // Sits between Management and Configuration headings.
    expect(labelAt).toBeGreaterThan(mgmtAt);
    expect(labelAt).toBeLessThan(configAt);
    // …and NOT inside Floor work.
    expect(labelAt < floorAt || labelAt > mgmtAt).toBe(true);
  });
  it("Invoice allocations points to /invoice-allocations", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/invoice-allocations"/);
  });
});
