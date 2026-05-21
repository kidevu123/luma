// PO-SYNC — Upsert purchase_orders from Zoho Inventory list endpoint,
// then fetch line items for every OPEN/RECEIVING PO and upsert into po_lines.
//
// Flow:
//   1. listInventoryPurchaseOrders → upsert PO headers
//   2. Pre-build tablet-type lookup map (zohoItemId → local UUID)
//   3. For each OPEN/RECEIVING PO: getInventoryPurchaseOrder → upsert po_lines
//
// See Task #29 spec for full algorithm documentation.

import { eq, isNotNull } from "drizzle-orm";
import { db as realDb } from "@/lib/db";
import { purchaseOrders, poLines, tabletTypes } from "@/lib/db/schema";
import {
  listInventoryPurchaseOrders,
  getInventoryPurchaseOrder,
} from "./inventory-service-client";
import type {
  ZohoPurchaseOrderSummary,
  ZohoPoLineItem,
} from "./inventory-service-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PoSyncResult = {
  fetched: number;
  poUpserted: number;      // both inserts and updates
  lineUpserted: number;    // inserts + updates across all receivable POs
  lineSkipped: number;     // lines skipped (no line_item_id)
  detailsFetched: number;  // count of getInventoryPurchaseOrder calls made
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

// Only lines with these Zoho statuses are eligible for raw-bag intake.
// received / not_receivable / unknown are skipped during sync.
// TODO: when Zoho Integration exposes is_tablet_po on list/detail, add tablet-PO
// scoping here (only call detail for tablet POs, only show tablet POs in dropdown).
const RECEIVABLE_LINE_STATUSES: ReadonlySet<string> = new Set([
  "to_be_received",
  "partially_received",
]);

// Return type for upsertPo — provides the local PO ID and effective status
// so the caller can decide whether to fetch line item details.
type UpsertPoResult = {
  localPoId: string;
  zohoPoId: string;
  effectiveStatus: LocalPoStatus;
};

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
      detailsFetched: 0,
      errors: [`Zoho fetch failed: ${listResult.message}`],
    };
  }

  const zohoPos = listResult.data;
  const fetched = zohoPos.length;
  let poUpserted = 0;

  // Step 2: Pre-fetch tablet type lookup map
  const tabletTypeMap = await buildTabletTypeMap(db);

  // Step 3: Upsert PO headers, collect receivable ones
  const receivablePos: { localPoId: string; zohoPoId: string }[] = [];

  for (const zohoPo of zohoPos) {
    try {
      const result = await upsertPo(db, zohoPo, errors);
      poUpserted++;
      if (
        result.effectiveStatus === "OPEN" ||
        result.effectiveStatus === "RECEIVING"
      ) {
        receivablePos.push({
          localPoId: result.localPoId,
          zohoPoId: result.zohoPoId,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to upsert PO ${zohoPo.purchaseorder_id}: ${msg}`);
    }
  }

  // Step 4: Fetch detail + upsert lines for receivable POs
  let lineUpserted = 0;
  let lineSkipped = 0;
  let detailsFetched = 0;

  const detailOpts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {};
  if (opts?.env !== undefined) detailOpts.env = opts.env;
  if (opts?.fetchImpl !== undefined) detailOpts.fetchImpl = opts.fetchImpl;

  for (const { localPoId, zohoPoId } of receivablePos) {
    try {
      const detail = await getInventoryPurchaseOrder(zohoPoId, detailOpts);
      detailsFetched++;
      if (!detail.ok) {
        errors.push(`Detail fetch failed for ${zohoPoId}: ${detail.message}`);
        continue;
      }
      const { upserted, skipped } = await upsertLines(
        db,
        localPoId,
        detail.data.line_items,
        tabletTypeMap,
        errors,
      );
      lineUpserted += upserted;
      lineSkipped += skipped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Line sync failed for PO ${zohoPoId}: ${msg}`);
    }
  }

  return {
    fetched,
    poUpserted,
    lineUpserted,
    lineSkipped,
    detailsFetched,
    errors,
  };
}

// ─── Internal: upsert single PO ──────────────────────────────────────────────

async function upsertPo(
  db: typeof realDb,
  zohoPo: ZohoPurchaseOrderSummary,
  errors: string[],
): Promise<UpsertPoResult> {
  void errors; // reserved for future per-field validation warnings

  const mappedStatus = mapZohoStatus(zohoPo.status);

  // Parse openedAt from Zoho date string; fall back to now() if unparseable
  const openedAt = parseDateSafe(zohoPo.date);

  // SELECT by zohoPoId (zoho_po_id is NOT a unique index)
  const existing = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.zohoPoId, zohoPo.purchaseorder_id));

  // Guard: duplicate rows mean the unique constraint is missing —
  // treat as an error so the caller knows the data needs investigation.
  if (existing.length > 1) {
    throw new Error(
      `Duplicate zohoPoId ${zohoPo.purchaseorder_id} — ${existing.length} rows found`,
    );
  }

  const existingPo = existing[0];

  if (existingPo === undefined) {
    // INSERT new row and return the generated UUID
    const returned = await db
      .insert(purchaseOrders)
      .values({
        poNumber: zohoPo.purchaseorder_number,
        vendorName: zohoPo.vendor_name,
        status: mappedStatus,
        zohoPoId: zohoPo.purchaseorder_id,
        openedAt,
      })
      .returning({ id: purchaseOrders.id });

    const insertedId = returned[0]?.id;
    if (!insertedId) {
      throw new Error(
        `Insert did not return ID for PO ${zohoPo.purchaseorder_id}`,
      );
    }

    return {
      localPoId: insertedId,
      zohoPoId: zohoPo.purchaseorder_id,
      effectiveStatus: mappedStatus,
    };
  } else {
    // UPDATE if not in terminal state
    const isTerminal = TERMINAL_STATUSES.has(existingPo.status);

    // Always refresh vendorName and openedAt;
    // only update status when the PO is not already in a terminal state.
    const updatePayload: Partial<typeof purchaseOrders.$inferInsert> = {
      vendorName: zohoPo.vendor_name,
      openedAt,
    };

    if (!isTerminal) {
      updatePayload.status = mappedStatus;
    }

    await db
      .update(purchaseOrders)
      .set(updatePayload)
      .where(eq(purchaseOrders.id, existingPo.id));

    const effectiveStatus = isTerminal
      ? (existingPo.status as LocalPoStatus)
      : mappedStatus;

    return {
      localPoId: existingPo.id,
      zohoPoId: zohoPo.purchaseorder_id,
      effectiveStatus,
    };
  }
}

// ─── Internal: build tablet type lookup map ───────────────────────────────────

async function buildTabletTypeMap(
  db: typeof realDb,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: tabletTypes.id, zohoItemId: tabletTypes.zohoItemId })
    .from(tabletTypes)
    .where(isNotNull(tabletTypes.zohoItemId));
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.zohoItemId) map.set(r.zohoItemId, r.id);
  }
  return map;
}

// ─── Internal: upsert lines for a single PO ──────────────────────────────────

async function upsertLines(
  db: typeof realDb,
  localPoId: string,
  lines: ZohoPoLineItem[],
  tabletTypeMap: Map<string, string>,
  errors: string[],
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0;
  let skipped = 0;

  for (const line of lines) {
    if (!line.line_item_id) {
      skipped++;
      continue;
    }
    if (!RECEIVABLE_LINE_STATUSES.has(line.status)) {
      skipped++;
      continue;
    }
    try {
      const tabletTypeId = tabletTypeMap.get(line.item_id) ?? null;
      const notesValue = tabletTypeId
        ? null
        : `${line.name} [${line.item_id}]`;

      const existing = await db
        .select()
        .from(poLines)
        .where(eq(poLines.zohoLineItemId, line.line_item_id));

      if (existing.length === 0) {
        await db.insert(poLines).values({
          poId: localPoId,
          qtyOrdered: line.quantity_ordered,
          zohoLineItemId: line.line_item_id,
          tabletTypeId,
          notes: notesValue,
        });
      } else {
        await db
          .update(poLines)
          .set({ qtyOrdered: line.quantity_ordered, tabletTypeId, notes: notesValue })
          .where(eq(poLines.id, existing[0]!.id));
      }
      upserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to upsert line ${line.line_item_id}: ${msg}`);
    }
  }

  return { upserted, skipped };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDateSafe(dateStr: string): Date {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}
