// DYNAMIC-BOM-DERIVATION-v1.4.4 — source-level contract tests.
//
// Pin the cross-file invariants of the BOM-derivation refactor:
//
//   1. Both dispatchers (admin preview + consolidated) call
//      deriveNormalizedBomQuantitiesForProduct BEFORE any pilot
//      predicate.
//   2. No new per-SKU pilot has been added (no isBlueRazSku,
//      no BLUERAZ_RAW_TABLET_ITEM_ID, no blueRazSourceAllocationBuildOpts).
//   3. Each existing pilot's allocation helper has the v1.4.4
//      deprecation notice.
//   4. The new helper module never reads from a hard-coded SKU /
//      raw-item-id constant — its logic is purely product-data
//      driven.
//   5. Neither dispatcher introduces a new `ZOHO_*_ENABLED` env
//      reference (no live-write gate change in this patch).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const DERIVER_PATH = "lib/zoho/derive-normalized-bom-quantities.ts";
const ADMIN_ACTION_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";
const CONSOLIDATED_PATH = "lib/db/queries/zoho-production-output-consolidated.ts";
const PILOT_FILES = [
  "lib/zoho/v1206-choco-drift-pilot-contract.ts",
  "lib/zoho/v1206-fix-relax-pilot-contract.ts",
  "lib/zoho/v1206-sweet-trip-pilot-contract.ts",
];

describe("Both dispatchers derive from Luma product data FIRST, then fall back to pilots", () => {
  it("admin preview action imports deriveNormalizedBomQuantitiesForProduct", () => {
    const src = read(ADMIN_ACTION_PATH);
    expect(src).toMatch(
      /import\s*\{\s*deriveNormalizedBomQuantitiesForProduct\s*\}\s*from\s*"@\/lib\/zoho\/derive-normalized-bom-quantities"/,
    );
  });

  it("consolidated path imports deriveNormalizedBomQuantitiesForProduct", () => {
    const src = read(CONSOLIDATED_PATH);
    expect(src).toMatch(
      /import\s*\{\s*deriveNormalizedBomQuantitiesForProduct\s*\}\s*from\s*"@\/lib\/zoho\/derive-normalized-bom-quantities"/,
    );
  });

  it("admin dispatcher calls the deriver BEFORE any isXxxSku predicate", () => {
    const src = read(ADMIN_ACTION_PATH);
    const deriveIdx = src.indexOf("await deriveNormalizedBomQuantitiesForProduct(");
    const firstPilotIdx = Math.min(
      ...["isChocoDriftSku(", "isFixRelaxSku(", "isSweetTripSku("]
        .map((s) => src.indexOf(s))
        .filter((i) => i > -1),
    );
    expect(deriveIdx).toBeGreaterThan(-1);
    expect(firstPilotIdx).toBeGreaterThan(deriveIdx);
  });

  it("consolidated dispatcher calls the deriver BEFORE any isXxxSku predicate", () => {
    const src = read(CONSOLIDATED_PATH);
    const deriveIdx = src.indexOf(
      "await deriveNormalizedBomQuantitiesForProduct(",
    );
    expect(deriveIdx).toBeGreaterThan(-1);
    // sourceAllocationBuildOptsForProduct is the new dispatcher;
    // pilot predicates inside it must appear AFTER the deriver call.
    const dispatcherStart = src.indexOf(
      "async function sourceAllocationBuildOptsForProduct(",
    );
    expect(dispatcherStart).toBeGreaterThan(-1);
    const inDispatcher = src.slice(dispatcherStart, dispatcherStart + 4000);
    const inDispatcherDeriveIdx = inDispatcher.indexOf(
      "await deriveNormalizedBomQuantitiesForProduct(",
    );
    const inDispatcherFirstPilotIdx = Math.min(
      ...["isChocoDriftSku(", "isFixRelaxSku(", "isSweetTripSku("]
        .map((s) => inDispatcher.indexOf(s))
        .filter((i) => i > -1),
    );
    expect(inDispatcherDeriveIdx).toBeGreaterThan(-1);
    expect(inDispatcherFirstPilotIdx).toBeGreaterThan(inDispatcherDeriveIdx);
  });
});

describe("No new per-SKU pilot was added for BlueRaz", () => {
  // Forbidden patterns — these must not appear anywhere in the
  // dispatcher / deriver / pilot files. If anyone adds a BlueRaz
  // pilot in the future, this test fails and forces them through
  // the data-driven path instead.
  const FORBIDDEN = [
    /isBlueRazSku/,
    /BLUERAZ_RAW_TABLET_ITEM_ID/,
    /blueRazSourceAllocationBuildOpts/,
    /\bblue[-_]?raz\s*pilot[-_]?contract\b/i,
  ];

  const FILES_TO_GUARD = [
    DERIVER_PATH,
    ADMIN_ACTION_PATH,
    CONSOLIDATED_PATH,
    ...PILOT_FILES,
  ];

  it.each(FORBIDDEN.map((p) => p.source))("no source file matches %s", (pat) => {
    const re = new RegExp(pat);
    for (const f of FILES_TO_GUARD) {
      expect(read(f)).not.toMatch(re);
    }
  });

  it("no new v1206-*-pilot-contract.ts file mentions tt-product-30 or 5254962000002266128", () => {
    for (const f of PILOT_FILES) {
      const src = read(f);
      expect(src).not.toMatch(/tt-product-30/);
      expect(src).not.toMatch(/5254962000002266128/);
    }
  });
});

describe("Existing pilots are flagged as deprecated", () => {
  it.each(PILOT_FILES)("%s carries the v1.4.4 deprecation notice", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/@deprecated[\s\S]+DYNAMIC-BOM-DERIVATION-v1\.4\.4/);
  });
});

describe("The new deriver does not hard-code any SKU / item ID", () => {
  // The deriver must be SKU-agnostic. The two BlueRaz strings appear
  // in tests but never in the production code path.
  it("derive-normalized-bom-quantities.ts has no SKU/item-id literals in CODE (comments may name historical context)", () => {
    const src = read(DERIVER_PATH);
    // Strip comments and JSDoc so the assertion is about real code,
    // not historical-context narrative. Comments are allowed to
    // mention SKUs / item IDs for explanatory purposes — what matters
    // is that no executable code branches on them.
    const code = src
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/tt-product-\d+/);
    expect(code).not.toMatch(/52549620000\d+/);
    expect(code).not.toMatch(/BlueRaz/i);
    expect(code).not.toMatch(/HYROXI/i);
    expect(code).not.toMatch(/ChocoDrift/i);
    expect(code).not.toMatch(/SweetTrip/i);
    expect(code).not.toMatch(/FixRelax/i);
  });

  it("derive-normalized-bom-quantities.ts has no hard-coded tabletsPerUnit value", () => {
    const src = read(DERIVER_PATH);
    // Strip comments + JSDoc; assertion is on real code only.
    const code = src
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // The literal 4 should not appear as a value in derivation code.
    // We allow it inside the test file but the deriver itself must
    // read tabletsPerUnit from the product row, not hard-code it.
    const literalAssignments = code.match(/=\s*4\b/g) ?? [];
    expect(literalAssignments.length).toBe(0);
  });
});

describe("No live-write gate references introduced by v1.4.4", () => {
  const FILES = [
    DERIVER_PATH,
    ADMIN_ACTION_PATH,
    // CONSOLIDATED_PATH legitimately reads commit gates for its
    // existing v1.20.6 commit-blocked behavior; not the deriver's
    // responsibility to assert this.
  ];

  it.each(FILES)("%s does not flip any ZOHO_*_ENABLED env var", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/ZOHO_AUTO_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED/);
    expect(src).not.toMatch(/ZOHO_DRY_RUN_WRITES_ENABLED/);
  });
});

describe("Specific blockers replace generic BOM_QUANTITY_PENDING", () => {
  it("the deriver emits the three specific codes by name", () => {
    const src = read(DERIVER_PATH);
    expect(src).toMatch(/"MISSING_TABLETS_PER_UNIT"/);
    expect(src).toMatch(/"MISSING_ALLOWED_TABLETS"/);
    expect(src).toMatch(/"MISSING_TABLET_ZOHO_ITEM_ID"/);
  });

  it("the deriver does not emit the generic BOM_QUANTITY_PENDING code (that comes from the downstream builder when neither path produces opts)", () => {
    const src = read(DERIVER_PATH);
    expect(src).not.toMatch(/"BOM_QUANTITY_PENDING"/);
  });
});
