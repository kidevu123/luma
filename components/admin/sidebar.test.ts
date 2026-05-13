// QC-4 — sidebar invariants.
//
// Server-component scan: sidebar.tsx is a "use client" file, so we
// can't import it directly under the node vitest env without React
// runtime. Instead, parse the file as text and assert the structural
// invariants — that's the actual contract we need: /qc-review is
// registered under Production with the QC Review label.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

describe("admin sidebar registers /qc-review under Production", () => {
  it("/qc-review entry exists", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/qc-review"/);
  });
  it("uses the QC Review label", () => {
    expect(sidebarSrc).toMatch(/"QC review"/);
  });
  it("the entry sits inside the Production intelligence heading group", () => {
    const headingAt = sidebarSrc.indexOf('heading: "Production intelligence"');
    const qcAt = sidebarSrc.indexOf('"/qc-review"');
    expect(headingAt).toBeGreaterThan(-1);
    expect(qcAt).toBeGreaterThan(headingAt);
    // and qcAt is before the next heading marker (Materials)
    const materialsAt = sidebarSrc.indexOf('heading: "Materials"');
    expect(materialsAt).toBeGreaterThan(qcAt);
  });
  it("does NOT introduce any of the QC banned phrases (per data-honesty rules)", () => {
    // Per QC-0: no "production loss" labels for receipt variance, no
    // "supplier shortage" labels for cycle-count variance. Sidebar is
    // a tiny surface; spot-check it stays clean.
    expect(sidebarSrc).not.toMatch(/production loss/i);
    expect(sidebarSrc).not.toMatch(/supplier shortage/i);
  });
});
