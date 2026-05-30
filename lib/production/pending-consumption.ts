// PACKAGING-PENDING-CONSUMPTION-HONESTY-1 — unattributed material consumption.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

type Queryable = typeof db;

export type PendingConsumptionRow = {
  eventId: number;
  packagingMaterialId: string;
  materialName: string;
  materialSku: string;
  materialKind: string;
  quantityUnits: number;
  unitOfMeasure: string | null;
  workflowBagId: string | null;
  productId: string | null;
  occurredAt: string;
  noLotReason: string | null;
  insufficientOnHand: boolean;
  observedQtyOnHand: number | null;
};

export type PendingConsumptionByMaterial = {
  packagingMaterialId: string;
  materialName: string;
  materialSku: string;
  materialKind: string;
  unitOfMeasure: string | null;
  pendingQty: number;
  eventCount: number;
  lastOccurredAt: string | null;
};

export type MaterialBalanceRow = {
  packagingMaterialId: string;
  materialName: string;
  materialSku: string;
  materialKind: string;
  unitOfMeasure: string;
  onHandQty: number;
  pendingQty: number;
  netBalance: number;
};

/** Null-lot MATERIAL_CONSUMED_ESTIMATED rows awaiting receipt / allocation.
 *  Subtracts MATERIAL_ESTIMATED_VOIDED quantities so partially-attributed
 *  events show their remaining pending qty; fully attributed events are
 *  excluded. */
export async function loadPendingConsumptionRows(
  tx: Queryable = db,
  opts: { materialId?: string; limit?: number } = {},
): Promise<PendingConsumptionRow[]> {
  const limit = opts.limit ?? 200;
  const rows = (await tx.execute(sql`
    WITH voided_sums AS (
      SELECT
        (v.payload->>'source_estimated_event_id')::bigint AS source_id,
        COALESCE(SUM(v.quantity_units), 0)::int           AS voided_qty
      FROM material_inventory_events v
      WHERE v.event_type = 'MATERIAL_ESTIMATED_VOIDED'
        AND v.payload->>'source_estimated_event_id' IS NOT NULL
        ${opts.materialId ? sql`AND v.packaging_material_id = ${opts.materialId}::uuid` : sql``}
      GROUP BY source_id
    )
    SELECT
      ev.id::int                              AS event_id,
      ev.packaging_material_id::text          AS packaging_material_id,
      pm.name                                 AS material_name,
      pm.sku                                  AS material_sku,
      pm.kind::text                           AS material_kind,
      (COALESCE(ev.quantity_units, 0)
         - COALESCE(vs.voided_qty, 0))::int  AS quantity_units,
      ev.unit_of_measure                      AS unit_of_measure,
      ev.workflow_bag_id::text                AS workflow_bag_id,
      ev.product_id::text                     AS product_id,
      ev.occurred_at::text                    AS occurred_at,
      ev.payload->>'no_lot_reason'            AS no_lot_reason,
      COALESCE((ev.payload->>'insufficient_on_hand')::boolean, false) AS insufficient_on_hand,
      NULLIF((ev.payload->>'observed_qty_on_hand')::int, 0)         AS observed_qty_on_hand
    FROM material_inventory_events ev
    JOIN packaging_materials pm ON pm.id = ev.packaging_material_id
    LEFT JOIN voided_sums vs ON vs.source_id = ev.id
    WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
      AND ev.packaging_lot_id IS NULL
      ${opts.materialId ? sql`AND ev.packaging_material_id = ${opts.materialId}::uuid` : sql``}
      AND (COALESCE(ev.quantity_units, 0) - COALESCE(vs.voided_qty, 0)) > 0
    ORDER BY ev.occurred_at DESC, ev.id DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    eventId: Number(r.event_id),
    packagingMaterialId: String(r.packaging_material_id),
    materialName: String(r.material_name),
    materialSku: String(r.material_sku),
    materialKind: String(r.material_kind),
    quantityUnits: Number(r.quantity_units),
    unitOfMeasure: (r.unit_of_measure as string | null) ?? null,
    workflowBagId: (r.workflow_bag_id as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    occurredAt: String(r.occurred_at),
    noLotReason: (r.no_lot_reason as string | null) ?? null,
    insufficientOnHand: Boolean(r.insufficient_on_hand),
    observedQtyOnHand:
      r.observed_qty_on_hand != null ? Number(r.observed_qty_on_hand) : null,
  }));
}

/** Aggregate pending consumption per material (count-based kinds only).
 *  Subtracts MATERIAL_ESTIMATED_VOIDED quantities so fully attributed
 *  events are excluded and partially attributed events show remaining qty. */
export async function loadPendingConsumptionByMaterial(
  tx: Queryable = db,
): Promise<PendingConsumptionByMaterial[]> {
  const rows = (await tx.execute(sql`
    WITH voided_sums AS (
      SELECT
        (v.payload->>'source_estimated_event_id')::bigint AS source_id,
        COALESCE(SUM(v.quantity_units), 0)::int           AS voided_qty
      FROM material_inventory_events v
      WHERE v.event_type = 'MATERIAL_ESTIMATED_VOIDED'
        AND v.payload->>'source_estimated_event_id' IS NOT NULL
      GROUP BY source_id
    ),
    pending_events AS (
      SELECT
        ev.packaging_material_id,
        ev.unit_of_measure,
        ev.occurred_at,
        (COALESCE(ev.quantity_units, 0)
           - COALESCE(vs.voided_qty, 0))::int AS remaining_qty
      FROM material_inventory_events ev
      LEFT JOIN voided_sums vs ON vs.source_id = ev.id
      WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
        AND ev.packaging_lot_id IS NULL
        AND (COALESCE(ev.quantity_units, 0) - COALESCE(vs.voided_qty, 0)) > 0
    )
    SELECT
      pe.packaging_material_id::text       AS packaging_material_id,
      pm.name                              AS material_name,
      pm.sku                               AS material_sku,
      pm.kind::text                        AS material_kind,
      COALESCE(MAX(pe.unit_of_measure), pm.uom) AS unit_of_measure,
      COALESCE(SUM(pe.remaining_qty), 0)::int   AS pending_qty,
      COUNT(*)::int                             AS event_count,
      MAX(pe.occurred_at)::text                 AS last_occurred_at
    FROM pending_events pe
    JOIN packaging_materials pm ON pm.id = pe.packaging_material_id
    WHERE pm.kind::text NOT IN ('PVC_ROLL', 'FOIL_ROLL', 'BLISTER_FOIL')
    GROUP BY pe.packaging_material_id, pm.name, pm.sku, pm.kind, pm.uom
    HAVING COALESCE(SUM(pe.remaining_qty), 0) > 0
    ORDER BY pending_qty DESC, pm.name
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    packagingMaterialId: String(r.packaging_material_id),
    materialName: String(r.material_name),
    materialSku: String(r.material_sku),
    materialKind: String(r.material_kind),
    unitOfMeasure: (r.unit_of_measure as string | null) ?? null,
    pendingQty: Number(r.pending_qty),
    eventCount: Number(r.event_count),
    lastOccurredAt: (r.last_occurred_at as string | null) ?? null,
  }));
}

/** On-hand, pending, and net balance per active count-based material.
 *  Pending qty subtracts MATERIAL_ESTIMATED_VOIDED so attributed events
 *  are removed from the pending column and net balance improves accordingly. */
export async function loadMaterialBalanceSummary(
  tx: Queryable = db,
): Promise<MaterialBalanceRow[]> {
  const rows = (await tx.execute(sql`
    WITH voided_sums AS (
      SELECT
        (v.payload->>'source_estimated_event_id')::bigint AS source_id,
        COALESCE(SUM(v.quantity_units), 0)::int           AS voided_qty
      FROM material_inventory_events v
      WHERE v.event_type = 'MATERIAL_ESTIMATED_VOIDED'
        AND v.payload->>'source_estimated_event_id' IS NOT NULL
      GROUP BY source_id
    ),
    pending AS (
      SELECT
        ev.packaging_material_id,
        COALESCE(SUM(
          GREATEST(
            COALESCE(ev.quantity_units, 0) - COALESCE(vs.voided_qty, 0),
            0
          )
        ), 0)::int AS pending_qty
      FROM material_inventory_events ev
      LEFT JOIN voided_sums vs ON vs.source_id = ev.id
      WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
        AND ev.packaging_lot_id IS NULL
      GROUP BY ev.packaging_material_id
    ),
    on_hand AS (
      SELECT
        pl.packaging_material_id,
        COALESCE(SUM(pl.qty_on_hand), 0)::int AS on_hand_qty
      FROM packaging_lots pl
      WHERE pl.status IN ('AVAILABLE', 'IN_USE')
      GROUP BY pl.packaging_material_id
    ),
    lot_net AS (
      SELECT
        rls.packaging_material_id,
        COALESCE(SUM(rls.current_quantity_estimate), 0)::int AS lot_net_qty
      FROM read_material_lot_state rls
      WHERE rls.status NOT IN ('DEPLETED', 'SCRAPPED')
        AND rls.current_quantity_estimate IS NOT NULL
      GROUP BY rls.packaging_material_id
    )
    SELECT
      pm.id::text                          AS packaging_material_id,
      pm.name                              AS material_name,
      pm.sku                               AS material_sku,
      pm.kind::text                        AS material_kind,
      pm.uom                               AS unit_of_measure,
      COALESCE(oh.on_hand_qty, 0)::int     AS on_hand_qty,
      COALESCE(p.pending_qty, 0)::int      AS pending_qty,
      COALESCE(ln.lot_net_qty, oh.on_hand_qty, 0)::int
        - COALESCE(p.pending_qty, 0)::int  AS net_balance
    FROM packaging_materials pm
    LEFT JOIN on_hand oh ON oh.packaging_material_id = pm.id
    LEFT JOIN pending p ON p.packaging_material_id = pm.id
    LEFT JOIN lot_net ln ON ln.packaging_material_id = pm.id
    WHERE pm.is_active = true
      AND pm.kind::text NOT IN ('PVC_ROLL', 'FOIL_ROLL', 'BLISTER_FOIL')
      AND (
        COALESCE(oh.on_hand_qty, 0) > 0
        OR COALESCE(p.pending_qty, 0) > 0
      )
    ORDER BY net_balance ASC, pm.name
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    packagingMaterialId: String(r.packaging_material_id),
    materialName: String(r.material_name),
    materialSku: String(r.material_sku),
    materialKind: String(r.material_kind),
    unitOfMeasure: String(r.unit_of_measure),
    onHandQty: Number(r.on_hand_qty),
    pendingQty: Number(r.pending_qty),
    netBalance: Number(r.net_balance),
  }));
}

export function pendingConsumptionLabel(row: {
  pendingQty: number;
  netBalance: number;
}): string | null {
  if (row.pendingQty > 0 && row.netBalance < 0) return "Negative balance";
  if (row.pendingQty > 0) return "Needs receipt";
  if (row.netBalance < 0) return "Negative balance";
  return null;
}
