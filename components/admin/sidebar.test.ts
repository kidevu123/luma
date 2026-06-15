// NAV-PHASED-1 — sidebar invariants for the process-phased nav.
//
// Parses sidebar.tsx as source text and asserts the structural
// contract: four phased sections in business-flow order, pinned
// Dashboard + Live floor, and no leftover Operations/Inventory/
// Reports labels from the prior structure.
//
// The four phases (Intake & materials → Run production →
// Reconciliation & output → Traceability & reporting) mirror how a
// production day actually plays out, so the tests verify both
// membership and ordering.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

const SECTION_HEADINGS = [
  "Intake & materials",
  "Run production",
  "Reconciliation & output",
  "Traceability & reporting",
] as const;

function sectionRange(heading: string): { start: number; end: number } {
  const start = src.indexOf(`heading: "${heading}"`);
  expect(start, `section ${heading} should exist`).toBeGreaterThan(-1);
  const idx = SECTION_HEADINGS.indexOf(heading as (typeof SECTION_HEADINGS)[number]);
  const nextHeading = SECTION_HEADINGS[idx + 1];
  const end = nextHeading
    ? src.indexOf(`heading: "${nextHeading}"`)
    : src.length;
  return { start, end };
}

function inSection(section: string, needle: string): boolean {
  const { start, end } = sectionRange(section);
  const at = src.indexOf(needle);
  return at > start && at < end;
}

// ─── Section headings ────────────────────────────────────────────────────

describe("NAV-PHASED-1 · section headings", () => {
  for (const heading of SECTION_HEADINGS) {
    it(`has section: ${heading}`, () => {
      expect(src).toMatch(new RegExp(`heading:\\s*"${heading.replace(/&/g, "\\&")}"`));
    });
  }

  it("sections appear in the documented business-flow order", () => {
    const positions = SECTION_HEADINGS.map((h) => src.indexOf(`heading: "${h}"`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("legacy section labels are gone", () => {
    expect(src).not.toMatch(/heading:\s*"Operations"/);
    expect(src).not.toMatch(/heading:\s*"Inventory"/);
    expect(src).not.toMatch(/heading:\s*"Reports"/);
    expect(src).not.toMatch(/heading:\s*"Oversight"/);
    expect(src).not.toMatch(/heading:\s*"Configure"/);
  });

  it("no collapsed-by-default groups (everything is reachable from the top of the sidebar)", () => {
    expect(src).not.toMatch(/collapsedByDefault:\s*true/);
  });
});

// ─── Pinned top items ────────────────────────────────────────────────────

describe("NAV-PHASED-1 · pinned top items", () => {
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

// ─── Intake & materials ─────────────────────────────────────────────────

describe("NAV-PHASED-1 · Intake & materials entries", () => {
  it("Receiving (/inbound) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/inbound"')).toBe(true);
  });
  it("Materials (/packaging-inventory) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/packaging-inventory"')).toBe(true);
  });
  it("Input lots (/batches) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/batches"')).toBe(true);
    expect(inSection("Intake & materials", '"Input lots"')).toBe(true);
  });
});

// ─── Run production ─────────────────────────────────────────────────────

describe("NAV-PHASED-1 · Run production entries", () => {
  it("Workflows (/workflow-submissions) is in Run production", () => {
    expect(inSection("Run production", '"/workflow-submissions"')).toBe(true);
  });
  it("Partial Bag Workbench is in Run production", () => {
    expect(inSection("Run production", '"/partial-bags"')).toBe(true);
  });
  it("QC review is in Run production", () => {
    expect(inSection("Run production", '"/qc-review"')).toBe(true);
  });
  it("Shift review is in Run production", () => {
    expect(inSection("Run production", '"/shift-review"')).toBe(true);
  });
});

// ─── Reconciliation & output ────────────────────────────────────────────

describe("NAV-PHASED-1 · Reconciliation & output entries", () => {
  it("Production output is in Reconciliation & output", () => {
    expect(inSection("Reconciliation & output", '"/packaging-output"')).toBe(true);
  });
  it("PO reconciliation is in Reconciliation & output", () => {
    expect(inSection("Reconciliation & output", '"/po-reconciliation"')).toBe(true);
  });
  it("PO reconciliation appears directly after Production output", () => {
    const prodOut = src.indexOf('"/packaging-output"');
    const poRecon = src.indexOf('"/po-reconciliation"');
    const finished = src.indexOf('"/finished-lots"');
    expect(prodOut).toBeGreaterThan(-1);
    expect(poRecon).toBeGreaterThan(prodOut);
    expect(poRecon).toBeLessThan(finished);
  });
  it("Finished lots is in Reconciliation & output", () => {
    expect(inSection("Reconciliation & output", '"/finished-lots"')).toBe(true);
  });
  it("Zoho output is in Reconciliation & output", () => {
    expect(
      inSection("Reconciliation & output", '"/zoho-production-operations"'),
    ).toBe(true);
  });
});

// ─── Traceability & reporting ───────────────────────────────────────────

describe("NAV-PHASED-1 · Traceability & reporting entries", () => {
  it("Traceability lookup (/recall) is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/recall"')).toBe(true);
  });
  it("Metrics is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/metrics"')).toBe(true);
  });
  it("Productivity is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/operator-productivity"')).toBe(
      true,
    );
  });
  it("Audit log is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/reports/audit-log"')).toBe(true);
  });
});

// ─── Cross-section invariants ───────────────────────────────────────────

describe("NAV-PHASED-1 · cross-section invariants", () => {
  it("Workflows is NOT under Intake & materials (it's a Run production concern)", () => {
    expect(inSection("Intake & materials", '"/workflow-submissions"')).toBe(false);
  });
  it("Zoho output is NOT under Intake & materials (it's a close-out step)", () => {
    expect(
      inSection("Intake & materials", '"/zoho-production-operations"'),
    ).toBe(false);
  });
  it("Roll management is reachable via Materials tabs, never as a standalone sidebar item", () => {
    expect(src).not.toMatch(/href:\s*"\/roll-management"/);
  });
  it("Batches label was renamed to Input lots", () => {
    expect(src).not.toMatch(/label:\s*"Batches"/);
  });
});

// ─── Settings link present ───────────────────────────────────────────────

describe("NAV-PHASED-1 · Settings", () => {
  it("Settings link exists", () => {
    expect(src).toMatch(/href.*"\/settings"/);
  });
});

// ─── Sidebar routes — all linked hrefs ───────────────────────────────────

describe("NAV-PHASED-1 · sidebar routes", () => {
  const routes = [
    "/dashboard",
    "/floor-board",
    "/inbound",
    "/packaging-inventory",
    "/batches",
    "/workflow-submissions",
    "/partial-bags",
    "/qc-review",
    "/shift-review",
    "/packaging-output",
    "/po-reconciliation",
    "/finished-lots",
    "/zoho-production-operations",
    "/recall",
    "/metrics",
    "/operator-productivity",
    "/reports/audit-log",
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

describe("NAV-PHASED-1 · removed sidebar routes", () => {
  // These are reachable via in-page tab rows (Receives, Materials,
  // Metrics) or via the parent routes they sit under, but they aren't
  // sidebar destinations on their own. /po-reconciliation IS in the
  // sidebar — it's intentionally absent from this list.
  const removed = [
    "/genealogy",
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
    "/roll-management",
  ];
  for (const route of removed) {
    it(`${route} is NOT a sidebar href`, () => {
      expect(src).not.toMatch(
        new RegExp(`href:\\s*"${route.replace(/\//g, "\\/")}"`),
      );
    });
  }
});

// ─── Data-honesty banned phrases ─────────────────────────────────────────

describe("NAV-PHASED-1 · banned phrases", () => {
  it("does not introduce banned QC phrases", () => {
    expect(src).not.toMatch(/production loss/i);
    expect(src).not.toMatch(/supplier shortage/i);
  });
});
