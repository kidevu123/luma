// NAV-PHASED-1 — sidebar invariants for the process-phased nav.
//
// Nav hrefs and role gates live in lib/auth/admin-nav.ts; sidebar.tsx
// maps icons and filters by the signed-in role.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { visibleAdminNavHrefs } from "@/lib/auth/admin-nav";

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(resolve(here, "sidebar.tsx"), "utf8");
const navSrc = readFileSync(resolve(here, "../../lib/auth/admin-nav.ts"), "utf8");

const SECTION_HEADINGS = [
  "Intake & materials",
  "Run production",
  "Reconciliation & output",
  "Traceability & reporting",
  "Advanced",
] as const;

function sectionRange(heading: string): { start: number; end: number } {
  const start = navSrc.indexOf(`heading: "${heading}"`);
  expect(start, `section ${heading} should exist`).toBeGreaterThan(-1);
  const idx = SECTION_HEADINGS.indexOf(heading as (typeof SECTION_HEADINGS)[number]);
  const nextHeading = SECTION_HEADINGS[idx + 1];
  const end = nextHeading
    ? navSrc.indexOf(`heading: "${nextHeading}"`)
    : navSrc.length;
  return { start, end };
}

function inSection(section: string, needle: string): boolean {
  const { start, end } = sectionRange(section);
  const at = navSrc.indexOf(needle);
  return at > start && at < end;
}

describe("NAV-PHASED-1 · section headings", () => {
  for (const heading of SECTION_HEADINGS) {
    it(`has section: ${heading}`, () => {
      expect(navSrc).toMatch(new RegExp(`heading:\\s*"${heading.replace(/&/g, "\\&")}"`));
    });
  }

  it("sections appear in the documented business-flow order", () => {
    const positions = SECTION_HEADINGS.map((h) => navSrc.indexOf(`heading: "${h}"`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("legacy section labels are gone", () => {
    expect(navSrc).not.toMatch(/heading:\s*"Operations"/);
    expect(navSrc).not.toMatch(/heading:\s*"Inventory"/);
    expect(navSrc).not.toMatch(/heading:\s*"Reports"/);
  });
});

describe("NAV-PHASED-1 · pinned top items", () => {
  it("Dashboard is in ADMIN_NAV_PINNED", () => {
    expect(navSrc).toMatch(/ADMIN_NAV_PINNED[\s\S]*"\/dashboard"/);
  });
  it("Live floor is in ADMIN_NAV_PINNED", () => {
    expect(navSrc).toMatch(/ADMIN_NAV_PINNED[\s\S]*"\/floor-board"/);
  });
});

describe("NAV-PHASED-1 · Intake & materials entries", () => {
  it("Receiving (/inbound) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/inbound"')).toBe(true);
  });
  it("Materials (/packaging-inventory) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/packaging-inventory"')).toBe(true);
  });
  it("Input lots (/batches) is in Intake & materials", () => {
    expect(inSection("Intake & materials", '"/batches"')).toBe(true);
  });
});

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

describe("NAV-DEMOTION-1 · Reconciliation & output is the closeout entry point", () => {
  it("Close out POs (/po-closeout) is the Reconciliation & output item", () => {
    expect(inSection("Reconciliation & output", '"/po-closeout"')).toBe(true);
    expect(navSrc).toMatch(/href: "\/po-closeout", label: "Close out POs", minRole: "ADMIN"/);
  });
  it("specialist pages moved OUT of Reconciliation & output", () => {
    for (const href of ['"/packaging-output"', '"/po-reconciliation"', '"/finished-lots"', '"/zoho-production-operations"']) {
      expect(inSection("Reconciliation & output", href), href).toBe(false);
    }
  });
});

describe("NAV-DEMOTION-1 · Advanced section (collapsed, unchanged guards)", () => {
  it("Advanced holds the demoted specialist pages", () => {
    for (const href of ['"/packaging-output"', '"/po-reconciliation"', '"/finished-lots"', '"/zoho-production-operations"']) {
      expect(inSection("Advanced", href), href).toBe(true);
    }
  });
  it("Advanced is collapsed by default and rendered as a details element", () => {
    const { start, end } = sectionRange("Advanced");
    expect(navSrc.slice(start, end)).toMatch(/collapsed: true/);
    expect(sidebarSrc).toMatch(/<details/);
    expect(sidebarSrc).toMatch(/<summary/);
  });
  it("demoted items keep their exact minRoles (no access change)", () => {
    const { start, end } = sectionRange("Advanced");
    const advanced = navSrc.slice(start, end);
    expect(advanced).toMatch(/href: "\/packaging-output", label: "Production output", minRole: "SESSION"/);
    expect(advanced).toMatch(/href: "\/po-reconciliation", label: "PO reconciliation", minRole: "ADMIN"/);
    expect(advanced).toMatch(/href: "\/finished-lots", label: "Finished lots", minRole: "SESSION"/);
    expect(advanced).toMatch(/minRole: "SESSION",\s*\n\s*\},\s*\n\s*\]/);
  });
});

describe("NAV-PHASED-1 · Traceability & reporting entries", () => {
  it("Traceability lookup (/recall) is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/recall"')).toBe(true);
  });
  it("Metrics is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/metrics"')).toBe(true);
  });
  it("Productivity is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/operator-productivity"')).toBe(true);
  });
  it("Audit log is in Traceability & reporting", () => {
    expect(inSection("Traceability & reporting", '"/reports/audit-log"')).toBe(true);
  });
});

describe("NAV-PHASED-1 · role-filtered sidebar", () => {
  it("Sidebar receives role from admin layout", () => {
    expect(sidebarSrc).toMatch(/export function Sidebar\(\{\s*role\s*\}/);
    expect(readFileSync(resolve(here, "../../app/(admin)/layout.tsx"), "utf8")).toMatch(
      /<Sidebar role=\{user\.role\} \/>/,
    );
  });

  it("Sidebar filters via filterAdminNavForRole", () => {
    expect(sidebarSrc).toMatch(/filterAdminNavForRole\(role\)/);
  });

  it("every nav href declares minRole in admin-nav", () => {
    expect(navSrc).toMatch(/minRole:/);
    for (const href of visibleAdminNavHrefs("OWNER")) {
      expect(navSrc).toContain(`"${href}"`);
    }
  });
});

describe("NAV-PHASED-1 · Settings", () => {
  it("Settings link exists in nav config", () => {
    expect(navSrc).toMatch(/ADMIN_NAV_SETTINGS[\s\S]*"\/settings"/);
  });
});

describe("NAV-PHASED-1 · removed sidebar routes", () => {
  const removed = [
    "/genealogy",
    "/packaging-receipts",
    "/active-rolls",
    "/production/start",
    "/roll-management",
  ];
  for (const route of removed) {
    it(`${route} is NOT in visible OWNER nav`, () => {
      expect(visibleAdminNavHrefs("OWNER")).not.toContain(route);
    });
  }
});

describe("NAV-PHASED-1 · banned phrases", () => {
  it("does not introduce banned QC phrases", () => {
    expect(sidebarSrc).not.toMatch(/production loss/i);
    expect(sidebarSrc).not.toMatch(/supplier shortage/i);
  });
});
