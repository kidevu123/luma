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
  it("Receive raw pills entry exists + points at /receiving/raw-bags", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/receiving\/raw-bags"/);
    expect(sidebarSrc).toMatch(/label:\s*"Receive raw pills"/);
    expect(inFloorWork('label: "Receive raw pills"')).toBe(true);
  });
  it("Receive packaging entry exists", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Receive packaging"/);
    expect(inFloorWork('label: "Receive packaging"')).toBe(true);
  });
  it("Start production entry exists", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Start production"/);
    expect(inFloorWork('label: "Start production"')).toBe(true);
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
    "/inbound/packaging-materials",
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
  it("/receiving/raw-bags is a new sidebar destination", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/receiving\/raw-bags"/);
  });
  it("integrations gets a direct entry", () => {
    expect(sidebarSrc).toMatch(/label:\s*"Integrations"/);
    expect(sidebarSrc).toMatch(/href:\s*"\/settings\/integrations\/zoho"/);
  });
});

// ─── Data-honesty banned phrases stay clean ─────────────────────────────

describe("WORKFLOW-UX-1 · banned-phrase guard", () => {
  it("does not introduce QC banned phrases", () => {
    expect(sidebarSrc).not.toMatch(/production loss/i);
    expect(sidebarSrc).not.toMatch(/supplier shortage/i);
  });
});
