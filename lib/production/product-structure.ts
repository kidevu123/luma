// Phase H.x0.5 — Generic product structure helpers.
//
// Answers the questions:
//   • What does this product convert from / into?
//   • To make N units of output X, how many units of input Y do I need?
//   • What materials and how much of each are required?
//
// All functions return MetricResult-shaped values, so callers always
// know whether the answer is real, partial, or missing. Nothing here
// hardcodes pill / card / bottle. The math walks item_conversions and
// product_packaging_specs; if those are not configured, every helper
// returns a `missing()` MetricResult with a canonical empty-state
// label that the UI can render as-is.

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  itemConversions,
  items,
  productPackagingSpecs,
  productionRoutes,
  packagingMaterials,
  blisterMaterialStandards,
  products,
  productRouteAssignments,
} from "@/lib/db/schema";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure-math primitives ───────────────────────────────────────────
// Exported so the test suite can pin them without touching the DB.

export type ConversionStep = {
  parentItemId: string;
  parentItemCode: string;
  parentName: string;
  parentPackLevel: string;
  parentQty: number;
  parentUom: string;
  childItemId: string;
  childItemCode: string;
  childName: string;
  childPackLevel: string;
  childQty: number;
  childUom: string;
};

export type ProductStructureView = {
  productId: string;
  steps: ReadonlyArray<ConversionStep>;
  /** Resolution metadata: did we find conversions or fall back? */
  source: "ITEM_CONVERSIONS" | "MISSING";
};

/** Multiply two numerics safely. Anything non-finite or NaN returns
 *  null, signalling the caller to surface a missing-input warning. */
export function safeMultiply(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || b < 0) return null;
  const v = a * b;
  return Number.isFinite(v) ? v : null;
}

/** Convert a parent quantity into the equivalent child quantity for a
 *  single conversion step. "1 case = 24 displays" with parent_qty=2
 *  → 48 displays. */
export function convertParentToChild(
  step: { parentQty: number; childQty: number },
  parentQuantity: number,
): number | null {
  if (step.parentQty <= 0) return null;
  if (parentQuantity < 0) return null;
  const ratio = step.childQty / step.parentQty;
  const v = parentQuantity * ratio;
  return Number.isFinite(v) ? v : null;
}

/** Inverse direction. "1 case = 24 displays" with childQty=120 →
 *  5 cases needed. Caller decides whether to ceil/floor; this helper
 *  returns the exact ratio. */
export function convertChildToParent(
  step: { parentQty: number; childQty: number },
  childQuantity: number,
): number | null {
  if (step.childQty <= 0) return null;
  if (childQuantity < 0) return null;
  const ratio = step.parentQty / step.childQty;
  const v = childQuantity * ratio;
  return Number.isFinite(v) ? v : null;
}

// ─── DB-backed helpers (always return MetricResult / View) ──────────

/** Returns the full conversion chain configured for a product, sorted
 *  by parent_pack_level so callers can present the chain in a sensible
 *  order (CASE → DISPLAY → UNIT → INTERMEDIATE → RAW). */
export async function deriveProductStructure(
  productId: string,
): Promise<ProductStructureView> {
  if (!productId) return { productId, steps: [], source: "MISSING" };
  const parentItems = items as typeof items;
  const childItems = items as typeof items;
  const rows = await db.execute<{
    parent_item_id: string;
    parent_item_code: string;
    parent_name: string;
    parent_pack_level: string;
    parent_qty: string;
    parent_uom: string;
    child_item_id: string;
    child_item_code: string;
    child_name: string;
    child_pack_level: string;
    child_qty: string;
    child_uom: string;
  }>(sql`
    SELECT
      ic.parent_item_id, p.item_code AS parent_item_code, p.name AS parent_name,
      ic.parent_pack_level, ic.parent_quantity::text AS parent_qty, ic.parent_unit_of_measure AS parent_uom,
      ic.child_item_id, c.item_code AS child_item_code, c.name AS child_name,
      ic.child_pack_level, ic.child_quantity::text AS child_qty, ic.child_unit_of_measure AS child_uom
    FROM item_conversions ic
    JOIN items p ON p.id = ic.parent_item_id
    JOIN items c ON c.id = ic.child_item_id
    WHERE ic.product_id = ${productId}
      AND ic.is_active = true
    ORDER BY
      CASE ic.parent_pack_level
        WHEN 'PALLET'        THEN 1
        WHEN 'CASE'          THEN 2
        WHEN 'DISPLAY'       THEN 3
        WHEN 'INNER_PACK'    THEN 4
        WHEN 'UNIT'          THEN 5
        WHEN 'INTERMEDIATE'  THEN 6
        WHEN 'COMPONENT'     THEN 7
        WHEN 'SELLABLE'      THEN 8
        WHEN 'FINISHED_GOOD' THEN 9
        WHEN 'RAW'           THEN 10
        ELSE 99
      END ASC
  `);
  void parentItems; void childItems;
  const list = rows as unknown as Array<Record<string, string>>;
  const steps: ConversionStep[] = list.map((r) => ({
    parentItemId: r.parent_item_id!,
    parentItemCode: r.parent_item_code!,
    parentName: r.parent_name!,
    parentPackLevel: r.parent_pack_level!,
    parentQty: Number(r.parent_qty),
    parentUom: r.parent_uom!,
    childItemId: r.child_item_id!,
    childItemCode: r.child_item_code!,
    childName: r.child_name!,
    childPackLevel: r.child_pack_level!,
    childQty: Number(r.child_qty),
    childUom: r.child_uom!,
  }));
  return {
    productId,
    steps,
    source: steps.length > 0 ? "ITEM_CONVERSIONS" : "MISSING",
  };
}

/** Walks conversions starting from `itemId`, following parent → child
 *  links. Useful for "what does this finished-good break down into?" */
export async function deriveItemConversionChain(
  itemId: string,
): Promise<ConversionStep[]> {
  if (!itemId) return [];
  const result: ConversionStep[] = [];
  const visited = new Set<string>([itemId]);
  let cursor: string | null = itemId;
  let safety = 32;
  type ConvRow = {
    parentItemId: string;
    childItemId: string;
    parentQty: string;
    childQty: string;
    parentPackLevel: string;
    childPackLevel: string;
    parentUom: string;
    childUom: string;
  };
  while (cursor && safety-- > 0) {
    const next: ConvRow[] = await db
      .select({
        parentItemId: itemConversions.parentItemId,
        childItemId: itemConversions.childItemId,
        parentQty: itemConversions.parentQuantity,
        childQty: itemConversions.childQuantity,
        parentPackLevel: itemConversions.parentPackLevel,
        childPackLevel: itemConversions.childPackLevel,
        parentUom: itemConversions.parentUnitOfMeasure,
        childUom: itemConversions.childUnitOfMeasure,
      })
      .from(itemConversions)
      .where(
        and(
          eq(itemConversions.parentItemId, cursor),
          eq(itemConversions.isActive, true),
        ),
      )
      .limit(1);
    const step = next[0];
    if (!step) break;
    if (visited.has(step.childItemId)) break;
    visited.add(step.childItemId);
    const [parentMeta] = await db
      .select({ code: items.itemCode, name: items.name })
      .from(items)
      .where(eq(items.id, step.parentItemId))
      .limit(1);
    const [childMeta] = await db
      .select({ code: items.itemCode, name: items.name })
      .from(items)
      .where(eq(items.id, step.childItemId))
      .limit(1);
    if (!parentMeta || !childMeta) break;
    result.push({
      parentItemId: step.parentItemId,
      parentItemCode: parentMeta.code,
      parentName: parentMeta.name,
      parentPackLevel: step.parentPackLevel,
      parentQty: Number(step.parentQty),
      parentUom: step.parentUom,
      childItemId: step.childItemId,
      childItemCode: childMeta.code,
      childName: childMeta.name,
      childPackLevel: step.childPackLevel,
      childQty: Number(step.childQty),
      childUom: step.childUom,
    });
    cursor = step.childItemId;
  }
  return result;
}

/** Convert quantities between two items using the configured chain.
 *  Returns null + missing() when no path exists. */
export async function convertItemQuantity(
  fromItemId: string,
  toItemId: string,
  quantity: number,
): Promise<MetricResult> {
  if (!fromItemId || !toItemId) {
    return missing(null, ["item_id"], "Item not specified");
  }
  if (fromItemId === toItemId) {
    return ok(quantity, null, { explanation: "Same item; no conversion needed." });
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return missing(null, ["quantity"], "Invalid quantity");
  }
  // Forward chain: fromItem is parent, find a path of children to toItem.
  const chain = await deriveItemConversionChain(fromItemId);
  let cumulativeRatio = 1;
  let lastUom: string | null = null;
  for (const step of chain) {
    const ratio = step.childQty / step.parentQty;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return missing(null, ["item_conversions"], "Invalid conversion ratio");
    }
    cumulativeRatio *= ratio;
    lastUom = step.childUom;
    if (step.childItemId === toItemId) {
      return ok(quantity * cumulativeRatio, lastUom, {
        explanation: `${chain.length} step${chain.length === 1 ? "" : "s"} via item_conversions.`,
      });
    }
  }
  // No forward path. Try inverse: toItem might be parent of fromItem.
  const reverse = await deriveItemConversionChain(toItemId);
  let invRatio = 1;
  let invUom: string | null = null;
  for (const step of reverse) {
    const ratio = step.childQty / step.parentQty;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return missing(null, ["item_conversions"], "Invalid conversion ratio");
    }
    invRatio *= ratio;
    invUom = step.parentUom;
    if (step.childItemId === fromItemId) {
      // quantity is in fromItem (child) units; divide by cumulative ratio
      // to recover the parent equivalent.
      if (invRatio <= 0) {
        return missing(null, ["item_conversions"], "Invalid conversion ratio");
      }
      return ok(quantity / invRatio, invUom, {
        explanation: `Inverse path via item_conversions (${reverse.length} step${reverse.length === 1 ? "" : "s"}).`,
      });
    }
  }
  return missing(null, ["item_conversions"], "Product structure missing");
}

export type RequiredInputs = {
  product: MetricResult;
  inputs: ReadonlyArray<{
    itemId: string;
    itemCode: string;
    name: string;
    packLevel: string;
    requiredQuantity: MetricResult;
  }>;
};

/** Given a target output (e.g. "100 cases of Product X"), expand the
 *  conversion tree to compute every input required at every level.
 *
 *  Output order mirrors `deriveProductStructure` — broadest pack level
 *  first (cases) descending to raw inputs. Each input carries its
 *  own MetricResult so the UI can flag intermediate missing data
 *  without poisoning the whole tree. */
export async function deriveRequiredInputsForOutput(
  productId: string,
  outputQuantity: number,
  outputUnit: string,
): Promise<RequiredInputs> {
  if (!productId) {
    return {
      product: missing(outputUnit, ["product_id"], "Product not specified"),
      inputs: [],
    };
  }
  if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
    return {
      product: missing(outputUnit, ["quantity"], "Output quantity must be positive"),
      inputs: [],
    };
  }
  const structure = await deriveProductStructure(productId);
  if (structure.source === "MISSING") {
    return {
      product: missing(
        outputUnit,
        ["item_conversions"],
        "Product structure missing",
        "Configure item_conversions for this product before computing inputs.",
      ),
      inputs: [],
    };
  }
  // Walk steps top-down, multiplying by the ratio at each step. The
  // FIRST step's parent is the "output unit" (cases, etc.). Each
  // subsequent step expands the previous child further.
  let runningQty = outputQuantity;
  let runningUom = outputUnit;
  const inputs: Array<{
    itemId: string;
    itemCode: string;
    name: string;
    packLevel: string;
    requiredQuantity: MetricResult;
  }> = [];
  for (const step of structure.steps) {
    // The step's parent must match what we currently hold. If the
    // top step's parent UOM doesn't match the requested outputUnit,
    // we accept and rebadge — admins are expected to pick consistent
    // UOMs but bad data must not crash the calculator.
    const ratio = step.childQty / step.parentQty;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      inputs.push({
        itemId: step.childItemId,
        itemCode: step.childItemCode,
        name: step.childName,
        packLevel: step.childPackLevel,
        requiredQuantity: missing(
          step.childUom,
          ["item_conversions.parent_quantity"],
          "Conversion has zero parent quantity",
        ),
      });
      continue;
    }
    const child = runningQty * ratio;
    inputs.push({
      itemId: step.childItemId,
      itemCode: step.childItemCode,
      name: step.childName,
      packLevel: step.childPackLevel,
      requiredQuantity: ok(child, step.childUom),
    });
    runningQty = child;
    runningUom = step.childUom;
  }
  void runningUom;
  return {
    product: ok(outputQuantity, outputUnit, {
      explanation: `${structure.steps.length} conversion step${structure.steps.length === 1 ? "" : "s"} expanded.`,
    }),
    inputs,
  };
}

export type MaterialRequirement = {
  packagingMaterialId: string;
  materialName: string;
  materialKind: string;
  perScope: string;
  qtyRequired: MetricResult;
  wasteAllowancePct: number;
};

export type RouteScope = "UNIT" | "DISPLAY" | "CASE";

/** Derive packaging-material requirements for a target finished output.
 *  Reads product_packaging_specs and multiplies qty_per_unit by the
 *  appropriate scaling factor for the target's pack level.
 *
 *  Does NOT include PVC/foil consumption — that's covered by
 *  blister_material_standards which work per-blister, not per-case.
 *  Callers that need both should compose this output with the metric
 *  API's deriveRollUsage for the same product. */
export async function derivePackagingAndMaterialRequirements(
  productId: string,
  targetQuantity: number,
  targetUnit: string,
): Promise<{
  product: MetricResult;
  materials: ReadonlyArray<MaterialRequirement>;
  /** Combined confidence — MISSING if no BOM, MEDIUM if BOM has gaps,
   *  HIGH otherwise. */
  combined: Confidence;
}> {
  if (!productId) {
    return {
      product: missing(targetUnit, ["product_id"], "Product not specified"),
      materials: [],
      combined: "MISSING",
    };
  }
  if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
    return {
      product: missing(targetUnit, ["quantity"], "Target quantity must be positive"),
      materials: [],
      combined: "MISSING",
    };
  }
  const productExists = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productExists[0]) {
    return {
      product: missing(targetUnit, ["product"], "Product not found"),
      materials: [],
      combined: "MISSING",
    };
  }

  const bom = await db
    .select({
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
      wastePct: productPackagingSpecs.wasteAllowancePercent,
      name: packagingMaterials.name,
      kind: packagingMaterials.kind,
    })
    .from(productPackagingSpecs)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId),
    )
    .where(eq(productPackagingSpecs.productId, productId))
    .orderBy(asc(packagingMaterials.name));

  if (bom.length === 0) {
    return {
      product: missing(
        targetUnit,
        ["product_packaging_specs"],
        "Packaging BOM missing",
      ),
      materials: [],
      combined: "MISSING",
    };
  }

  // The BOM uses per-UNIT, per-DISPLAY, per-CASE multipliers. For a
  // target expressed in cases (the most common ask), the scaling is
  // simply targetQty for CASE, targetQty × unitsPerDisplay for
  // DISPLAY, and targetQty × unitsPerDisplay × displaysPerCase for
  // UNIT. We don't read products.units_per_display directly — the
  // BOM stores that information per scope so the helper stays
  // generic. If the per-scope is UNIT and the target is CASE, we
  // surface MEDIUM confidence + missingInput "case_to_unit_factor"
  // because we lack the precise scaling without item_conversions.
  const targetScope: RouteScope =
    targetUnit === "cases" ? "CASE" :
    targetUnit === "displays" ? "DISPLAY" :
    "UNIT";

  const requirements: MaterialRequirement[] = [];
  const partsConfidence: Confidence[] = [];

  for (const line of bom) {
    const wastePctNum = Number(line.wastePct ?? 0);
    const adjustedQtyPerScope = line.qtyPerUnit * (1 + wastePctNum / 100);
    let qtyValue: number | null = null;
    let confidenceForLine: Confidence = "HIGH";
    let inputsMissing: string[] = [];

    if (line.perScope === targetScope) {
      qtyValue = adjustedQtyPerScope * targetQuantity;
    } else {
      // Scope mismatch: we can't scale precisely without conversion
      // data. Mark MEDIUM and surface the missing input. The structure
      // helpers (item_conversions) eventually fill this gap.
      confidenceForLine = "MEDIUM";
      inputsMissing = [`scope_factor:${targetScope}_to_${line.perScope}`];
      qtyValue = adjustedQtyPerScope * targetQuantity;
    }

    requirements.push({
      packagingMaterialId: line.packagingMaterialId,
      materialName: line.name,
      materialKind: String(line.kind),
      perScope: line.perScope,
      qtyRequired:
        qtyValue == null
          ? missing("each", ["bom_qty"], "BOM line invalid")
          : confidenceForLine === "HIGH"
            ? ok(qtyValue, "each")
            : partial(qtyValue, "each", {
                missingInputs: inputsMissing,
                explanation: "Scope mismatch — exact scale requires item_conversions.",
              }),
      wasteAllowancePct: wastePctNum,
    });
    partsConfidence.push(confidenceForLine);
  }

  return {
    product: ok(targetQuantity, targetUnit, {
      explanation: `${bom.length} BOM line${bom.length === 1 ? "" : "s"} expanded.`,
    }),
    materials: requirements,
    combined: combineConfidence(partsConfidence),
  };
}

// ─── Compatibility shim for the rest of the system ─────────────────

/** Look up the items.id row for a polymorphic source (TABLET_TYPE,
 *  PRODUCT, PACKAGING_MATERIAL). Returns null if the items row was
 *  never backfilled — happens in tests with empty fixtures. */
export async function findItemBySource(
  sourceKind: "TABLET_TYPE" | "PACKAGING_MATERIAL" | "PRODUCT" | "STANDALONE",
  sourceId: string,
): Promise<string | null> {
  if (!sourceId) return null;
  const [row] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.sourceKind, sourceKind), eq(items.sourceId, sourceId)))
    .limit(1);
  return row?.id ?? null;
}

/** Resolves the route configured for a product via product_route_assignments.
 *  Used by the structure UI to disambiguate which conversion chain to
 *  use when a product has multiple routes (rare today). */
export async function resolveRouteForProduct(
  productId: string,
): Promise<{ routeId: string; routeCode: string } | null> {
  const [row] = await db
    .select({
      routeId: productionRoutes.id,
      routeCode: productionRoutes.code,
    })
    .from(productRouteAssignments)
    .innerJoin(
      productionRoutes,
      eq(productionRoutes.id, productRouteAssignments.routeId),
    )
    .where(
      and(
        eq(productRouteAssignments.productId, productId),
        eq(productRouteAssignments.isActive, true),
        eq(productRouteAssignments.isDefault, true),
      ),
    )
    .limit(1);
  return row ? { routeId: row.routeId, routeCode: row.routeCode } : null;
}

// Hold the (currently unused) blister-material-standards reference so
// future helpers (PVC/foil rollup per target) can wire through this
// module. Avoids an import-side-effect-only surface.
export const _blisterStandardsRef = blisterMaterialStandards;
