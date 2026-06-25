// D-3 · BOM dispatcher behavior contracts (audit-only).
//
// Pins the CURRENT behavior of:
//   - sourceAllocationBuildOptsForProduct (consolidated / cron enqueue path)
//   - buildAdminPreviewSourceAllocationOpts (admin preview action)
//
// These mirrors must stay in sync with production dispatchers until a
// shared helper lands in D-4. If production logic changes, update both.

import { describe, expect, it } from "vitest";
import { readRepoSource } from "@/lib/test/source-scan";
import {
  deriveNormalizedBomQuantitiesFromRows,
  type DeriveNormalizedBomQuantitiesResult,
} from "@/lib/zoho/derive-normalized-bom-quantities";
import {
  chocoDriftSourceAllocationBuildOpts,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import {
  fixRelaxSourceAllocationBuildOpts,
  FIX_RELAX_SKU,
  isFixRelaxSku,
} from "@/lib/zoho/v1206-fix-relax-pilot-contract";
import {
  isSweetTripSku,
  sweetTripSourceAllocationBuildOpts,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

const CONSOLIDATED_PATH = "lib/db/queries/zoho-production-output-consolidated.ts";
const ADMIN_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";

const UNKNOWN_SKU = "tt-product-unknown-d3";
const FIX_RELAX_PRODUCT_ID = "95c61efe-a36a-44df-8fee-8e66d659ed80";

type AllocOpts = {
  resolveBatches: boolean;
  normalizedBomQuantities?: Record<string, number>;
  batchTrackedItemIds?: Set<string>;
};

type ConsolidatedResolution =
  | { ok: true; opts: AllocOpts }
  | { ok: false; blockers: Array<{ code: string; field: string; message: string }> };

type AdminResolution =
  | {
      ok: true;
      opts: AllocOpts;
      warnings: Array<{ code: string; field: string; message: string }>;
      source: "luma" | "pilot" | "default";
    }
  | { ok: false; blockers: Array<{ code: string; field: string; message: string }> };

function batchResolveFlag(): boolean {
  return process.env.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true";
}

/** Mirror of sourceAllocationBuildOptsForProduct as of v1.5.22. */
function consolidatedDispatch(
  productId: string | null,
  sku: string,
  derived: DeriveNormalizedBomQuantitiesResult,
): ConsolidatedResolution {
  if (productId) {
    if (derived.ok) {
      return {
        ok: true,
        opts: {
          resolveBatches: batchResolveFlag(),
          normalizedBomQuantities: derived.normalizedBomQuantities,
          batchTrackedItemIds: derived.batchTrackedItemIds,
        },
      };
    }
    if (!isChocoDriftSku(sku) && !isFixRelaxSku(sku) && !isSweetTripSku(sku)) {
      return { ok: false, blockers: derived.blockers };
    }
  }
  if (isChocoDriftSku(sku)) return { ok: true, opts: chocoDriftSourceAllocationBuildOpts() };
  if (isFixRelaxSku(sku)) return { ok: true, opts: fixRelaxSourceAllocationBuildOpts() };
  if (isSweetTripSku(sku)) return { ok: true, opts: sweetTripSourceAllocationBuildOpts() };
  return {
    ok: true,
    opts: {
      resolveBatches: batchResolveFlag(),
    },
  };
}

/** Mirror of buildAdminPreviewSourceAllocationOpts as of v1.5.22. */
function adminDispatch(
  _productId: string,
  sku: string,
  derived: DeriveNormalizedBomQuantitiesResult,
): AdminResolution {
  if (derived.ok) {
    return {
      ok: true,
      source: "luma",
      warnings: derived.warnings,
      opts: {
        resolveBatches: batchResolveFlag(),
        normalizedBomQuantities: derived.normalizedBomQuantities,
        batchTrackedItemIds: derived.batchTrackedItemIds,
      },
    };
  }
  if (isChocoDriftSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: chocoDriftSourceAllocationBuildOpts(),
    };
  }
  if (isFixRelaxSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: fixRelaxSourceAllocationBuildOpts(),
    };
  }
  if (isSweetTripSku(sku)) {
    return {
      ok: true,
      source: "pilot",
      warnings: [],
      opts: sweetTripSourceAllocationBuildOpts(),
    };
  }
  return { ok: false, blockers: derived.blockers };
}

function sliceDispatcherBody(src: string, fnName: string): string {
  const start = src.indexOf(`async function ${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  const nextFn = src.indexOf("\nasync function ", start + 1);
  const nextImport = src.indexOf("\nimport {", start + 1);
  const endCandidates = [nextFn, nextImport].filter((i) => i > start);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : src.length;
  return src.slice(start, end);
}

const configuredProductDerived = deriveNormalizedBomQuantitiesFromRows({
  product: { id: "prod-configured", tabletsPerUnit: 2 },
  allowedTablets: [
    {
      tabletTypeId: "tab-1",
      tabletTypeName: "Primary",
      zohoItemId: "5254962000001111111",
      isPrimary: true,
    },
  ],
});

const missingSetupDerived = deriveNormalizedBomQuantitiesFromRows({
  product: { id: "prod-incomplete", tabletsPerUnit: null },
  allowedTablets: [],
});

describe("D-3 call-site contracts", () => {
  it("consolidated dispatcher has one runtime call site in upsertConsolidatedProductionOutputOpForLot", () => {
    const src = readRepoSource(CONSOLIDATED_PATH);
    expect(src.match(/await sourceAllocationBuildOptsForProduct\(/g)?.length).toBe(1);
    expect(src).toMatch(
      /const derivedOptsResolution = await sourceAllocationBuildOptsForProduct\(\s*lotRow\?\.productId \?\? null,/,
    );
  });

  it("admin dispatcher has one runtime call site in previewZohoProductionOutputAction", () => {
    const src = readRepoSource(ADMIN_PATH);
    expect(src.match(/await buildAdminPreviewSourceAllocationOpts\(/g)?.length).toBe(1);
    expect(src).toMatch(
      /const allocResolution = await buildAdminPreviewSourceAllocationOpts\(\s*lot\.product\.id,/,
    );
  });

  it("consolidated enqueue path is wired from lot-create and cron commit flows", () => {
    const enqueueSrc = readRepoSource("lib/zoho/enqueue-production-output-after-lot-create.ts");
    expect(enqueueSrc).toMatch(/upsertConsolidatedProductionOutputOpForLot/);
  });
});

describe("D-3 structural difference contracts", () => {
  it("consolidated accepts nullable productId; admin requires a string productId", () => {
    const consolidatedFn = sliceDispatcherBody(
      readRepoSource(CONSOLIDATED_PATH),
      "sourceAllocationBuildOptsForProduct",
    );
    const adminFn = sliceDispatcherBody(
      readRepoSource(ADMIN_PATH),
      "buildAdminPreviewSourceAllocationOpts",
    );
    expect(consolidatedFn).toMatch(/productId: string \| null/);
    expect(adminFn).toMatch(/productId: string,/);
    expect(adminFn).not.toMatch(/productId: string \| null/);
  });

  it("admin resolution carries source + warnings; consolidated resolution does not", () => {
    const adminFn = sliceDispatcherBody(
      readRepoSource(ADMIN_PATH),
      "buildAdminPreviewSourceAllocationOpts",
    );
    const consolidatedFn = sliceDispatcherBody(
      readRepoSource(CONSOLIDATED_PATH),
      "sourceAllocationBuildOptsForProduct",
    );
    expect(adminFn).toMatch(/source: "luma"/);
    expect(adminFn).toMatch(/source: "pilot"/);
    expect(adminFn).toMatch(/warnings:/);
    expect(consolidatedFn).not.toMatch(/source: "luma"/);
    expect(consolidatedFn).not.toMatch(/warnings:/);
  });

  it("consolidated retains generic resolveBatches-only fallback; admin returns derivation blockers instead", () => {
    const consolidatedFn = sliceDispatcherBody(
      readRepoSource(CONSOLIDATED_PATH),
      "sourceAllocationBuildOptsForProduct",
    );
    const adminFn = sliceDispatcherBody(
      readRepoSource(ADMIN_PATH),
      "buildAdminPreviewSourceAllocationOpts",
    );
    expect(consolidatedFn).toMatch(
      /return \{\s*ok: true,\s*opts: \{\s*resolveBatches: process\.env\.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true",\s*\},\s*\};/,
    );
    expect(adminFn).toMatch(/return \{ ok: false, blockers: derived\.blockers \}/);
    expect(adminFn).not.toMatch(/resolveBatches: process\.env\.ZOHO_PRODUCTION_OUTPUT_BATCH_RESOLVE === "true",\s*\},\s*\};/);
  });

  it("consolidated returns derivation blockers when productId is set and SKU is not a pilot", () => {
    const consolidatedFn = sliceDispatcherBody(
      readRepoSource(CONSOLIDATED_PATH),
      "sourceAllocationBuildOptsForProduct",
    );
    expect(consolidatedFn).toMatch(
      /if \(!isChocoDriftSku\(sku\) && !isFixRelaxSku\(sku\) && !isSweetTripSku\(sku\)\)/,
    );
    expect(consolidatedFn).toMatch(/return \{ ok: false, blockers: derived\.blockers \}/);
  });
});

describe("D-3 scenario matrix — configured product (Luma derivation succeeds)", () => {
  it("both paths return equivalent opts when derivation succeeds", () => {
    expect(configuredProductDerived.ok).toBe(true);
    if (!configuredProductDerived.ok) return;

    const consolidated = consolidatedDispatch(
      "prod-configured",
      UNKNOWN_SKU,
      configuredProductDerived,
    );
    const admin = adminDispatch("prod-configured", UNKNOWN_SKU, configuredProductDerived);

    expect(consolidated.ok).toBe(true);
    expect(admin.ok).toBe(true);
    if (!consolidated.ok || !admin.ok) return;

    expect(consolidated.opts.normalizedBomQuantities).toEqual(
      admin.opts.normalizedBomQuantities,
    );
    expect(consolidated.opts.resolveBatches).toBe(admin.opts.resolveBatches);
    expect(admin.source).toBe("luma");
  });
});

describe("D-3 scenario matrix — missing setup, non-pilot SKU", () => {
  it("admin preview blocks with derivation blockers", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const admin = adminDispatch("prod-incomplete", UNKNOWN_SKU, missingSetupDerived);
    expect(admin.ok).toBe(false);
    if (admin.ok) return;
    expect(admin.blockers.some((b) => b.code === "MISSING_TABLETS_PER_UNIT")).toBe(true);
  });

  it("consolidated blocks when productId is present and SKU is not a pilot", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const consolidated = consolidatedDispatch(
      "prod-incomplete",
      UNKNOWN_SKU,
      missingSetupDerived,
    );
    expect(consolidated.ok).toBe(false);
    if (consolidated.ok) return;
    expect(consolidated.blockers.some((b) => b.code === "MISSING_TABLETS_PER_UNIT")).toBe(
      true,
    );
  });

  it("consolidated generic-fallback succeeds when productId is null (admin path cannot reach this state)", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const consolidated = consolidatedDispatch(null, UNKNOWN_SKU, missingSetupDerived);
    expect(consolidated.ok).toBe(true);
    if (!consolidated.ok) return;
    expect(consolidated.opts.normalizedBomQuantities).toBeUndefined();
    expect(consolidated.opts.resolveBatches).toBe(batchResolveFlag());

    const admin = adminDispatch("prod-incomplete", UNKNOWN_SKU, missingSetupDerived);
    expect(admin.ok).toBe(false);
  });
});

describe("D-3 scenario matrix — v1206 pilot fallback (derivation fails)", () => {
  it("both paths use FIX Relax pilot opts when derivation fails", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const consolidated = consolidatedDispatch(
      FIX_RELAX_PRODUCT_ID,
      FIX_RELAX_SKU,
      missingSetupDerived,
    );
    const admin = adminDispatch(FIX_RELAX_PRODUCT_ID, FIX_RELAX_SKU, missingSetupDerived);

    expect(consolidated.ok).toBe(true);
    expect(admin.ok).toBe(true);
    if (!consolidated.ok || !admin.ok) return;

    expect(consolidated.opts).toEqual(fixRelaxSourceAllocationBuildOpts());
    expect(admin.opts).toEqual(fixRelaxSourceAllocationBuildOpts());
    expect(admin.source).toBe("pilot");
  });

  it("consolidated pilot fallback works even when productId is null", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const consolidated = consolidatedDispatch(null, FIX_RELAX_SKU, missingSetupDerived);
    expect(consolidated.ok).toBe(true);
    if (!consolidated.ok) return;
    expect(consolidated.opts).toEqual(fixRelaxSourceAllocationBuildOpts());
  });
});

describe("D-3 non-equivalence verdict", () => {
  it("paths diverge on null productId + unknown SKU (consolidated generic fallback vs admin blockers)", () => {
    expect(missingSetupDerived.ok).toBe(false);
    if (missingSetupDerived.ok) return;

    const consolidated = consolidatedDispatch(null, UNKNOWN_SKU, missingSetupDerived);
    const admin = adminDispatch("prod-incomplete", UNKNOWN_SKU, missingSetupDerived);

    expect(consolidated.ok).toBe(true);
    expect(admin.ok).toBe(false);
  });

  it("paths diverge on return shape even when opts match (admin exposes source/warnings)", () => {
    expect(configuredProductDerived.ok).toBe(true);
    if (!configuredProductDerived.ok) return;

    const admin = adminDispatch("prod-configured", UNKNOWN_SKU, configuredProductDerived);
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    expect(admin.source).toBe("luma");
    expect(Array.isArray(admin.warnings)).toBe(true);
  });
});
