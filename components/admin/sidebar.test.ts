// NAV-REDESIGN-1 — sidebar invariants for the consolidated nav.
//
// Parses sidebar.tsx as source text and asserts the structural
// contract: 3 sections, pinned top items, nothing buried in Advanced.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

// ─── Section headings ────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · section headings", () => {
  it("has an Operations section", () => {
    expect(src).toMatch(/heading:\s*"Operations"/);
  });
  it("has an Inventory section", () => {
    expect(src).toMatch(/heading:\s*"Inventory"/);
  });
  it("has a Reports section", () => {
    expect(src).toMatch(/heading:\s*"Reports"/);
  });
  it("does NOT have an Advanced collapsed section", () => {
    expect(src).not.toMatch(/collapsedByDefault:\s*true/);
  });
  it("does NOT have an Oversight section", () => {
    expect(src).not.toMatch(/heading:\s*"Oversight"/);
  });
  it("does NOT have a Configure section", () => {
    expect(src).not.toMatch(/heading:\s*"Configure"/);
  });
});

// ─── Pinned top items ────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · pinned top items", () => {
  it("Dashboard is in PINNED_TOP", () => {
    const pinnedAt = src.indexOf("PINNED_TOP");
    const sectionsAt = src.indexOf("SECTIONS");
    const dashAt = src.indexOf('"/dashboard"');
    expect(dashAt).toBeGreaterThan(-1);
    expect(dashAt).toBeLessThan(sectionsAt);
    expect(dashAt).toBeGreaterThan(pinnedAt);
  });
  it("Live floor is in PINNED_TOP", () => {
    const pinnedAt = src.indexOf("PINNED_TOP");
    const sectionsAt = src.indexOf("SECTIONS");
    const liveAt = src.indexOf('"/floor-board"');
    expect(liveAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(sectionsAt);
    expect(liveAt).toBeGreaterThan(pinnedAt);
  });
});

// ─── Operations entries ──────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Operations entries", () => {
  function inOps(s: string): boolean {
    const start = src.indexOf('heading: "Operations"');
    const end = src.indexOf('heading: "Inventory"');
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Start production is not in Operations", () => {
    expect(inOps('"/production/start"')).toBe(false);
  });
  it("Receiving is in Operations", () => {
    expect(inOps('"/inbound"')).toBe(true);
  });
  it("Production output is in Operations", () => {
    expect(inOps('"Production output"')).toBe(true);
  });
  it("QC review is in Operations", () => {
    expect(inOps('"QC review"')).toBe(true);
  });
  it("Available Partial Bags is in Operations", () => {
    expect(inOps('"/partial-bags"')).toBe(true);
  });
});

// ─── Inventory entries ───────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Inventory entries", () => {
  function inInventory(s: string): boolean {
    const start = src.indexOf('heading: "Inventory"');
    const end = src.indexOf('heading: "Reports"');
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Materials (packaging-inventory) is in Inventory", () => {
    expect(inInventory('"/packaging-inventory"')).toBe(true);
  });
  it("Roll management is in Inventory", () => {
    expect(inInventory('"/roll-management"')).toBe(true);
  });
  it("Finished lots is in Inventory", () => {
    expect(inInventory('"/finished-lots"')).toBe(true);
  });
  it("Input lots is in Inventory", () => {
    expect(inInventory('"/batches"')).toBe(true);
    expect(inInventory('"Input lots"')).toBe(true);
  });
  it("Batches label was renamed to Input lots", () => {
    expect(src).not.toMatch(/label:\s*"Batches"/);
  });
  it("Workflows is in Inventory", () => {
    expect(inInventory('"/workflow-submissions"')).toBe(true);
  });
  it("Find lot is in Inventory", () => {
    expect(inInventory('"/recall"')).toBe(true);
  });
});

// ─── Reports entries ─────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Reports entries", () => {
  function inReports(s: string): boolean {
    const start = src.indexOf('heading: "Reports"');
    const end = src.length; // Reports is last section
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Metrics is in Reports", () => {
    expect(inReports('"/metrics"')).toBe(true);
  });
  it("Productivity is in Reports", () => {
    expect(inReports('"/operator-productivity"')).toBe(true);
  });
});

// ─── Settings link present ───────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Settings", () => {
  it("Settings link exists", () => {
    expect(src).toMatch(/href.*"\/settings"/);
  });
});

// ─── Sidebar routes — all linked hrefs ───────────────────────────────────

describe("NAV-REDESIGN-1 · sidebar routes", () => {
  const routes = [
    "/dashboard",
    "/floor-board",
    "/partial-bags",
    "/inbound",
    "/packaging-output",
    "/qc-review",
    "/packaging-inventory",
    "/roll-management",
    "/finished-lots",
    "/batches",
    "/workflow-submissions",
    "/recall",
    "/metrics",
    "/operator-productivity",
    "/settings",
  ];
  for (const route of routes) {
    it(`${route} is linked`, () => {
      expect(src).toMatch(new RegExp(`href.*"${route.replace(/\//g, "\\/")}"`));
    });
  }
});

// ─── Routes that moved OUT of sidebar ───────────────────────────────────

describe("STATION-NAV-CLEANUP-1 · removed sidebar routes", () => {
  it("/production/start is not a sidebar href", () => {
    expect(src).not.toMatch(/href:\s*"\/production\/start"/);
  });
});

describe("NAV-REDESIGN-1 · removed sidebar routes", () => {
  const removed = [
    "/genealogy",
    "/po-reconciliation",
    "/packaging-receipts",
    "/active-rolls",
    "/material-alerts",
    "/reports",
    "/production-capacity",
    "/roll-variance",
    "/material-reconciliation",
    "/invoice-allocations",
    "/product-packaging-requirements",
    "/zoho-operations",
    "/products",
  ];
  for (const route of removed) {
    it(`${route} is NOT a sidebar href`, () => {
      // The route may appear in comments or isActive logic — check it's
      // not an href value.
      expect(src).not.toMatch(
        new RegExp(`href:\\s*"${route.replace(/\//g, "\\/")}"`),
      );
    });
  }
});

// ─── Data-honesty banned phrases ─────────────────────────────────────────

describe("NAV-REDESIGN-1 · banned phrases", () => {
  it("does not introduce banned QC phrases", () => {
    expect(src).not.toMatch(/production loss/i);
    expect(src).not.toMatch(/supplier shortage/i);
  });
});
