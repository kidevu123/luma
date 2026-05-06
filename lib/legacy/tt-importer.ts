// TabletTracker → Luma importer.
//
// Walks the legacy SQLite dump in dependency order, mapping every
// integer PK to a Luma UUID via legacy_tt_id_map. Idempotent — a
// second run is a no-op for rows already mapped. Reversible — the
// caller takes a Luma snapshot first, so a bad import is undone by
// restoring that snapshot.

import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tabletTypes,
  products,
  productAllowedTablets,
  machines,
  stations,
  qrCards,
  employees,
  purchaseOrders,
  poLines,
  shipments,
  receives,
  smallBoxes,
  inventoryBags,
  workflowBags,
  workflowEvents,
  legacyTtIdMap,
  legacyWarehouseSubmissions,
  legacyMachineCounts,
  legacySubmissionBagDeductions,
  legacyBlisterRolls,
  legacyCompressors,
  legacyPoDamageCloseout,
  legacyAppSettings,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { synthesizeReadModelsFromEvents } from "./read-model-synthesizer";
import {
  openTtDb,
  selectAll,
  tableCounts,
  type TtAppSetting,
  type TtBag,
  type TtBlisterRoll,
  type TtCompressor,
  type TtEmployee,
  type TtMachine,
  type TtMachineCount,
  type TtPoDamageCloseoutLine,
  type TtPoLine,
  type TtProductAllowedTabletType,
  type TtProductDetails,
  type TtPurchaseOrder,
  type TtQrCard,
  type TtReceiving,
  type TtShipment,
  type TtSmallBox,
  type TtSubmissionBagDeduction,
  type TtTabletType,
  type TtWarehouseSubmission,
  type TtWorkflowBag,
  type TtWorkflowEvent,
  type TtWorkflowStation,
} from "./tt-reader";

const DEFAULT_SOURCE = "/data/legacy-imports/tt-latest.db.gz";

type IdMap = Map<string, string>;

async function loadIdMap(): Promise<IdMap> {
  const rows = await db.select().from(legacyTtIdMap);
  const m: IdMap = new Map();
  for (const r of rows) m.set(`${r.ttTable}:${r.ttId}`, r.lumaId);
  return m;
}

async function recordMap(
  ttTable: string,
  ttId: number,
  lumaTable: string,
  lumaId: string,
): Promise<void> {
  await db
    .insert(legacyTtIdMap)
    .values({ ttTable, ttId, lumaTable, lumaId })
    .onConflictDoNothing();
}

function lookup(map: IdMap, ttTable: string, ttId: number | null): string | null {
  if (ttId == null) return null;
  return map.get(`${ttTable}:${ttId}`) ?? null;
}

function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v);
  if (typeof v !== "string") return null;
  const isoish = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(isoish);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === "1" || v === true || v === "true";
}

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

type PoStatus = "DRAFT" | "OPEN" | "RECEIVING" | "RECEIVED" | "CLOSED" | "CANCELLED";

function poStatusFromLegacy(internal: string | null, closed: number): PoStatus {
  if (closed === 1 || internal === "Closed") return "CLOSED";
  if (internal === "Issued") return "OPEN";
  if (internal === "Partially Received") return "RECEIVING";
  if (internal === "Received") return "RECEIVED";
  if (internal === "Cancelled") return "CANCELLED";
  return "OPEN";
}

type MachineKind = "BLISTER" | "SEALING" | "PACKAGING" | "BOTTLE_HANDPACK" | "BOTTLE_CAP_SEAL" | "BOTTLE_STICKER" | "COMBINED";

function machineKindFromRole(role: string | null): MachineKind {
  switch ((role ?? "").toLowerCase()) {
    case "blister": return "BLISTER";
    case "sealing": return "SEALING";
    case "packaging": return "PACKAGING";
    case "bottle":
    case "bottle_cap_seal": return "BOTTLE_CAP_SEAL";
    case "stickering":
    case "bottle_stickering": return "BOTTLE_STICKER";
    case "bottle_handpack": return "BOTTLE_HANDPACK";
    default: return "COMBINED";
  }
}

function stationKindFromLegacy(kind: string | null): MachineKind {
  switch ((kind ?? "").toLowerCase()) {
    case "blister": return "BLISTER";
    case "sealing": return "SEALING";
    case "packaging": return "PACKAGING";
    case "bottle_handpack": return "BOTTLE_HANDPACK";
    case "bottle_cap_seal": return "BOTTLE_CAP_SEAL";
    case "bottle_stickering":
    case "bottle_sticker": return "BOTTLE_STICKER";
    default: return "COMBINED";
  }
}

function productKindFromFlags(p: TtProductDetails): "CARD" | "BOTTLE" | "VARIETY" {
  if (toBool(p.is_variety_pack)) return "VARIETY";
  if (toBool(p.is_bottle_product)) return "BOTTLE";
  return "CARD";
}

type InventoryBagStatus = "AVAILABLE" | "IN_USE" | "EMPTIED" | "QUARANTINED" | "VOID";

function inventoryBagStatusFromLegacy(s: string | null): InventoryBagStatus {
  switch ((s ?? "").toLowerCase()) {
    case "in_use":
    case "in use": return "IN_USE";
    case "emptied": return "EMPTIED";
    case "quarantined":
    case "quarantine": return "QUARANTINED";
    case "void":
    case "voided": return "VOID";
    default: return "AVAILABLE";
  }
}

function qrCardStatusFromLegacy(s: string | null): "IDLE" | "ASSIGNED" | "RETIRED" {
  const lower = (s ?? "").toLowerCase();
  if (lower.startsWith("retired")) return "RETIRED";
  if (lower === "idle" || lower === "") return "IDLE";
  return "ASSIGNED";
}

const EVENT_TYPE_MAP: Record<string, string> = {
  "Card assigned": "CARD_ASSIGNED",
  "Product mapped": "PRODUCT_MAPPED",
  "Bag claimed": "BAG_CLAIMED",
  "Station resumed": "BAG_RESUMED",
  "Blister": "BLISTER_COMPLETE",
  "Sealing": "SEALING_COMPLETE",
  "Packaging": "PACKAGING_SNAPSHOT",
  "Bottle handpack": "BOTTLE_HANDPACK_COMPLETE",
  "Bottle sticker": "BOTTLE_STICKER_COMPLETE",
  "Bottle cap seal": "BOTTLE_CAP_SEAL_COMPLETE",
  "Variety Sources Assigned": "VARIETY_SOURCES_ASSIGNED",
  "BAG_FINALIZED": "BAG_FINALIZED",
  "BAG_PAUSED": "BAG_PAUSED",
  "BAG_RESUMED": "BAG_RESUMED",
};

function translateEventType(raw: string, payload: Record<string, unknown>): {
  eventType: string;
  payload: Record<string, unknown>;
} {
  if (raw.startsWith("Pause:")) {
    const reason = raw.slice("Pause:".length).trim();
    return { eventType: "BAG_PAUSED", payload: { ...payload, reason } };
  }
  if (raw in EVENT_TYPE_MAP) {
    return { eventType: EVENT_TYPE_MAP[raw]!, payload };
  }
  return {
    eventType: "SUBMISSION_CORRECTED",
    payload: { ...payload, _legacy_event_type: raw },
  };
}

export type ImportPhase =
  | "tablet_types" | "products" | "product_allowed_tablets"
  | "machines" | "stations" | "qr_cards" | "employees"
  | "purchase_orders" | "po_lines" | "shipments" | "receives"
  | "small_boxes" | "inventory_bags" | "workflow_bags"
  | "workflow_events" | "warehouse_submissions" | "machine_counts"
  | "submission_bag_deductions" | "blister_rolls" | "compressors"
  | "po_damage_closeout" | "app_settings";

export type ImportResult = {
  ok: boolean;
  sourceFile: string;
  legacyCounts: Record<string, number>;
  inserted: Record<ImportPhase, number>;
  skipped: Record<ImportPhase, number>;
  errors: Array<{ phase: ImportPhase; ttId: number | null; message: string }>;
  durationMs: number;
};

export type ImportPreview = {
  sourceFile: string;
  legacyCounts: Record<string, number>;
  alreadyMapped: Record<string, number>;
  wouldInsert: Record<string, number>;
};

/** Dry-run report — opens the SQLite, counts rows, intersects with
 *  legacy_tt_id_map, and tells the operator how many of each table
 *  would be inserted vs already mapped. Pure read; no DB writes. */
export async function previewImport(args: {
  sourceFilePath?: string;
}): Promise<ImportPreview> {
  const file = args.sourceFilePath ?? DEFAULT_SOURCE;
  const ttDb = await openTtDb(file);
  const counts = tableCounts(ttDb);
  const idMap = await loadIdMap();

  // Tables we actually map (in the same order as runImport).
  const TT_TABLES_TO_LUMA: Record<string, string> = {
    tablet_types: "tablet_types",
    product_details: "products",
    product_allowed_tablet_types: "product_allowed_tablets",
    machines: "machines",
    workflow_stations: "stations",
    qr_cards: "qr_cards",
    employees: "employees",
    purchase_orders: "purchase_orders",
    po_lines: "po_lines",
    shipments: "shipments",
    receiving: "receives",
    small_boxes: "small_boxes",
    bags: "inventory_bags",
    workflow_bags: "workflow_bags",
    workflow_events: "workflow_events",
    warehouse_submissions: "legacy_warehouse_submissions",
    machine_counts: "legacy_machine_counts",
    submission_bag_deductions: "legacy_submission_bag_deductions",
    blister_material_rolls: "legacy_blister_rolls",
    compressors: "legacy_compressors",
    po_damage_closeout_lines: "legacy_po_damage_closeout",
    app_settings: "legacy_app_settings",
  };

  const alreadyMapped: Record<string, number> = {};
  const wouldInsert: Record<string, number> = {};

  for (const [ttTable] of Object.entries(TT_TABLES_TO_LUMA)) {
    const total = counts[ttTable] ?? 0;
    if (total === 0) {
      alreadyMapped[ttTable] = 0;
      wouldInsert[ttTable] = 0;
      continue;
    }
    const ids = selectAll<{ id: number }>(
      ttDb,
      `SELECT id FROM ${ttTable}`,
    );
    let mapped = 0;
    for (const { id } of ids) {
      if (idMap.has(`${ttTable}:${id}`)) mapped++;
    }
    alreadyMapped[ttTable] = mapped;
    wouldInsert[ttTable] = total - mapped;
  }

  ttDb.close();

  return {
    sourceFile: file,
    legacyCounts: counts,
    alreadyMapped,
    wouldInsert,
  };
}

const PHASES: ImportPhase[] = [
  "tablet_types", "products", "product_allowed_tablets",
  "machines", "stations", "qr_cards", "employees",
  "purchase_orders", "po_lines", "shipments", "receives",
  "small_boxes", "inventory_bags", "workflow_bags",
  "workflow_events", "warehouse_submissions", "machine_counts",
  "submission_bag_deductions", "blister_rolls", "compressors",
  "po_damage_closeout", "app_settings",
];

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function runImport(args: {
  actor: CurrentUser;
  sourceFilePath?: string;
}): Promise<ImportResult> {
  const start = Date.now();
  const file = args.sourceFilePath ?? DEFAULT_SOURCE;
  const errors: ImportResult["errors"] = [];
  const inserted = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<ImportPhase, number>;
  const skipped = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<ImportPhase, number>;

  const ttDb = await openTtDb(file);
  const counts = tableCounts(ttDb);
  const idMap = await loadIdMap();

  const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!company) throw new Error("No company row in Luma — seed must run first.");

  async function phase<T extends { id: number }>(
    name: ImportPhase,
    rows: T[],
    inserter: (row: T) => Promise<{ inserted: boolean; lumaId?: string }>,
  ): Promise<void> {
    for (const row of rows) {
      try {
        const r = await inserter(row);
        if (r.inserted) inserted[name]++;
        else skipped[name]++;
      } catch (err) {
        errors.push({
          phase: name,
          ttId: row.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 1. tablet_types
  await phase<TtTabletType>(
    "tablet_types",
    selectAll<TtTabletType>(ttDb, "SELECT * FROM tablet_types"),
    async (r) => {
      if (lookup(idMap, "tablet_types", r.id)) return { inserted: false };
      const [out] = await db
        .insert(tabletTypes)
        .values({
          name: r.tablet_type_name,
          sku: r.inventory_item_id ?? `tt-${r.id}`,
          zohoItemId: r.inventory_item_id,
        })
        .returning({ id: tabletTypes.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`tablet_types:${r.id}`, out.id);
      await recordMap("tablet_types", r.id, "tablet_types", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 2. products
  await phase<TtProductDetails>(
    "products",
    selectAll<TtProductDetails>(ttDb, "SELECT * FROM product_details"),
    async (r) => {
      if (lookup(idMap, "product_details", r.id)) return { inserted: false };
      const [out] = await db
        .insert(products)
        .values({
          sku: `tt-product-${r.id}`,
          name: r.product_name,
          kind: productKindFromFlags(r),
          tabletsPerUnit: toInt(r.tablets_per_package) ?? toInt(r.tablets_per_bottle),
          unitsPerDisplay: toInt(r.packages_per_display) ?? toInt(r.bottles_per_display),
          displaysPerCase: toInt(r.displays_per_case),
        })
        .returning({ id: products.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`product_details:${r.id}`, out.id);
      await recordMap("product_details", r.id, "products", out.id);
      if (r.tablet_type_id != null) {
        const ttUuid = lookup(idMap, "tablet_types", r.tablet_type_id);
        if (ttUuid) {
          await db
            .insert(productAllowedTablets)
            .values({ productId: out.id, tabletTypeId: ttUuid, isPrimary: true })
            .onConflictDoNothing();
        }
      }
      return { inserted: true, lumaId: out.id };
    },
  );

  // 3. product_allowed_tablet_types
  await phase<TtProductAllowedTabletType>(
    "product_allowed_tablets",
    selectAll<TtProductAllowedTabletType>(ttDb, "SELECT * FROM product_allowed_tablet_types"),
    async (r) => {
      if (lookup(idMap, "product_allowed_tablet_types", r.id)) return { inserted: false };
      const productUuid = lookup(idMap, "product_details", r.product_details_id);
      const tabletUuid = lookup(idMap, "tablet_types", r.tablet_type_id);
      if (!productUuid || !tabletUuid) {
        await recordMap("product_allowed_tablet_types", r.id, "product_allowed_tablets", NIL_UUID);
        return { inserted: false };
      }
      await db
        .insert(productAllowedTablets)
        .values({ productId: productUuid, tabletTypeId: tabletUuid, isPrimary: false })
        .onConflictDoNothing();
      const synth = crypto.randomUUID();
      idMap.set(`product_allowed_tablet_types:${r.id}`, synth);
      await recordMap("product_allowed_tablet_types", r.id, "product_allowed_tablets", synth);
      return { inserted: true };
    },
  );

  // 4. machines
  await phase<TtMachine>(
    "machines",
    selectAll<TtMachine>(ttDb, "SELECT * FROM machines"),
    async (r) => {
      if (lookup(idMap, "machines", r.id)) return { inserted: false };
      const [out] = await db
        .insert(machines)
        .values({
          name: r.machine_name,
          kind: machineKindFromRole(r.machine_role),
          cardsPerTurn: toInt(r.cards_per_turn) ?? 1,
          isActive: toBool(r.is_active),
        })
        .returning({ id: machines.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`machines:${r.id}`, out.id);
      await recordMap("machines", r.id, "machines", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 5. stations
  await phase<TtWorkflowStation>(
    "stations",
    selectAll<TtWorkflowStation>(ttDb, "SELECT * FROM workflow_stations"),
    async (r) => {
      if (lookup(idMap, "workflow_stations", r.id)) return { inserted: false };
      const machineUuid = lookup(idMap, "machines", r.machine_id);
      const [out] = await db
        .insert(stations)
        .values({
          label: r.label,
          kind: stationKindFromLegacy(r.station_kind),
          ...(machineUuid ? { machineId: machineUuid } : {}),
          scanToken: r.station_scan_token,
        })
        .onConflictDoNothing({ target: stations.scanToken })
        .returning({ id: stations.id });
      if (!out) {
        const [existing] = await db
          .select({ id: stations.id })
          .from(stations)
          .where(eq(stations.scanToken, r.station_scan_token));
        if (!existing) throw new Error("station upsert lost row");
        idMap.set(`workflow_stations:${r.id}`, existing.id);
        await recordMap("workflow_stations", r.id, "stations", existing.id);
        return { inserted: false, lumaId: existing.id };
      }
      idMap.set(`workflow_stations:${r.id}`, out.id);
      await recordMap("workflow_stations", r.id, "stations", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 6. qr_cards
  await phase<TtQrCard>(
    "qr_cards",
    selectAll<TtQrCard>(ttDb, "SELECT * FROM qr_cards"),
    async (r) => {
      if (lookup(idMap, "qr_cards", r.id)) return { inserted: false };
      const [out] = await db
        .insert(qrCards)
        .values({
          label: r.label ?? `Card ${r.id}`,
          scanToken: r.scan_token,
          status: qrCardStatusFromLegacy(r.status),
        })
        .onConflictDoNothing({ target: qrCards.scanToken })
        .returning({ id: qrCards.id });
      if (!out) {
        const [existing] = await db
          .select({ id: qrCards.id })
          .from(qrCards)
          .where(eq(qrCards.scanToken, r.scan_token));
        if (!existing) throw new Error("qr upsert lost row");
        idMap.set(`qr_cards:${r.id}`, existing.id);
        await recordMap("qr_cards", r.id, "qr_cards", existing.id);
        return { inserted: false, lumaId: existing.id };
      }
      idMap.set(`qr_cards:${r.id}`, out.id);
      await recordMap("qr_cards", r.id, "qr_cards", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 7. employees
  await phase<TtEmployee>(
    "employees",
    selectAll<TtEmployee>(ttDb, "SELECT * FROM employees"),
    async (r) => {
      if (lookup(idMap, "employees", r.id)) return { inserted: false };
      const [out] = await db
        .insert(employees)
        .values({
          fullName: r.full_name,
          legacyId: r.username,
          language: r.preferred_language ?? "en",
          status: toBool(r.is_active) ? "ACTIVE" : "INACTIVE",
        })
        .returning({ id: employees.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`employees:${r.id}`, out.id);
      await recordMap("employees", r.id, "employees", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 8. purchase_orders
  await phase<TtPurchaseOrder>(
    "purchase_orders",
    selectAll<TtPurchaseOrder>(ttDb, "SELECT * FROM purchase_orders"),
    async (r) => {
      if (lookup(idMap, "purchase_orders", r.id)) return { inserted: false };
      const [out] = await db
        .insert(purchaseOrders)
        .values({
          poNumber: r.po_number,
          parentPoNumber: r.parent_po_number,
          vendorName: r.vendor_name,
          status: poStatusFromLegacy(r.internal_status, r.closed),
          zohoPoId: r.zoho_po_id,
          openedAt: toDate(r.created_at) ?? new Date(),
          closedAt: r.closed === 1 ? (toDate(r.updated_at) ?? new Date()) : null,
        })
        .onConflictDoNothing({ target: purchaseOrders.poNumber })
        .returning({ id: purchaseOrders.id });
      if (!out) {
        const [existing] = await db
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.poNumber, r.po_number));
        if (!existing) throw new Error("po upsert lost row");
        idMap.set(`purchase_orders:${r.id}`, existing.id);
        await recordMap("purchase_orders", r.id, "purchase_orders", existing.id);
        return { inserted: false, lumaId: existing.id };
      }
      idMap.set(`purchase_orders:${r.id}`, out.id);
      await recordMap("purchase_orders", r.id, "purchase_orders", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 9. po_lines
  await phase<TtPoLine>(
    "po_lines",
    selectAll<TtPoLine>(ttDb, "SELECT * FROM po_lines"),
    async (r) => {
      if (lookup(idMap, "po_lines", r.id)) return { inserted: false };
      const poUuid = lookup(idMap, "purchase_orders", r.po_id);
      if (!poUuid) {
        await recordMap("po_lines", r.id, "po_lines", NIL_UUID);
        return { inserted: false };
      }
      let tabletTypeUuid: string | null = null;
      if (r.inventory_item_id) {
        const [tt] = await db
          .select({ id: tabletTypes.id })
          .from(tabletTypes)
          .where(eq(tabletTypes.zohoItemId, r.inventory_item_id))
          .limit(1);
        tabletTypeUuid = tt?.id ?? null;
      }
      const [out] = await db
        .insert(poLines)
        .values({
          poId: poUuid,
          ...(tabletTypeUuid ? { tabletTypeId: tabletTypeUuid } : {}),
          qtyOrdered: toInt(r.quantity_ordered) ?? 0,
          zohoLineItemId: r.zoho_line_item_id,
          notes: r.line_item_name,
        })
        .returning({ id: poLines.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`po_lines:${r.id}`, out.id);
      await recordMap("po_lines", r.id, "po_lines", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 10. shipments (empty in seed, but supported)
  await phase<TtShipment>(
    "shipments",
    selectAll<TtShipment>(ttDb, "SELECT * FROM shipments"),
    async (r) => {
      if (lookup(idMap, "shipments", r.id)) return { inserted: false };
      const poUuid = lookup(idMap, "purchase_orders", r.po_id);
      const [out] = await db
        .insert(shipments)
        .values({
          ...(poUuid ? { poId: poUuid } : {}),
          carrier: r.carrier,
          trackingNumber: r.tracking_number,
          shippedAt: toDate(r.shipped_date),
          deliveredAt: toDate(r.delivered_at) ?? toDate(r.actual_delivery),
          deliveryPhotoPath: null,
        })
        .returning({ id: shipments.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`shipments:${r.id}`, out.id);
      await recordMap("shipments", r.id, "shipments", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 11. receives
  await phase<TtReceiving>(
    "receives",
    selectAll<TtReceiving>(ttDb, "SELECT * FROM receiving"),
    async (r) => {
      if (lookup(idMap, "receiving", r.id)) return { inserted: false };
      const poUuid = lookup(idMap, "purchase_orders", r.po_id);
      const shipmentUuid = lookup(idMap, "shipments", r.shipment_id);
      const receiveName = r.receive_name ?? `legacy-${r.id}`;
      const [out] = await db
        .insert(receives)
        .values({
          ...(poUuid ? { poId: poUuid } : {}),
          ...(shipmentUuid ? { shipmentId: shipmentUuid } : {}),
          receiveName,
          receivedAt: toDate(r.received_date) ?? new Date(),
          notes: r.notes,
          closedAt: r.closed === 1 ? toDate(r.received_date) : null,
        })
        .onConflictDoNothing({ target: receives.receiveName })
        .returning({ id: receives.id });
      if (!out) {
        const [existing] = await db
          .select({ id: receives.id })
          .from(receives)
          .where(eq(receives.receiveName, receiveName));
        if (!existing) throw new Error("receive upsert lost row");
        idMap.set(`receiving:${r.id}`, existing.id);
        await recordMap("receiving", r.id, "receives", existing.id);
        return { inserted: false, lumaId: existing.id };
      }
      idMap.set(`receiving:${r.id}`, out.id);
      await recordMap("receiving", r.id, "receives", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 12. small_boxes
  await phase<TtSmallBox>(
    "small_boxes",
    selectAll<TtSmallBox>(ttDb, "SELECT * FROM small_boxes"),
    async (r) => {
      if (lookup(idMap, "small_boxes", r.id)) return { inserted: false };
      const receiveUuid = lookup(idMap, "receiving", r.receiving_id);
      if (!receiveUuid) {
        await recordMap("small_boxes", r.id, "small_boxes", NIL_UUID);
        return { inserted: false };
      }
      const [out] = await db
        .insert(smallBoxes)
        .values({
          receiveId: receiveUuid,
          boxNumber: toInt(r.box_number) ?? 0,
          totalBags: toInt(r.total_bags) ?? 0,
        })
        .returning({ id: smallBoxes.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`small_boxes:${r.id}`, out.id);
      await recordMap("small_boxes", r.id, "small_boxes", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 13. inventory_bags
  await phase<TtBag>(
    "inventory_bags",
    selectAll<TtBag>(ttDb, "SELECT * FROM bags"),
    async (r) => {
      if (lookup(idMap, "bags", r.id)) return { inserted: false };
      const boxUuid = lookup(idMap, "small_boxes", r.small_box_id);
      const tabletUuid = lookup(idMap, "tablet_types", r.tablet_type_id);
      if (!boxUuid || !tabletUuid) {
        await recordMap("bags", r.id, "inventory_bags", NIL_UUID);
        return { inserted: false };
      }
      const weightGrams = r.bag_weight_kg != null ? Math.round(r.bag_weight_kg * 1000) : null;
      const [out] = await db
        .insert(inventoryBags)
        .values({
          smallBoxId: boxUuid,
          bagNumber: toInt(r.bag_number) ?? 0,
          tabletTypeId: tabletUuid,
          pillCount: toInt(r.pill_count) ?? toInt(r.estimated_tablets_from_weight) ?? toInt(r.bag_label_count),
          ...(weightGrams != null ? { weightGrams } : {}),
          ...(r.batch_number ? { vendorBarcode: r.batch_number } : {}),
          status: inventoryBagStatusFromLegacy(r.status),
          reservedForBottles: toBool(r.reserved_for_bottles),
        })
        .onConflictDoNothing({
          target: [inventoryBags.smallBoxId, inventoryBags.bagNumber],
        })
        .returning({ id: inventoryBags.id });
      if (!out) {
        const [existing] = await db
          .select({ id: inventoryBags.id })
          .from(inventoryBags)
          .where(
            and(
              eq(inventoryBags.smallBoxId, boxUuid),
              eq(inventoryBags.bagNumber, toInt(r.bag_number) ?? 0),
            ),
          );
        if (!existing) throw new Error("bag upsert lost row");
        idMap.set(`bags:${r.id}`, existing.id);
        await recordMap("bags", r.id, "inventory_bags", existing.id);
        return { inserted: false, lumaId: existing.id };
      }
      idMap.set(`bags:${r.id}`, out.id);
      await recordMap("bags", r.id, "inventory_bags", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 14. workflow_bags
  await phase<TtWorkflowBag>(
    "workflow_bags",
    selectAll<TtWorkflowBag>(ttDb, "SELECT * FROM workflow_bags"),
    async (r) => {
      if (lookup(idMap, "workflow_bags", r.id)) return { inserted: false };
      const productUuid = lookup(idMap, "product_details", r.product_id);
      const inventoryBagUuid = lookup(idMap, "bags", r.inventory_bag_id);
      const [out] = await db
        .insert(workflowBags)
        .values({
          ...(productUuid ? { productId: productUuid } : {}),
          ...(inventoryBagUuid ? { inventoryBagId: inventoryBagUuid } : {}),
          receiptNumber: r.receipt_number,
          boxNumber: toInt(r.box_number),
          bagNumber: toInt(r.bag_number),
          startedAt: new Date(r.created_at),
        })
        .returning({ id: workflowBags.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`workflow_bags:${r.id}`, out.id);
      await recordMap("workflow_bags", r.id, "workflow_bags", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // QR cards pass-2: link assigned_workflow_bag_id now that workflow_bags are mapped.
  const qrLinks = selectAll<TtQrCard>(
    ttDb,
    "SELECT * FROM qr_cards WHERE assigned_workflow_bag_id IS NOT NULL",
  );
  for (const r of qrLinks) {
    const cardUuid = lookup(idMap, "qr_cards", r.id);
    const wfbUuid = lookup(idMap, "workflow_bags", r.assigned_workflow_bag_id!);
    if (!cardUuid || !wfbUuid) continue;
    await db
      .update(qrCards)
      .set({ assignedWorkflowBagId: wfbUuid })
      .where(eq(qrCards.id, cardUuid));
  }

  // 15. workflow_events
  await phase<TtWorkflowEvent>(
    "workflow_events",
    selectAll<TtWorkflowEvent>(
      ttDb,
      "SELECT * FROM workflow_events ORDER BY occurred_at, id",
    ),
    async (r) => {
      if (lookup(idMap, "workflow_events", r.id)) return { inserted: false };
      const wfbUuid = lookup(idMap, "workflow_bags", r.workflow_bag_id);
      if (!wfbUuid) {
        await recordMap("workflow_events", r.id, "workflow_events", NIL_UUID);
        return { inserted: false };
      }
      const stationUuid = lookup(idMap, "workflow_stations", r.station_id);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.payload || "{}") as Record<string, unknown>;
      } catch {
        payload = { _raw: r.payload };
      }
      const translated = translateEventType(r.event_type, payload);
      const [out] = await db
        .insert(workflowEvents)
        .values({
          workflowBagId: wfbUuid,
          ...(stationUuid ? { stationId: stationUuid } : {}),
          eventType: translated.eventType as never,
          payload: translated.payload,
          occurredAt: new Date(r.occurred_at),
        })
        .returning({ id: workflowEvents.id });
      if (!out) throw new Error("insert returned no id");
      idMap.set(`workflow_events:${r.id}`, out.id);
      await recordMap("workflow_events", r.id, "workflow_events", out.id);
      return { inserted: true, lumaId: out.id };
    },
  );

  // 16. warehouse_submissions (stash, bulk)
  // Wide table, ~1700 rows in seed. Per-row insert + per-row id_map
  // record was burning 3,500+ round-trips, blowing past the action
  // timeout. Switch to chunked bulk INSERT … RETURNING with a single
  // bulk id_map upsert per chunk → ~10 round-trips total.
  {
    const rows = selectAll<TtWarehouseSubmission>(
      ttDb,
      "SELECT * FROM warehouse_submissions",
    );
    const unmapped = rows.filter(
      (r) => !lookup(idMap, "warehouse_submissions", r.id),
    );
    const CHUNK = 200;
    for (let i = 0; i < unmapped.length; i += CHUNK) {
      const slice = unmapped.slice(i, i + CHUNK);
      try {
        const values = slice.map((r) => {
          const bagUuid = lookup(
            idMap,
            "bags",
            typeof r.bag_id === "number" ? r.bag_id : null,
          );
          return {
            ttId: r.id,
            payload: r as Record<string, unknown>,
            submissionType: r.submission_type,
            ...(bagUuid ? { bagId: bagUuid } : {}),
            employeeName: r.employee_name,
            createdAt: toDate(r.created_at),
          };
        });
        const out = await db
          .insert(legacyWarehouseSubmissions)
          .values(values)
          .onConflictDoNothing({ target: legacyWarehouseSubmissions.ttId })
          .returning({
            id: legacyWarehouseSubmissions.id,
            ttId: legacyWarehouseSubmissions.ttId,
          });
        // Bulk id_map record.
        if (out.length > 0) {
          await db
            .insert(legacyTtIdMap)
            .values(
              out.map((o) => ({
                ttTable: "warehouse_submissions",
                ttId: o.ttId,
                lumaTable: "legacy_warehouse_submissions",
                lumaId: o.id,
              })),
            )
            .onConflictDoNothing();
          for (const o of out) {
            idMap.set(`warehouse_submissions:${o.ttId}`, o.id);
          }
          inserted.warehouse_submissions += out.length;
        }
        const insertedTtIds = new Set(out.map((o) => o.ttId));
        skipped.warehouse_submissions += slice.length - insertedTtIds.size;
      } catch (err) {
        for (const r of slice) {
          errors.push({
            phase: "warehouse_submissions",
            ttId: r.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // 17. machine_counts (stash, bulk) — same batching pattern as #16.
  {
    const rows = selectAll<TtMachineCount>(
      ttDb,
      "SELECT * FROM machine_counts",
    );
    const unmapped = rows.filter(
      (r) => !lookup(idMap, "machine_counts", r.id),
    );
    const CHUNK = 200;
    for (let i = 0; i < unmapped.length; i += CHUNK) {
      const slice = unmapped.slice(i, i + CHUNK);
      try {
        const values = slice.map((r) => {
          const tabletUuid = lookup(idMap, "tablet_types", r.tablet_type_id);
          const machineUuid = lookup(idMap, "machines", r.machine_id);
          return {
            ttId: r.id,
            payload: r as Record<string, unknown>,
            ...(tabletUuid ? { tabletTypeId: tabletUuid } : {}),
            ...(machineUuid ? { machineId: machineUuid } : {}),
            employeeName: r.employee_name,
            countDate: r.count_date,
            createdAt: toDate(r.created_at),
          };
        });
        const out = await db
          .insert(legacyMachineCounts)
          .values(values)
          .onConflictDoNothing({ target: legacyMachineCounts.ttId })
          .returning({
            id: legacyMachineCounts.id,
            ttId: legacyMachineCounts.ttId,
          });
        if (out.length > 0) {
          await db
            .insert(legacyTtIdMap)
            .values(
              out.map((o) => ({
                ttTable: "machine_counts",
                ttId: o.ttId,
                lumaTable: "legacy_machine_counts",
                lumaId: o.id,
              })),
            )
            .onConflictDoNothing();
          for (const o of out) {
            idMap.set(`machine_counts:${o.ttId}`, o.id);
          }
          inserted.machine_counts += out.length;
        }
        const insertedTtIds = new Set(out.map((o) => o.ttId));
        skipped.machine_counts += slice.length - insertedTtIds.size;
      } catch (err) {
        for (const r of slice) {
          errors.push({
            phase: "machine_counts",
            ttId: r.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // 18. submission_bag_deductions (stash)
  await phase<TtSubmissionBagDeduction>(
    "submission_bag_deductions",
    selectAll<TtSubmissionBagDeduction>(ttDb, "SELECT * FROM submission_bag_deductions"),
    async (r) => {
      if (lookup(idMap, "submission_bag_deductions", r.id)) return { inserted: false };
      const submissionUuid = lookup(idMap, "warehouse_submissions", r.submission_id);
      const bagUuid = lookup(idMap, "bags", r.bag_id);
      if (!submissionUuid) return { inserted: false };
      const [out] = await db
        .insert(legacySubmissionBagDeductions)
        .values({
          ttId: r.id,
          legacySubmissionId: submissionUuid,
          ...(bagUuid ? { bagId: bagUuid } : {}),
          tabletsDeducted: r.tablets_deducted,
          createdAt: toDate(r.created_at),
        })
        .onConflictDoNothing({ target: legacySubmissionBagDeductions.ttId })
        .returning({ id: legacySubmissionBagDeductions.id });
      if (!out) return { inserted: false };
      idMap.set(`submission_bag_deductions:${r.id}`, out.id);
      await recordMap("submission_bag_deductions", r.id, "legacy_submission_bag_deductions", out.id);
      return { inserted: true };
    },
  );

  // 19. blister_material_rolls (stash)
  await phase<TtBlisterRoll>(
    "blister_rolls",
    selectAll<TtBlisterRoll>(ttDb, "SELECT * FROM blister_material_rolls"),
    async (r) => {
      if (lookup(idMap, "blister_material_rolls", r.id)) return { inserted: false };
      const machineUuid = lookup(idMap, "machines", r.machine_id);
      const [out] = await db
        .insert(legacyBlisterRolls)
        .values({
          ttId: r.id,
          ...(machineUuid ? { machineId: machineUuid } : {}),
          materialType: r.material_type,
          rollCode: r.roll_code,
          startedAt: new Date(r.started_at_ms),
          endedAt: r.ended_at_ms != null ? new Date(r.ended_at_ms) : null,
          startPressCount: r.start_press_count,
          endPressCount: r.end_press_count,
          blistersPerPress: r.blisters_per_press,
          totalBlisters: r.total_blisters,
          status: r.status,
        })
        .onConflictDoNothing({ target: legacyBlisterRolls.ttId })
        .returning({ id: legacyBlisterRolls.id });
      if (!out) return { inserted: false };
      idMap.set(`blister_material_rolls:${r.id}`, out.id);
      await recordMap("blister_material_rolls", r.id, "legacy_blister_rolls", out.id);
      return { inserted: true };
    },
  );

  // 20. compressors (stash)
  await phase<TtCompressor>(
    "compressors",
    selectAll<TtCompressor>(ttDb, "SELECT * FROM compressors"),
    async (r) => {
      if (lookup(idMap, "compressors", r.id)) return { inserted: false };
      const machineUuid = lookup(idMap, "machines", r.machine_id);
      const [out] = await db
        .insert(legacyCompressors)
        .values({
          ttId: r.id,
          compressorName: r.compressor_name,
          status: r.status,
          ...(machineUuid ? { machineId: machineUuid } : {}),
          notes: r.notes,
          isActive: toBool(r.is_active),
          cost: r.cost,
          tankSize: r.tank_size,
          createdAt: r.created_at != null ? new Date(r.created_at) : null,
          updatedAt: r.updated_at != null ? new Date(r.updated_at) : null,
        })
        .onConflictDoNothing({ target: legacyCompressors.ttId })
        .returning({ id: legacyCompressors.id });
      if (!out) return { inserted: false };
      idMap.set(`compressors:${r.id}`, out.id);
      await recordMap("compressors", r.id, "legacy_compressors", out.id);
      return { inserted: true };
    },
  );

  // 21. po_damage_closeout_lines (stash)
  await phase<TtPoDamageCloseoutLine>(
    "po_damage_closeout",
    selectAll<TtPoDamageCloseoutLine>(ttDb, "SELECT * FROM po_damage_closeout_lines"),
    async (r) => {
      if (lookup(idMap, "po_damage_closeout_lines", r.id)) return { inserted: false };
      const poUuid = lookup(idMap, "purchase_orders", r.po_id);
      const poLineUuid = lookup(idMap, "po_lines", r.po_line_id);
      const [out] = await db
        .insert(legacyPoDamageCloseout)
        .values({
          ttId: r.id,
          ...(poUuid ? { poId: poUuid } : {}),
          ...(poLineUuid ? { poLineId: poLineUuid } : {}),
          inventoryItemId: r.inventory_item_id,
          damageWeightKg: r.damage_weight_kg,
          estimatedDamagedTablets: r.estimated_damaged_tablets,
          gramsPerTablet: r.grams_per_tablet,
          weightMissing: toBool(r.weight_missing),
          weightSource: r.weight_source,
          updatedBy: r.updated_by,
          updatedAt: toDate(r.updated_at) ?? new Date(),
          createdAt: toDate(r.created_at) ?? new Date(),
        })
        .onConflictDoNothing({ target: legacyPoDamageCloseout.ttId })
        .returning({ id: legacyPoDamageCloseout.id });
      if (!out) return { inserted: false };
      idMap.set(`po_damage_closeout_lines:${r.id}`, out.id);
      await recordMap("po_damage_closeout_lines", r.id, "legacy_po_damage_closeout", out.id);
      return { inserted: true };
    },
  );

  // 22. app_settings (stash)
  await phase<TtAppSetting>(
    "app_settings",
    selectAll<TtAppSetting>(ttDb, "SELECT * FROM app_settings"),
    async (r) => {
      if (lookup(idMap, "app_settings", r.id)) return { inserted: false };
      const [out] = await db
        .insert(legacyAppSettings)
        .values({
          ttId: r.id,
          settingKey: r.setting_key,
          settingValue: r.setting_value,
          description: r.description,
          updatedAt: toDate(r.updated_at),
        })
        .onConflictDoNothing({ target: legacyAppSettings.ttId })
        .returning({ id: legacyAppSettings.id });
      if (!out) return { inserted: false };
      idMap.set(`app_settings:${r.id}`, out.id);
      await recordMap("app_settings", r.id, "legacy_app_settings", out.id);
      return { inserted: true };
    },
  );

  ttDb.close();

  // Synthesize read models from the events we just imported. The
  // importer inserts workflow_events directly without going through
  // projectEvent(), so the rollups (read_bag_state / read_bag_metrics
  // / read_daily_throughput / read_operator_daily) are still empty
  // for legacy data. This rebuilds them from scratch via SQL.
  let synthesis: Awaited<ReturnType<typeof synthesizeReadModelsFromEvents>> | null = null;
  try {
    synthesis = await synthesizeReadModelsFromEvents();
  } catch (err) {
    errors.push({
      phase: "tablet_types", // pseudo — there isn't a "synthesis" phase enum
      ttId: null,
      message:
        "Read-model synthesis failed: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  await writeAudit({
    actorId: args.actor.id,
    actorRole: args.actor.role,
    action: "legacy_import.run",
    targetType: "LegacyImportRun",
    targetId: file,
    after: {
      sourceFile: file,
      legacyCounts: counts,
      inserted,
      skipped,
      errorCount: errors.length,
      synthesis,
    },
  });

  return {
    ok: errors.length === 0,
    sourceFile: file,
    legacyCounts: counts,
    inserted,
    skipped,
    errors,
    durationMs: Date.now() - start,
  };
}
