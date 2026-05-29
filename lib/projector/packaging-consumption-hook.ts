// SOURCE-OF-TRUTH-WIRING-1 — Count-based packaging consumption on PACKAGING_COMPLETE.
//
// When PACKAGING_COMPLETE fires with master_cases / displays_made / loose_cards:
//   1. Read product from workflowBag.productId
//   2. Read product structure (unitsPerDisplay, displaysPerCase, kind)
//   3. Read product_packaging_specs BOM
//   4. Calculate total units / displays / cases consumed
//   5. For each BOM spec, calculate qty consumed based on perScope
//   6. Find best available lot (status=AVAILABLE or IN_USE) for each material
//   7. Write MATERIAL_CONSUMED_ACTUAL (lot found) or MATERIAL_CONSUMED_ESTIMATED (no lot)
//   8. Return per-material status for UI display
//
// PACKAGING-PENDING-CONSUMPTION-HONESTY-1: when lot on-hand is insufficient,
// split into ACTUAL (up to available) + ESTIMATED remainder (null lot).

import { sql, eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  materialInventoryEvents,
  workflowBags,
  products,
  productPackagingSpecs,
  packagingMaterials,
} from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type PackagingConsumptionMaterialStatus =
  | "DEDUCTED"
  | "ESTIMATED"
  | "PARTIAL"
  | "SKIPPED_ROLL"
  | "ZERO_CONSUMPTION";

export type PackagingConsumptionResult = {
  productId: string | null;
  bomStatus: "COMPLETE" | "MISSING" | "PARTIAL";
  totalUnits: number;
  totalDisplays: number;
  totalCases: number;
  materials: {
    packagingMaterialId: string;
    materialName: string;
    materialKind: string;
    perScope: string;
    qtyConsumed: number;
    qtyActual?: number;
    qtyEstimated?: number;
    status: PackagingConsumptionMaterialStatus;
    lotId: string | null;
  }[];
};

const ROLL_KINDS = new Set(["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"]);

type BestLotRow = {
  id: string;
  source_system: string | null;
  qty_on_hand: number;
};

type SpecRow = {
  packagingMaterialId: string;
  qtyPerUnit: number;
  perScope: string;
  materialName: string;
  materialKind: string;
  materialUom: string;
};

type ConsumptionTotals = {
  totalCases: number;
  totalDisplays: number;
  totalUnits: number;
};

type ConsumptionContextPayload = {
  per_scope: string;
  qty_per_unit: number;
  total_units: number;
  total_displays: number;
  total_cases: number;
  deduction_basis: "PACKAGING_COMPLETE";
};

/** Split qty into ACTUAL (lot-attributed) and ESTIMATED (pending) portions. */
export function resolvePackagingConsumptionSplit(
  qtyConsumed: number,
  observedQtyOnHand: number,
): { actualQty: number; estimatedQty: number } {
  if (qtyConsumed <= 0) return { actualQty: 0, estimatedQty: 0 };
  const available = Math.max(0, observedQtyOnHand);
  const actualQty = Math.min(qtyConsumed, available);
  return {
    actualQty,
    estimatedQty: qtyConsumed - actualQty,
  };
}

export function calculatePackagingConsumption(opts: {
  masterCases: number;
  displaysMade: number;
  looseUnits: number;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
}): { totalCases: number; totalDisplays: number; totalUnits: number } {
  const totalCases = opts.masterCases;
  const totalDisplays =
    opts.masterCases * (opts.displaysPerCase ?? 0) + opts.displaysMade;
  const totalUnits =
    totalDisplays * (opts.unitsPerDisplay ?? 0) + opts.looseUnits;
  return { totalCases, totalDisplays, totalUnits };
}

export function calculateSpecQty(
  spec: { perScope: string; qtyPerUnit: number },
  totals: { totalCases: number; totalDisplays: number; totalUnits: number },
): number {
  if (spec.perScope === "CASE") return totals.totalCases * spec.qtyPerUnit;
  if (spec.perScope === "DISPLAY") return totals.totalDisplays * spec.qtyPerUnit;
  return totals.totalUnits * spec.qtyPerUnit;
}

function baseContextPayload(
  spec: SpecRow,
  totals: ConsumptionTotals,
): ConsumptionContextPayload {
  return {
    per_scope: spec.perScope,
    qty_per_unit: spec.qtyPerUnit,
    total_units: totals.totalUnits,
    total_displays: totals.totalDisplays,
    total_cases: totals.totalCases,
    deduction_basis: "PACKAGING_COMPLETE",
  };
}

async function emitEstimatedConsumption(
  tx: Tx,
  args: {
    spec: SpecRow;
    productId: string;
    workflowBagId: string;
    stationId: string;
    quantityUnits: number;
    occurredAt: Date;
    totals: ConsumptionTotals;
    extraPayload: Record<string, unknown>;
  },
): Promise<void> {
  if (args.quantityUnits <= 0) return;
  await tx.insert(materialInventoryEvents).values({
    eventType: "MATERIAL_CONSUMED_ESTIMATED",
    packagingMaterialId: args.spec.packagingMaterialId,
    packagingLotId: null,
    productId: args.productId,
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    quantityUnits: args.quantityUnits,
    unitOfMeasure: args.spec.materialUom,
    occurredAt: args.occurredAt,
    payload: {
      ...baseContextPayload(args.spec, args.totals),
      lot_source_system: null,
      ...args.extraPayload,
    },
    source: "projector.packaging_complete_hook",
  });
}

async function emitActualConsumption(
  tx: Tx,
  args: {
    spec: SpecRow;
    productId: string;
    workflowBagId: string;
    stationId: string;
    lotId: string;
    lotSourceSystem: string | null;
    quantityUnits: number;
    occurredAt: Date;
    totals: ConsumptionTotals;
  },
): Promise<void> {
  if (args.quantityUnits <= 0) return;
  await tx.insert(materialInventoryEvents).values({
    eventType: "MATERIAL_CONSUMED_ACTUAL",
    packagingMaterialId: args.spec.packagingMaterialId,
    packagingLotId: args.lotId,
    productId: args.productId,
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    quantityUnits: args.quantityUnits,
    unitOfMeasure: args.spec.materialUom,
    occurredAt: args.occurredAt,
    payload: {
      ...baseContextPayload(args.spec, args.totals),
      lot_source_system: args.lotSourceSystem,
    },
    source: "projector.packaging_complete_hook",
  });
}

export async function emitCountBasedPackagingConsumption(
  tx: Tx,
  args: {
    workflowBagId: string;
    stationId: string;
    payload: {
      master_cases: number;
      displays_made: number;
      loose_cards: number;
      damaged_packaging?: number;
      ripped_cards?: number;
    };
    occurredAt: Date;
  },
): Promise<PackagingConsumptionResult> {
  const [bagRow] = await tx
    .select({ productId: workflowBags.productId })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId));

  const productId = bagRow?.productId ?? null;

  if (!productId) {
    return {
      productId: null,
      bomStatus: "MISSING",
      totalUnits: 0,
      totalDisplays: 0,
      totalCases: 0,
      materials: [],
    };
  }

  const [productRow] = await tx
    .select({
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(products)
    .where(eq(products.id, productId));

  const specs: SpecRow[] = await tx
    .select({
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      materialUom: packagingMaterials.uom,
    })
    .from(productPackagingSpecs)
    .innerJoin(
      packagingMaterials,
      eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
    )
    .where(eq(productPackagingSpecs.productId, productId));

  if (specs.length === 0) {
    return {
      productId,
      bomStatus: "MISSING",
      totalUnits: 0,
      totalDisplays: 0,
      totalCases: 0,
      materials: [],
    };
  }

  const totals = calculatePackagingConsumption({
    masterCases: args.payload.master_cases,
    displaysMade: args.payload.displays_made,
    looseUnits: args.payload.loose_cards,
    unitsPerDisplay: productRow?.unitsPerDisplay ?? null,
    displaysPerCase: productRow?.displaysPerCase ?? null,
  });

  const materialResults: PackagingConsumptionResult["materials"] = [];
  let hasActualConsumption = false;
  let hasZeroOrSkipped = false;

  for (const spec of specs) {
    const isRoll = ROLL_KINDS.has(spec.materialKind);
    if (isRoll) {
      materialResults.push({
        packagingMaterialId: spec.packagingMaterialId,
        materialName: spec.materialName,
        materialKind: spec.materialKind,
        perScope: spec.perScope,
        qtyConsumed: 0,
        status: "SKIPPED_ROLL",
        lotId: null,
      });
      hasZeroOrSkipped = true;
      continue;
    }

    const qtyConsumed = calculateSpecQty(spec, totals);

    if (qtyConsumed === 0) {
      materialResults.push({
        packagingMaterialId: spec.packagingMaterialId,
        materialName: spec.materialName,
        materialKind: spec.materialKind,
        perScope: spec.perScope,
        qtyConsumed: 0,
        status: "ZERO_CONSUMPTION",
        lotId: null,
      });
      hasZeroOrSkipped = true;
      continue;
    }

    const bestLots = await tx.execute<BestLotRow>(sql`
      SELECT id::text, source_system::text, qty_on_hand::int
      FROM packaging_lots
      WHERE packaging_material_id = ${spec.packagingMaterialId}::uuid
        AND status IN ('AVAILABLE', 'IN_USE')
      ORDER BY
        CASE source_system::text WHEN 'PACKTRACK' THEN 0 ELSE 1 END,
        received_at ASC
      LIMIT 1
    `);
    const bestLot = (bestLots as unknown as BestLotRow[])[0] ?? null;

    if (!bestLot) {
      await emitEstimatedConsumption(tx, {
        spec,
        productId,
        workflowBagId: args.workflowBagId,
        stationId: args.stationId,
        quantityUnits: qtyConsumed,
        occurredAt: args.occurredAt,
        totals,
        extraPayload: { no_lot_reason: "no_available_lot" },
      });
      materialResults.push({
        packagingMaterialId: spec.packagingMaterialId,
        materialName: spec.materialName,
        materialKind: spec.materialKind,
        perScope: spec.perScope,
        qtyConsumed,
        qtyEstimated: qtyConsumed,
        status: "ESTIMATED",
        lotId: null,
      });
      hasZeroOrSkipped = true;
      continue;
    }

    const { actualQty, estimatedQty } = resolvePackagingConsumptionSplit(
      qtyConsumed,
      bestLot.qty_on_hand,
    );

    if (actualQty > 0) {
      await emitActualConsumption(tx, {
        spec,
        productId,
        workflowBagId: args.workflowBagId,
        stationId: args.stationId,
        lotId: bestLot.id,
        lotSourceSystem: bestLot.source_system,
        quantityUnits: actualQty,
        occurredAt: args.occurredAt,
        totals,
      });
      hasActualConsumption = true;
    }

    if (estimatedQty > 0) {
      await emitEstimatedConsumption(tx, {
        spec,
        productId,
        workflowBagId: args.workflowBagId,
        stationId: args.stationId,
        quantityUnits: estimatedQty,
        occurredAt: args.occurredAt,
        totals,
        extraPayload: {
          insufficient_on_hand: true,
          observed_qty_on_hand: bestLot.qty_on_hand,
          partial_lot_id: bestLot.id,
        },
      });
      hasZeroOrSkipped = true;
    }

    let status: PackagingConsumptionMaterialStatus;
    if (actualQty > 0 && estimatedQty > 0) status = "PARTIAL";
    else if (actualQty > 0) status = "DEDUCTED";
    else status = "ESTIMATED";

    materialResults.push({
      packagingMaterialId: spec.packagingMaterialId,
      materialName: spec.materialName,
      materialKind: spec.materialKind,
      perScope: spec.perScope,
      qtyConsumed,
      ...(actualQty > 0 ? { qtyActual: actualQty } : {}),
      ...(estimatedQty > 0 ? { qtyEstimated: estimatedQty } : {}),
      status,
      lotId: actualQty > 0 ? bestLot.id : null,
    });

    if (estimatedQty > 0) hasZeroOrSkipped = true;
  }

  const nonSkipped = materialResults.filter(
    (m) => m.status !== "SKIPPED_ROLL",
  );
  let bomStatus: "COMPLETE" | "MISSING" | "PARTIAL";
  if (nonSkipped.length === 0) {
    bomStatus = "MISSING";
  } else if (hasActualConsumption && !hasZeroOrSkipped) {
    bomStatus = "COMPLETE";
  } else if (
    !hasActualConsumption &&
    nonSkipped.every((m) => m.status === "ZERO_CONSUMPTION")
  ) {
    bomStatus = "PARTIAL";
  } else {
    bomStatus = hasActualConsumption ? "PARTIAL" : "PARTIAL";
  }

  return {
    productId,
    bomStatus,
    totalUnits: totals.totalUnits,
    totalDisplays: totals.totalDisplays,
    totalCases: totals.totalCases,
    materials: materialResults,
  };
}
