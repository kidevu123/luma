// Phase H.x3.6 — Raw bag allocation ledger.
//
// An inventory_bag is no longer a single-shot consumed flag. It's a
// balance ledger that supports:
//   • partial consumption
//   • return to stock + later re-open
//   • split usage across multiple products / routes
//   • depletion + adjustment + voiding
//
// Source of truth: raw_bag_allocation_events (append-only).
// Aggregations: raw_bag_allocation_sessions (open/close lifecycle).
// Legacy fallback: when no allocation events exist for a bag, we
//   synthesize a single virtual allocation from
//   workflow_bags.inventory_bag_id + finished_lot_inputs.qty_consumed
//   so existing data still reconciles. The fallback is labeled
//   confidence MEDIUM with a missing-input note pointing at
//   "raw_bag_allocation_events".

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { combineConfidence, missing, ok, partial } from "./confidence";
import type { Confidence, MetricResult } from "./types";

// ─── Pure-math primitives ────────────────────────────────────────

/** From an ordered list of allocation events, compute the running
 *  balance. Pure function; no DB. Used by deriveRawBagBalance and by
 *  tests to pin the algebra. */
export type LedgerEntry = {
  eventType: string;
  quantity: number | null;
  occurredAt?: string;
};

export type LedgerBalance = {
  starting: number | null;
  allocated: number;
  consumed: number;
  returned: number;
  reweighed: number | null;
  adjusted: number;
  voided: number;
  /** Open allocation (resource committed to a session that hasn't
   *  closed yet). Computed as ALLOCATED − CONSUMED − RETURNED for
   *  the open-session subset. The caller passes only events from
   *  open sessions when computing this. */
  openAllocation: number;
  remainingEstimate: number | null;
};

/** Single-pass reduction. Treats RAW_BAG_OPENED as the starting
 *  balance (one OPEN event per session). RAW_BAG_REWEIGHED replaces
 *  the running balance with its quantity (a weigh-back is the most
 *  authoritative read). */
export function reduceLedger(
  entries: ReadonlyArray<LedgerEntry>,
  initialBalance: number | null = null,
): LedgerBalance {
  let starting: number | null = initialBalance;
  let allocated = 0;
  let consumed = 0;
  let returned = 0;
  let reweighed: number | null = null;
  let adjusted = 0;
  let voided = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.quantity ?? NaN)) {
      // Skip entries with invalid quantity but keep the rest of the
      // stream — we don't want one bad event to nuke the whole ledger.
      // The caller's confidence rollup should already capture this.
      continue;
    }
    const q = e.quantity!;
    switch (e.eventType) {
      case "RAW_BAG_OPENED":
        if (starting == null) starting = q;
        break;
      case "RAW_BAG_ALLOCATED":
        allocated += q;
        break;
      case "RAW_BAG_PARTIAL_CONSUMED":
        consumed += q;
        break;
      case "RAW_BAG_RETURNED_TO_STOCK":
        returned += q;
        break;
      case "RAW_BAG_REWEIGHED":
        reweighed = q;
        break;
      case "RAW_BAG_DEPLETED":
        // Mark depleted; remaining = 0 regardless of math.
        consumed += q;
        break;
      case "RAW_BAG_ADJUSTED":
        adjusted += q;
        break;
      case "RAW_BAG_VOIDED":
        voided += q;
        break;
      default:
        // Unknown event type — skip.
        break;
    }
  }
  // Remaining estimate: if we have a weigh-back, trust it.
  // Otherwise: starting + adjusted − consumed − returned − voided.
  let remainingEstimate: number | null = null;
  if (reweighed != null) {
    remainingEstimate = reweighed;
  } else if (starting != null) {
    remainingEstimate = starting + adjusted - consumed - returned - voided;
    if (remainingEstimate < 0) remainingEstimate = 0;
  }
  return {
    starting,
    allocated,
    consumed,
    returned,
    reweighed,
    adjusted,
    voided,
    openAllocation: 0,
    remainingEstimate,
  };
}

/** "Open allocation" view — given the same ledger, compute the
 *  quantity committed to OPEN sessions but not yet consumed/returned.
 *  Caller filters entries to only those from open sessions. */
export function reduceOpenAllocation(
  openEntries: ReadonlyArray<LedgerEntry>,
): number {
  let allocated = 0;
  let consumed = 0;
  let returned = 0;
  for (const e of openEntries) {
    if (!Number.isFinite(e.quantity ?? NaN)) continue;
    const q = e.quantity!;
    if (e.eventType === "RAW_BAG_ALLOCATED") allocated += q;
    else if (e.eventType === "RAW_BAG_PARTIAL_CONSUMED") consumed += q;
    else if (e.eventType === "RAW_BAG_RETURNED_TO_STOCK") returned += q;
  }
  const v = allocated - consumed - returned;
  return v > 0 ? v : 0;
}

/** Confidence ladder — pure helper used by derive functions. */
export function classifyBagConfidence(input: {
  hasEvents: boolean;
  hasFinishedLink: boolean;
  hasOpenAllocation: boolean;
  hasReweigh: boolean;
  hasStarting: boolean;
}): Confidence {
  // Per spec:
  //   HIGH:    closed session(s) + finished link + product structure + remaining/depleted known
  //   MEDIUM:  inferred from counters or finished output
  //   LOW:     manual allocation without closeout, partial bag still WIP, no weigh-back
  //   MISSING: no bag link / no product structure / no finished link / no remaining
  if (!input.hasEvents && !input.hasFinishedLink) return "MISSING";
  if (!input.hasFinishedLink && !input.hasReweigh) return "LOW";
  if (input.hasOpenAllocation && !input.hasReweigh) return "LOW";
  if (input.hasReweigh && input.hasFinishedLink && input.hasStarting) return "HIGH";
  if (input.hasFinishedLink) return "MEDIUM";
  return "LOW";
}

// ─── DB-backed helpers ──────────────────────────────────────────

export type LedgerEvent = {
  id: string;
  eventType: string;
  quantity: number | null;
  unitOfMeasure: string;
  quantitySource: string | null;
  occurredAt: string;
  productId: string | null;
  routeId: string | null;
  finishedLotId: string | null;
  workflowBagId: string | null;
  payload: Record<string, unknown>;
  confidence: string;
};

/** Full event stream for a bag, ordered. Includes the new ledger
 *  events; falls back to a synthesized stream from finished_lot_inputs
 *  when no ledger events exist. */
export async function deriveRawBagLedger(
  inventoryBagId: string,
): Promise<LedgerEvent[]> {
  if (!inventoryBagId) return [];
  type Row = {
    id: string;
    event_type: string;
    quantity: string | null;
    unit_of_measure: string;
    quantity_source: string | null;
    occurred_at: string;
    product_id: string | null;
    route_id: string | null;
    finished_lot_id: string | null;
    workflow_bag_id: string | null;
    payload: Record<string, unknown>;
    confidence: string;
  };
  const rows = (await db.execute<Row>(sql`
    SELECT
      id::text, event_type, quantity::text AS quantity, unit_of_measure,
      quantity_source, occurred_at::text AS occurred_at,
      product_id::text, route_id::text, finished_lot_id::text,
      workflow_bag_id::text, payload, confidence
    FROM raw_bag_allocation_events
    WHERE inventory_bag_id = ${inventoryBagId}
    ORDER BY occurred_at, id
  `)) as unknown as Row[];
  if (rows.length > 0) {
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      quantity: r.quantity != null ? Number(r.quantity) : null,
      unitOfMeasure: r.unit_of_measure,
      quantitySource: r.quantity_source,
      occurredAt: r.occurred_at,
      productId: r.product_id,
      routeId: r.route_id,
      finishedLotId: r.finished_lot_id,
      workflowBagId: r.workflow_bag_id,
      payload: r.payload,
      confidence: r.confidence,
    }));
  }
  // Lazy fallback — synthesize from existing data so legacy bags
  // still reconcile. Each finished_lot_inputs row tied to the bag's
  // batch becomes a single RAW_BAG_PARTIAL_CONSUMED entry.
  type FbRow = {
    id: string;
    qty: number;
    finished_lot_id: string;
    occurred_at: string;
    product_id: string | null;
  };
  const fb = (await db.execute<FbRow>(sql`
    SELECT
      fli.id::text                      AS id,
      fli.qty_consumed                  AS qty,
      fli.finished_lot_id::text         AS finished_lot_id,
      fl.created_at::text               AS occurred_at,
      fl.product_id::text               AS product_id
    FROM inventory_bags ib
    JOIN finished_lot_inputs fli       ON fli.batch_id = ib.batch_id
    JOIN finished_lots fl              ON fl.id = fli.finished_lot_id
    WHERE ib.id = ${inventoryBagId}
    ORDER BY fl.created_at, fli.id
  `)) as unknown as FbRow[];
  return fb.map((r) => ({
    id: r.id,
    eventType: "RAW_BAG_PARTIAL_CONSUMED",
    quantity: r.qty,
    unitOfMeasure: "tablets",
    quantitySource: "FINISHED_LOT_INPUT",
    occurredAt: r.occurred_at,
    productId: r.product_id,
    routeId: null,
    finishedLotId: r.finished_lot_id,
    workflowBagId: null,
    payload: { lazy_fallback: true },
    confidence: "MEDIUM",
  }));
}

export type RawBagBalance = {
  inventoryBagId: string;
  poId: string | null;
  rawItemId: string | null;
  vendorDeclaredCount: number | null;
  receivedWeightGrams: number | null;
  startingQty: number | null;
  allocatedQty: number;
  consumedQty: number;
  returnedQty: number;
  remainingQtyEstimate: number | null;
  openAllocationQty: number;
  knownLossQty: number;
  unknownVarianceQty: number | null;
  confidence: Confidence;
  missingInputs: string[];
  lastEventAt: string | null;
  fallbackUsed: boolean;
  status: string;
};

export async function deriveRawBagBalance(
  inventoryBagId: string,
): Promise<RawBagBalance | null> {
  if (!inventoryBagId) return null;
  type BagRow = {
    inventory_bag_id: string;
    po_id: string | null;
    raw_item_id: string | null;
    vendor_declared_count: number | null;
    received_weight_grams: number | null;
    status: string;
    batch_id: string | null;
  };
  const bagRows = (await db.execute<BagRow>(sql`
    SELECT
      ib.id::text                  AS inventory_bag_id,
      po.id::text                  AS po_id,
      ib.tablet_type_id::text      AS raw_item_id,
      ib.pill_count                AS vendor_declared_count,
      ib.weight_grams              AS received_weight_grams,
      ib.status::text              AS status,
      ib.batch_id::text            AS batch_id
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb     ON sb.id = ib.small_box_id
    LEFT JOIN receives r         ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${inventoryBagId}
    LIMIT 1
  `)) as unknown as BagRow[];
  const bag = bagRows[0];
  if (!bag) return null;

  const ledger = await deriveRawBagLedger(inventoryBagId);
  const fallbackUsed = ledger.length > 0 && ledger[0]?.payload?.["lazy_fallback"] === true;

  const balance = reduceLedger(
    ledger.map((e) => ({ eventType: e.eventType, quantity: e.quantity })),
    bag.vendor_declared_count ?? null,
  );

  // Find OPEN sessions for this bag — quantity held in pending
  // allocations.
  type OpenRow = { quantity: number };
  const openEntries = (await db.execute<OpenRow>(sql`
    SELECT
      e.quantity::numeric::int                 AS quantity,
      e.event_type
    FROM raw_bag_allocation_events e
    JOIN raw_bag_allocation_sessions s ON s.id = e.allocation_session_id
    WHERE e.inventory_bag_id = ${inventoryBagId}
      AND s.allocation_status = 'OPEN'
      AND e.event_type IN ('RAW_BAG_ALLOCATED','RAW_BAG_PARTIAL_CONSUMED','RAW_BAG_RETURNED_TO_STOCK')
  `)) as unknown as Array<{ quantity: number; event_type?: string }>;
  const openAllocationQty = reduceOpenAllocation(
    openEntries.map((e) => ({ eventType: (e as { event_type?: string }).event_type ?? "", quantity: e.quantity })),
  );

  // Known loss for this bag — pulled from workflow_events tied to
  // the consuming workflow_bags.
  type LossRow = { known_loss: number | null };
  const lossRows = (await db.execute<LossRow>(sql`
    SELECT SUM(
      COALESCE(
        NULLIF((we.payload->>'damaged_count'),'')::int,
        NULLIF((we.payload->>'rework_count'),'')::int,
        NULLIF((we.payload->>'count'),'')::int
      )
    )::int AS known_loss
    FROM workflow_events we
    JOIN workflow_bags wb ON wb.id = we.workflow_bag_id
    WHERE wb.inventory_bag_id = ${inventoryBagId}
      AND we.event_type::text IN ('PACKAGING_DAMAGE_RETURN','BAG_PAUSED')
  `)) as unknown as LossRow[];
  const knownLossQty = lossRows[0]?.known_loss ?? 0;

  const lastEventAt = ledger.length > 0
    ? (ledger[ledger.length - 1] as LedgerEvent).occurredAt
    : null;

  // Unknown variance:
  //   vendor_declared - consumed - returned - remaining - knownLoss
  let unknownVariance: number | null = null;
  if (
    bag.vendor_declared_count != null &&
    balance.remainingEstimate != null
  ) {
    unknownVariance =
      bag.vendor_declared_count -
      balance.consumed -
      balance.returned -
      balance.remainingEstimate -
      knownLossQty;
  }

  const missingInputs: string[] = [];
  if (bag.vendor_declared_count == null) missingInputs.push("vendor_declared_count");
  if (bag.received_weight_grams == null) missingInputs.push("received_net_weight");
  if (ledger.length === 0) missingInputs.push("raw_bag_allocation_events");
  if (fallbackUsed) missingInputs.push("legacy_lazy_fallback");
  if (openAllocationQty > 0) missingInputs.push("open_allocation");

  const confidence = classifyBagConfidence({
    hasEvents: ledger.length > 0 && !fallbackUsed,
    hasFinishedLink: ledger.some((e) => e.finishedLotId != null),
    hasOpenAllocation: openAllocationQty > 0,
    hasReweigh: balance.reweighed != null,
    hasStarting: balance.starting != null,
  });

  return {
    inventoryBagId: bag.inventory_bag_id,
    poId: bag.po_id,
    rawItemId: bag.raw_item_id,
    vendorDeclaredCount: bag.vendor_declared_count,
    receivedWeightGrams: bag.received_weight_grams,
    startingQty: balance.starting,
    allocatedQty: balance.allocated,
    consumedQty: balance.consumed,
    returnedQty: balance.returned,
    remainingQtyEstimate: balance.remainingEstimate,
    openAllocationQty,
    knownLossQty,
    unknownVarianceQty: unknownVariance,
    confidence,
    missingInputs,
    lastEventAt,
    fallbackUsed,
    status: bag.status,
  };
}

/** All currently-open allocation sessions across every bag.
 *  Helpful for the floor "what's open right now?" view. */
export type OpenAllocation = {
  sessionId: string;
  inventoryBagId: string;
  productId: string | null;
  productName: string | null;
  routeId: string | null;
  workflowBagId: string | null;
  componentRole: string | null;
  startingBalanceQty: number | null;
  consumedQty: number | null;
  openedAt: string;
};

export async function deriveOpenBagAllocations(): Promise<OpenAllocation[]> {
  type Row = {
    session_id: string;
    inventory_bag_id: string;
    product_id: string | null;
    product_name: string | null;
    route_id: string | null;
    workflow_bag_id: string | null;
    component_role: string | null;
    starting_balance_qty: number | null;
    consumed_qty: number | null;
    opened_at: string;
  };
  const rows = (await db.execute<Row>(sql`
    SELECT
      s.id::text                AS session_id,
      s.inventory_bag_id::text  AS inventory_bag_id,
      s.product_id::text        AS product_id,
      p.name                    AS product_name,
      s.route_id::text          AS route_id,
      s.workflow_bag_id::text   AS workflow_bag_id,
      s.component_role          AS component_role,
      s.starting_balance_qty    AS starting_balance_qty,
      s.consumed_qty            AS consumed_qty,
      s.opened_at::text         AS opened_at
    FROM raw_bag_allocation_sessions s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.allocation_status = 'OPEN'
    ORDER BY s.opened_at DESC
    LIMIT 500
  `)) as unknown as Row[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    inventoryBagId: r.inventory_bag_id,
    productId: r.product_id,
    productName: r.product_name,
    routeId: r.route_id,
    workflowBagId: r.workflow_bag_id,
    componentRole: r.component_role,
    startingBalanceQty: r.starting_balance_qty,
    consumedQty: r.consumed_qty,
    openedAt: r.opened_at,
  }));
}

// ─── Pure helpers for allocation session lifecycle ───────────────

/**
 * Pure helper — exported for testing.
 * Determines the default starting balance when opening a NEW allocation
 * session on a bag that has prior sessions.
 *
 * Precedence:
 *  1. If the last closed session has endingBalanceQty → use it (most authoritative).
 *  2. Else compute: lastSession.startingBalanceQty - lastSession.consumedQty (clamped ≥ 0).
 *  3. No prior session → fall back to pillCount (first-time open).
 */
export function resolveReopenStartingBalance(
  lastClosedSession: {
    endingBalanceQty: number | null;
    startingBalanceQty: number | null;
    consumedQty: number | null;
  } | null | undefined,
  pillCount: number | null | undefined,
): number | null {
  if (!lastClosedSession) return pillCount ?? null;
  if (lastClosedSession.endingBalanceQty != null) return lastClosedSession.endingBalanceQty;
  const start = lastClosedSession.startingBalanceQty ?? pillCount;
  if (start != null) {
    return Math.max(0, start - (lastClosedSession.consumedQty ?? 0));
  }
  return pillCount ?? null;
}

/**
 * Pure helper — exported for testing.
 * Returns an error string if consumedQty would exceed the session's
 * starting balance; null if OK or if starting balance is unknown.
 */
export function checkOverAllocation(
  consumedQty: number,
  startingBalanceQty: number | null | undefined,
): string | null {
  if (startingBalanceQty != null && consumedQty > startingBalanceQty) {
    return (
      `Consumed quantity (${consumedQty.toLocaleString()}) exceeds session starting ` +
      `balance (${startingBalanceQty.toLocaleString()}). Check your consumed count.`
    );
  }
  return null;
}

// ─── PO-level allocation reports ────────────────────────────────

export type PoBagAllocationRow = RawBagBalance & {
  bagNumber: number | null;
  vendorBarcode: string | null;
  rawItemName: string | null;
};

/** Per-bag allocation balance for every bag in the PO. */
export async function derivePoBagAllocationReport(
  poId: string,
): Promise<PoBagAllocationRow[]> {
  if (!poId) return [];
  type IbRow = {
    id: string;
    bag_number: number | null;
    vendor_barcode: string | null;
    raw_item_name: string | null;
  };
  const bagsRows = (await db.execute<IbRow>(sql`
    SELECT
      ib.id::text                AS id,
      ib.bag_number              AS bag_number,
      ib.vendor_barcode          AS vendor_barcode,
      tt.name                    AS raw_item_name
    FROM inventory_bags ib
    LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
    JOIN small_boxes sb       ON sb.id = ib.small_box_id
    JOIN receives r           ON r.id = sb.receive_id
    WHERE r.po_id = ${poId}
    ORDER BY ib.bag_number
  `)) as unknown as IbRow[];

  const out: PoBagAllocationRow[] = [];
  for (const b of bagsRows) {
    const balance = await deriveRawBagBalance(b.id);
    if (balance) {
      out.push({
        ...balance,
        bagNumber: b.bag_number,
        vendorBarcode: b.vendor_barcode,
        rawItemName: b.raw_item_name,
      });
    }
  }
  return out;
}

export type PoSplitUsageRow = {
  productId: string;
  productName: string;
  productSku: string;
  routeCode: string | null;
  bagsTouched: number;
  consumedFromPo: number;
  finishedEquivalent: number;
  damageRework: number;
  yieldPercent: number | null;
  shareOfPoConsumed: number | null;
  /** Confidence inherited from underlying ledger sources. */
  confidence: Confidence;
};

/** Per (product, route) consumption rollup for a PO. Pulls from
 *  raw_bag_allocation_events when present; otherwise falls back to
 *  finished_lot_inputs.qty_consumed (legacy data). */
export async function derivePoSplitUsageReport(
  poId: string,
): Promise<PoSplitUsageRow[]> {
  type Row = {
    product_id: string;
    product_name: string;
    product_sku: string;
    route_code: string | null;
    bags_touched: number;
    consumed_from_po: number;
    finished_equivalent: number;
    damage_rework: number;
    used_ledger: boolean;
  };
  const rows = (await db.execute<Row>(sql`
    WITH bag_set AS (
      SELECT ib.id, ib.batch_id
      FROM inventory_bags ib
      JOIN small_boxes sb ON sb.id = ib.small_box_id
      JOIN receives r     ON r.id = sb.receive_id
      WHERE r.po_id = ${poId}
    ),
    -- Ledger-based consumption per product
    ledger AS (
      SELECT
        e.product_id,
        COUNT(DISTINCT e.inventory_bag_id)::int AS bags_touched,
        SUM(
          CASE WHEN e.event_type = 'RAW_BAG_PARTIAL_CONSUMED' THEN COALESCE(e.quantity::numeric::int, 0) ELSE 0 END
        )::int AS consumed_from_po
      FROM raw_bag_allocation_events e
      WHERE e.inventory_bag_id IN (SELECT id FROM bag_set)
        AND e.product_id IS NOT NULL
      GROUP BY e.product_id
    ),
    -- Legacy fallback per product (from finished_lot_inputs).
    legacy AS (
      SELECT
        fl.product_id,
        SUM(fli.qty_consumed)::int  AS legacy_consumed,
        SUM(fl.units_produced)::int AS finished_equivalent
      FROM finished_lot_inputs fli
      JOIN finished_lots fl ON fl.id = fli.finished_lot_id
      WHERE fli.batch_id IN (SELECT batch_id FROM bag_set WHERE batch_id IS NOT NULL)
      GROUP BY fl.product_id
    ),
    damage AS (
      SELECT
        wb.product_id,
        SUM(
          COALESCE(NULLIF((we.payload->>'damaged_count'),'')::int,
                   NULLIF((we.payload->>'rework_count'),'')::int,
                   NULLIF((we.payload->>'count'),'')::int)
        )::int AS damage_rework
      FROM workflow_bags wb
      JOIN workflow_events we ON we.workflow_bag_id = wb.id
      WHERE wb.inventory_bag_id IN (SELECT id FROM bag_set)
        AND we.event_type::text IN ('PACKAGING_DAMAGE_RETURN','BAG_PAUSED')
      GROUP BY wb.product_id
    )
    SELECT
      p.id::text                                   AS product_id,
      p.name                                       AS product_name,
      p.sku                                        AS product_sku,
      pr.code                                      AS route_code,
      COALESCE(l.bags_touched, 0)                  AS bags_touched,
      COALESCE(l.consumed_from_po, lg.legacy_consumed, 0) AS consumed_from_po,
      COALESCE(lg.finished_equivalent, 0)          AS finished_equivalent,
      COALESCE(d.damage_rework, 0)                 AS damage_rework,
      (l.consumed_from_po IS NOT NULL)             AS used_ledger
    FROM products p
    LEFT JOIN ledger l   ON l.product_id = p.id
    LEFT JOIN legacy lg  ON lg.product_id = p.id
    LEFT JOIN damage d   ON d.product_id = p.id
    LEFT JOIN product_route_assignments pra
      ON pra.product_id = p.id AND pra.is_default = true AND pra.is_active = true
    LEFT JOIN production_routes pr ON pr.id = pra.route_id
    WHERE COALESCE(l.consumed_from_po, lg.legacy_consumed, 0) > 0
       OR COALESCE(d.damage_rework, 0) > 0
    ORDER BY p.name
  `)) as unknown as Row[];

  const totalConsumed = rows.reduce((sum, r) => sum + (r.consumed_from_po ?? 0), 0);
  return rows.map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    productSku: r.product_sku,
    routeCode: r.route_code,
    bagsTouched: r.bags_touched,
    consumedFromPo: r.consumed_from_po,
    finishedEquivalent: r.finished_equivalent,
    damageRework: r.damage_rework,
    yieldPercent: r.consumed_from_po > 0 ? (r.finished_equivalent / r.consumed_from_po) * 100 : null,
    shareOfPoConsumed: totalConsumed > 0 ? (r.consumed_from_po / totalConsumed) * 100 : null,
    confidence: r.used_ledger ? "HIGH" : "MEDIUM",
  }));
}

// ─── Vendor dispute / audit packet ────────────────────────────

export type SupplierDisputePacket = {
  poNumber: string;
  vendorName: string | null;
  generatedAt: string;
  bagsReceived: number;
  vendorDeclaredTotal: MetricResult;
  ourReceivedWeightTotal: MetricResult;
  consumedByCard: MetricResult;
  consumedByBottle: MetricResult;
  consumedByVarietyPack: MetricResult;
  remainingTotal: MetricResult;
  knownDamageRework: MetricResult;
  unknownVariance: MetricResult;
  combinedConfidence: Confidence;
  /** Bullet list of short, neutral-language explanations the report
   *  can render verbatim. No accusatory language. */
  narrative: string[];
};

export async function derivePoSupplierDisputePacket(
  poId: string,
): Promise<SupplierDisputePacket | null> {
  if (!poId) return null;
  type Row = {
    po_number: string;
    vendor_name: string | null;
    bags_received: number;
    vendor_total: number | null;
    received_weight_total: number | null;
  };
  const headerRows = (await db.execute<Row>(sql`
    SELECT
      po.po_number                         AS po_number,
      po.vendor_name                       AS vendor_name,
      COUNT(ib.id)::int                    AS bags_received,
      SUM(ib.pill_count)::int              AS vendor_total,
      SUM(ib.weight_grams)::int            AS received_weight_total
    FROM purchase_orders po
    LEFT JOIN receives r        ON r.po_id = po.id
    LEFT JOIN small_boxes sb    ON sb.receive_id = r.id
    LEFT JOIN inventory_bags ib ON ib.small_box_id = sb.id
    WHERE po.id = ${poId}
    GROUP BY po.po_number, po.vendor_name
  `)) as unknown as Row[];
  const h = headerRows[0];
  if (!h) return null;

  const split = await derivePoSplitUsageReport(poId);
  const bagBalance = await derivePoBagAllocationReport(poId);

  // Bucket consumption by route family.
  let card = 0;
  let bottle = 0;
  let variety = 0;
  for (const s of split) {
    const route = (s.routeCode ?? "").toUpperCase();
    if (route.includes("CARD") || route.includes("BLISTER")) card += s.consumedFromPo;
    else if (route.includes("BOTTLE")) bottle += s.consumedFromPo;
    else if (route.includes("VARIETY") || route.includes("PACK")) variety += s.consumedFromPo;
    else if (s.productName.toLowerCase().includes("variety")) variety += s.consumedFromPo;
  }

  const remainingTotal = bagBalance.reduce(
    (acc, b) => acc + (b.remainingQtyEstimate ?? 0),
    0,
  );
  const remainingHasMissing = bagBalance.some(
    (b) => b.remainingQtyEstimate == null,
  );

  const knownLoss = bagBalance.reduce((acc, b) => acc + (b.knownLossQty ?? 0), 0);

  const unknown =
    h.vendor_total != null && !remainingHasMissing
      ? h.vendor_total - card - bottle - variety - remainingTotal - knownLoss
      : null;

  const combinedConfidence = combineConfidence(
    bagBalance.length > 0
      ? bagBalance.map((b) => b.confidence)
      : ["MISSING"],
  );

  const narrative: string[] = [
    `We received ${h.bags_received} bag${h.bags_received === 1 ? "" : "s"} under PO ${h.po_number}.`,
    h.vendor_total != null
      ? `Vendor declared total was ${h.vendor_total.toLocaleString()} units.`
      : "Vendor declared total is missing — see bag-level breakdown for which bags lack a declaration.",
    h.received_weight_total != null
      ? `Combined received net weight: ${h.received_weight_total.toLocaleString()} g.`
      : "Received weights are not recorded for this PO.",
    card > 0 ? `${card.toLocaleString()} units consumed into card / blister products.` : "",
    bottle > 0 ? `${bottle.toLocaleString()} units consumed into bottle products.` : "",
    variety > 0 ? `${variety.toLocaleString()} units consumed into variety packs.` : "",
    remainingHasMissing
      ? "Remaining inventory total is incomplete — at least one bag has no remaining estimate (likely WIP)."
      : `${remainingTotal.toLocaleString()} units remain in inventory across the PO's bags.`,
    `${knownLoss.toLocaleString()} units recorded as known damage / rework.`,
    unknown != null
      ? `${unknown.toLocaleString()} units are unaccounted-for variance — the residual after all accounted output, remaining, and known loss.`
      : "Unknown variance is not computable yet — at least one input is missing (see Missing Data panel).",
    `Combined confidence across all bags: ${combinedConfidence}. Settlement source must consider this confidence — manual review is required when LOW or MISSING.`,
  ].filter((s) => s.length > 0);

  return {
    poNumber: h.po_number,
    vendorName: h.vendor_name,
    generatedAt: new Date().toISOString(),
    bagsReceived: h.bags_received,
    vendorDeclaredTotal:
      h.vendor_total != null
        ? ok(h.vendor_total, "units")
        : missing("units", ["vendor_declared_count"], "Vendor declared count missing"),
    ourReceivedWeightTotal:
      h.received_weight_total != null
        ? ok(h.received_weight_total, "g")
        : missing("g", ["received_net_weight"], "Received weight not recorded"),
    consumedByCard:
      card > 0 ? ok(card, "units") : ok(0, "units", { explanation: "No card-route consumption recorded." }),
    consumedByBottle:
      bottle > 0 ? ok(bottle, "units") : ok(0, "units", { explanation: "No bottle-route consumption recorded." }),
    consumedByVarietyPack:
      variety > 0 ? ok(variety, "units") : ok(0, "units", { explanation: "No variety-pack consumption recorded." }),
    remainingTotal: remainingHasMissing
      ? partial(remainingTotal, "units", {
          missingInputs: ["wip_remaining"],
          explanation: "At least one bag has no remaining estimate (likely WIP).",
        })
      : ok(remainingTotal, "units"),
    knownDamageRework: ok(knownLoss, "units", {
      explanation: "Sum of damage/rework counters across consuming workflow bags.",
    }),
    unknownVariance:
      unknown != null
        ? partial(unknown, "units", {
            missingInputs: [],
            explanation:
              "Residual after vendor declared minus accounted output minus remaining minus known loss. Investigate when non-zero.",
          })
        : missing("units", ["accounting_inputs"], "Cannot compute (missing input)"),
    combinedConfidence,
    narrative,
  };
}

// ─── QR lifecycle helpers ────────────────────────────────────────

/** Determines whether the QR traveler card should be released to IDLE
 *  at BAG_FINALIZED time, based on the most-recent allocation session.
 *
 *  - No session (legacy/untracked bag): release.
 *  - CLOSED, endingBalanceQty > 0: hold — partial remaining.
 *  - CLOSED/RETURNED_TO_STOCK, endingBalanceQty null: hold — unknown.
 *  - CLOSED/RETURNED_TO_STOCK, endingBalanceQty = 0: release — empty.
 *  - CLOSED/RETURNED_TO_STOCK, endingBalanceQty > 0: hold — partial bag.
 *  - DEPLETED / VOIDED: release.
 */
export function shouldReleaseQrAtFinalization(
  session: { allocationStatus: string; endingBalanceQty: number | null } | null | undefined,
): boolean {
  if (!session) return true;
  if (
    session.allocationStatus === "CLOSED" ||
    session.allocationStatus === "RETURNED_TO_STOCK"
  ) {
    if (session.endingBalanceQty == null) return false;
    return session.endingBalanceQty <= 0;
  }
  return true;
}

/** The inventory_bags.status to set after closeAllocationSessionAction.
 *  Returns null if the bag status should not change (leave as IN_USE).
 *
 *  - endingBalanceQty > 0  → AVAILABLE (partial; can reopen)
 *  - endingBalanceQty = 0  → EMPTIED (operator confirmed empty on close)
 *  - endingBalanceQty null → null (leave IN_USE; operator must mark depleted separately)
 */
export function deriveBagStatusAfterClose(
  endingBalanceQty: number | null | undefined,
): "AVAILABLE" | "EMPTIED" | null {
  if (endingBalanceQty == null) return null;
  if (endingBalanceQty > 0) return "AVAILABLE";
  return "EMPTIED";
}

/** True when a finalized workflow_bag's allocation session still has
 *  remaining tablets — the QR should stay assigned and be resumable.
 *  Covers both CLOSED (with endingBalance > 0) and RETURNED_TO_STOCK. */
export function isPartialBagResume(
  session: { allocationStatus: string; endingBalanceQty: number | null } | null | undefined,
): boolean {
  if (!session) return false;
  if (
    session.allocationStatus !== "CLOSED" &&
    session.allocationStatus !== "RETURNED_TO_STOCK"
  ) {
    return false;
  }
  return session.endingBalanceQty == null || session.endingBalanceQty > 0;
}
