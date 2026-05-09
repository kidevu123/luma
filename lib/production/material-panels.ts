// H.x7 material panel loaders.
//
// These functions are deliberately read-only. They shape rows from
// existing read models / source tables so React pages do display work
// only. Business math remains in projectors and metric helpers.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { db } from "@/lib/db";
import type { Confidence } from "@/lib/production/types";
import {
  listReconciliationV2Rows,
  type ReconciliationV2Row,
} from "@/lib/production/reconciliation-v2-loader";

type Queryable = {
  execute: <T = any>(...args: any[]) => any;
};

export type PackagingInventoryLotRow = {
  lotId: string;
  materialName: string;
  materialKind: string;
  materialSku: string;
  rollNumber: string | null;
  boxNumber: string | null;
  supplierLotNumber: string | null;
  status: string;
  qtyOnHand: number;
  acceptedQuantity: number | null;
  declaredQuantity: number | null;
  countedQuantity: number | null;
  uom: string;
  netWeightGrams: number | null;
  currentWeightGramsEstimate: number | null;
  supplier: string | null;
  location: string | null;
  sourceSystem: string;
  externalPoId: string | null;
  receiptNumber: string | null;
  receivedAt: string | null;
  confidence: Confidence;
  receiptTruthLabel: string;
  warnings: string[];
};

export type PackagingInventoryPanel = {
  lots: PackagingInventoryLotRow[];
  statusCounts: Array<{ status: string; n: number }>;
  kindCounts: Array<{
    kind: string;
    lots: number;
    totalGrams: number | null;
    totalUnits: number | null;
  }>;
};

export type ProductPackagingRequirementLine = {
  productId: string;
  productName: string;
  productSku: string;
  materialId: string | null;
  materialName: string | null;
  materialSku: string | null;
  materialKind: string | null;
  perScope: string | null;
  qtyNeeded: number | null;
  unit: string | null;
  wasteAllowancePct: number | null;
  confidence: Confidence;
  missingInputs: string[];
  label: string;
};

export type ProductPackagingRequirementPanel = {
  products: Array<{
    productId: string;
    productName: string;
    productSku: string;
    confidence: Confidence;
    missingInputs: string[];
    lines: ProductPackagingRequirementLine[];
  }>;
};

export type ActiveRollRow = {
  packagingLotId: string;
  rollNumber: string | null;
  materialRole: string | null;
  materialKind: string;
  materialName: string;
  machineId: string | null;
  machineName: string | null;
  mountedAt: string | null;
  startingWeightGrams: number | null;
  currentWeightGramsEstimate: number | null;
  expectedUsedGrams: number | null;
  actualUsedGrams: number | null;
  varianceGrams: number | null;
  blistersProduced: number | null;
  projectedRemainingGrams: number | null;
  projectedBlistersRemaining: number | null;
  confidence: Confidence;
  supplier: string | null;
  sourceSystem: string;
  externalPoId: string | null;
  weighbackAt: string | null;
  estimateActualLabel: string;
  warnings: string[];
};

export type ActiveRollPanel = {
  rows: ActiveRollRow[];
  machineRows: Array<{
    machineId: string;
    machineName: string;
    rolls: ActiveRollRow[];
    warnings: string[];
  }>;
};

export type RollVarianceRow = {
  packagingLotId: string;
  rollNumber: string | null;
  materialRole: string | null;
  materialKind: string;
  materialName: string;
  machineName: string | null;
  mountedAt: string | null;
  unmountedAt: string | null;
  startingWeightGrams: number | null;
  endingWeightGrams: number | null;
  expectedUsedGrams: number | null;
  actualUsedGrams: number | null;
  varianceGrams: number | null;
  variancePct: number | null;
  varianceSeverity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "MISSING";
  blistersProduced: number | null;
  confidence: Confidence;
  supplier: string | null;
  sourceSystem: string;
  externalPoId: string | null;
  estimateActualLabel: string;
  warnings: string[];
};

export type RollVariancePanel = {
  rows: RollVarianceRow[];
  summary: {
    totalRolls: number;
    withWeighback: number;
    totalVarianceGrams: number | null;
    rollsOver5Pct: number;
  };
  reconciliationAlerts: ReconciliationV2Row[];
};

export type MaterialAlertsPanel = {
  shortages: Array<{
    materialId: string;
    materialName: string;
    materialKind: string;
    parLevel: number | null;
    totalOnHand: number | null;
    uom: string;
    confidence: Confidence;
    warning: string;
  }>;
  runouts: Array<{
    packagingLotId: string;
    rollNumber: string | null;
    materialName: string;
    materialRole: string | null;
    machineName: string | null;
    currentWeightGramsEstimate: number | null;
    projectedBlistersRemaining: number | null;
    confidence: Confidence;
    warning: string;
  }>;
  held: Array<{
    lotId: string;
    materialName: string;
    status: string;
    qtyOnHand: number;
    uom: string;
    supplier: string | null;
    confidence: Confidence;
  }>;
  openAllocations: Array<{
    sessionId: string;
    inventoryBagId: string;
    productName: string | null;
    openedAt: string;
    hoursOpen: number;
    warning: string;
  }>;
  reconciliationAlerts: ReconciliationV2Row[];
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function asConfidence(value: unknown): Confidence {
  return value === "HIGH" ||
    value === "MEDIUM" ||
    value === "LOW" ||
    value === "MISSING"
    ? value
    : "MISSING";
}

export function receiptTruthLabel(input: {
  confidence: Confidence;
  countedQuantity: number | null;
  declaredQuantity: number | null;
  acceptedQuantity: number | null;
}): string {
  if (input.acceptedQuantity == null) return "Missing";
  if (input.confidence === "HIGH" && input.countedQuantity != null) {
    return "Physically counted";
  }
  if (
    input.confidence === "MEDIUM" &&
    input.declaredQuantity != null &&
    input.countedQuantity == null
  ) {
    return "Supplier-declared only";
  }
  if (input.confidence === "LOW") return "Legacy code only";
  return input.confidence === "HIGH" ? "Confirmed" : input.confidence;
}

export function estimateActualLabel(input: {
  actualUsedGrams: number | null;
  expectedUsedGrams: number | null;
  blistersProduced: number | null;
  weighbackAt?: string | null;
  unmountedAt?: string | null;
}): string {
  if (input.actualUsedGrams != null || input.weighbackAt != null) {
    return "Actual (weigh-back)";
  }
  if (input.expectedUsedGrams != null) return "Estimated (configured standard)";
  if ((input.blistersProduced ?? 0) > 0) return "Roll standard missing";
  return input.unmountedAt ? "Not weighed back" : "Mounted, no segments yet";
}

export function varianceSeverity(
  value: number | null,
): "NONE" | "LOW" | "MEDIUM" | "HIGH" | "MISSING" {
  if (value == null) return "MISSING";
  const abs = Math.abs(value);
  if (abs < 0.0001) return "NONE";
  if (abs <= 1) return "LOW";
  if (abs <= 5) return "MEDIUM";
  return "HIGH";
}

function rollWarnings(input: {
  expectedUsedGrams: number | null;
  actualUsedGrams: number | null;
  blistersProduced: number | null;
  projectedBlistersRemaining?: number | null;
  unmountedAt?: string | null;
}): string[] {
  const out: string[] = [];
  if ((input.blistersProduced ?? 0) > 0 && input.expectedUsedGrams == null) {
    out.push("Roll standard missing");
  }
  if (input.unmountedAt != null && input.actualUsedGrams == null) {
    out.push("Not weighed back");
  }
  if (
    input.projectedBlistersRemaining != null &&
    input.projectedBlistersRemaining < 5000
  ) {
    out.push("Low remaining roll");
  }
  return out;
}

export async function loadPackagingInventoryPanel(
  tx: Queryable = db,
  filters: { kind?: string; status?: string } = {},
): Promise<PackagingInventoryPanel> {
  const lotsQ = await tx.execute<{
    lot_id: string;
    material_name: string;
    material_kind: string;
    material_sku: string;
    roll_number: string | null;
    box_number: string | null;
    supplier_lot_number: string | null;
    status: string;
    qty_on_hand: number;
    accepted_quantity: number | null;
    declared_quantity: number | null;
    counted_quantity: number | null;
    uom: string;
    net_weight_grams: number | null;
    current_weight_grams_estimate: number | null;
    supplier: string | null;
    location: string | null;
    source_system: string | null;
    external_po_id: string | null;
    receipt_number: string | null;
    received_at: string | null;
    confidence: string | null;
  }>(sql`
    SELECT
      pl.id::text                              AS lot_id,
      pm.name                                  AS material_name,
      pm.kind::text                            AS material_kind,
      pm.sku                                   AS material_sku,
      pl.roll_number                           AS roll_number,
      pl.box_number                            AS box_number,
      pl.supplier_lot_number                   AS supplier_lot_number,
      pl.status::text                          AS status,
      pl.qty_on_hand                           AS qty_on_hand,
      pl.accepted_quantity                     AS accepted_quantity,
      pl.declared_quantity                     AS declared_quantity,
      pl.counted_quantity                      AS counted_quantity,
      pm.uom                                   AS uom,
      pl.net_weight_grams                      AS net_weight_grams,
      pl.current_weight_grams_estimate         AS current_weight_grams_estimate,
      pl.supplier                              AS supplier,
      pl.location                              AS location,
      COALESCE(pl.source_system::text, es.code, CASE WHEN po.id IS NOT NULL THEN 'LUMA_PO' ELSE 'LUMA_RECEIVE' END)
                                               AS source_system,
      COALESCE(pl.packtrack_po_id, eim.external_item_code, po.po_number)
                                               AS external_po_id,
      COALESCE(pl.packtrack_receipt_id, po.po_number)
                                               AS receipt_number,
      pl.received_at::text                     AS received_at,
      pl.confidence                            AS confidence
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    WHERE 1=1
    ${filters.kind ? sql`AND pm.kind::text = ${filters.kind}` : sql``}
    ${filters.status ? sql`AND pl.status::text = ${filters.status}` : sql``}
    ORDER BY pl.received_at DESC NULLS LAST
    LIMIT 500
  `);

  const lots = (lotsQ as unknown as Array<Record<string, unknown>>).map((r) => {
    const confidence = asConfidence(r.confidence);
    const acceptedQuantity = num(r.accepted_quantity);
    const declaredQuantity = num(r.declared_quantity);
    const countedQuantity = num(r.counted_quantity);
    const warnings: string[] = [];
    if (acceptedQuantity == null && num(r.net_weight_grams) == null) {
      warnings.push("Missing usable quantity");
    }
    if (confidence === "MEDIUM") warnings.push("Supplier-declared only");
    if (confidence === "LOW") warnings.push("Legacy code only");
    return {
      lotId: String(r.lot_id),
      materialName: String(r.material_name),
      materialKind: String(r.material_kind),
      materialSku: String(r.material_sku),
      rollNumber: (r.roll_number as string | null) ?? null,
      boxNumber: (r.box_number as string | null) ?? null,
      supplierLotNumber: (r.supplier_lot_number as string | null) ?? null,
      status: String(r.status),
      qtyOnHand: num(r.qty_on_hand) ?? 0,
      acceptedQuantity,
      declaredQuantity,
      countedQuantity,
      uom: String(r.uom),
      netWeightGrams: num(r.net_weight_grams),
      currentWeightGramsEstimate: num(r.current_weight_grams_estimate),
      supplier: (r.supplier as string | null) ?? null,
      location: (r.location as string | null) ?? null,
      sourceSystem: String(r.source_system ?? "LUMA_RECEIVE"),
      externalPoId: (r.external_po_id as string | null) ?? null,
      receiptNumber: (r.receipt_number as string | null) ?? null,
      receivedAt: (r.received_at as string | null) ?? null,
      confidence,
      receiptTruthLabel: receiptTruthLabel({
        confidence,
        countedQuantity,
        declaredQuantity,
        acceptedQuantity,
      }),
      warnings,
    };
  });

  const statusCounts = (await tx.execute(sql`
    SELECT status::text AS status, COUNT(*)::int AS n
    FROM packaging_lots
    GROUP BY status
    ORDER BY status
  `)) as unknown as Array<{ status: string; n: number }>;

  const kindCountsRaw = (await tx.execute(sql`
    SELECT
      pm.kind::text                                      AS kind,
      COUNT(pl.id)::int                                  AS lots,
      SUM(pl.net_weight_grams)::int                      AS total_grams,
      SUM(pl.qty_on_hand)::int                           AS total_units
    FROM packaging_materials pm
    LEFT JOIN packaging_lots pl ON pl.packaging_material_id = pm.id
    WHERE pm.is_active = true
    GROUP BY pm.kind
    ORDER BY pm.kind
  `)) as unknown as Array<{
    kind: string;
    lots: number;
    total_grams: number | null;
    total_units: number | null;
  }>;

  return {
    lots,
    statusCounts,
    kindCounts: kindCountsRaw.map((r) => ({
      kind: r.kind,
      lots: Number(r.lots),
      totalGrams: num(r.total_grams),
      totalUnits: num(r.total_units),
    })),
  };
}

export async function loadProductPackagingRequirementsPanel(
  tx: Queryable = db,
): Promise<ProductPackagingRequirementPanel> {
  const rows = (await tx.execute(sql`
    SELECT
      p.id::text                         AS product_id,
      p.name                             AS product_name,
      p.sku                              AS product_sku,
      pm.id::text                        AS material_id,
      pm.name                            AS material_name,
      pm.sku                             AS material_sku,
      pm.kind::text                      AS material_kind,
      pm.uom                             AS uom,
      pps.per_scope                      AS per_scope,
      pps.qty_per_unit                   AS qty_needed,
      pps.waste_allowance_percent::text  AS waste_allowance_pct
    FROM products p
    LEFT JOIN product_packaging_specs pps ON pps.product_id = p.id
    LEFT JOIN packaging_materials pm ON pm.id = pps.packaging_material_id
    WHERE p.is_active = true
    ORDER BY p.sku, pps.per_scope NULLS LAST, pm.sku NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;

  const byProduct = new Map<string, ProductPackagingRequirementPanel["products"][number]>();
  for (const r of rows) {
    const productId = String(r.product_id);
    let product = byProduct.get(productId);
    if (!product) {
      product = {
        productId,
        productName: String(r.product_name),
        productSku: String(r.product_sku),
        confidence: "MISSING",
        missingInputs: ["product_packaging_specs"],
        lines: [],
      };
      byProduct.set(productId, product);
    }
    if (r.material_id == null) continue;
    const line: ProductPackagingRequirementLine = {
      productId,
      productName: product.productName,
      productSku: product.productSku,
      materialId: String(r.material_id),
      materialName: String(r.material_name),
      materialSku: String(r.material_sku),
      materialKind: String(r.material_kind),
      perScope: String(r.per_scope ?? "UNIT"),
      qtyNeeded: num(r.qty_needed),
      unit: String(r.uom ?? "each"),
      wasteAllowancePct: num(r.waste_allowance_pct) ?? 0,
      confidence: "HIGH",
      missingInputs: [],
      label: "Configured",
    };
    product.lines.push(line);
  }

  for (const product of byProduct.values()) {
    if (product.lines.length > 0) {
      product.confidence = "HIGH";
      product.missingInputs = [];
    }
  }

  return { products: Array.from(byProduct.values()) };
}

export async function loadActiveRollPanel(
  tx: Queryable = db,
): Promise<ActiveRollPanel> {
  const rowsQ = await tx.execute(sql`
    WITH last_weigh AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id, ev.occurred_at
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_WEIGHED'
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      rru.packaging_lot_id::text                      AS packaging_lot_id,
      rru.roll_number                                 AS roll_number,
      rru.material_role                               AS material_role,
      rru.material_kind                               AS material_kind,
      pm.name                                         AS material_name,
      rru.machine_id::text                            AS machine_id,
      m.name                                          AS machine_name,
      rru.mounted_at::text                            AS mounted_at,
      rru.starting_weight_grams                       AS starting_weight_grams,
      pl.current_weight_grams_estimate                AS current_weight_grams_estimate,
      rru.expected_used_grams                         AS expected_used_grams,
      rru.actual_used_grams                           AS actual_used_grams,
      rru.variance_grams                              AS variance_grams,
      rru.blisters_produced                           AS blisters_produced,
      rru.projected_remaining_grams                   AS projected_remaining_grams,
      rru.projected_blisters_remaining                AS projected_blisters_remaining,
      rru.confidence                                  AS confidence,
      pl.supplier                                     AS supplier,
      COALESCE(pl.source_system::text, es.code, CASE WHEN po.id IS NOT NULL THEN 'LUMA_PO' ELSE 'LUMA_RECEIVE' END)
                                                     AS source_system,
      COALESCE(pl.packtrack_po_id, eim.external_item_code, po.po_number)
                                                     AS external_po_id,
      lw.occurred_at::text                            AS weighback_at
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    LEFT JOIN last_weigh lw ON lw.packaging_lot_id = rru.packaging_lot_id
    WHERE rru.mounted_at IS NOT NULL
      AND rru.unmounted_at IS NULL
    ORDER BY rru.material_role, rru.mounted_at DESC
  `);

  const rows = (rowsQ as unknown as Array<Record<string, unknown>>).map((r): ActiveRollRow => {
    const row = {
      packagingLotId: String(r.packaging_lot_id),
      rollNumber: (r.roll_number as string | null) ?? null,
      materialRole: (r.material_role as string | null) ?? null,
      materialKind: String(r.material_kind),
      materialName: String(r.material_name),
      machineId: (r.machine_id as string | null) ?? null,
      machineName: (r.machine_name as string | null) ?? null,
      mountedAt: (r.mounted_at as string | null) ?? null,
      startingWeightGrams: num(r.starting_weight_grams),
      currentWeightGramsEstimate: num(r.current_weight_grams_estimate),
      expectedUsedGrams: num(r.expected_used_grams),
      actualUsedGrams: num(r.actual_used_grams),
      varianceGrams: num(r.variance_grams),
      blistersProduced: num(r.blisters_produced),
      projectedRemainingGrams: num(r.projected_remaining_grams),
      projectedBlistersRemaining: num(r.projected_blisters_remaining),
      confidence: asConfidence(r.confidence),
      supplier: (r.supplier as string | null) ?? null,
      sourceSystem: String(r.source_system ?? "LUMA_RECEIVE"),
      externalPoId: (r.external_po_id as string | null) ?? null,
      weighbackAt: (r.weighback_at as string | null) ?? null,
    };
    return {
      ...row,
      estimateActualLabel: estimateActualLabel(row),
      warnings: rollWarnings(row),
    };
  });

  const machines = (await tx.execute(sql`
    SELECT id::text AS machine_id, name AS machine_name
    FROM machines
    WHERE is_active = true AND kind IN ('BLISTER','COMBINED')
    ORDER BY name
  `)) as unknown as Array<{ machine_id: string; machine_name: string }>;

  const machineRows = machines.map((m) => {
    const rolls = rows.filter((r) => r.machineId === m.machine_id);
    return {
      machineId: m.machine_id,
      machineName: m.machine_name,
      rolls,
      warnings: rolls.length === 0 ? ["No roll mounted"] : [],
    };
  });
  for (const r of rows.filter((r) => r.machineId == null)) {
    let unassigned = machineRows.find((m) => m.machineId === "unassigned");
    if (!unassigned) {
      unassigned = {
        machineId: "unassigned",
        machineName: "Unassigned machine",
        rolls: [],
        warnings: [],
      };
      machineRows.push(unassigned);
    }
    unassigned.rolls.push(r);
  }

  return { rows, machineRows };
}

export async function loadRollVariancePanel(
  tx: Queryable = db,
): Promise<RollVariancePanel> {
  const rowsQ = await tx.execute(sql`
    SELECT
      rru.packaging_lot_id::text                   AS packaging_lot_id,
      rru.roll_number                              AS roll_number,
      rru.material_role                            AS material_role,
      rru.material_kind                            AS material_kind,
      pm.name                                      AS material_name,
      m.name                                       AS machine_name,
      rru.mounted_at::text                         AS mounted_at,
      rru.unmounted_at::text                       AS unmounted_at,
      rru.starting_weight_grams                    AS starting_weight_grams,
      rru.ending_weight_grams                      AS ending_weight_grams,
      rru.expected_used_grams                      AS expected_used_grams,
      rru.actual_used_grams                        AS actual_used_grams,
      rru.variance_grams                           AS variance_grams,
      rru.variance_pct::text                       AS variance_pct,
      rru.blisters_produced                        AS blisters_produced,
      rru.confidence                               AS confidence,
      pl.supplier                                  AS supplier,
      COALESCE(pl.source_system::text, es.code, CASE WHEN po.id IS NOT NULL THEN 'LUMA_PO' ELSE 'LUMA_RECEIVE' END)
                                                     AS source_system,
      COALESCE(pl.packtrack_po_id, eim.external_item_code, po.po_number)
                                                     AS external_po_id
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    ORDER BY rru.unmounted_at DESC NULLS LAST, rru.mounted_at DESC
    LIMIT 200
  `);

  const rows = (rowsQ as unknown as Array<Record<string, unknown>>).map((r): RollVarianceRow => {
    const row = {
      packagingLotId: String(r.packaging_lot_id),
      rollNumber: (r.roll_number as string | null) ?? null,
      materialRole: (r.material_role as string | null) ?? null,
      materialKind: String(r.material_kind),
      materialName: String(r.material_name),
      machineName: (r.machine_name as string | null) ?? null,
      mountedAt: (r.mounted_at as string | null) ?? null,
      unmountedAt: (r.unmounted_at as string | null) ?? null,
      startingWeightGrams: num(r.starting_weight_grams),
      endingWeightGrams: num(r.ending_weight_grams),
      expectedUsedGrams: num(r.expected_used_grams),
      actualUsedGrams: num(r.actual_used_grams),
      varianceGrams: num(r.variance_grams),
      variancePct: num(r.variance_pct),
      blistersProduced: num(r.blisters_produced),
      confidence: asConfidence(r.confidence),
      supplier: (r.supplier as string | null) ?? null,
      sourceSystem: String(r.source_system ?? "LUMA_RECEIVE"),
      externalPoId: (r.external_po_id as string | null) ?? null,
    };
    return {
      ...row,
      varianceSeverity: varianceSeverity(row.variancePct),
      estimateActualLabel: estimateActualLabel(row),
      warnings: rollWarnings(row),
    };
  });

  const summary = {
    totalRolls: rows.length,
    withWeighback: rows.filter((r) => r.actualUsedGrams != null).length,
    totalVarianceGrams:
      rows.some((r) => r.varianceGrams != null)
        ? rows.reduce((sum, r) => sum + (r.varianceGrams ?? 0), 0)
        : null,
    rollsOver5Pct: rows.filter((r) => Math.abs(r.variancePct ?? 0) > 5).length,
  };

  const reconciliationAlerts = await listReconciliationV2Rows(tx as typeof db, {
    varianceOnly: true,
  });

  return { rows, summary, reconciliationAlerts: reconciliationAlerts.slice(0, 20) };
}

export async function loadMaterialAlertsPanel(
  tx: Queryable = db,
): Promise<MaterialAlertsPanel> {
  const shortagesRaw = (await tx.execute(sql`
    SELECT
      pm.id::text                    AS material_id,
      pm.name                        AS material_name,
      pm.kind::text                  AS material_kind,
      pm.par_level                   AS par_level,
      SUM(pl.qty_on_hand)::int       AS total_on_hand,
      pm.uom                         AS uom,
      COALESCE(MIN(pl.confidence), 'MISSING') AS confidence
    FROM packaging_materials pm
    LEFT JOIN packaging_lots pl
      ON pl.packaging_material_id = pm.id
     AND pl.status IN ('AVAILABLE','IN_USE')
    WHERE pm.is_active = true
      AND pm.par_level IS NOT NULL
    GROUP BY pm.id
    HAVING COALESCE(SUM(pl.qty_on_hand), 0) < pm.par_level
    ORDER BY pm.par_level - COALESCE(SUM(pl.qty_on_hand), 0) DESC
    LIMIT 50
  `)) as unknown as Array<Record<string, unknown>>;

  const runoutsRaw = (await tx.execute(sql`
    SELECT
      rru.packaging_lot_id::text                 AS packaging_lot_id,
      rru.roll_number                            AS roll_number,
      pm.name                                    AS material_name,
      rru.material_role                          AS material_role,
      m.name                                     AS machine_name,
      pl.current_weight_grams_estimate           AS current_weight_grams_estimate,
      rru.projected_blisters_remaining           AS projected_blisters_remaining,
      rru.confidence                             AS confidence
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    WHERE rru.mounted_at IS NOT NULL
      AND rru.unmounted_at IS NULL
      AND rru.projected_blisters_remaining IS NOT NULL
      AND rru.projected_blisters_remaining < 5000
    ORDER BY rru.projected_blisters_remaining ASC
    LIMIT 50
  `)) as unknown as Array<Record<string, unknown>>;

  const heldRaw = (await tx.execute(sql`
    SELECT
      pl.id::text             AS lot_id,
      pm.name                 AS material_name,
      pl.status::text         AS status,
      pl.qty_on_hand          AS qty_on_hand,
      pm.uom                  AS uom,
      pl.supplier             AS supplier,
      pl.confidence           AS confidence
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    WHERE pl.status IN ('HELD','SCRAPPED')
    ORDER BY pl.received_at DESC
    LIMIT 50
  `)) as unknown as Array<Record<string, unknown>>;

  const openAllocRaw = (await tx.execute(sql`
    SELECT
      s.id::text                                    AS session_id,
      s.inventory_bag_id::text                      AS inventory_bag_id,
      p.name                                        AS product_name,
      s.opened_at::text                             AS opened_at,
      EXTRACT(EPOCH FROM (now() - s.opened_at))/3600 AS hours_open
    FROM raw_bag_allocation_sessions s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.allocation_status = 'OPEN'
      AND s.opened_at < now() - INTERVAL '12 hours'
    ORDER BY s.opened_at ASC
    LIMIT 50
  `)) as unknown as Array<Record<string, unknown>>;

  const reconciliationAlerts = await listReconciliationV2Rows(tx as typeof db, {
    varianceOnly: true,
  });

  return {
    shortages: shortagesRaw.map((r) => ({
      materialId: String(r.material_id),
      materialName: String(r.material_name),
      materialKind: String(r.material_kind),
      parLevel: num(r.par_level),
      totalOnHand: num(r.total_on_hand),
      uom: String(r.uom),
      confidence: asConfidence(r.confidence),
      warning: "Below par level",
    })),
    runouts: runoutsRaw.map((r) => ({
      packagingLotId: String(r.packaging_lot_id),
      rollNumber: (r.roll_number as string | null) ?? null,
      materialName: String(r.material_name),
      materialRole: (r.material_role as string | null) ?? null,
      machineName: (r.machine_name as string | null) ?? null,
      currentWeightGramsEstimate: num(r.current_weight_grams_estimate),
      projectedBlistersRemaining: num(r.projected_blisters_remaining),
      confidence: asConfidence(r.confidence),
      warning: "Low remaining roll",
    })),
    held: heldRaw.map((r) => ({
      lotId: String(r.lot_id),
      materialName: String(r.material_name),
      status: String(r.status),
      qtyOnHand: num(r.qty_on_hand) ?? 0,
      uom: String(r.uom),
      supplier: (r.supplier as string | null) ?? null,
      confidence: asConfidence(r.confidence),
    })),
    openAllocations: openAllocRaw.map((r) => ({
      sessionId: String(r.session_id),
      inventoryBagId: String(r.inventory_bag_id),
      productName: (r.product_name as string | null) ?? null,
      openedAt: String(r.opened_at),
      hoursOpen: num(r.hours_open) ?? 0,
      warning: "Allocation session stale",
    })),
    reconciliationAlerts: reconciliationAlerts.slice(0, 20),
  };
}
