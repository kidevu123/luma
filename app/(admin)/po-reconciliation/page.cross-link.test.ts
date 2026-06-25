// PO-RECON-CROSS-LINK — v1.5.9 relabel.
//
// /po-reconciliation and /po-reconciliation-v2 are different lenses on the
// same domain, not legacy-vs-current. v1 is the per-PO summary lens; v2 is
// the multi-scope variance lens. This test pins the non-misleading cross-link
// copy in both directions and the active sidebar label.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const v1Src = readFileSync(resolve(here, "page.tsx"), "utf8");
const v2Src = readFileSync(resolve(here, "../po-reconciliation-v2/page.tsx"), "utf8");
const navSrc = readFileSync(
  resolve(here, "../../../lib/auth/admin-nav.ts"),
  "utf8",
);

describe("PO-RECON-CROSS-LINK · cross-link wording (v1.5.9)", () => {
  it("v1 page links to v2 as 'Multi-scope variance lens'", () => {
    expect(v1Src).toMatch(/Multi-scope variance lens/);
    expect(v1Src).not.toMatch(/New 8-bucket view/);
  });

  it("v2 page links back to v1 as 'Per-PO lens'", () => {
    expect(v2Src).toMatch(/Per-PO lens/);
    expect(v2Src).not.toMatch(/legacy PO reconciliation/);
  });

  it("v1 page still owns the canonical /po-reconciliation route", () => {
    expect(v1Src).toMatch(/href="\/po-reconciliation-v2"/);
    expect(navSrc).toMatch(/href:\s*"\/po-reconciliation"/);
  });
});
