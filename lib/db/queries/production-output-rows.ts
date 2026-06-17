// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — unified historical query.
//
// Single source of truth for the workbench results table. Returns one
// row per workflow_bag that matches the filter set, joined with:
//   - read_bag_metrics      (production quantities)
//   - read_bag_state        (stage, excluded flag, operator code)
//   - products              (name, sku, Zoho ids, tablets-per-unit)
//   - inventory_bags        (receipt number, source bag)
//   - finished_lots         (lot id, number, status — when issued)
//   - latest zoho op        (status, committed_at — via LATERAL)
//   - genealogy link count  (finished_lot_raw_bags rows — correlated)
//
// Unlike `listProductionOutputBacklogWithEligibility`, this query is
// NOT restricted to `finished_lots.id IS NULL` — when status=all or
// status=issued_lot is selected, already-issued lots come back too.
//
// The query intentionally fetches a superset (no SQL-side status
// filter except for packaged_not_finalized) and lets the JS classifier
// derive each row's status badge. That keeps the SQL straightforward
// and the classification rules co-located with the type definitions
// in production-output-row-classifier.ts.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  PRODUCTION_OUTPUT_LIMIT_MAX,
  type ProductionOutputFilters,
  type ProductionOutputLimitOption,
} from "@/lib/production/production-output-filters";

export type ProductionOutputRowRaw = {
  workflowBagId: string;
  receiptNumber: string | null;
  startedAt: Date | null;
  finalizedAt: Date | null;
  stage: string | null;
  excludedFromOutput: boolean | null;
  operatorCode: string | null;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  productTabletsPerUnit: number | null;
  productZohoItemIdUnit: string | null;
  productZohoItemIdDisplay: string | null;
  productZohoItemIdCase: string | null;
  masterCases: number | null;
  displaysMade: number | null;
  looseCards: number | null;
  unitsYielded: number | null;
  damagedPackaging: number | null;
  rippedCards: number | null;
  inventoryBagId: string | null;
  finishedLotId: string | null;
  finishedLotNumber: string | null;
  finishedLotStatus: string | null;
  finishedLotProducedOn: Date | null;
  poId: string | null;
  poNumber: string | null;
  zohoOpId: string | null;
  zohoOpStatus: string | null;
  zohoOpCommittedAt: Date | null;
  genealogyLinkCount: number;
};

export type ListProductionOutputRowsResult = {
  rows: ProductionOutputRowRaw[];
  totalCount: number;
  limit: ProductionOutputLimitOption;
  page: number;
  hasMore: boolean;
};

/**
 * Run the unified workbench query.
 *
 * Defaults (no filters):
 *   - finalized_at IS NOT NULL
 *   - finished_lots.id IS NULL
 *   - excluded_from_output = false
 *   - 20 most recent by finalized_at
 *
 * Defaults preserve the historical "Output queue" semantics so the
 * page renders identically when no filter is set.
 *
 * Any user-driven filter (q/from/to/status/poId/page) widens the
 * query so older runs and already-issued lots become reachable.
 */
export async function listProductionOutputRowsWithFilters(
  filters: ProductionOutputFilters,
): Promise<ListProductionOutputRowsResult> {
  const limit = filters.limit;
  const offset = (filters.page - 1) * limit;

  // We always cap at MAX defensively even though parseLimit already
  // clamps to {20,50,100}.
  const safeLimit = Math.min(limit, PRODUCTION_OUTPUT_LIMIT_MAX);

  const hasUserFilter = filters.hasUserFilter;
  const status = filters.status;

  // Inclusive lower / exclusive upper for date filters. We compare
  // against finalized_at when present, falling back to started_at so
  // unfinalized rows from the PACKAGED stage are still findable by
  // operators who type a recent date range.
  const fromIso = filters.from?.toISOString() ?? null;
  const toIso = filters.to?.toISOString() ?? null;

  // Search needles. We accept partial matches via ILIKE on:
  //   - inventory_bags.internal_receipt_number
  //   - workflow_bags.receipt_number
  //   - products.name / sku
  //   - workflow_bags.id (full uuid + first-8 shortcut)
  //   - finished_lots.finished_lot_number / trace_code / alias
  //   - read_bag_state.current_operator_code
  //
  // The needle is wrapped in `%...%` server-side; SQL parameterization
  // protects against injection.
  const searchNeedle = filters.q ? `%${filters.q}%` : null;
  const searchExact = filters.q ?? null;

  const poId = filters.poId;

  // Build the WHERE clause. Default (no user filter) matches the
  // legacy backlog query. Any user filter switches to the wider
  // search-mode WHERE.
  let whereClause = sql``;
  if (hasUserFilter) {
    const clauses: ReturnType<typeof sql>[] = [];
    // Always exclude rows the operator has explicitly marked excluded
    // — even in search mode. They get their own status badge and are
    // reachable only via status=all + explicit confirmation.
    clauses.push(
      sql`COALESCE(rbs.excluded_from_output, false) = false`,
    );
    if (status === "packaged_not_finalized") {
      clauses.push(sql`wb.finalized_at IS NULL`);
      clauses.push(sql`rbs.stage = 'PACKAGED'`);
    } else if (status === "issued_lot" || status === "zoho_pending" || status === "zoho_committed") {
      clauses.push(sql`fl.id IS NOT NULL`);
    } else if (
      status === "awaiting_lot" ||
      status === "ready_to_auto_issue" ||
      status === "missing_allocation" ||
      status === "blocked"
    ) {
      clauses.push(sql`wb.finalized_at IS NOT NULL`);
      clauses.push(sql`fl.id IS NULL`);
    }
    if (fromIso) {
      clauses.push(
        sql`COALESCE(wb.finalized_at, wb.started_at) >= ${fromIso}::timestamptz`,
      );
    }
    if (toIso) {
      clauses.push(
        sql`COALESCE(wb.finalized_at, wb.started_at) <= ${toIso}::timestamptz`,
      );
    }
    if (poId) {
      clauses.push(sql`po.id = ${poId}`);
    }
    if (searchNeedle && searchExact) {
      clauses.push(sql`(
        ib.internal_receipt_number ILIKE ${searchNeedle}
        OR wb.receipt_number ILIKE ${searchNeedle}
        OR p.name ILIKE ${searchNeedle}
        OR p.sku ILIKE ${searchNeedle}
        OR wb.id::text ILIKE ${searchNeedle}
        OR LEFT(wb.id::text, 8) = ${searchExact.toLowerCase()}
        OR fl.finished_lot_number ILIKE ${searchNeedle}
        OR fl.trace_code ILIKE ${searchNeedle}
        OR fl.finished_lot_code_alias ILIKE ${searchNeedle}
        OR rbs.current_operator_code ILIKE ${searchNeedle}
      )`);
    }
    whereClause = sql`WHERE ${joinAnd(clauses)}`;
  } else {
    // Default mode mirrors the historical backlog filter.
    whereClause = sql`WHERE wb.finalized_at IS NOT NULL
      AND fl.id IS NULL
      AND COALESCE(rbs.excluded_from_output, false) = false`;
  }

  // ORDER BY: most recent first by COALESCE(finalized_at, started_at)
  // so PACKAGED rows surfaced via search still sort sensibly.
  const orderClause = sql`ORDER BY COALESCE(wb.finalized_at, wb.started_at) DESC NULLS LAST, wb.id DESC`;

  const dataQuery = sql`
    SELECT
      wb.id                                   AS workflow_bag_id,
      COALESCE(ib.internal_receipt_number, wb.receipt_number) AS receipt_number,
      wb.started_at                           AS started_at,
      wb.finalized_at                         AS finalized_at,
      rbs.stage                               AS stage,
      rbs.excluded_from_output                AS excluded_from_output,
      rbs.current_operator_code               AS operator_code,
      wb.product_id                           AS product_id,
      p.name                                  AS product_name,
      p.sku                                   AS product_sku,
      p.tablets_per_unit                      AS product_tablets_per_unit,
      p.zoho_item_id_unit                     AS product_zoho_item_id_unit,
      p.zoho_item_id_display                  AS product_zoho_item_id_display,
      p.zoho_item_id_case                     AS product_zoho_item_id_case,
      rbm.master_cases                        AS master_cases,
      rbm.displays_made                       AS displays_made,
      rbm.loose_cards                         AS loose_cards,
      rbm.units_yielded                       AS units_yielded,
      rbm.damaged_packaging                   AS damaged_packaging,
      rbm.ripped_cards                        AS ripped_cards,
      ib.id                                   AS inventory_bag_id,
      fl.id                                   AS finished_lot_id,
      fl.finished_lot_number                  AS finished_lot_number,
      fl.status::text                         AS finished_lot_status,
      fl.produced_on                          AS finished_lot_produced_on,
      po.id                                   AS po_id,
      po.po_number                            AS po_number,
      zop.id                                  AS zoho_op_id,
      zop.status                              AS zoho_op_status,
      zop.committed_at                        AS zoho_op_committed_at,
      (
        SELECT COUNT(*)::int
        FROM finished_lot_raw_bags flrb
        WHERE flrb.finished_lot_id = fl.id
      )                                       AS genealogy_link_count
    FROM workflow_bags wb
    LEFT JOIN inventory_bags ib  ON ib.id = wb.inventory_bag_id
    LEFT JOIN products p         ON p.id = wb.product_id
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    LEFT JOIN read_bag_metrics rbm ON rbm.workflow_bag_id = wb.id
    LEFT JOIN finished_lots fl   ON fl.workflow_bag_id = wb.id
    LEFT JOIN po_lines pol       ON pol.id = ib.po_line_id
    LEFT JOIN purchase_orders po ON po.id = pol.po_id
    LEFT JOIN LATERAL (
      SELECT id, status, committed_at
      FROM zoho_production_output_ops
      WHERE workflow_bag_id = wb.id
      ORDER BY created_at DESC
      LIMIT 1
    ) zop ON true
    ${whereClause}
    ${orderClause}
    LIMIT ${safeLimit}
    OFFSET ${offset}
  `;

  const countQuery = sql`
    SELECT COUNT(*)::int AS n
    FROM workflow_bags wb
    LEFT JOIN inventory_bags ib  ON ib.id = wb.inventory_bag_id
    LEFT JOIN products p         ON p.id = wb.product_id
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    LEFT JOIN finished_lots fl   ON fl.workflow_bag_id = wb.id
    LEFT JOIN po_lines pol       ON pol.id = ib.po_line_id
    LEFT JOIN purchase_orders po ON po.id = pol.po_id
    ${whereClause}
  `;

  type DataRow = {
    workflow_bag_id: string;
    receipt_number: string | null;
    started_at: Date | null;
    finalized_at: Date | null;
    stage: string | null;
    excluded_from_output: boolean | null;
    operator_code: string | null;
    product_id: string | null;
    product_name: string | null;
    product_sku: string | null;
    product_tablets_per_unit: number | null;
    product_zoho_item_id_unit: string | null;
    product_zoho_item_id_display: string | null;
    product_zoho_item_id_case: string | null;
    master_cases: number | null;
    displays_made: number | null;
    loose_cards: number | null;
    units_yielded: number | null;
    damaged_packaging: number | null;
    ripped_cards: number | null;
    inventory_bag_id: string | null;
    finished_lot_id: string | null;
    finished_lot_number: string | null;
    finished_lot_status: string | null;
    finished_lot_produced_on: Date | null;
    po_id: string | null;
    po_number: string | null;
    zoho_op_id: string | null;
    zoho_op_status: string | null;
    zoho_op_committed_at: Date | null;
    genealogy_link_count: number;
  };

  const [dataRows, countRows] = await Promise.all([
    db.execute<DataRow>(dataQuery),
    db.execute<{ n: number }>(countQuery),
  ]);

  const rows = (dataRows as unknown as DataRow[]).map(
    (r): ProductionOutputRowRaw => ({
      workflowBagId: r.workflow_bag_id,
      receiptNumber: r.receipt_number,
      startedAt: r.started_at != null ? new Date(r.started_at) : null,
      finalizedAt: r.finalized_at != null ? new Date(r.finalized_at) : null,
      stage: r.stage,
      excludedFromOutput: r.excluded_from_output,
      operatorCode: r.operator_code,
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      productTabletsPerUnit: r.product_tablets_per_unit,
      productZohoItemIdUnit: r.product_zoho_item_id_unit,
      productZohoItemIdDisplay: r.product_zoho_item_id_display,
      productZohoItemIdCase: r.product_zoho_item_id_case,
      masterCases: r.master_cases,
      displaysMade: r.displays_made,
      looseCards: r.loose_cards,
      unitsYielded: r.units_yielded,
      damagedPackaging: r.damaged_packaging,
      rippedCards: r.ripped_cards,
      inventoryBagId: r.inventory_bag_id,
      finishedLotId: r.finished_lot_id,
      finishedLotNumber: r.finished_lot_number,
      finishedLotStatus: r.finished_lot_status,
      finishedLotProducedOn:
        r.finished_lot_produced_on != null
          ? new Date(r.finished_lot_produced_on)
          : null,
      poId: r.po_id,
      poNumber: r.po_number,
      zohoOpId: r.zoho_op_id,
      zohoOpStatus: r.zoho_op_status,
      zohoOpCommittedAt:
        r.zoho_op_committed_at != null
          ? new Date(r.zoho_op_committed_at)
          : null,
      genealogyLinkCount: Number(r.genealogy_link_count ?? 0),
    }),
  );

  const totalCount = Number(
    (countRows as unknown as Array<{ n: number }>)[0]?.n ?? 0,
  );

  return {
    rows,
    totalCount,
    limit: safeLimit as ProductionOutputLimitOption,
    page: filters.page,
    hasMore: offset + rows.length < totalCount,
  };
}

function joinAnd(clauses: ReturnType<typeof sql>[]): ReturnType<typeof sql> {
  if (clauses.length === 0) return sql`true`;
  let acc = clauses[0]!;
  for (let i = 1; i < clauses.length; i++) {
    acc = sql`${acc} AND ${clauses[i]}`;
  }
  return acc;
}
