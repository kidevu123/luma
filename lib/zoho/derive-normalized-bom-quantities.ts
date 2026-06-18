// DYNAMIC-BOM-DERIVATION-v1.4.4 — derive normalizedBomQuantities from
// Luma product setup data, replacing the per-SKU pilot-contract
// dependency for production-output source allocation.
//
// What it returns
// ===============
//
// `normalizedBomQuantities` is a Record<tabletZohoItemId, tabletsPerUnit>
// consumed by buildSourceAllocationsForFinishedLot
// (lib/zoho/production-output-source-allocations.ts:343-358). Without
// a non-empty value for a given raw tablet's Zoho item ID, the builder
// emits BOM_QUANTITY_PENDING.
//
// Where the data lives
// ====================
//
//   - products.tablets_per_unit                        — int per Single
//   - product_allowed_tablets(product_id, tablet_type_id)
//                                                       — allowed
//                                                         tablet types
//                                                         (primary +
//                                                         secondary)
//   - tablet_types.zoho_item_id                        — raw item ID
//
// For every row in product_allowed_tablets joined with tablet_types
// that has a non-null zoho_item_id, we emit
// { [tablet_types.zoho_item_id]: products.tablets_per_unit }. Both
// primary AND non-primary tablets are included — the allocation
// builder only looks up tabletZohoItemIds that actually appear in
// closed allocation sessions for the lot, so unused secondary
// suppliers cause no harm.
//
// Why no per-SKU contracts
// ========================
//
// Pre-v1.4.4 the dispatcher hard-coded BOM per SKU in
// lib/zoho/v1206-{choco-drift,sweet-trip,fix-relax}-pilot-contract.ts.
// New products required a code change to the dispatcher PLUS a new
// pilot file. That was the v1.4.2 BlueRaz #36 blocker. The fix is to
// READ THE DATA that already exists in the product setup tables
// instead of duplicating it in TypeScript. Existing pilots remain as
// a transition fallback only and are NOT extended with new SKUs.
//
// Failure modes (specific, operator-actionable)
// =============================================
//
// Instead of the generic BOM_QUANTITY_PENDING, this helper returns
// field-level blockers that tell operators exactly where to fix the
// setup:
//
//   MISSING_TABLETS_PER_UNIT       products.tablets_per_unit is NULL
//   MISSING_ALLOWED_TABLETS        no rows in product_allowed_tablets
//   MISSING_TABLET_ZOHO_ITEM_ID    one or more allowed tablet_types
//                                   have NULL zoho_item_id
//
// The dispatcher will surface these directly as PAYLOAD_BLOCKED
// blockers in the admin preview action, replacing the generic
// gateway-level BOM_QUANTITY_PENDING with a Luma-specific
// admin-fixable blocker.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productAllowedTablets,
  products,
  tabletTypes,
} from "@/lib/db/schema";

export type DeriveNormalizedBomQuantitiesBlocker = {
  code:
    | "MISSING_TABLETS_PER_UNIT"
    | "MISSING_ALLOWED_TABLETS"
    | "MISSING_TABLET_ZOHO_ITEM_ID";
  field: string;
  message: string;
};

export type DeriveNormalizedBomQuantitiesResult =
  | {
      ok: true;
      normalizedBomQuantities: Record<string, number>;
      /** Same item IDs as keys of normalizedBomQuantities. Kept as a
       *  Set so the source-allocation builder can use it as the
       *  batchTrackedItemIds opt without re-iterating. */
      batchTrackedItemIds: Set<string>;
      /** Tablet types that were excluded because their zoho_item_id
       *  was NULL. Reported as a non-blocking warning so operators
       *  can clean these up over time. Empty when all allowed
       *  tablets had a Zoho item ID. */
      warnings: Array<{ code: string; field: string; message: string }>;
    }
  | {
      ok: false;
      blockers: DeriveNormalizedBomQuantitiesBlocker[];
    };

/**
 * Pure derivation from a pre-loaded product row + allowed-tablet rows.
 * Tests exercise this directly with fixtures; the DB-backed entry
 * point below loads the rows and delegates here.
 */
export function deriveNormalizedBomQuantitiesFromRows(input: {
  product: { id: string; tabletsPerUnit: number | null };
  allowedTablets: Array<{
    tabletTypeId: string;
    tabletTypeName: string | null;
    zohoItemId: string | null;
    isPrimary: boolean;
  }>;
}): DeriveNormalizedBomQuantitiesResult {
  const { product, allowedTablets } = input;
  const blockers: DeriveNormalizedBomQuantitiesBlocker[] = [];

  if (product.tabletsPerUnit == null) {
    blockers.push({
      code: "MISSING_TABLETS_PER_UNIT",
      field: "products.tablets_per_unit",
      message:
        "Set tablets per unit on the product before running the production-output preview. Edit on /products/" +
        product.id +
        ".",
    });
  } else if (product.tabletsPerUnit <= 0) {
    blockers.push({
      code: "MISSING_TABLETS_PER_UNIT",
      field: "products.tablets_per_unit",
      message:
        "tablets_per_unit must be a positive integer; saw " +
        String(product.tabletsPerUnit) +
        ". Edit on /products/" +
        product.id +
        ".",
    });
  }

  if (allowedTablets.length === 0) {
    blockers.push({
      code: "MISSING_ALLOWED_TABLETS",
      field: "product_allowed_tablets",
      message:
        "Add at least one allowed tablet type for this product before running the production-output preview. Edit on /products/" +
        product.id +
        ".",
    });
  }

  const withZohoId = allowedTablets.filter(
    (t) => t.zohoItemId != null && t.zohoItemId.length > 0,
  );
  const withoutZohoId = allowedTablets.filter(
    (t) => t.zohoItemId == null || t.zohoItemId.length === 0,
  );

  // If there is at least one allowed tablet but none has a Zoho ID,
  // that's a hard blocker — the source-allocation builder can't look
  // up any consumption. If some have IDs and some don't, the
  // missing ones become a non-blocking warning (the lookup just
  // won't find them in any allocation session).
  if (allowedTablets.length > 0 && withZohoId.length === 0) {
    const names = allowedTablets
      .map((t) => t.tabletTypeName ?? t.tabletTypeId)
      .join(", ");
    blockers.push({
      code: "MISSING_TABLET_ZOHO_ITEM_ID",
      field: "tablet_types.zoho_item_id",
      message:
        "No allowed tablet type has a Zoho item ID. Set zoho_item_id on the tablet type(s): " +
        names +
        ". Edit on /tablet-types.",
    });
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  // tabletsPerUnit is non-null and > 0 here (would have blocked otherwise).
  const tabletsPerUnit = product.tabletsPerUnit as number;

  const normalizedBomQuantities: Record<string, number> = {};
  const batchTrackedItemIds = new Set<string>();
  for (const t of withZohoId) {
    const id = t.zohoItemId as string;
    normalizedBomQuantities[id] = tabletsPerUnit;
    batchTrackedItemIds.add(id);
  }

  const warnings = withoutZohoId.map((t) => ({
    code: "ALLOWED_TABLET_WITHOUT_ZOHO_ITEM_ID",
    field: "tablet_types.zoho_item_id",
    message:
      "Allowed tablet '" +
      (t.tabletTypeName ?? t.tabletTypeId) +
      "' has no Zoho item ID. Its consumption will not be included in source allocations. Set zoho_item_id on /tablet-types/" +
      t.tabletTypeId +
      " to enable.",
  }));

  return {
    ok: true,
    normalizedBomQuantities,
    batchTrackedItemIds,
    warnings,
  };
}

/**
 * DB-backed entry point. Loads products + product_allowed_tablets +
 * tablet_types, then delegates to the pure helper above. Used by
 * both the admin preview action and the consolidated path.
 */
export async function deriveNormalizedBomQuantitiesForProduct(
  productId: string,
): Promise<DeriveNormalizedBomQuantitiesResult> {
  const [product] = await db
    .select({
      id: products.id,
      tabletsPerUnit: products.tabletsPerUnit,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) {
    return {
      ok: false,
      blockers: [
        {
          code: "MISSING_ALLOWED_TABLETS",
          field: "products.id",
          message: "Product not found: " + productId,
        },
      ],
    };
  }

  const allowed = await db
    .select({
      tabletTypeId: productAllowedTablets.tabletTypeId,
      isPrimary: productAllowedTablets.isPrimary,
      tabletTypeName: tabletTypes.name,
      zohoItemId: tabletTypes.zohoItemId,
    })
    .from(productAllowedTablets)
    .innerJoin(
      tabletTypes,
      eq(tabletTypes.id, productAllowedTablets.tabletTypeId),
    )
    .where(eq(productAllowedTablets.productId, productId));

  return deriveNormalizedBomQuantitiesFromRows({
    product,
    allowedTablets: allowed,
  });
}
