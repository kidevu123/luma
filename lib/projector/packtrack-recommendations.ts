// PT-7C — PackTrack shortage recommendation projector / rebuilder.
//
// Walks active packaging materials, skips machine consumables
// (PVC/FOIL/BLISTER_FOIL), hydrates a ShortageRecommendationInput per
// (material × product-or-shared) from the existing read models +
// PBOM-2 compatibility matrix, hands it to PT-7B's pure helpers, and
// upserts read_material_recommendations.
//
// Rebuild semantics:
//   - Idempotent: running twice produces the same row set.
//   - Preserves acknowledged_at / dismissed_at / recommendation_id /
//     last_send_error on existing rows (operator state is sticky).
//   - When derive returns null for a (material, product) pair that
//     previously had an ACTIVE row, the row is DELETED. Rows that
//     were already acknowledged or dismissed stay (audit trail).
//   - Newly-emitted rows get a fresh recommendation_id; updated rows
//     keep their existing one — PackTrack uses this as the
//     idempotency key, so churning it would create duplicate POs
//     downstream.
//
// No PackTrack call lives here. PT-7E adds the outbound client.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  packagingMaterials,
  productMaterialCompatibility,
  productPackagingSpecs,
  products,
  readMaterialLotState,
  readMaterialRecommendations,
} from "@/lib/db/schema";
import {
  deriveShortageRecommendation,
  skipMaterialKindForPackTrackShortage,
  type InventorySource,
  type ShortageRecommendation,
  type ShortageRecommendationInput,
  type UsageRateSource,
  type ShortageConfidence,
} from "@/lib/production/packtrack-shortage";
import type { PackagingMaterialKind } from "@/lib/production/packaging-bom-kinds";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

const DEFAULT_LEAD_TIME_DAYS = 7;
const USAGE_WINDOW_DAYS = 7;

// ─── Public API ────────────────────────────────────────────────────────

export type RebuildResult = {
  scanned: number;
  written: number;
  deleted: number;
  preservedAcknowledged: number;
  skippedMachineConsumable: number;
};

/** Full rebuild. Walks every active packaging material and refreshes
 *  the recommendation table. Idempotent; safe to call repeatedly. */
export async function rebuildMaterialRecommendations(
  tx: Tx,
  opts: { now?: Date; leadTimeDays?: number } = {},
): Promise<RebuildResult> {
  const now = opts.now ?? new Date();
  const leadTimeDefault = opts.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;

  const result: RebuildResult = {
    scanned: 0,
    written: 0,
    deleted: 0,
    preservedAcknowledged: 0,
    skippedMachineConsumable: 0,
  };

  const materials = await tx
    .select({
      id: packagingMaterials.id,
      sku: packagingMaterials.sku,
      name: packagingMaterials.name,
      kind: packagingMaterials.kind,
      parLevel: packagingMaterials.parLevel,
      minOrderQuantity: packagingMaterials.minOrderQuantity,
      safetyBufferPercent: packagingMaterials.safetyBufferPercent,
      orderMultiple: packagingMaterials.orderMultiple,
    })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.isActive, true));

  for (const mat of materials) {
    result.scanned += 1;
    if (skipMaterialKindForPackTrackShortage(mat.kind as PackagingMaterialKind)) {
      result.skippedMachineConsumable += 1;
      continue;
    }

    // Determine product scope. PBOM-2 active compatibility rows tell
    // us which products this material is approved for. Per PT-7A §11.3:
    //   - 0 products → material-wide (product_id = null)
    //   - 1 product  → product-scoped row
    //   - 2+ products → material-wide row with multi-product signals
    const compatRows = (await tx.execute(sql`
      SELECT
        product_id AS "productId",
        compatibility_role AS "role",
        required,
        default_for_product AS "isDefault",
        scope
      FROM product_material_compatibility
      WHERE material_id = ${mat.id}
        AND active = true
        AND (effective_to IS NULL OR effective_to > now())
    `)) as unknown as Array<{
      productId: string;
      role: string;
      required: boolean;
      isDefault: boolean;
      scope: string;
    }>;
    const distinctProductIds = Array.from(
      new Set(compatRows.map((r) => r.productId)),
    );

    const targetPairs: Array<{ productId: string | null }> =
      distinctProductIds.length === 1
        ? [{ productId: distinctProductIds[0]! }]
        : [{ productId: null }];

    for (const pair of targetPairs) {
      const input = await hydrateInput(tx, {
        now,
        material: mat,
        productId: pair.productId,
        compatRows,
        leadTimeDefault,
      });
      const rec = deriveShortageRecommendation(input);
      const writeResult = await upsertOrDelete(tx, {
        materialId: mat.id,
        productId: pair.productId,
        rec,
        input,
      });
      if (writeResult === "written") result.written += 1;
      if (writeResult === "deleted") result.deleted += 1;
      if (writeResult === "preserved") result.preservedAcknowledged += 1;
    }
  }

  return result;
}

// ─── Hydration ─────────────────────────────────────────────────────────

type MaterialRow = {
  id: string;
  sku: string;
  name: string;
  kind: PackagingMaterialKind;
  parLevel: number | null;
  minOrderQuantity: string | null;
  safetyBufferPercent: string | null;
  orderMultiple: string | null;
};

async function hydrateInput(
  tx: Tx,
  args: {
    now: Date;
    material: MaterialRow;
    productId: string | null;
    compatRows: Array<{
      productId: string;
      role: string;
      required: boolean;
      isDefault: boolean;
      scope: string;
    }>;
    leadTimeDefault: number;
  },
): Promise<ShortageRecommendationInput> {
  const { now, material, productId, compatRows, leadTimeDefault } = args;

  // Inventory state — sum across all active lots for this material.
  const lotAgg = (await tx.execute(sql`
    SELECT
      COALESCE(SUM(qty_on_hand), 0)::float AS "onHand",
      MAX(confidence)                       AS "maxConfidence",
      MIN(confidence)                       AS "minConfidence"
    FROM read_material_lot_state
    WHERE packaging_lot_id IN (
      SELECT id FROM packaging_lots WHERE packaging_material_id = ${material.id}
    )
  `)) as unknown as Array<{
    onHand: number | null;
    maxConfidence: string | null;
    minConfidence: string | null;
  }>;
  const currentOnHand =
    lotAgg[0]?.onHand != null ? Number(lotAgg[0]!.onHand) : null;
  const inventoryConfidence: ShortageConfidence = mapInventoryConfidence(
    lotAgg[0]?.minConfidence ?? null,
  );

  // Accepted inventory — sum across packaging_lots for this material.
  // Uses accepted_quantity (PT-1) when set; falls back to qty_received.
  const acceptedAgg = (await tx.execute(sql`
    SELECT
      COALESCE(SUM(COALESCE(accepted_quantity, qty_received, 0)), 0)::float AS "accepted",
      bool_or(source_system = 'PACKTRACK')::boolean   AS "anyPacktrack",
      bool_or(source_system = 'IMPORT')::boolean      AS "anyImport",
      bool_or(source_system = 'MANUAL_LUMA')::boolean AS "anyManual",
      bool_and(counted_quantity IS NOT NULL)::boolean AS "allCounted"
    FROM packaging_lots
    WHERE packaging_material_id = ${material.id}
  `)) as unknown as Array<{
    accepted: number | null;
    anyPacktrack: boolean | null;
    anyImport: boolean | null;
    anyManual: boolean | null;
    allCounted: boolean | null;
  }>;
  const acceptedRow = acceptedAgg[0];
  const acceptedInventory =
    acceptedRow?.accepted != null ? Number(acceptedRow.accepted) : null;
  const inventorySource: InventorySource = pickInventorySource(acceptedRow);

  // Most recent receipt (drives supplier hint + RECENT_RECEIPT signal).
  const recentReceiptRows = (await tx.execute(sql`
    SELECT
      received_at,
      COALESCE(accepted_quantity, qty_received, 0) AS qty,
      source_system,
      supplier
    FROM packaging_lots
    WHERE packaging_material_id = ${material.id}
    ORDER BY received_at DESC
    LIMIT 1
  `)) as unknown as Array<{
    received_at: string | Date;
    qty: number | string;
    source_system: "PACKTRACK" | "MANUAL_LUMA" | "ZOHO" | "IMPORT" | null;
    supplier: string | null;
  }>;
  const recentReceipt = recentReceiptRows[0];

  // Daily consumption — preferred from read_material_consumption_daily
  // when available; fallback from sku_daily × product BOM.
  const usageRows = (await tx.execute(sql`
    SELECT
      COALESCE(AVG(qty_consumed), 0)::float AS "rate",
      COUNT(*)::int AS "days"
    FROM read_material_burn
    WHERE packaging_material_id = ${material.id}
      AND day >= (now() - interval '${sql.raw(String(USAGE_WINDOW_DAYS))} days')::date
  `)) as unknown as Array<{ rate: number | null; days: number | null }>;
  const usageRow = usageRows[0];
  const usageWindow = Number(usageRow?.days ?? 0);
  const dailyUsageRate =
    usageWindow > 0 && usageRow?.rate != null ? Number(usageRow.rate) : null;
  const usageSource: UsageRateSource =
    dailyUsageRate != null ? "READ_MATERIAL_CONSUMPTION_DAILY" : null;

  // Product context — when productId set, pull product fields + BOM
  // line + the matching compatibility row.
  let productName: string | null = null;
  let productSku: string | null = null;
  let compatibilityRole: string | null = null;
  let compatibilityRequired = false;
  let perUnit: number | null = null;
  let perDisplay: number | null = null;
  let perCase: number | null = null;
  if (productId) {
    const prod = (await tx
      .select({ name: products.name, sku: products.sku })
      .from(products)
      .where(eq(products.id, productId))) as Array<{
      name: string;
      sku: string;
    }>;
    if (prod[0]) {
      productName = prod[0].name;
      productSku = prod[0].sku;
    }
    const compat = compatRows.find((r) => r.productId === productId);
    if (compat) {
      compatibilityRole = compat.role;
      compatibilityRequired = compat.required;
    }
    const bom = (await tx
      .select({
        qtyPerUnit: productPackagingSpecs.qtyPerUnit,
        perScope: productPackagingSpecs.perScope,
      })
      .from(productPackagingSpecs)
      .where(
        and(
          eq(productPackagingSpecs.productId, productId),
          eq(productPackagingSpecs.packagingMaterialId, material.id),
        ),
      )) as Array<{ qtyPerUnit: number; perScope: string }>;
    for (const b of bom) {
      if (b.perScope === "UNIT") perUnit = b.qtyPerUnit;
      if (b.perScope === "DISPLAY") perDisplay = b.qtyPerUnit;
      if (b.perScope === "CASE") perCase = b.qtyPerUnit;
    }
  }

  const minOrderQuantity =
    material.minOrderQuantity != null ? Number(material.minOrderQuantity) : null;
  const safetyBufferPercent =
    material.safetyBufferPercent != null
      ? Number(material.safetyBufferPercent)
      : null;
  const orderMultiple =
    material.orderMultiple != null ? Number(material.orderMultiple) : null;

  // Did this (material, productId) have an active recommendation
  // before? Used by PT-7B's hysteresis predicate. We answer this via
  // an explicit query so a deleted row from an earlier rebuild step
  // doesn't accidentally flag "hadActive=true" via stale state.
  const hadActive = await hasActiveRecommendation(tx, material.id, productId);

  return {
    generatedAt: now,
    materialId: material.id,
    materialCode: material.sku || null,
    materialName: material.name,
    materialKind: material.kind,

    productId: productId ?? null,
    productName,
    productSku,
    compatibilityRole,
    compatibilityRequired,

    currentOnHand,
    acceptedInventory,
    inventorySource,
    inventoryConfidence,

    dailyUsageRate,
    usageWindowDays: usageWindow,
    usageSource,
    productionTargetDemand: null,

    leadTimeDays: leadTimeDefault,
    leadTimeSource: "CONFIG_DEFAULT",
    safetyBufferPercent,
    minOrderQuantity,
    orderMultiple,
    parLevel: material.parLevel,

    hadActiveRecommendation: hadActive,

    recentReceipt:
      recentReceipt && recentReceipt.received_at
        ? {
            receivedAt: new Date(recentReceipt.received_at),
            quantity: Number(recentReceipt.qty ?? 0),
            source: (recentReceipt.source_system ?? "MANUAL_LUMA") as
              | "PACKTRACK"
              | "MANUAL_LUMA"
              | "ZOHO"
              | "IMPORT",
            supplier: recentReceipt.supplier ?? null,
          }
        : null,
    recentScrap: null,

    productRequirement: productId
      ? { perUnit, perDisplay, perCase }
      : null,
  };
}

function pickInventorySource(
  agg:
    | {
        anyPacktrack: boolean | null;
        anyImport: boolean | null;
        anyManual: boolean | null;
        allCounted: boolean | null;
      }
    | undefined,
): InventorySource {
  if (!agg) return null;
  if (agg.allCounted) return "COUNTED";
  if (agg.anyImport) return "LEGACY_IMPORT";
  if (agg.anyManual && !agg.anyPacktrack) return "SUPPLIER_DECLARED";
  if (agg.anyPacktrack) return "SUPPLIER_DECLARED";
  return null;
}

function mapInventoryConfidence(raw: string | null): ShortageConfidence {
  switch ((raw ?? "").toUpperCase()) {
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
      return "MEDIUM";
    case "LOW":
      return "LOW";
    case "MISSING":
      return "MISSING";
    default:
      return "MISSING";
  }
}

async function hasActiveRecommendation(
  tx: Tx,
  materialId: string,
  productId: string | null,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1
    FROM read_material_recommendations
    WHERE material_id = ${materialId}
      AND (${productId == null}::boolean = (product_id IS NULL))
      AND (product_id = ${productId ?? null} OR product_id IS NULL AND ${productId ?? null}::uuid IS NULL)
      AND acknowledged_at IS NULL
      AND dismissed_at IS NULL
      AND superseded_by IS NULL
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
}

// ─── Upsert / delete ───────────────────────────────────────────────────

type WriteOutcome = "written" | "deleted" | "preserved" | "noop";

async function upsertOrDelete(
  tx: Tx,
  args: {
    materialId: string;
    productId: string | null;
    rec: ShortageRecommendation | null;
    input: ShortageRecommendationInput;
  },
): Promise<WriteOutcome> {
  const { materialId, productId, rec, input } = args;

  // Look up existing ACTIVE row for this scope key.
  const existing = await findActiveRow(tx, materialId, productId);

  if (rec == null) {
    if (!existing) return "noop";
    // Existing row but no longer recommended.
    if (existing.acknowledgedAt || existing.dismissedAt) {
      return "preserved";
    }
    await tx
      .delete(readMaterialRecommendations)
      .where(eq(readMaterialRecommendations.id, existing.id));
    return "deleted";
  }

  // We have a recommendation to write.
  if (existing) {
    // Update in place — preserve acknowledged/dismissed/recommendation_id.
    await tx
      .update(readMaterialRecommendations)
      .set({
        materialCode: rec.materialCode ?? input.materialCode ?? "",
        materialName: rec.materialName,
        productName: rec.productName,
        productSku: rec.productSku,
        compatibilityRole: rec.compatibilityRole,
        currentOnHand: numOrNull(rec.currentOnHand),
        acceptedInventory: numOrNull(rec.acceptedInventory),
        projectedDemand: numOrNull(rec.projectedDemand),
        projectedShortageQuantity: numOrNull(rec.projectedShortageQuantity),
        recommendedOrderQuantity: numOrNull(rec.recommendedOrderQuantity),
        neededByDate: rec.neededByDate
          ? rec.neededByDate.toISOString().slice(0, 10)
          : null,
        confidence: rec.confidence,
        severity: rec.severity,
        reason: rec.reason,
        sourceSignals: rec.sourceSignals as unknown as object,
        missingInputs: rec.missingInputs as unknown as object,
        warnings: rec.warnings as unknown as object,
        sendableToPackTrack: rec.sendableToPackTrack,
        generatedAt: rec.generatedAt,
        expiresAt: rec.expiresAt,
        recommendedSupplierHint: rec.recommendedSupplierHint,
        updatedAt: new Date(),
      })
      .where(eq(readMaterialRecommendations.id, existing.id));
    return "written";
  }

  // Insert fresh row.
  await tx.insert(readMaterialRecommendations).values({
    materialId,
    materialCode: rec.materialCode ?? input.materialCode ?? "",
    materialName: rec.materialName,
    productId: productId ?? null,
    productName: rec.productName,
    productSku: rec.productSku,
    compatibilityRole: rec.compatibilityRole,
    currentOnHand: numOrNull(rec.currentOnHand),
    acceptedInventory: numOrNull(rec.acceptedInventory),
    projectedDemand: numOrNull(rec.projectedDemand),
    projectedShortageQuantity: numOrNull(rec.projectedShortageQuantity),
    recommendedOrderQuantity: numOrNull(rec.recommendedOrderQuantity),
    neededByDate: rec.neededByDate
      ? rec.neededByDate.toISOString().slice(0, 10)
      : null,
    confidence: rec.confidence,
    severity: rec.severity,
    reason: rec.reason,
    sourceSignals: rec.sourceSignals as unknown as object,
    missingInputs: rec.missingInputs as unknown as object,
    warnings: rec.warnings as unknown as object,
    sendableToPackTrack: rec.sendableToPackTrack,
    generatedAt: rec.generatedAt,
    expiresAt: rec.expiresAt,
    recommendedSupplierHint: rec.recommendedSupplierHint,
  });
  return "written";
}

type ExistingRow = {
  id: string;
  acknowledgedAt: Date | null;
  dismissedAt: Date | null;
};

async function findActiveRow(
  tx: Tx,
  materialId: string,
  productId: string | null,
): Promise<ExistingRow | null> {
  const rows = (await tx
    .select({
      id: readMaterialRecommendations.id,
      acknowledgedAt: readMaterialRecommendations.acknowledgedAt,
      dismissedAt: readMaterialRecommendations.dismissedAt,
    })
    .from(readMaterialRecommendations)
    .where(
      and(
        eq(readMaterialRecommendations.materialId, materialId),
        productId == null
          ? isNull(readMaterialRecommendations.productId)
          : eq(readMaterialRecommendations.productId, productId),
        isNull(readMaterialRecommendations.supersededBy),
      ),
    )
    .limit(1)) as Array<{
    id: string;
    acknowledgedAt: Date | null;
    dismissedAt: Date | null;
  }>;
  return rows[0] ?? null;
}

function numOrNull(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (!Number.isFinite(n)) return null;
  return String(n);
}
