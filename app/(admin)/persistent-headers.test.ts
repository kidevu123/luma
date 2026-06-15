// Persistent tab-row contract for the Receives, Materials, and
// Metrics areas. The user can move between sibling pages via the
// header tabs WITHOUT bouncing back through the sidebar — that means
// every subroute under these areas must render the shared tabs
// component at the top of its tree.
//
// We parse the page source instead of mounting React because the
// admin pages are server components with heavy DB joins; this stays
// fast and matches the pattern in components/admin/sidebar.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(resolve(here, rel), "utf8");
}

function rendersTab(src: string, componentName: string): boolean {
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s*from\\s*["']@/components/ui/`,
  ).test(src);
  const rendered = new RegExp(`<${componentName}\\s*/?>`).test(src);
  return imported && rendered;
}

// ── Receives ────────────────────────────────────────────────────────

describe("persistent Receives header on every intake subroute", () => {
  // NAV-PHASED-1 — PO reconciliation is intentionally NOT in this
  // list. It's a close-out / reconciliation page, not an intake page;
  // it lives under "Reconciliation & output" in the sidebar and
  // renders WITHOUT the Receives tab row so the two surfaces stay
  // distinct.
  const subroutes: Array<[string, string]> = [
    ["/inbound", "inbound/page.tsx"],
    ["/receiving/raw-bags", "receiving/raw-bags/page.tsx"],
    ["/inbound/packaging-materials", "inbound/packaging-materials/page.tsx"],
    ["/packaging-receipts", "packaging-receipts/page.tsx"],
  ];
  for (const [route, file] of subroutes) {
    it(`${route} renders <ReceivingTabs />`, () => {
      const src = readSrc(file);
      expect(rendersTab(src, "ReceivingTabs")).toBe(true);
    });
  }
});

describe("PO reconciliation is NOT inside the Receives tab row", () => {
  it("the standalone /po-reconciliation page does not import ReceivingTabs", () => {
    const src = readSrc("po-reconciliation/page.tsx");
    expect(src).not.toMatch(/ReceivingTabs/);
  });
  it("ReceivingTabs definition does not link to /po-reconciliation", () => {
    const componentsDir = resolve(here, "../../components/ui");
    const src = readFileSync(resolve(componentsDir, "receiving-tabs.tsx"), "utf8");
    expect(src).not.toMatch(/href:\s*"\/po-reconciliation"/);
  });
});

// ── Materials ───────────────────────────────────────────────────────

describe("persistent Materials header on every subroute", () => {
  const subroutes: Array<[string, string]> = [
    ["/packaging-inventory", "packaging-inventory/page.tsx"],
    ["/active-rolls", "active-rolls/page.tsx"],
    ["/roll-management", "roll-management/page.tsx"],
    ["/material-alerts", "material-alerts/page.tsx"],
  ];
  for (const [route, file] of subroutes) {
    it(`${route} renders <MaterialsTabs />`, () => {
      const src = readSrc(file);
      expect(rendersTab(src, "MaterialsTabs")).toBe(true);
    });
  }
});

// ── Metrics ─────────────────────────────────────────────────────────

describe("persistent Metrics header on every subroute", () => {
  const subroutes: Array<[string, string]> = [
    ["/metrics", "metrics/page.tsx"],
    ["/reports", "reports/page.tsx"],
    ["/production-capacity", "production-capacity/page.tsx"],
    ["/roll-variance", "roll-variance/page.tsx"],
  ];
  for (const [route, file] of subroutes) {
    it(`${route} renders <MetricsTabs />`, () => {
      const src = readSrc(file);
      expect(rendersTab(src, "MetricsTabs")).toBe(true);
    });
  }
});

// ── Tab definitions ────────────────────────────────────────────────

// If the tabs themselves drift out of sync with the subroutes, the
// header rows will silently lose entries. Pin the contract.

describe("tab definitions match the subroute list", () => {
  const componentsDir = resolve(here, "../../components/ui");

  function readComponent(name: string): string {
    return readFileSync(resolve(componentsDir, name), "utf8");
  }

  it("ReceivingTabs links to every Receives intake subroute (no PO recon)", () => {
    const src = readComponent("receiving-tabs.tsx");
    for (const href of [
      "/inbound",
      "/receiving/raw-bags",
      "/inbound/packaging-materials",
      "/packaging-receipts",
    ]) {
      expect(src).toMatch(new RegExp(`href:\\s*"${href.replace(/\//g, "\\/")}"`));
    }
  });

  it("MaterialsTabs links to every Materials subroute", () => {
    const src = readComponent("materials-tabs.tsx");
    for (const href of [
      "/packaging-inventory",
      "/active-rolls",
      "/roll-management",
      "/material-alerts",
    ]) {
      expect(src).toMatch(new RegExp(`href:\\s*"${href.replace(/\//g, "\\/")}"`));
    }
  });

  it("MetricsTabs links to every Metrics subroute", () => {
    const src = readComponent("metrics-tabs.tsx");
    for (const href of [
      "/metrics",
      "/reports",
      "/production-capacity",
      "/roll-variance",
    ]) {
      expect(src).toMatch(new RegExp(`href:\\s*"${href.replace(/\//g, "\\/")}"`));
    }
  });
});
