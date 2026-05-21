// QC-4 — loaders for the /qc-review admin page.
//
// Three loaders + two pure helpers, all DB-handle-driven so tests can
// stub the drizzle execute() chain without a real database:
//
//   loadPendingDamage(db)      — PACKAGING_DAMAGE_RETURN events not
//                                yet converted to SCRAP_RECORDED or
//                                REWORK_SENT (NOT EXISTS via the
//                                payload->>'linked_event_id' index).
//
//   loadReworkInFlight(db)     — REWORK_SENT events where
//                                sum(linked REWORK_RECEIVED.received_quantity)
//                                < sent_quantity. Partial receives
//                                stack; remainder per row drives the
//                                "X of Y received, Z remaining" UI.
//
//   loadRecentQcEvents(db)     — latest N events across all five QC
//                                types, newest first.
//
// computeReworkRemainder(sent, receivedSum)
// isPartialReceiveValid(sent, thisReceive, priorSum)
//   Pure math helpers, unit-tested independently. UI uses these to
//   refuse a bad partial-receive before round-tripping to the action.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type DbLike = typeof Db;

export type PendingDamageRow = {
  id: string;
  occurredAt: Date;
  workflowBagId: string;
  stationId: string | null;
  stationLabel: string | null;
  machineId: string | null;
  machineName: string | null;
  productId: string | null;
  productSku: string | null;
  quantity: number;
  unit: string;
  reasonCode: string;
  notes: string | null;
  dispositionSuggestion: string | null;
  accountableEmployeeId: string | null;
  accountableEmployeeName: string | null;
  enteredByUserId: string | null;
  enteredByEmail: string | null;
};

export type ReworkInFlightRow = {
  id: string;
  occurredAt: Date;
  workflowBagId: string;
  fromStationId: string | null;
  fromStationLabel: string | null;
  toStationId: string | null;
  toStationLabel: string | null;
  sentQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
  unit: string;
  reasonCode: string;
  accountableEmployeeId: string | null;
  accountableEmployeeName: string | null;
  enteredByUserId: string | null;
  enteredByEmail: string | null;
};

export type RecentQcEventRow = {
  id: string;
  occurredAt: Date;
  eventType: string;
  workflowBagId: string;
  quantity: number | null;
  unit: string | null;
  reasonCode: string | null;
  linkedEventId: string | null;
  accountableEmployeeId: string | null;
  accountableEmployeeName: string | null;
  enteredByUserId: string | null;
  enteredByEmail: string | null;
};

export async function loadPendingDamage(
  db: DbLike,
  opts: { limit?: number } = {},
): Promise<PendingDamageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = (await db.execute(sql`
    SELECT
      e.id                                       AS "id",
      e.occurred_at                              AS "occurred_at",
      e.workflow_bag_id                          AS "workflow_bag_id",
      e.station_id                               AS "station_id",
      s.label                                    AS "station_label",
      s.machine_id                               AS "machine_id",
      m.name                                     AS "machine_name",
      e.payload->>'product_id'                   AS "product_id",
      p.sku                                      AS "product_sku",
      COALESCE((e.payload->>'quantity')::int, 0) AS "quantity",
      e.payload->>'unit'                         AS "unit",
      e.payload->>'reason_code'                  AS "reason_code",
      e.payload->>'notes'                        AS "notes",
      e.payload->>'disposition_suggestion'       AS "disposition_suggestion",
      e.employee_id                              AS "accountable_employee_id",
      emp.full_name                              AS "accountable_employee_name",
      e.user_id                                  AS "entered_by_user_id",
      u.email                                    AS "entered_by_email"
    FROM workflow_events e
    LEFT JOIN stations  s   ON s.id = e.station_id
    LEFT JOIN machines  m   ON m.id = s.machine_id
    LEFT JOIN products  p   ON p.id::text = e.payload->>'product_id'
    LEFT JOIN employees emp ON emp.id = e.employee_id
    LEFT JOIN users     u   ON u.id   = e.user_id
    WHERE e.event_type = 'PACKAGING_DAMAGE_RETURN'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_events r
        WHERE r.event_type IN ('SCRAP_RECORDED', 'REWORK_SENT')
          AND r.payload->>'linked_event_id' = e.id::text
      )
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: new Date(r.occurred_at as string | Date),
    workflowBagId: String(r.workflow_bag_id),
    stationId: (r.station_id as string | null) ?? null,
    stationLabel: (r.station_label as string | null) ?? null,
    machineId: (r.machine_id as string | null) ?? null,
    machineName: (r.machine_name as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    productSku: (r.product_sku as string | null) ?? null,
    quantity: Number(r.quantity ?? 0),
    unit: String(r.unit ?? ""),
    reasonCode: String(r.reason_code ?? ""),
    notes: (r.notes as string | null) ?? null,
    dispositionSuggestion: (r.disposition_suggestion as string | null) ?? null,
    accountableEmployeeId: (r.accountable_employee_id as string | null) ?? null,
    accountableEmployeeName: (r.accountable_employee_name as string | null) ?? null,
    enteredByUserId: (r.entered_by_user_id as string | null) ?? null,
    enteredByEmail: (r.entered_by_email as string | null) ?? null,
  }));
}

export async function loadReworkInFlight(
  db: DbLike,
  opts: { limit?: number } = {},
): Promise<ReworkInFlightRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = (await db.execute(sql`
    WITH sent AS (
      SELECT
        e.id                       AS sent_id,
        e.occurred_at,
        e.workflow_bag_id,
        e.station_id               AS from_station_id,
        e.payload->>'to_station_id' AS to_station_id,
        COALESCE((e.payload->>'quantity')::int, 0) AS sent_quantity,
        e.payload->>'unit'         AS unit,
        e.payload->>'reason_code'  AS reason_code,
        e.employee_id              AS accountable_employee_id,
        e.user_id                  AS entered_by_user_id
      FROM workflow_events e
      WHERE e.event_type = 'REWORK_SENT'
    ),
    received AS (
      SELECT
        r.payload->>'linked_event_id' AS sent_id,
        SUM(COALESCE((r.payload->>'received_quantity')::int, 0)) AS received_quantity
      FROM workflow_events r
      WHERE r.event_type = 'REWORK_RECEIVED'
        AND r.payload ? 'linked_event_id'
      GROUP BY r.payload->>'linked_event_id'
    )
    SELECT
      s.sent_id                                                            AS "id",
      s.occurred_at                                                        AS "occurred_at",
      s.workflow_bag_id                                                    AS "workflow_bag_id",
      s.from_station_id                                                    AS "from_station_id",
      fs.label                                                             AS "from_station_label",
      s.to_station_id                                                      AS "to_station_id",
      ts.label                                                             AS "to_station_label",
      s.sent_quantity                                                      AS "sent_quantity",
      COALESCE(rc.received_quantity, 0)                                    AS "received_quantity",
      GREATEST(s.sent_quantity - COALESCE(rc.received_quantity, 0), 0)     AS "remaining_quantity",
      s.unit                                                               AS "unit",
      s.reason_code                                                        AS "reason_code",
      s.accountable_employee_id                                            AS "accountable_employee_id",
      emp.full_name                                                        AS "accountable_employee_name",
      s.entered_by_user_id                                                 AS "entered_by_user_id",
      u.email                                                              AS "entered_by_email"
    FROM sent s
    LEFT JOIN received  rc  ON rc.sent_id = s.sent_id::text
    LEFT JOIN stations  fs  ON fs.id = s.from_station_id
    LEFT JOIN stations  ts  ON ts.id::text = s.to_station_id
    LEFT JOIN employees emp ON emp.id = s.accountable_employee_id
    LEFT JOIN users     u   ON u.id   = s.entered_by_user_id
    WHERE COALESCE(rc.received_quantity, 0) < s.sent_quantity
    ORDER BY s.occurred_at DESC, s.sent_id DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: new Date(r.occurred_at as string | Date),
    workflowBagId: String(r.workflow_bag_id),
    fromStationId: (r.from_station_id as string | null) ?? null,
    fromStationLabel: (r.from_station_label as string | null) ?? null,
    toStationId: (r.to_station_id as string | null) ?? null,
    toStationLabel: (r.to_station_label as string | null) ?? null,
    sentQuantity: Number(r.sent_quantity ?? 0),
    receivedQuantity: Number(r.received_quantity ?? 0),
    remainingQuantity: Number(r.remaining_quantity ?? 0),
    unit: String(r.unit ?? ""),
    reasonCode: String(r.reason_code ?? ""),
    accountableEmployeeId: (r.accountable_employee_id as string | null) ?? null,
    accountableEmployeeName: (r.accountable_employee_name as string | null) ?? null,
    enteredByUserId: (r.entered_by_user_id as string | null) ?? null,
    enteredByEmail: (r.entered_by_email as string | null) ?? null,
  }));
}

export async function loadRecentQcEvents(
  db: DbLike,
  opts: { limit?: number } = {},
): Promise<RecentQcEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = (await db.execute(sql`
    SELECT
      e.id                          AS "id",
      e.occurred_at                 AS "occurred_at",
      e.event_type::text            AS "event_type",
      e.workflow_bag_id             AS "workflow_bag_id",
      (e.payload->>'quantity')::int AS "quantity",
      e.payload->>'unit'            AS "unit",
      e.payload->>'reason_code'     AS "reason_code",
      e.payload->>'linked_event_id' AS "linked_event_id",
      e.employee_id                 AS "accountable_employee_id",
      emp.full_name                 AS "accountable_employee_name",
      e.user_id                     AS "entered_by_user_id",
      u.email                       AS "entered_by_email"
    FROM workflow_events e
    LEFT JOIN employees emp ON emp.id = e.employee_id
    LEFT JOIN users     u   ON u.id   = e.user_id
    WHERE e.event_type IN (
      'PACKAGING_DAMAGE_RETURN',
      'REWORK_SENT',
      'REWORK_RECEIVED',
      'SCRAP_RECORDED',
      'SUBMISSION_CORRECTED'
    )
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: new Date(r.occurred_at as string | Date),
    eventType: String(r.event_type),
    workflowBagId: String(r.workflow_bag_id),
    quantity:
      r.quantity == null || r.quantity === ""
        ? null
        : Number(r.quantity),
    unit: (r.unit as string | null) ?? null,
    reasonCode: (r.reason_code as string | null) ?? null,
    linkedEventId: (r.linked_event_id as string | null) ?? null,
    accountableEmployeeId: (r.accountable_employee_id as string | null) ?? null,
    accountableEmployeeName: (r.accountable_employee_name as string | null) ?? null,
    enteredByUserId: (r.entered_by_user_id as string | null) ?? null,
    enteredByEmail: (r.entered_by_email as string | null) ?? null,
  }));
}

// ─── Pure partial-receive math ─────────────────────────────────────────

export function computeReworkRemainder(
  sentQuantity: number,
  receivedQuantitySum: number,
): number {
  const r = sentQuantity - receivedQuantitySum;
  return r > 0 ? r : 0;
}

export function isPartialReceiveValid(
  sentQuantity: number,
  thisReceiveQuantity: number,
  priorReceivedSum: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(thisReceiveQuantity) || thisReceiveQuantity <= 0) {
    return {
      ok: false,
      reason: "Received quantity must be a positive integer.",
    };
  }
  const newTotal = priorReceivedSum + thisReceiveQuantity;
  if (newTotal > sentQuantity) {
    return {
      ok: false,
      reason: `Received total ${newTotal} would exceed sent quantity ${sentQuantity}.`,
    };
  }
  return { ok: true };
}
