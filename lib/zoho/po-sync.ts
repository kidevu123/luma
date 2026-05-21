// PO-SYNC — Upsert purchase_orders from Zoho Inventory list endpoint.
//
// Calls listInventoryPurchaseOrders from inventory-service-client, then for
// each ZohoPurchaseOrderSummary:
//   1. SELECTs by zohoPoId
//   2. INSERTs if not found; UPDATEs if found (terminal-status guard applies)
//
// Line items are NOT synced here — the list endpoint carries no line details.
// lineUpserted and lineSkipped are always 0.
//
// See Task #29 spec for full algorithm documentation.

import { eq } from "drizzle-orm";
import { db as realDb } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { listInventoryPurchaseOrders } from "./inventory-service-client";
import type { ZohoPurchaseOrderSummary } from "./inventory-service-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PoSyncResult = {
  fetched: number;
  poUpserted: number;    // both inserts and updates
  lineUpserted: number;  // always 0 — list endpoint has no line items
  lineSkipped: number;   // always 0 — list endpoint has no line items
  errors: string[];
};

// Local status values (mirrors poStatusEnum in schema)
type LocalPoStatus = "DRAFT" | "OPEN" | "RECEIVING" | "RECEIVED" | "CLOSED" | "CANCELLED";

// Terminal statuses: once in these states, we do not let Zoho downgrade them.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<LocalPoStatus>([
  "RECEIVED",
  "CLOSED",
  "CANCELLED",
]);

// ─── Status mapping ───────────────────────────────────────────────────────────

function mapZohoStatus(zohoStatus: string): LocalPoStatus {
  switch (zohoStatus) {
    case "issued":             return "OPEN";
    case "partially_received": return "RECEIVING";
    case "received":           return "RECEIVED";
    case "draft":              return "DRAFT";
    case "cancelled":          return "CANCELLED";
    default:                   return "OPEN"; // safe default for unknown future statuses
  }
}

// ─── Main sync function ───────────────────────────────────────────────────────

export async function syncPurchaseOrdersFromZoho(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  dbOverride?: typeof realDb;
}): Promise<PoSyncResult> {
  const db = opts?.dbOverride ?? realDb;
  const errors: string[] = [];

  // Step 1: Fetch from Zoho
  // Build opts object conditionally to satisfy exactOptionalPropertyTypes —
  // we must not pass `env: undefined` or `fetchImpl: undefined` explicitly.
  const listOpts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {};
  if (opts?.env !== undefined) listOpts.env = opts.env;
  if (opts?.fetchImpl !== undefined) listOpts.fetchImpl = opts.fetchImpl;

  const listResult = await listInventoryPurchaseOrders(listOpts);

  if (!listResult.ok) {
    return {
      fetched: 0,
      poUpserted: 0,
      lineUpserted: 0,
      lineSkipped: 0,
      errors: [`Zoho fetch failed: ${listResult.message}`],
    };
  }

  const zohoPos = listResult.data;
  const fetched = zohoPos.length;
  let poUpserted = 0;

  // Step 2: Upsert each PO
  for (const zohoPo of zohoPos) {
    try {
      await upsertPo(db, zohoPo, errors);
      poUpserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to upsert PO ${zohoPo.purchaseorder_id}: ${msg}`);
    }
  }

  return {
    fetched,
    poUpserted,
    lineUpserted: 0,
    lineSkipped: 0,
    errors,
  };
}

// ─── Internal: upsert single PO ──────────────────────────────────────────────

async function upsertPo(
  db: typeof realDb,
  zohoPo: ZohoPurchaseOrderSummary,
  errors: string[],
): Promise<void> {
  const mappedStatus = mapZohoStatus(zohoPo.status);

  // Parse openedAt from Zoho date string; fall back to now() if unparseable
  const openedAt = parseDateSafe(zohoPo.date);

  // Step 2b: SELECT by zohoPoId (zoho_po_id is NOT a unique index)
  const existing = await (db as unknown as DbLike)
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.zohoPoId, zohoPo.purchaseorder_id));

  const existingPo = existing[0];

  if (existingPo === undefined) {
    // Step 2d: INSERT new row
    await (db as unknown as DbLike)
      .insert(purchaseOrders)
      .values({
        poNumber: zohoPo.purchaseorder_number,
        vendorName: zohoPo.vendor_name,
        status: mappedStatus,
        zohoPoId: zohoPo.purchaseorder_id,
        openedAt,
      });
  } else {
    // Step 2c: UPDATE if not in terminal state
    const localStatus = existingPo["status"] as string;
    const isTerminal = TERMINAL_STATUSES.has(localStatus);

    // Build update payload — always refresh vendorName and openedAt;
    // only update status when the PO is not already in a terminal state.
    const updatePayload: Record<string, unknown> = {
      vendorName: zohoPo.vendor_name,
      openedAt,
    };

    if (!isTerminal) {
      updatePayload["status"] = mappedStatus;
    }

    const existingId = existingPo["id"] as string;

    await (db as unknown as DbLike)
      .update(purchaseOrders)
      .set(updatePayload)
      .where(eq(purchaseOrders.id, existingId));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDateSafe(dateStr: string): Date {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

// Minimal structural type for the db client so we can use the mock without
// casting to `any`. This covers only the operations used in this file.
type DbLike = {
  select: () => {
    from: (table: unknown) => {
      where: (cond: unknown) => Promise<Array<Record<string, unknown>>>;
    };
  };
  insert: (table: unknown) => {
    values: (vals: Record<string, unknown>) => Promise<unknown>;
  };
  update: (table: unknown) => {
    set: (vals: Record<string, unknown>) => {
      where: (cond: unknown) => Promise<unknown>;
    };
  };
};
