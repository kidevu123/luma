// Luma — production-floor traceability for Haute Nutrition.
// Six bounded contexts in this file, separated by banners.
//
// Design rules (locked, do not relax):
// 1. workflow_events is append-only and the source of truth. Any UI
//    state that depends on production progress reads a denormalized
//    read-model row, not a fold across this table.
// 2. Money / weights / qty are stored as integers in their canonical
//    base unit (mg, grams, cents, units). No floats anywhere.
// 3. Timestamptz everywhere. Display tz is `company.timezone`.
// 4. Soft-delete only. `voidedAt` flags rows; nothing leaves the DB.
// 5. Every batch has a status lifecycle. Production cannot consume a
//    batch that is not RELEASED. Enforced at the projector + at the
//    write-path action layer.
// 6. Every finished lot records its complete batch genealogy. Recall
//    queries are a single recursive CTE join, not a forensic dig.

import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "LEAD",
  "STAFF",
]);

export const employeeStatusEnum = pgEnum("employee_status", [
  "ACTIVE",
  "INACTIVE",
  "TERMINATED",
]);

export const machineKindEnum = pgEnum("machine_kind", [
  "BLISTER",
  "SEALING",
  "PACKAGING",
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
  "COMBINED",
]);

export const stationKindEnum = pgEnum("station_kind", [
  "BLISTER",
  "SEALING",
  "PACKAGING",
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
  "COMBINED",
]);

export const productKindEnum = pgEnum("product_kind", [
  "CARD",        // blister-card finished good
  "BOTTLE",      // bottle finished good
  "VARIETY",     // pack of multiple cards/bottles, mixed source batches
]);

export const packagingMaterialKindEnum = pgEnum("packaging_material_kind", [
  "BLISTER_FOIL",
  "HEAT_SEAL_FILM",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "LABEL",
  "DESICCANT",
  "COTTON",
  "DISPLAY",
  "CASE",
  "INSERT",
  "OTHER",
  // Phase H additions
  "PVC_ROLL",
  "FOIL_ROLL",
  "SHRINK_BAND",
]);

export const materialLotStatusEnum = pgEnum("material_lot_status", [
  "AVAILABLE",
  "IN_USE",
  "DEPLETED",
  "HELD",
  "SCRAPPED",
  "ADJUSTED",
]);

export const materialEventTypeEnum = pgEnum("material_event_type", [
  "MATERIAL_RECEIVED",
  "MATERIAL_ISSUED",
  "MATERIAL_RETURNED",
  "MATERIAL_CONSUMED_ESTIMATED",
  "MATERIAL_CONSUMED_ACTUAL",
  "MATERIAL_ADJUSTED",
  "ROLL_MOUNTED",
  "ROLL_UNMOUNTED",
  "ROLL_WEIGHED",
  "ROLL_DEPLETED",
  "MATERIAL_SCRAPPED",
  "ROLL_COUNTER_SEGMENT_RECORDED",
  // PT-1 — PackTrack -> Luma packaging-receipt vocabulary.
  "PACKAGING_RECEIPT_IMPORTED",
  "PACKAGING_BOX_RECEIVED",
  "PACKAGING_BOX_COUNTED",
  "PACKAGING_RECEIPT_ADJUSTED",
  "PACKAGING_VARIANCE_RECORDED",
]);

/** Source system that produced a packaging-receipt row. PackTrack is
 *  the procurement system; MANUAL_LUMA is the in-app receive form;
 *  ZOHO is the inventory ERP; IMPORT is the legacy bulk-import path. */
export const packagingReceiptSourceEnum = pgEnum("packaging_receipt_source", [
  "PACKTRACK",
  "MANUAL_LUMA",
  "ZOHO",
  "IMPORT",
]);

export const batchKindEnum = pgEnum("batch_kind", ["TABLET", "PACKAGING"]);

export const batchStatusEnum = pgEnum("batch_status", [
  "QUARANTINE", // newly received, awaiting QA
  "RELEASED",   // QA-released, eligible for production
  "ON_HOLD",    // mid-life hold (QA finds an issue)
  "RECALLED",   // recalled by vendor or internal decision
  "EXPIRED",    // past expiry_date
  "DEPLETED",   // qty_on_hand == 0
]);

export const poStatusEnum = pgEnum("po_status", [
  "DRAFT",
  "OPEN",
  "RECEIVING",
  "RECEIVED",
  "CLOSED",
  "CANCELLED",
]);

export const inventoryBagStatusEnum = pgEnum("inventory_bag_status", [
  "AVAILABLE",
  "IN_USE",
  "EMPTIED",
  "QUARANTINED",
  "VOID",
]);

export const qrCardStatusEnum = pgEnum("qr_card_status", [
  "IDLE",
  "ASSIGNED",
  "RETIRED",
]);

export const workflowEventTypeEnum = pgEnum("workflow_event_type", [
  // Card / bag lifecycle
  "CARD_ASSIGNED",
  "CARD_FORCE_RELEASED",
  "BAG_CLAIMED",
  "STATION_RESUMED",
  "OPERATOR_CHANGE",
  "PRODUCT_MAPPED",
  // Vendor barcode verification at run-start
  "BAG_VERIFIED",
  // Production stages
  "BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_SNAPSHOT",
  "PACKAGING_COMPLETE",
  "PACKAGING_TAKEN_FOR_ORDER",
  "PACKAGING_DAMAGE_RETURN",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
  // Pause / resume — workflow nuance, supports PVC swap, shift end,
  // machine jam, etc. Cycle-time math subtracts paused duration.
  "BAG_PAUSED",
  "BAG_RESUMED",
  // Variety pack lineage
  "VARIETY_SOURCES_ASSIGNED",
  // Batch traceability
  "BATCH_RELEASED",
  "BATCH_HELD",
  "BATCH_RECALLED",
  // Material consumption (synthesized by projector from production events)
  "MATERIAL_CONSUMED",
  // Station hand-off — a station hands a bag forward (not finalize).
  // Clears that station's read_station_live entry; does not close
  // the bag and does not touch the QR card. Card stays ASSIGNED.
  "BAG_RELEASED",
  // The next station claims the bag by scanning its still-ASSIGNED
  // card. Updates that station's read_station_live entry; does not
  // change the bag's stage on its own.
  "BAG_PICKED_UP",
  // Corrections + termination
  "SUBMISSION_CORRECTED",
  "BAG_FINALIZED",
  // Token rotation audit
  "STATION_SCAN_TOKEN_ROTATED",
  // ─── Phase A additions (production-intelligence rebuild) ───
  // Machine downtime — first-class, separate from BAG_PAUSED which
  // tracks bag-level operational pauses (PVC swap, shift end, jam).
  "DOWNTIME_STARTED",
  "DOWNTIME_ENDED",
  // Material swap mid-run (PVC roll, foil change, etc.). Distinct
  // from MATERIAL_CONSUMED which is a tally projection.
  "MATERIAL_CHANGED",
  // QA holds at the bag level — complement BATCH_HELD which is
  // batch-wide. Per-bag holds let a single contaminated/suspect bag
  // be parked without quarantining its whole batch.
  "QA_HOLD_STARTED",
  "QA_HOLD_RELEASED",
  // Rework lifecycle. REWORK_SENT marks units returning to a prior
  // station; REWORK_RECEIVED marks the receiving station accepting
  // them. Cycle-time math must subtract rework time to avoid penalty.
  "REWORK_SENT",
  "REWORK_RECEIVED",
  // Hard scrap — distinct from rework. Removes units from yield.
  "SCRAP_RECORDED",
  // Packaging-material movements — issued from store to line, then
  // returned (typical end-of-run leftovers). Lets material burn
  // reconcile against actual issuance.
  "PACKAGING_MATERIAL_ISSUED",
  "PACKAGING_MATERIAL_RETURNED",
  // Finished goods release — fires when a finishedLot moves from
  // PENDING_QC → RELEASED. Decouples QC release from BAG_FINALIZED.
  "FINISHED_GOODS_RELEASED",
]);

export const finishedLotStatusEnum = pgEnum("finished_lot_status", [
  "PENDING_QC",
  "RELEASED",
  "ON_HOLD",
  "SHIPPED",
  "RECALLED",
]);

export const zohoPushStatusEnum = pgEnum("zoho_push_status", [
  "PENDING",
  "SUCCESS",
  "FAILED",
  "PARTIAL",
]);

// ZOHO-1 — sync kind / status enums. CONNECTIVITY_CHECK is the only
// kind ZOHO-1 actually writes; the others land in ZOHO-2..5.
export const zohoSyncKindEnum = pgEnum("zoho_sync_kind", [
  "CONNECTIVITY_CHECK",
  "ITEMS",
  "CUSTOMERS",
  "SALES_ORDERS",
  "PURCHASE_ORDERS",
  "FINISHED_LOT_PUSH",
  // COMMERCIAL-TRACE-2 — invoice sync runs land here. Added to the
  // enum in migration 0035 (standalone ALTER TYPE ADD VALUE; combining
  // enum-add with table DDL in one transaction silently rolls back).
  "INVOICES",
]);

export const zohoSyncRunStatusEnum = pgEnum("zoho_sync_run_status", [
  "STARTED",
  "SUCCESS",
  "PARTIAL",
  "FAILED",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Auth + tenancy (single-tenant for v1, columns ready for multi)
// ─────────────────────────────────────────────────────────────────────────────

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  brandColorHex: text("brand_color_hex").notNull().default("#0d9488"),
  logoPath: text("logo_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"), // null when authentik-managed
    role: userRoleEnum("role").notNull().default("STAFF"),
    employeeId: uuid("employee_id"), // FK applied below
    authentikSubject: text("authentik_subject"), // OIDC sub claim
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    uniqueIndex("users_authentik_unique").on(t.authentikSubject),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 1 — Master data
// ─────────────────────────────────────────────────────────────────────────────

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: text("legacy_id"),
    fullName: text("full_name").notNull(),
    preferredName: text("preferred_name"),
    email: text("email"),
    phone: text("phone"),
    /** Short, operator-friendly badge / login code (e.g. "1042"). Optional;
     *  partial unique index below enforces uniqueness only among ACTIVE
     *  employees so the code can be reused after termination. */
    employeeCode: text("employee_code"),
    language: text("language").notNull().default("en"), // en | es
    status: employeeStatusEnum("status").notNull().default("ACTIVE"),
    hiredOn: date("hired_on"),
    birthday: date("birthday"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("employees_code_active_unique")
      .on(t.employeeCode)
      .where(sql`status = 'ACTIVE' AND employee_code IS NOT NULL`),
  ],
);

export const tabletTypes = pgTable(
  "tablet_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku"),
    name: text("name").notNull(),
    /** Default mass per tablet, milligrams. Used by weight-based
     *  bag estimation when count isn't directly known. */
    defaultMgPerTablet: integer("default_mg_per_tablet"),
    zohoItemId: text("zoho_item_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tablet_types_sku_unique").on(t.sku)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    kind: productKindEnum("kind").notNull(),
    /** Tablets per finished unit (per card, per bottle). For variety
     *  this is null; lineage comes from per-source rules. */
    tabletsPerUnit: integer("tablets_per_unit"),
    /** Cards per display, displays per case. Display = retail-facing
     *  tray; case = shipper carton. Matches what packagers count. */
    unitsPerDisplay: integer("units_per_display"),
    displaysPerCase: integer("displays_per_case"),
    /** Default shelf-life days from manufacture. Finished-lot expiry
     *  is computed as min(tablet batch expiry, manufactured + this). */
    defaultShelfLifeDays: integer("default_shelf_life_days"),
    zohoItemId: text("zoho_item_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_sku_unique").on(t.sku),
    index("products_kind_idx").on(t.kind),
  ],
);

/** Many-to-many: which tablet types a product can pull from. Replaces
 *  the old single tablet_type_id and supports flexible sourcing. */
export const productAllowedTablets = pgTable(
  "product_allowed_tablets",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tabletTypeId: uuid("tablet_type_id")
      .notNull()
      .references(() => tabletTypes.id, { onDelete: "restrict" }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.productId, t.tabletTypeId] })],
);

export const machines = pgTable("machines", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: machineKindEnum("kind").notNull(),
  cardsPerTurn: integer("cards_per_turn").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stations = pgTable(
  "stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    kind: stationKindEnum("kind").notNull(),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    /** Cryptographic floor-API auth. Rotated via admin UI. */
    scanToken: text("scan_token").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stations_scan_token_unique").on(t.scanToken)],
);

/** OP-1C: per-station operator session. The currently-open session
 *  (closed_at IS NULL) is what every floor count submission reads to
 *  default `workflow_events.employee_id` without forcing the operator
 *  to retype their code per click. Only one open session per station
 *  is allowed via the partial unique index in migration 0023. */
export const stationOperatorSessions = pgTable(
  "station_operator_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stationId: uuid("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    /** Stable employee identity. Null only when the session was opened
     *  with a free-text fallback (LEGACY_TEXT / MANUAL_TEXT) — those
     *  sessions still serve as accountability context but are
     *  confidence-LOW downstream. */
    employeeId: uuid("employee_id"),
    /** Frozen at session open so audit reads stay readable even if the
     *  employees row is later renamed. */
    employeeNameSnapshot: text("employee_name_snapshot").notNull(),
    /** One of the AccountabilitySource union values. Stored as text
     *  rather than an enum to avoid a second ALTER TYPE per source
     *  addition; the helper validates on read/write. */
    accountabilitySource: text("accountability_source").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** When an admin opened the session on the operator's behalf. */
    openedByUserId: uuid("opened_by_user_id"),
    closedByUserId: uuid("closed_by_user_id"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("station_operator_sessions_active_unique")
      .on(t.stationId)
      .where(sql`closed_at IS NULL`),
    index("station_operator_sessions_employee_idx")
      .on(t.employeeId)
      .where(sql`employee_id IS NOT NULL`),
    index("station_operator_sessions_opened_idx").on(t.openedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 2 — Inbound (POs, receives, raw-tablet bags, packaging materials)
// ─────────────────────────────────────────────────────────────────────────────

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull(),
    parentPoNumber: text("parent_po_number"), // for -OVERS or split POs
    vendorName: text("vendor_name"),
    status: poStatusEnum("status").notNull().default("OPEN"),
    zohoPoId: text("zoho_po_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("po_number_unique").on(t.poNumber),
    index("po_zoho_idx").on(t.zohoPoId),
    index("po_status_idx").on(t.status),
  ],
);

export const poLines = pgTable(
  "po_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** Either a tablet type (raw) OR a packaging material. Exactly one
     *  must be non-null; enforced by check constraint at migration. */
    tabletTypeId: uuid("tablet_type_id").references(() => tabletTypes.id),
    packagingMaterialId: uuid("packaging_material_id"),
    qtyOrdered: integer("qty_ordered").notNull(),
    zohoLineItemId: text("zoho_line_item_id"),
    notes: text("notes"),
  },
  (t) => [index("po_lines_po_idx").on(t.poId)],
);

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryPhotoPath: text("delivery_photo_path"),
    /** LOT-1B — customer this shipment is bound for. Nullable for
     *  legacy / unrouted shipments. FK defined in SQL (forward ref
     *  to customers table declared below). */
    customerId: uuid("customer_id"),
  },
  (t) => [
    index("shipments_po_idx").on(t.poId),
    index("shipments_customer_idx")
      .on(t.customerId)
      .where(sql`customer_id IS NOT NULL`),
  ],
);

export const receives = pgTable(
  "receives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id").references(() => purchaseOrders.id),
    /** INTAKE-WORKFLOW-1 — link to the exact PO line being fulfilled.
     *  Nullable: legacy receives + manual-PO-reference receives leave
     *  it null. When set, variance against po_lines.qty_ordered is
     *  unambiguous. */
    poLineId: uuid("po_line_id").references(() => poLines.id, {
      onDelete: "set null",
    }),
    shipmentId: uuid("shipment_id").references(() => shipments.id),
    receiveName: text("receive_name").notNull(), // sequential per PO, e.g. "PO123-R1"
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    receivedById: uuid("received_by_id").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("receives_po_idx").on(t.poId),
    index("receives_po_line_idx")
      .on(t.poLineId)
      .where(sql`po_line_id IS NOT NULL`),
    uniqueIndex("receives_name_unique").on(t.receiveName),
  ],
);

export const smallBoxes = pgTable(
  "small_boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiveId: uuid("receive_id")
      .notNull()
      .references(() => receives.id, { onDelete: "cascade" }),
    boxNumber: integer("box_number").notNull(),
    /** Default batch + tablet type for bags inside this box. Bags can
     *  override per-bag. */
    defaultBatchId: uuid("default_batch_id"), // FK applied below
    defaultTabletTypeId: uuid("default_tablet_type_id").references(() => tabletTypes.id),
    totalBags: integer("total_bags").notNull().default(0),
  },
  (t) => [index("small_boxes_receive_idx").on(t.receiveId)],
);

/** Raw-tablet inventory bag — what comes off the truck and gets
 *  consumed by a workflow_bag during production. */
export const inventoryBags = pgTable(
  "inventory_bags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    smallBoxId: uuid("small_box_id")
      .notNull()
      .references(() => smallBoxes.id, { onDelete: "cascade" }),
    bagNumber: integer("bag_number").notNull(),
    tabletTypeId: uuid("tablet_type_id")
      .notNull()
      .references(() => tabletTypes.id),
    batchId: uuid("batch_id"), // FK applied below
    /** Estimated tablet count when known (intake weight × density,
     *  or printed count). */
    pillCount: integer("pill_count"),
    weightGrams: integer("weight_grams"),
    /** Manufacturer's existing barcode/lot number on the bag's
     *  printed sticker. Captured at receive time so an operator at
     *  the blister machine can scan the same barcode and the
     *  system verifies which inventory bag they're working — no
     *  new label printing required. */
    vendorBarcode: text("vendor_barcode"),
    status: inventoryBagStatusEnum("status").notNull().default("AVAILABLE"),
    /** Reserved for bottle production (kept out of card-flow picking). */
    reservedForBottles: boolean("reserved_for_bottles").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
    /** LOT-1B — Luma-issued QR string printed at intake. Distinct
     *  from vendorBarcode (manufacturer's own sticker) and distinct
     *  from qr_cards.scan_token (production badge). Nullable until
     *  intake UI generates one. */
    bagQrCode: text("bag_qr_code"),
    /** LOT-1B — internal receipt-pad identifier. Typically built from
     *  receives.receive_name + small_box.box_number + bag_number; stored
     *  explicitly so the value survives renames. */
    internalReceiptNumber: text("internal_receipt_number"),
    /** LOT-1B — supplier-declared count at intake. pillCount above is
     *  the live working count post-adjustment; this is the original. */
    declaredPillCount: integer("declared_pill_count"),
  },
  (t) => [
    index("inventory_bags_box_idx").on(t.smallBoxId),
    index("inventory_bags_batch_idx").on(t.batchId),
    index("inventory_bags_status_idx").on(t.status),
    uniqueIndex("inventory_bags_box_bagno_unique").on(t.smallBoxId, t.bagNumber),
    uniqueIndex("inventory_bags_bag_qr_code_unique")
      .on(t.bagQrCode)
      .where(sql`bag_qr_code IS NOT NULL`),
    index("inventory_bags_internal_receipt_idx")
      .on(t.internalReceiptNumber)
      .where(sql`internal_receipt_number IS NOT NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Packaging materials — lots of bottles, caps, labels, foil, cases, etc.
// ─────────────────────────────────────────────────────────────────────────────

export const packagingMaterials = pgTable(
  "packaging_materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    kind: packagingMaterialKindEnum("kind").notNull(),
    /** Stock-keeping unit of measure ("each", "roll", "kg"). */
    uom: text("uom").notNull().default("each"),
    /** Reorder threshold; below this we alert. */
    parLevel: integer("par_level"),
    /** PT-7C — quantity-formula knobs read by the shortage projector.
     *  All nullable; PT-7B applies sensible defaults when missing
     *  (20% safety buffer; no min order; no multiple rounding). */
    minOrderQuantity: numeric("min_order_quantity", { precision: 20, scale: 6 }),
    safetyBufferPercent: numeric("safety_buffer_percent", { precision: 6, scale: 2 }),
    orderMultiple: numeric("order_multiple", { precision: 20, scale: 6 }),
    zohoItemId: text("zoho_item_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("packaging_materials_sku_unique").on(t.sku),
    index("packaging_materials_kind_idx").on(t.kind),
  ],
);

/** Bill of materials — for product P, you need qtyPerUnit of material M
 *  per finished unit. Drives auto-decrement on packaging events. */
export const productPackagingSpecs = pgTable(
  "product_packaging_specs",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "restrict" }),
    qtyPerUnit: integer("qty_per_unit").notNull(),
    /** Some materials are per-display (a shipper insert) or per-case
     *  (an outer label). null/per_unit = per finished unit. */
    perScope: text("per_scope").notNull().default("UNIT"), // UNIT | DISPLAY | CASE
    /** Phase H — waste tolerance applied to expected consumption.
     *  Default 0% (no waste built-in). Honest: must be configured
     *  per material to apply. */
    wasteAllowancePercent: numeric("waste_allowance_percent", {
      precision: 5,
      scale: 2,
    }).default("0"),
    notes: text("notes"),
  },
  (t) => [primaryKey({ columns: [t.productId, t.packagingMaterialId, t.perScope] })],
);

/** PBOM-2 — Product ↔ packaging-material compatibility matrix.
 *  Gates the BOM page's material dropdown by product + route +
 *  scope + role. PBOM-1 filters by material kind; PBOM-2 narrows
 *  further so Mango Peach only sees its own approved printed
 *  cards / display boxes / master cases. Empty matrix = empty
 *  dropdown (no silent fallback to "all materials"). */
export const productMaterialCompatibility = pgTable(
  "product_material_compatibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    /** "UNIT" | "DISPLAY" | "CASE" — mirrors product_packaging_specs. */
    scope: text("scope").notNull(),
    /** "CARD_MATERIAL" | "DISPLAY_BOX" | "MASTER_CASE" | "BOTTLE" |
     *  "CAP" | "LABEL" | "INDUCTION_SEAL" | "INSERT" | "SHRINK_BAND"
     *  | "OTHER". Stored as text for forward-compat; validated in
     *  lib/production/product-material-compatibility. */
    compatibilityRole: text("compatibility_role").notNull(),
    required: boolean("required").notNull().default(false),
    defaultForProduct: boolean("default_for_product").notNull().default(false),
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("product_material_compatibility_lookup_idx")
      .on(t.productId, t.scope, t.active)
      .where(sql`active = true`),
    uniqueIndex("product_material_compatibility_default_unique")
      .on(t.productId, t.routeId, t.scope, t.compatibilityRole)
      .where(sql`default_for_product = true AND active = true`),
    uniqueIndex("product_material_compatibility_no_dupe")
      .on(t.productId, t.routeId, t.materialId, t.scope)
      .where(sql`active = true`),
    index("product_material_compatibility_role_idx").on(t.compatibilityRole),
  ],
);

/** Each shipment / lot of a packaging material we receive. Each lot
 *  has its own batch (kind=PACKAGING) for genealogy.
 *
 *  Phase H additions: roll-tracking columns (gross/tare/net/current
 *  weight, roll number, supplier, location, scan token) for PVC and
 *  foil rolls. Count-based materials use qtyReceived/qtyOnHand and
 *  ignore weight columns. Status drives the "IN_USE / DEPLETED /
 *  HELD" lifecycle. */
export const packagingLots = pgTable(
  "packaging_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id"), // FK applied below
    poId: uuid("po_id").references(() => purchaseOrders.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    qtyReceived: integer("qty_received").notNull(),
    qtyOnHand: integer("qty_on_hand").notNull(),
    expiryDate: date("expiry_date"),
    coaPath: text("coa_path"),
    notes: text("notes"),
    // Phase H — lot-level lifecycle + roll fields
    status: materialLotStatusEnum("status").notNull().default("AVAILABLE"),
    rollNumber: text("roll_number"),
    grossWeightGrams: integer("gross_weight_grams"),
    tareWeightGrams: integer("tare_weight_grams"),
    netWeightGrams: integer("net_weight_grams"),
    currentWeightGramsEstimate: integer("current_weight_grams_estimate"),
    weightUnit: text("weight_unit").default("g"),
    widthMm: integer("width_mm"),
    thicknessMicrons: integer("thickness_microns"),
    materialSpec: text("material_spec"),
    coreWeightGrams: integer("core_weight_grams"),
    supplier: text("supplier"),
    location: text("location"),
    scanToken: text("scan_token"),
    /** Confidence on the lot's recorded quantity. HIGH when net
     *  weight came from gross-tare OR counted_quantity was entered;
     *  MEDIUM when only the supplier-declared box quantity is on
     *  file; LOW when imported/incomplete; MISSING when no usable
     *  quantity exists. */
    confidence: text("confidence").default("HIGH"),
    // PT-1 — PackTrack-aware packaging-receipt fields. All nullable
    // and additive; legacy rows backfill accepted_quantity from
    // qty_received via 0021 migration.
    declaredQuantity: integer("declared_quantity"),
    countedQuantity: integer("counted_quantity"),
    /** accepted_quantity = COALESCE(counted_quantity, declared_quantity).
     *  This is the figure Luma uses for inventory availability and
     *  shortage projection going forward. qty_received is kept for
     *  back-compat. */
    acceptedQuantity: integer("accepted_quantity"),
    boxNumber: text("box_number"),
    supplierLotNumber: text("supplier_lot_number"),
    packtrackPoId: text("packtrack_po_id"),
    packtrackReceiptId: text("packtrack_receipt_id"),
    sourceSystem: packagingReceiptSourceEnum("source_system"),
    receivedByUserId: uuid("received_by_user_id"), // FK applied below
  },
  (t) => [
    index("packaging_lots_material_idx").on(t.packagingMaterialId),
    index("packaging_lots_batch_idx").on(t.batchId),
    index("packaging_lots_status_idx").on(t.status),
    index("packaging_lots_packtrack_receipt_idx").on(t.packtrackReceiptId),
  ],
);

// ─── Phase H — Material standards + event log ────────────────────

/** Per-(product, role) PVC/foil consumption standard. material_role
 *  is "PVC" or "FOIL". Either expectedGramsPerBlister OR
 *  expectedBlistersPerKg is set — the projector prefers the per-
 *  blister number when both are present. setup/changeover waste
 *  in grams is added to the projected used weight per run. */
export const blisterMaterialStandards = pgTable(
  "blister_material_standards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    materialRole: text("material_role").notNull(), // PVC | FOIL
    expectedGramsPerBlister: numeric("expected_grams_per_blister", {
      precision: 10,
      scale: 4,
    }),
    expectedBlistersPerKg: numeric("expected_blisters_per_kg", {
      precision: 10,
      scale: 3,
    }),
    setupWasteGrams: integer("setup_waste_grams").notNull().default(0),
    changeoverWasteGrams: integer("changeover_waste_grams")
      .notNull()
      .default(0),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("blister_material_standards_product_idx").on(
      t.productId,
      t.materialRole,
    ),
    index("blister_material_standards_active_idx").on(t.isActive),
  ],
);

/** Append-only event log for material movements. Mirrors workflow_
 *  events but for inventory state changes (received, issued,
 *  consumed, scrapped, mounted, weighed). The metric layer reads
 *  this to compute lot state and consumption rollups. */
export const materialInventoryEvents = pgTable(
  "material_inventory_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    eventType: materialEventTypeEnum("event_type").notNull(),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    packagingLotId: uuid("packaging_lot_id").references(
      () => packagingLots.id,
      { onDelete: "set null" },
    ),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    workflowBagId: uuid("workflow_bag_id").references(() => workflowBags.id, {
      onDelete: "set null",
    }),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    stationId: uuid("station_id").references(() => stations.id, {
      onDelete: "set null",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Count-based qty (e.g. caps issued). */
    quantityUnits: integer("quantity_units"),
    /** Weight-based qty (e.g. PVC consumed). Stored in grams as
     *  integer per the no-floats design rule. */
    quantityGrams: integer("quantity_grams"),
    unitOfMeasure: text("unit_of_measure"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    source: text("source").notNull().default("system"),
    /** Idempotency key. Floor PWA generates a UUID before fire-and-
     *  retry; the partial unique index on (lot, type, client_event_id)
     *  rejects duplicates. */
    clientEventId: uuid("client_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("material_events_lot_idx").on(t.packagingLotId),
    index("material_events_material_idx").on(t.packagingMaterialId),
    index("material_events_bag_idx").on(t.workflowBagId),
    index("material_events_machine_idx").on(t.machineId),
    index("material_events_type_occurred_idx").on(
      t.eventType,
      t.occurredAt,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 3 — Batches & Lots (the traceability spine)
// ─────────────────────────────────────────────────────────────────────────────

/** Every tablet shipment AND every packaging lot has exactly one batch
 *  row. Status drives whether production can consume it. */
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: batchKindEnum("kind").notNull(),
    batchNumber: text("batch_number").notNull(),
    /** Exactly one of these two is set. Enforced by check constraint. */
    tabletTypeId: uuid("tablet_type_id").references(() => tabletTypes.id),
    packagingMaterialId: uuid("packaging_material_id").references(
      () => packagingMaterials.id,
    ),
    vendorName: text("vendor_name"),
    vendorLotNumber: text("vendor_lot_number"),
    manufacturedAt: date("manufactured_at"),
    expiryDate: date("expiry_date"),
    status: batchStatusEnum("status").notNull().default("QUARANTINE"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    statusChangedById: uuid("status_changed_by_id").references(() => users.id),
    qtyReceived: integer("qty_received").notNull().default(0),
    qtyOnHand: integer("qty_on_hand").notNull().default(0),
    coaPath: text("coa_path"),
    coaUploadedAt: timestamp("coa_uploaded_at", { withTimezone: true }),
    coaUploadedById: uuid("coa_uploaded_by_id").references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("batches_kind_number_unique").on(t.kind, t.batchNumber),
    index("batches_status_idx").on(t.status),
    index("batches_tablet_type_idx").on(t.tabletTypeId),
    index("batches_packaging_material_idx").on(t.packagingMaterialId),
    index("batches_expiry_idx").on(t.expiryDate),
  ],
);

/** A batch can be put on hold mid-life. Multiple holds, audited. */
export const batchHolds = pgTable(
  "batch_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedById: uuid("opened_by_id")
      .notNull()
      .references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedById: uuid("closed_by_id").references(() => users.id),
    closedReason: text("closed_reason"),
  },
  (t) => [index("batch_holds_batch_idx").on(t.batchId)],
);

/** Finished good — a single production run's output. Created when a
 *  workflow_bag finalizes. Carries expiry + status + recall window. */
export const finishedLots = pgTable(
  "finished_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    workflowBagId: uuid("workflow_bag_id"), // FK applied below
    finishedLotNumber: text("finished_lot_number").notNull(),
    producedOn: date("produced_on").notNull(),
    expiryDate: date("expiry_date").notNull(),
    unitsProduced: integer("units_produced").notNull(),
    displaysProduced: integer("displays_produced"),
    casesProduced: integer("cases_produced"),
    status: finishedLotStatusEnum("status").notNull().default("PENDING_QC"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** LOT-1B — customer-facing printed code. Single namespace for
     *  recall lookup. Same value as finishedLotNumber for newly
     *  created lots today, but distinct so they can diverge later
     *  (e.g. customer-branded variants). */
    traceCode: text("trace_code"),
    /** LOT-1B — when the lot finished packing. expiryDate above is
     *  date-typed; this is the precise timestamp. */
    packedAt: timestamp("packed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** LOT-1B — optional secondary code printed for a specific
     *  customer (e.g. their internal SKU). */
    finishedLotCodeAlias: text("finished_lot_code_alias"),
  },
  (t) => [
    uniqueIndex("finished_lots_number_unique").on(t.finishedLotNumber),
    index("finished_lots_product_idx").on(t.productId),
    index("finished_lots_produced_idx").on(t.producedOn),
    uniqueIndex("finished_lots_trace_code_unique")
      .on(t.traceCode)
      .where(sql`trace_code IS NOT NULL`),
    index("finished_lots_alias_idx")
      .on(t.finishedLotCodeAlias)
      .where(sql`finished_lot_code_alias IS NOT NULL`),
    index("finished_lots_packed_at_idx")
      .on(t.packedAt)
      .where(sql`packed_at IS NOT NULL`),
  ],
);

/** The genealogy table — for finished lot F, list every input batch
 *  (tablet AND packaging) that contributed, and how much. Recall
 *  query: SELECT product, finished_lot WHERE batch_id = ? */
export const finishedLotInputs = pgTable(
  "finished_lot_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    /** Qty consumed in the batch's UoM (tablets, bottles, labels, ...). */
    qtyConsumed: integer("qty_consumed").notNull(),
    /** Pointer back to the workflow event that recorded the consumption. */
    derivedFromEventId: uuid("derived_from_event_id"), // FK applied below
  },
  (t) => [
    index("finished_lot_inputs_lot_idx").on(t.finishedLotId),
    index("finished_lot_inputs_batch_idx").on(t.batchId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 4 — Production (event-sourced QR workflow)
// ─────────────────────────────────────────────────────────────────────────────

export const qrCards = pgTable(
  "qr_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    scanToken: text("scan_token").notNull(),
    status: qrCardStatusEnum("status").notNull().default("IDLE"),
    assignedWorkflowBagId: uuid("assigned_workflow_bag_id"), // FK applied below
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("qr_cards_token_unique").on(t.scanToken),
    index("qr_cards_status_idx").on(t.status),
  ],
);

/** A workflow_bag is the journey of one bag of tablets through
 *  production. Created when staff scan a card + pick the input
 *  inventory_bag. Finalized when all required events have fired. */
export const workflowBags = pgTable(
  "workflow_bags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").references(() => products.id),
    /** The raw-tablet input. Nullable for bottle workflows that pull
     *  from multiple sources (lineage in workflow_events payload). */
    inventoryBagId: uuid("inventory_bag_id").references(() => inventoryBags.id),
    receiptNumber: text("receipt_number"), // denormalized for fast display
    boxNumber: integer("box_number"),
    bagNumber: integer("bag_number"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    index("workflow_bags_product_idx").on(t.productId),
    index("workflow_bags_inventory_idx").on(t.inventoryBagId),
    index("workflow_bags_started_idx").on(t.startedAt),
  ],
);

/** Append-only event stream. Source of truth for production state. */
export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowBagId: uuid("workflow_bag_id")
      .notNull()
      .references(() => workflowBags.id, { onDelete: "cascade" }),
    eventType: workflowEventTypeEnum("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    stationId: uuid("station_id").references(() => stations.id),
    employeeId: uuid("employee_id").references(() => employees.id),
    userId: uuid("user_id").references(() => users.id),
    /** Floor-side correlation only. Not identity, not authorization. */
    deviceId: text("device_id"),
    pageSessionId: text("page_session_id"),
    /** Idempotency key sent by the floor PWA — UUID per click. The
     *  partial unique index below makes a retried action a no-op
     *  instead of a double-fire. */
    clientEventId: text("client_event_id"),
  },
  (t) => [
    index("workflow_events_bag_idx").on(t.workflowBagId),
    index("workflow_events_type_idx").on(t.eventType),
    index("workflow_events_occurred_idx").on(t.occurredAt),
    index("workflow_events_bag_occurred_idx").on(
      t.workflowBagId,
      t.occurredAt,
      t.id,
    ),
    // At-most-once finalization per bag.
    uniqueIndex("workflow_events_finalized_unique")
      .on(t.workflowBagId)
      .where(sql`event_type = 'BAG_FINALIZED'`),
    // Idempotency: same (bag, event_type, client_event_id) tuple
    // can only land once. Lets retried floor events no-op cleanly.
    uniqueIndex("workflow_events_client_event_unique")
      .on(t.workflowBagId, t.eventType, t.clientEventId)
      .where(sql`client_event_id IS NOT NULL`),
    // QC-1: fast lookup of QC chain events by linked_event_id.
    // Lives in migration 0026; declared here so introspection /
    // migration generation stays in sync.
    index("workflow_events_linked_event_idx")
      .on(sql`(payload->>'linked_event_id')`)
      .where(sql`payload ? 'linked_event_id'`),
    // QC-1: prevent double-resolving a source QC event into more
    // than one scrap row OR more than one rework-sent row.
    uniqueIndex("workflow_events_linked_event_resolution_unique")
      .on(sql`(payload->>'linked_event_id')`, t.eventType)
      .where(
        sql`event_type IN ('SCRAP_RECORDED', 'REWORK_SENT') AND payload ? 'linked_event_id'`,
      ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 5 — Output (Zoho push, ship/release tracking)
// ─────────────────────────────────────────────────────────────────────────────

export const zohoCredentials = pgTable(
  "zoho_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret").notNull(),
    refreshToken: text("refresh_token").notNull(),
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    /** us | eu | in | au | jp — picks the API host. */
    dataCenter: text("data_center").notNull().default("us"),
    warehouseId: text("warehouse_id"),
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedById: uuid("updated_by_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("zoho_credentials_company_unique").on(t.companyId),
  ],
);

export const zohoPushes = pgTable(
  "zoho_pushes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    /** zohoReceiveId = the Zoho-side purchase_receive id we created. */
    zohoReceiveId: text("zoho_receive_id"),
    zohoOversReceiveId: text("zoho_overs_receive_id"),
    status: zohoPushStatusEnum("status").notNull().default("PENDING"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    /** Net amount in cents (Zoho's expected total). bigint for safety. */
    amountCents: bigint("amount_cents", { mode: "number" }),
  },
  (t) => [
    index("zoho_pushes_lot_idx").on(t.finishedLotId),
    index("zoho_pushes_status_idx").on(t.status),
  ],
);

// ZOHO-1 — gateway connectivity / sync audit. Every gateway call,
// dry-run, and live sync writes a row here. ZOHO-1 only writes
// CONNECTIVITY_CHECK kind; items / customers / SO / PO / push land in
// ZOHO-2..5.
export const zohoSyncRuns = pgTable(
  "zoho_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncType: zohoSyncKindEnum("sync_type").notNull(),
    status: zohoSyncRunStatusEnum("status").notNull().default("STARTED"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Free-text: 'manual' for admin-button-triggered runs, 'pg_boss'
     *  for scheduled handlers in later phases. No enum so future sources
     *  land without an ALTER TYPE. */
    source: text("source").notNull().default("manual"),
    /** Defaults to true. Live writes flip this in later phases. */
    dryRun: boolean("dry_run").notNull().default(true),
    /** Structured outcome — rowsSeen / rowsWritten / unmatched / per-
     *  sync-kind payload. Kept jsonb so the schema doesn't ossify. */
    summary: jsonb("summary").notNull().default({}),
    error: text("error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("zoho_sync_runs_type_started_idx").on(t.syncType, t.startedAt),
    index("zoho_sync_runs_status_idx").on(t.status),
  ],
);

// ZOHO-1 — per-object Zoho-side state. ZOHO-1 does not write here; the
// table is created in preparation for ZOHO-2/ZOHO-3. (object_type,
// external_id) is the natural key. object_type is free-text so future
// kinds land without an enum migration.
export const zohoSyncState = pgTable(
  "zoho_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectType: text("object_type").notNull(),
    externalId: text("external_id").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** SHA256 of the verbatim Zoho payload (or a stable subset) so future
     *  syncs detect "no change" without diffing every field. */
    sourceHash: text("source_hash"),
    status: text("status").notNull().default("SEEN"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("zoho_sync_state_object_external_unique").on(
      t.objectType,
      t.externalId,
    ),
    index("zoho_sync_state_last_seen_idx").on(t.lastSeenAt),
    index("zoho_sync_state_status_idx").on(t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 5b — Legacy import (PythonAnywhere fetcher)
// ─────────────────────────────────────────────────────────────────────────────
//
// One-row config per company holding the PA username + API token + a list
// of files we pull on a schedule (DB dumps, Zoho config exports, etc).
// Each fetched file gets dropped into /data/legacy-imports/ with a
// timestamped basename and a row in legacy_import_runs for audit.

export const legacyImportConfig = pgTable(
  "legacy_import_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** PythonAnywhere username (e.g. "sahilk1"). Drives the API host
     *  https://www.pythonanywhere.com/api/v0/user/<username>/files/path. */
    paUsername: text("pa_username").notNull(),
    /** PA API token. Plaintext at rest, like zoho_credentials —
     *  protected by Postgres ACLs + audit log. Masked in UI. */
    paApiToken: text("pa_api_token").notNull(),
    /** Whether the scheduled fetcher should run. Manual "Fetch now"
     *  works even when this is off. */
    isActive: boolean("is_active").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncOk: boolean("last_sync_ok"),
    lastSyncError: text("last_sync_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedById: uuid("updated_by_id").references(() => users.id),
  },
  (t) => [uniqueIndex("legacy_import_config_company_unique").on(t.companyId)],
);

export const legacyImportPaths = pgTable(
  "legacy_import_paths",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id")
      .notNull()
      .references(() => legacyImportConfig.id, { onDelete: "cascade" }),
    /** Absolute remote path on PA, e.g. /home/sahilk1/dumps/tt-latest.sql.gz */
    remotePath: text("remote_path").notNull(),
    /** Human-readable label shown in the UI. */
    label: text("label").notNull(),
    /** What this file is for. Drives downstream importers. */
    kind: text("kind", {
      enum: ["DB_DUMP", "ZOHO_CONFIG", "OTHER"],
    })
      .notNull()
      .default("OTHER"),
    enabled: boolean("enabled").notNull().default(true),
    /** Last-fetch metadata. */
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastBytes: integer("last_bytes"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    /** Where the most recent successful download landed locally. */
    lastLocalPath: text("last_local_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("legacy_import_paths_remote_unique").on(t.configId, t.remotePath),
    index("legacy_import_paths_enabled_idx").on(t.configId, t.enabled),
  ],
);

export const legacyImportRuns = pgTable(
  "legacy_import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id")
      .notNull()
      .references(() => legacyImportConfig.id, { onDelete: "cascade" }),
    triggeredBy: text("triggered_by", {
      enum: ["MANUAL", "SCHEDULED"],
    }).notNull(),
    triggeredById: uuid("triggered_by_id").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    filesAttempted: integer("files_attempted").notNull().default(0),
    filesSucceeded: integer("files_succeeded").notNull().default(0),
    summary: text("summary"),
  },
  (t) => [index("legacy_import_runs_started_idx").on(t.startedAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 5c — Legacy TabletTracker import support
// ─────────────────────────────────────────────────────────────────────────────
//
// Two roles:
//   1. legacyTtIdMap — translates TT integer auto-increment PKs to
//      Luma UUIDs. Re-running the importer is idempotent because we
//      check this table before inserting.
//   2. legacy_* stash tables — preserve TT rows we don't yet have a
//      clean Luma target for (warehouse_submissions, machine_counts,
//      etc.) so historical reporting works and a Phase 2 synthesizer
//      can convert them into Luma workflow_events later.

export const legacyTtIdMap = pgTable(
  "legacy_tt_id_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttTable: text("tt_table").notNull(),
    ttId: integer("tt_id").notNull(),
    lumaTable: text("luma_table").notNull(),
    lumaId: uuid("luma_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("legacy_tt_id_map_source_unique").on(t.ttTable, t.ttId),
    index("legacy_tt_id_map_luma_idx").on(t.lumaTable, t.lumaId),
  ],
);

export const legacyWarehouseSubmissions = pgTable(
  "legacy_warehouse_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    payload: jsonb("payload").notNull(),
    submissionType: text("submission_type"),
    bagId: uuid("bag_id").references(() => inventoryBags.id),
    workflowBagId: uuid("workflow_bag_id").references(() => workflowBags.id),
    employeeName: text("employee_name"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [
    index("legacy_ws_bag_idx").on(t.bagId),
    index("legacy_ws_wfb_idx").on(t.workflowBagId),
    index("legacy_ws_type_idx").on(t.submissionType),
  ],
);

export const legacyMachineCounts = pgTable(
  "legacy_machine_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    payload: jsonb("payload").notNull(),
    tabletTypeId: uuid("tablet_type_id").references(() => tabletTypes.id),
    machineId: uuid("machine_id").references(() => machines.id),
    employeeName: text("employee_name"),
    countDate: date("count_date"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [
    index("legacy_mc_tt_idx").on(t.tabletTypeId),
    index("legacy_mc_machine_idx").on(t.machineId),
    index("legacy_mc_date_idx").on(t.countDate),
  ],
);

export const legacySubmissionBagDeductions = pgTable(
  "legacy_submission_bag_deductions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    legacySubmissionId: uuid("legacy_submission_id")
      .notNull()
      .references(() => legacyWarehouseSubmissions.id, {
        onDelete: "cascade",
      }),
    bagId: uuid("bag_id").references(() => inventoryBags.id),
    tabletsDeducted: integer("tablets_deducted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [
    index("legacy_sbd_submission_idx").on(t.legacySubmissionId),
    index("legacy_sbd_bag_idx").on(t.bagId),
  ],
);

export const legacyBlisterRolls = pgTable(
  "legacy_blister_rolls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    machineId: uuid("machine_id").references(() => machines.id),
    materialType: text("material_type").notNull(),
    rollCode: text("roll_code").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    startPressCount: doublePrecision("start_press_count").notNull().default(0),
    endPressCount: doublePrecision("end_press_count"),
    blistersPerPress: integer("blisters_per_press").notNull().default(1),
    totalBlisters: doublePrecision("total_blisters"),
    status: text("status").notNull().default("active"),
  },
  (t) => [
    index("legacy_blister_rolls_machine_idx").on(t.machineId),
    index("legacy_blister_rolls_status_idx").on(t.status),
  ],
);

export const legacyCompressors = pgTable(
  "legacy_compressors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    compressorName: text("compressor_name").notNull(),
    status: text("status").notNull().default("working"),
    machineId: uuid("machine_id").references(() => machines.id),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    cost: doublePrecision("cost"),
    tankSize: text("tank_size"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [index("legacy_compressors_machine_idx").on(t.machineId)],
);

export const legacyPoDamageCloseout = pgTable(
  "legacy_po_damage_closeout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    poId: uuid("po_id").references(() => purchaseOrders.id),
    poLineId: uuid("po_line_id").references(() => poLines.id),
    inventoryItemId: text("inventory_item_id"),
    damageWeightKg: doublePrecision("damage_weight_kg"),
    estimatedDamagedTablets: integer("estimated_damaged_tablets"),
    gramsPerTablet: doublePrecision("grams_per_tablet"),
    weightMissing: boolean("weight_missing").notNull().default(false),
    weightSource: text("weight_source"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("legacy_po_damage_po_idx").on(t.poId)],
);

export const legacyAppSettings = pgTable(
  "legacy_app_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttId: integer("tt_id").notNull().unique(),
    settingKey: text("setting_key").notNull(),
    settingValue: text("setting_value").notNull(),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("legacy_app_settings_key_unique").on(t.settingKey)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 5b — Standards / config (Phase A of production-intelligence rebuild)
//
// Without these tables, true OEE / on-time completion / labor cost are
// impossible to compute. The metric layer refuses to display those KPIs
// until the relevant standards row exists. Each table is empty by default;
// the user fills them in via the Standards Admin UI (Phase D).
// ─────────────────────────────────────────────────────────────────────────────

/** Shift definitions — drive Availability denominator for OEE.
 *
 * Multiple calendars supported (e.g. weekday-shift vs weekend-shift).
 * `effectiveFrom` lets calendars version without losing history.
 * `plannedBreakMinutes` is what's subtracted from the shift duration
 * to get planned production time.
 *
 * Empty by default. Until at least one calendar row matches a given
 * date+station, OEE Availability is "Insufficient data". */
export const productionCalendars = pgTable(
  "production_calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Inclusive start of validity. */
    effectiveFrom: date("effective_from").notNull(),
    /** Exclusive end. NULL = open-ended. */
    effectiveTo: date("effective_to"),
    /** "08:00" 24-hour. Local time per company.timezone. */
    shiftStart: text("shift_start").notNull(),
    /** "17:00" 24-hour. May cross midnight (e.g. "22:00"→"06:00"); the
     *  metric layer interprets shift_end <= shift_start as next-day. */
    shiftEnd: text("shift_end").notNull(),
    plannedBreakMinutes: integer("planned_break_minutes").notNull().default(0),
    /** Day-of-week mask. Bit 0 = Sunday … bit 6 = Saturday. 0b1111100 (124) = Mon–Fri. */
    daysOfWeekMask: integer("days_of_week_mask").notNull().default(127),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("production_calendars_effective_idx").on(t.effectiveFrom, t.effectiveTo),
  ],
);

/** Per-(station, product) ideal cycle and target rate. Drives the
 *  Performance factor in OEE and the "is this run slow?" detection.
 *
 *  - `idealCycleSeconds`: ideal time per UNIT of `outputUnit`. NULL
 *    = no standard known; performance unmeasurable.
 *  - `targetUnitsPerHour`: alternate way to express the same thing
 *    (some teams prefer rate). Either field can be NULL; metric
 *    layer prefers idealCycleSeconds when both present.
 *  - `expectedYieldPct`: 0–100; sets the Quality benchmark.
 *  - `outputUnit`: which unit type the standard applies to —
 *    "BAG", "DISPLAY", "CASE", "TABLET", "BOTTLE". Different
 *    stations measure differently; explicit unit avoids confusion.
 *  - `effectiveFrom`/`effectiveTo`: versioned, like calendars.
 *
 *  Either station_id or machine_id is required (XOR). station-level
 *  standards are most specific (a sealing line on heat-sealer-2);
 *  machine-level fallback covers anything-on-DPP115. */
export const stationStandards = pgTable(
  "station_standards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stationId: uuid("station_id").references(() => stations.id, {
      onDelete: "cascade",
    }),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "cascade",
    }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    idealCycleSeconds: numeric("ideal_cycle_seconds", { precision: 10, scale: 3 }),
    targetUnitsPerHour: numeric("target_units_per_hour", { precision: 10, scale: 3 }),
    expectedYieldPct: numeric("expected_yield_pct", { precision: 5, scale: 2 }),
    outputUnit: text("output_unit").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Cannot have both station and machine set, must have at least
    // one. Enforced via the metric-layer write-path; the constraint
    // here documents the intent for SQL readers.
    index("station_standards_lookup_idx").on(t.stationId, t.productId, t.effectiveFrom),
    index("station_standards_machine_lookup_idx").on(t.machineId, t.productId, t.effectiveFrom),
    index("station_standards_active_idx").on(t.isActive),
  ],
);

/** Hourly rate per role. Burden multiplier (e.g. 1.30 for benefits +
 *  payroll taxes) is separate from the base rate so the burdened
 *  rate can be recomputed without rewriting history. Empty by
 *  default; labor cost shows "No labor rate configured" until at
 *  least one effective row exists for the role at the given date. */
export const laborRates = pgTable(
  "labor_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Free-text role tag — matches the operator's role on the
     *  floor (e.g. "BLISTER_OPERATOR", "PACKAGING", "SEALING"). */
    role: text("role").notNull(),
    /** Cents per hour. Integer (per design rule #2: no floats). */
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    /** 1.000 = no burden. 1.300 = 30% burden. precision 5 scale 3
     *  covers 0.000–99.999. */
    burdenMultiplier: numeric("burden_multiplier", { precision: 5, scale: 3 })
      .notNull()
      .default("1.000"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("labor_rates_role_effective_idx").on(t.role, t.effectiveFrom),
  ],
);

/** Order/batch due dates for on-time completion tracking. Without
 *  due targets, the metric layer refuses to compute schedule gap or
 *  on-time-completion KPIs. */
export const dueTargets = pgTable(
  "due_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Loose link — could be a PO, a sales-order ID from Zoho, or
     *  an internal batch number. Free text so we don't constrain
     *  what the user wants to track. */
    referenceKind: text("reference_kind").notNull(),
    referenceId: text("reference_id").notNull(),
    /** What we're trying to deliver. NULL productId = "any product
     *  to satisfy the order quantity". */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    targetQuantity: integer("target_quantity").notNull(),
    /** Same lexicon as stationStandards.outputUnit. */
    targetUnit: text("target_unit").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** 1 = top priority. Higher = lower urgency. */
    priority: integer("priority").notNull().default(50),
    /** Filled when satisfied. NULL while open. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("due_targets_reference_unique").on(t.referenceKind, t.referenceId, t.productId),
    index("due_targets_due_at_idx").on(t.dueAt),
    index("due_targets_open_idx").on(t.completedAt),
  ],
);

// ─── Phase H.x0 — Route / Operation Compatibility Layer ──────────────────────
// Lifts the implicit CARD vs BOTTLE routing into data so future products
// can be configured without enum migrations. Existing enums and projector
// stay unchanged; these tables are read-side until a follow-up phase
// migrates the write side. See docs/PRODUCT_ONBOARDING_AND_EXTENSIBILITY.md.

export const productionRoutes = pgTable(
  "production_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("production_routes_code_unique").on(t.code)],
);

export const operationTypes = pgTable(
  "operation_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    requiresTimer: boolean("requires_timer").notNull().default(false),
    requiresCounter: boolean("requires_counter").notNull().default(false),
    requiresMachine: boolean("requires_machine").notNull().default(false),
    requiresMaterials: boolean("requires_materials").notNull().default(false),
    /** Free-text output unit lexicon (cards, bottles, cases, lots, …).
     *  Mirrors stationStandards.outputUnit / dueTargets.targetUnit. */
    outputUnit: text("output_unit"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("operation_types_code_unique").on(t.code)],
);

export const routeOperations = pgTable(
  "route_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => productionRoutes.id, { onDelete: "cascade" }),
    operationTypeId: uuid("operation_type_id")
      .notNull()
      .references(() => operationTypes.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    /** Stage the bag is in BEFORE this operation runs. Mirrors the
     *  STAGE_KEYS literal in lib/production/types.ts. Stored as text
     *  so a new stage doesn't need a TS literal change to be modeled. */
    stageKey: text("stage_key").notNull(),
    /** Stage the bag advances to once this operation completes. */
    nextStageKey: text("next_stage_key"),
    /** Where rework sends the bag. NULL means no rework path. */
    reworkStageKey: text("rework_stage_key"),
    /** Free-text. Today matches station_kind / machine_kind enum
     *  values; future routes can introduce new kinds without an
     *  enum migration. */
    allowedStationKind: text("allowed_station_kind"),
    allowedMachineKind: text("allowed_machine_kind"),
    requiresScan: boolean("requires_scan").notNull().default(true),
    requiresCounter: boolean("requires_counter").notNull().default(false),
    requiresTimer: boolean("requires_timer").notNull().default(false),
    outputUnit: text("output_unit"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("route_operations_seq_unique").on(t.routeId, t.sequence),
    index("route_operations_route_idx").on(t.routeId, t.sequence),
    index("route_operations_stage_idx").on(t.routeId, t.stageKey),
    index("route_operations_operation_idx").on(t.operationTypeId),
  ],
);

export const productRouteAssignments = pgTable(
  "product_route_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => productionRoutes.id, { onDelete: "restrict" }),
    isDefault: boolean("is_default").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("product_route_assignments_product_idx").on(t.productId, t.isActive),
    index("product_route_assignments_route_idx").on(t.routeId),
  ],
);

export const routeStationPermissions = pgTable(
  "route_station_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeOperationId: uuid("route_operation_id")
      .notNull()
      .references(() => routeOperations.id, { onDelete: "cascade" }),
    stationId: uuid("station_id").references(() => stations.id, {
      onDelete: "cascade",
    }),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "cascade",
    }),
    stationKind: text("station_kind"),
    machineKind: text("machine_kind"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("route_station_permissions_op_idx").on(t.routeOperationId, t.isActive)],
);

export const qualityChecks = pgTable(
  "quality_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Free-text dispatch hint: COUNT_VERIFY, SEAL_INSPECT,
     *  LABEL_VERIFY, DAMAGE_CHECK, WEIGHT_CHECK, PHOTO,
     *  SUPERVISOR_APPROVAL, etc. Foundational only — UI behavior
     *  per check_type lands in a follow-up phase. */
    checkType: text("check_type").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("quality_checks_code_unique").on(t.code)],
);

export const routeQualityChecks = pgTable(
  "route_quality_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeOperationId: uuid("route_operation_id")
      .notNull()
      .references(() => routeOperations.id, { onDelete: "cascade" }),
    qualityCheckId: uuid("quality_check_id")
      .notNull()
      .references(() => qualityChecks.id, { onDelete: "restrict" }),
    isRequired: boolean("is_required").notNull().default(false),
    sequence: integer("sequence").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("route_quality_checks_unique").on(t.routeOperationId, t.qualityCheckId),
    index("route_quality_checks_op_idx").on(t.routeOperationId, t.sequence),
  ],
);

// ─── Phase H.x0.5 — Generic item identity + product structure + Zoho fdtn ──
// `items` is a thin polymorphic registry over the three existing master
// tables (tablet_types, packaging_materials, products). It exists so
// `item_conversions` can express "1 X contains N Y" for any pair of
// items regardless of source — the generic answer to questions today's
// hardcoded products.tablets_per_unit / units_per_display etc. answer.
// See docs/PRODUCT_STRUCTURE_AND_ZOHO_ITEMS.md.

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemCode: text("item_code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** RAW_MATERIAL | PACKAGING_MATERIAL | COMPONENT | INTERMEDIATE_GOOD
     *  | FINISHED_GOOD | SELLABLE_SKU | SERVICE | OTHER. Free-text with
     *  CHECK constraint at DB. */
    itemCategory: text("item_category").notNull(),
    defaultUnitOfMeasure: text("default_unit_of_measure").notNull(),
    /** Polymorphic FK target. Source rows live in tablet_types,
     *  packaging_materials, products, OR null (standalone virtual
     *  intermediates like "blister card before sealing"). */
    sourceKind: text("source_kind"),
    sourceId: uuid("source_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("items_item_code_unique").on(t.itemCode),
    uniqueIndex("items_source_unique").on(t.sourceKind, t.sourceId),
    index("items_category_idx").on(t.itemCategory, t.isActive),
    index("items_source_idx").on(t.sourceKind, t.sourceId),
  ],
);

export const itemConversions = pgTable(
  "item_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    /** Direction: parent (output) contains child (input).
     *  "1 blister card contains 20 tablets" stores card as parent. */
    parentItemId: uuid("parent_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    childItemId: uuid("child_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    parentQuantity: numeric("parent_quantity", { precision: 20, scale: 6 }).notNull(),
    parentUnitOfMeasure: text("parent_unit_of_measure").notNull(),
    parentPackLevel: text("parent_pack_level").notNull(),
    childQuantity: numeric("child_quantity", { precision: 20, scale: 6 }).notNull(),
    childUnitOfMeasure: text("child_unit_of_measure").notNull(),
    childPackLevel: text("child_pack_level").notNull(),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("item_conversions_product_idx").on(t.productId, t.isActive),
    index("item_conversions_route_idx").on(t.routeId),
    index("item_conversions_parent_idx").on(t.parentItemId, t.isActive),
    index("item_conversions_child_idx").on(t.childItemId, t.isActive),
  ],
);

export const externalSystems = pgTable(
  "external_systems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("external_systems_code_unique").on(t.code)],
);

export const externalItemMappings = pgTable(
  "external_item_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalSystemId: uuid("external_system_id")
      .notNull()
      .references(() => externalSystems.id, { onDelete: "cascade" }),
    externalItemId: text("external_item_id").notNull(),
    externalItemCode: text("external_item_code"),
    externalItemName: text("external_item_name"),
    lumaItemId: uuid("luma_item_id").references(() => items.id, {
      onDelete: "set null",
    }),
    lumaProductId: uuid("luma_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    materialItemId: uuid("material_item_id").references(() => packagingMaterials.id, {
      onDelete: "set null",
    }),
    /** Hint about how the upstream item should be classified. UNKNOWN
     *  means undecided — production code that needs the mapping must
     *  surface a "Mapping missing" missing-state. */
    mappingType: text("mapping_type").notNull().default("UNKNOWN"),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_item_mappings_unique").on(t.externalSystemId, t.externalItemId),
    index("external_item_mappings_system_idx").on(t.externalSystemId, t.isActive),
    index("external_item_mappings_luma_item_idx").on(t.lumaItemId),
    index("external_item_mappings_product_idx").on(t.lumaProductId),
  ],
);

export const externalInventorySnapshots = pgTable(
  "external_inventory_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalSystemId: uuid("external_system_id")
      .notNull()
      .references(() => externalSystems.id, { onDelete: "cascade" }),
    externalItemId: text("external_item_id").notNull(),
    itemCode: text("item_code"),
    itemName: text("item_name"),
    quantityOnHand: numeric("quantity_on_hand", { precision: 20, scale: 6 }),
    quantityAvailable: numeric("quantity_available", { precision: 20, scale: 6 }),
    unitOfMeasure: text("unit_of_measure"),
    warehouseName: text("warehouse_name"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("external_inventory_snapshots_system_item_idx").on(
      t.externalSystemId,
      t.externalItemId,
      t.snapshotAt,
    ),
    index("external_inventory_snapshots_at_idx").on(t.snapshotAt),
  ],
);

// ─── Phase H.x3.6 — Raw bag allocation ledger + variety-pack components ───
// Turns inventory_bag from a single-shot consumed flag into a balance
// ledger. A bag can be opened, partially consumed, returned to stock,
// reopened later for a different product. Variety packs require
// multiple raw components (flavors); product_component_requirements
// expresses that BOM at the raw level.

export const rawBagAllocationSessions = pgTable(
  "raw_bag_allocation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryBagId: uuid("inventory_bag_id")
      .notNull()
      .references(() => inventoryBags.id, { onDelete: "cascade" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),
    workflowBagId: uuid("workflow_bag_id").references(() => workflowBags.id, {
      onDelete: "set null",
    }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    finishedLotId: uuid("finished_lot_id").references(() => finishedLots.id, {
      onDelete: "set null",
    }),
    /** Variety-pack slot label. PRIMARY | FLAVOR_A | FLAVOR_B | FLAVOR_C
     *  | COMPONENT | SECONDARY. Free-text — no enum. */
    componentRole: text("component_role"),
    /** OPEN | CLOSED | RETURNED_TO_STOCK | DEPLETED | VOIDED. */
    allocationStatus: text("allocation_status").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startingBalanceQty: integer("starting_balance_qty"),
    startingBalanceSource: text("starting_balance_source"),
    endingBalanceQty: integer("ending_balance_qty"),
    endingBalanceSource: text("ending_balance_source"),
    consumedQty: integer("consumed_qty"),
    consumedQtySource: text("consumed_qty_source"),
    unitOfMeasure: text("unit_of_measure").notNull().default("tablets"),
    confidence: text("confidence").notNull().default("LOW"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rba_sessions_bag_idx").on(t.inventoryBagId, t.openedAt),
    index("rba_sessions_po_idx").on(t.poId),
    index("rba_sessions_product_idx").on(t.productId, t.allocationStatus),
    index("rba_sessions_workflow_idx").on(t.workflowBagId),
  ],
);

export const rawBagAllocationEvents = pgTable(
  "raw_bag_allocation_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    allocationSessionId: uuid("allocation_session_id").references(
      () => rawBagAllocationSessions.id,
      { onDelete: "cascade" },
    ),
    inventoryBagId: uuid("inventory_bag_id")
      .notNull()
      .references(() => inventoryBags.id, { onDelete: "cascade" }),
    workflowBagId: uuid("workflow_bag_id").references(() => workflowBags.id, {
      onDelete: "set null",
    }),
    poId: uuid("po_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    finishedLotId: uuid("finished_lot_id").references(() => finishedLots.id, {
      onDelete: "set null",
    }),
    /** RAW_BAG_OPENED | RAW_BAG_ALLOCATED | RAW_BAG_RETURNED_TO_STOCK
     *  | RAW_BAG_PARTIAL_CONSUMED | RAW_BAG_DEPLETED | RAW_BAG_REWEIGHED
     *  | RAW_BAG_ADJUSTED | RAW_BAG_VOIDED */
    eventType: text("event_type").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    unitOfMeasure: text("unit_of_measure").notNull().default("tablets"),
    /** VENDOR_DECLARED | RECEIVED_WEIGHT_ESTIMATE | MACHINE_COUNTER
     *  | FINISHED_LOT_INPUT | MANUAL_ENTRY | WEIGH_BACK | ESTIMATED | UNKNOWN */
    quantitySource: text("quantity_source"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    confidence: text("confidence").notNull().default("MEDIUM"),
    missingInputs: jsonb("missing_inputs").notNull().default([]),
    clientEventId: uuid("client_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rba_events_bag_idx").on(t.inventoryBagId, t.occurredAt),
    index("rba_events_session_idx").on(t.allocationSessionId),
    index("rba_events_po_idx").on(t.poId),
    index("rba_events_product_idx").on(t.productId),
    index("rba_events_finished_lot_idx").on(t.finishedLotId),
    index("rba_events_type_idx").on(t.eventType, t.occurredAt),
  ],
);

export const productComponentRequirements = pgTable(
  "product_component_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    /** Generic items reference so future raw kinds work without a
     *  migration. For today's variety packs this resolves to a
     *  TABLET_TYPE-source item. */
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    componentRole: text("component_role").notNull(),
    quantityPerFinishedUnit: numeric("quantity_per_finished_unit", {
      precision: 20,
      scale: 6,
    }).notNull(),
    unitOfMeasure: text("unit_of_measure").notNull(),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pcr_product_idx").on(t.productId, t.isActive),
    index("pcr_component_idx").on(t.componentItemId),
  ],
);

// ─── Phase H.x3.5 — Raw-item unit-weight standards ─────────────────────────
// Per-tablet-type unit weight, used to derive an internal
// "our_estimated_count" from received_net_weight when the vendor's
// declaration is missing or suspect. Empty by default. Production
// code surfaces "Unit weight standard missing" when no row exists —
// it never invents a unit weight.

export const rawItemWeightStandards = pgTable(
  "raw_item_weight_standards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tabletTypeId: uuid("tablet_type_id")
      .notNull()
      .references(() => tabletTypes.id, { onDelete: "cascade" }),
    sampleSource: text("sample_source"),
    standardUnitWeight: numeric("standard_unit_weight", {
      precision: 12,
      scale: 6,
    }).notNull(),
    weightUnit: text("weight_unit").notNull().default("g"),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    /** Free-text confidence; the helper layer coerces to the canonical
     *  HIGH/MEDIUM/LOW/MISSING ladder. */
    confidence: text("confidence").notNull().default("MEDIUM"),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("raw_item_weight_standards_lookup_idx").on(
      t.tabletTypeId,
      t.effectiveFrom,
      t.isActive,
    ),
  ],
);

// ─── Phase H.x3 — Learned material usage standard (read model) ─────────────
// Per (product, route, material, role, machine) bucket of empirical
// grams-per-blister samples. Filled by lib/projector/material-usage-
// learning.ts from rolls that have been weighed back. Used as fallback
// when blister_material_standards has no configured row for the same
// (product, role) pair. See docs/PRODUCT_STRUCTURE_AND_ZOHO_ITEMS.md
// for the lexicon (CONFIGURED takes priority over LEARNED).

export const readMaterialUsageLearning = pgTable(
  "read_material_usage_learning",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    routeId: uuid("route_id").references(() => productionRoutes.id, {
      onDelete: "set null",
    }),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    /** "PVC" | "FOIL"; free-text to leave room for new roles. */
    materialRole: text("material_role").notNull(),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    sampleCount: integer("sample_count").notNull().default(0),
    totalBlistersProduced: bigint("total_blisters_produced", { mode: "number" }),
    totalActualWeightUsedGrams: integer("total_actual_weight_used_grams"),
    avgWeightPerBlister: numeric("avg_weight_per_blister", {
      precision: 10,
      scale: 4,
    }),
    medianWeightPerBlister: numeric("median_weight_per_blister", {
      precision: 10,
      scale: 4,
    }),
    p90WeightPerBlister: numeric("p90_weight_per_blister", {
      precision: 10,
      scale: 4,
    }),
    lastSampleAt: timestamp("last_sample_at", { withTimezone: true }),
    /** HIGH ≥ 5 samples, MEDIUM 2–4, LOW = 1, MISSING = 0. */
    confidence: text("confidence").notNull().default("MISSING"),
    missingInputs: jsonb("missing_inputs").notNull().default([]),
    source: text("source").notNull().default("LEARNED"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_material_usage_learning_lookup_idx").on(
      t.packagingMaterialId,
      t.materialRole,
      t.productId,
      t.machineId,
    ),
    index("read_material_usage_learning_product_idx").on(
      t.productId,
      t.materialRole,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 6 — Read models (denormalized projections, refreshed by pg-boss
//                          jobs that listen to workflow_events.pg_notify)
// ─────────────────────────────────────────────────────────────────────────────

/** Current state of every active station. One row per station. */
export const readStationLive = pgTable("read_station_live", {
  stationId: uuid("station_id")
    .primaryKey()
    .references(() => stations.id, { onDelete: "cascade" }),
  currentWorkflowBagId: uuid("current_workflow_bag_id"),
  currentProductId: uuid("current_product_id"),
  currentEmployeeName: text("current_employee_name"),
  lastEventType: text("last_event_type"),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  busyForSeconds: integer("busy_for_seconds"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Per-bag rollup. Drives the "bags in flight" lists. */
export const readBagState = pgTable(
  "read_bag_state",
  {
    workflowBagId: uuid("workflow_bag_id")
      .primaryKey()
      .references(() => workflowBags.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(), // STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED
    productId: uuid("product_id"),
    productName: text("product_name"),
    inventoryBagBatchId: uuid("inventory_bag_batch_id"),
    receiptNumber: text("receipt_number"),
    isFinalized: boolean("is_finalized").notNull().default(false),
    isOnHold: boolean("is_on_hold").notNull().default(false),
    /** Pause/resume state. While paused, cycle-time math should
     *  treat (now - paused_at) as time NOT counted. On resume the
     *  delta gets added to paused_seconds_accum. */
    isPaused: boolean("is_paused").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedSecondsAccum: integer("paused_seconds_accum").notNull().default(0),
    /** Most-recent operator code (4-digit or scanned employee QR).
     *  Optional — system works fine without it; populating
     *  unlocks per-employee performance metrics. */
    currentOperatorCode: text("current_operator_code"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    /** QC-5 flags. Set by lib/projector/qc-events.ts:
     *   - rework_pending: true while an open REWORK_SENT on this bag
     *     has not been fully closed by cumulative REWORK_RECEIVED.
     *   - rework_received: sticky once any REWORK_RECEIVED has fired
     *     for this bag.
     *   - has_correction: sticky once any SUBMISSION_CORRECTED has
     *     landed on any of this bag's events. */
    reworkPending: boolean("rework_pending").notNull().default(false),
    reworkReceived: boolean("rework_received").notNull().default(false),
    hasCorrection: boolean("has_correction").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_bag_state_stage_idx").on(t.stage),
    index("read_bag_state_finalized_idx").on(t.isFinalized),
    index("read_bag_state_paused_idx").on(t.isPaused),
    index("read_bag_state_rework_pending_idx")
      .on(t.reworkPending)
      .where(sql`rework_pending = true`),
  ],
);

/** Daily throughput rollup for fast reports. */
export const readDailyThroughput = pgTable(
  "read_daily_throughput",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    productId: uuid("product_id").references(() => products.id),
    machineId: uuid("machine_id").references(() => machines.id),
    bagsBlistered: integer("bags_blistered").notNull().default(0),
    bagsSealed: integer("bags_sealed").notNull().default(0),
    bagsPackaged: integer("bags_packaged").notNull().default(0),
    bagsFinalized: integer("bags_finalized").notNull().default(0),
    unitsProduced: integer("units_produced").notNull().default(0),
    displaysProduced: integer("displays_produced").notNull().default(0),
    casesProduced: integer("cases_produced").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_daily_throughput_day_product_machine_unique").on(
      t.day,
      t.productId,
      t.machineId,
    ),
    index("read_daily_throughput_day_idx").on(t.day),
  ],
);

/** Per-finalized-bag metrics snapshot. Computed by the projector at
 *  BAG_FINALIZED time by walking the bag's workflow_events, so the
 *  reports / analytics page never has to aggregate over the raw
 *  event stream. Every per-bag stat the system can produce lives
 *  here. */
export const readBagMetrics = pgTable(
  "read_bag_metrics",
  {
    workflowBagId: uuid("workflow_bag_id")
      .primaryKey()
      .references(() => workflowBags.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
    totalSeconds: integer("total_seconds").notNull(),
    pausedSeconds: integer("paused_seconds").notNull().default(0),
    activeSeconds: integer("active_seconds").notNull(),
    blisterSeconds: integer("blister_seconds"),
    sealingSeconds: integer("sealing_seconds"),
    packagingSeconds: integer("packaging_seconds"),
    bottleHandpackSeconds: integer("bottle_handpack_seconds"),
    bottleCapSealSeconds: integer("bottle_cap_seal_seconds"),
    bottleStickerSeconds: integer("bottle_sticker_seconds"),
    /** Time bag spent between BLISTER_COMPLETE and the next stage's
     *  BAG_CLAIMED. Cards: blister → sealing handoff. Bottles: handpack → sticker. */
    staging1Seconds: integer("staging_1_seconds"),
    staging2Seconds: integer("staging_2_seconds"),
    masterCases: integer("master_cases").notNull().default(0),
    displaysMade: integer("displays_made").notNull().default(0),
    looseCards: integer("loose_cards").notNull().default(0),
    damagedPackaging: integer("damaged_packaging").notNull().default(0),
    rippedCards: integer("ripped_cards").notNull().default(0),
    inputPillCount: integer("input_pill_count"),
    unitsYielded: integer("units_yielded").notNull().default(0),
    /** Yield = unitsYielded / inputPillCount, expressed as %. Null
     *  when input wasn't recorded. */
    yieldPct: numeric("yield_pct", { precision: 6, scale: 3 }),
    operatorCodes: text("operator_codes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    machineIds: uuid("machine_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
  },
  (t) => [
    index("read_bag_metrics_finalized_idx").on(t.finalizedAt),
    index("read_bag_metrics_product_idx").on(t.productId),
  ],
);

/** Per-(day, operator) rollup — drives the operator leaderboard
 *  and per-employee productivity stats. Updated at BAG_FINALIZED
 *  time alongside read_bag_metrics.
 *
 *  OP-1E: rows are now keyed by stable employee_id when accountability
 *  resolved. Legacy rows (employee_id null) still key on operator_code.
 *  The CHECK constraint at the DB layer guarantees at least one
 *  identity is set; the two partial unique indexes keep employee-id
 *  rows and code-only rows from colliding. */
export const readOperatorDaily = pgTable(
  "read_operator_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    /** Stable identity. Populated when the bag's accountable employee
     *  was resolved at finalize time. Null only for legacy rows that
     *  carry only a free-text operator_code. */
    employeeId: uuid("employee_id"),
    /** Free-text operator code seen in payload. Optional now — kept
     *  populated alongside employee_id when both are known so legacy
     *  reports keep linking. Required only when employee_id is null. */
    operatorCode: text("operator_code"),
    bagsFinalized: integer("bags_finalized").notNull().default(0),
    activeSecondsTotal: integer("active_seconds_total").notNull().default(0),
    /** Legacy Phase A column. QC-1 adds the canonical QC counters
     *  below; this stays for backward compatibility and will be
     *  retired once no read path depends on it. */
    damageCountTotal: integer("damage_count_total").notNull().default(0),
    /** QC-1 counters. damage_events_total counts PACKAGING_DAMAGE_RETURN
     *  events (one per event, not per unit). rework_sent / received
     *  count their respective events. scrap_units_total sums the
     *  quantity field across SCRAP_RECORDED events. corrections_total
     *  counts SUBMISSION_CORRECTED events whose linked event named
     *  this employee as accountable. */
    damageEventsTotal: integer("damage_events_total").notNull().default(0),
    reworkSentTotal: integer("rework_sent_total").notNull().default(0),
    reworkReceivedTotal: integer("rework_received_total").notNull().default(0),
    scrapUnitsTotal: integer("scrap_units_total").notNull().default(0),
    correctionsTotal: integer("corrections_total").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_operator_daily_day_employee_unique")
      .on(t.day, t.employeeId)
      .where(sql`employee_id IS NOT NULL`),
    uniqueIndex("read_operator_daily_day_code_legacy_unique")
      .on(t.day, t.operatorCode)
      .where(sql`employee_id IS NULL AND operator_code IS NOT NULL`),
    index("read_operator_daily_employee_idx")
      .on(t.employeeId)
      .where(sql`employee_id IS NOT NULL`),
    index("read_operator_daily_day_idx").on(t.day),
  ],
);

/** Per-day material burn — drives "running out of bottles" alerts. */
export const readMaterialBurn = pgTable(
  "read_material_burn",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id),
    qtyConsumed: integer("qty_consumed").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_material_burn_day_material_unique").on(
      t.day,
      t.packagingMaterialId,
    ),
  ],
);

// ─── Phase A read-models (production-intelligence rebuild) ──────────────────
// Note on bag genealogy: the user's spec mentions read_bag_genealogy. We are
// intentionally NOT materialising it. workflow_events is already an append-
// only chronological event stream keyed on workflow_bag_id; selecting
// `where workflow_bag_id = $1 order by occurred_at, id` returns the exact
// genealogy with all metadata (station, machine, operator, payload) preserved.
// A materialised view would just be a duplicate index. Genealogy reads in the
// metric layer go straight at the event log, with sub-millisecond performance
// from the existing workflow_events_bag_idx index.

/** Live per-stage queue snapshot — drives bottleneck detection and the
 *  "oldest waiting bag" KPI. One row per stage. Updated by the projector
 *  on every stage event. Empty when no bags exist in flight. */
export const readQueueState = pgTable(
  "read_queue_state",
  {
    /** "BLISTER_QUEUE" | "POST_BLISTER_STAGING" | "SEALING_QUEUE" |
     *  "POST_SEAL_STAGING" | "PACKAGING_QUEUE" | "BOTTLE_FILL_QUEUE" |
     *  "BOTTLE_STICKER_QUEUE" | "BOTTLE_INDUCTION_QUEUE" |
     *  "FINISHED_GOODS_QUEUE". Stage keys are stable string IDs the UI
     *  maps to localized labels. */
    stageKey: text("stage_key").primaryKey(),
    /** Count of bags currently in this queue/stage. */
    wip: integer("wip").notNull().default(0),
    /** Age in seconds of the oldest bag in this queue. NULL when empty. */
    oldestAgeSeconds: integer("oldest_age_seconds"),
    /** Mean queue age across bags in this stage. NULL when empty. */
    avgAgeSeconds: integer("avg_age_seconds"),
    /** 90th-percentile queue age. NULL when fewer than 5 bags. */
    p90AgeSeconds: integer("p90_age_seconds"),
    /** Bags in this queue older than the configured queue-aging
     *  threshold (default: 4 hours). */
    bagsOverThreshold: integer("bags_over_threshold").notNull().default(0),
    /** "EMPTY" | "FLOWING" | "AGING" | "STALLED" — high-level
     *  status tag the floor board renders as a colored chip. */
    queueStatus: text("queue_status").notNull().default("EMPTY"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/** Per-(day, sku) rollup — drives flavor / SKU analytics. Separates
 *  unit types so display vs case vs tablet aren't ever conflated. */
export const readSkuDaily = pgTable(
  "read_sku_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Denormalized for fast leaderboard rendering. */
    productSku: text("product_sku").notNull(),
    productKind: text("product_kind").notNull(),
    /** Tablets pulled from inventoryBags toward this SKU's bags today. */
    tabletsConsumed: integer("tablets_consumed").notNull().default(0),
    bagsCompleted: integer("bags_completed").notNull().default(0),
    displaysCompleted: integer("displays_completed").notNull().default(0),
    casesCompleted: integer("cases_completed").notNull().default(0),
    bottlesCompleted: integer("bottles_completed").notNull().default(0),
    looseCards: integer("loose_cards").notNull().default(0),
    looseDisplays: integer("loose_displays").notNull().default(0),
    damages: integer("damages").notNull().default(0),
    rework: integer("rework").notNull().default(0),
    scrap: integer("scrap").notNull().default(0),
    /** Average per-bag lead time in seconds across bags finalised today. */
    avgLeadTimeSeconds: integer("avg_lead_time_seconds"),
    /** Average active runtime per bag in seconds across bags finalised today. */
    avgCycleSeconds: integer("avg_cycle_seconds"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_sku_daily_day_product_unique").on(t.day, t.productId),
    index("read_sku_daily_day_idx").on(t.day),
  ],
);

/** Per-bag pill-count reconciliation. Fills out as the bag progresses;
 *  finalised when BAG_FINALIZED fires. Variance is `received - (consumed
 *  + scrap + remaining)`; an estimated flag warns the UI when one of
 *  the components had to be inferred. */
export const readMaterialReconciliation = pgTable(
  "read_material_reconciliation",
  {
    workflowBagId: uuid("workflow_bag_id")
      .primaryKey()
      .references(() => workflowBags.id, { onDelete: "cascade" }),
    receivedQty: integer("received_qty"),
    consumedQty: integer("consumed_qty"),
    finishedQty: integer("finished_qty"),
    scrapQty: integer("scrap_qty"),
    remainingQty: integer("remaining_qty"),
    /** received - consumed - scrap - remaining. Signed: negative
     *  means more output than input (suggests counter error / typo). */
    varianceQty: integer("variance_qty"),
    /** Expressed as percent of receivedQty, signed. Stored numeric to
     *  preserve precision on small bags. */
    variancePct: numeric("variance_pct", { precision: 7, scale: 3 }),
    /** TRUE when at least one component (consumed/scrap/remaining) was
     *  estimated rather than directly recorded. UI must label estimated. */
    isEstimated: boolean("is_estimated").notNull().default(false),
    /** What inputs were missing, comma-separated tags: "consumed",
     *  "remaining", "scrap" — for the UI to label gaps explicitly. */
    missingInputs: text("missing_inputs"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_material_recon_variance_idx").on(t.varianceQty),
    index("read_material_recon_estimated_idx").on(t.isEstimated),
  ],
);

/** PT-6C — 8-bucket reconciliation read model (v2). Coexists with
 *  v1 (`read_material_reconciliation`) until PT-6D switches the UI.
 *  Each row captures one (scope_type, scope_id) snapshot — typically
 *  per packaging_lot. PT-6B's pure helpers compute the bucket values;
 *  this projector persists them so the UI can read without re-walking
 *  the event ledger. */
export const readMaterialReconciliationV2 = pgTable(
  "read_material_reconciliation_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    materialItemId: uuid("material_item_id"),
    packagingLotId: uuid("packaging_lot_id"),
    rawBagId: uuid("raw_bag_id"),
    poId: uuid("po_id"),
    productId: uuid("product_id"),
    unitOfMeasure: text("unit_of_measure").notNull(),

    declaredValue: numeric("declared_value", { precision: 20, scale: 6 }),
    declaredConfidence: text("declared_confidence").notNull(),
    declaredSource: text("declared_source"),
    declaredMissingInputs: jsonb("declared_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    countedValue: numeric("counted_value", { precision: 20, scale: 6 }),
    countedConfidence: text("counted_confidence").notNull(),
    countedSource: text("counted_source"),
    countedMissingInputs: jsonb("counted_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    acceptedValue: numeric("accepted_value", { precision: 20, scale: 6 }),
    acceptedConfidence: text("accepted_confidence").notNull(),
    acceptedSource: text("accepted_source"),
    acceptedMissingInputs: jsonb("accepted_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    consumedEstimatedValue: numeric("consumed_estimated_value", { precision: 20, scale: 6 }),
    consumedEstimatedConfidence: text("consumed_estimated_confidence").notNull(),
    consumedEstimatedSource: text("consumed_estimated_source"),
    consumedEstimatedMissingInputs: jsonb("consumed_estimated_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    consumedActualValue: numeric("consumed_actual_value", { precision: 20, scale: 6 }),
    consumedActualConfidence: text("consumed_actual_confidence").notNull(),
    consumedActualSource: text("consumed_actual_source"),
    consumedActualMissingInputs: jsonb("consumed_actual_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    scrappedOrDamagedValue: numeric("scrapped_or_damaged_value", { precision: 20, scale: 6 }),
    scrappedOrDamagedConfidence: text("scrapped_or_damaged_confidence").notNull(),
    scrappedOrDamagedSource: text("scrapped_or_damaged_source"),
    scrappedOrDamagedMissingInputs: jsonb("scrapped_or_damaged_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    onHandValue: numeric("on_hand_value", { precision: 20, scale: 6 }),
    onHandConfidence: text("on_hand_confidence").notNull(),
    onHandSource: text("on_hand_source"),
    onHandMissingInputs: jsonb("on_hand_missing_inputs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    receiptVarianceValue: numeric("receipt_variance_value", { precision: 20, scale: 6 }),
    receiptVarianceConfidence: text("receipt_variance_confidence").notNull(),
    receiptVarianceSeverity: text("receipt_variance_severity").notNull(),

    cycleCountVarianceValue: numeric("cycle_count_variance_value", { precision: 20, scale: 6 }),
    cycleCountVarianceConfidence: text("cycle_count_variance_confidence").notNull(),
    cycleCountVarianceSeverity: text("cycle_count_variance_severity").notNull(),

    consumptionVarianceValue: numeric("consumption_variance_value", { precision: 20, scale: 6 }),
    consumptionVarianceConfidence: text("consumption_variance_confidence").notNull(),
    consumptionVarianceSeverity: text("consumption_variance_severity").notNull(),

    unknownVarianceValue: numeric("unknown_variance_value", { precision: 20, scale: 6 }),
    unknownVarianceConfidence: text("unknown_variance_confidence").notNull(),
    unknownVarianceSeverity: text("unknown_variance_severity").notNull(),

    overallConfidence: text("overall_confidence").notNull(),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    sourceSnapshot: jsonb("source_snapshot").notNull().default(sql`'{}'::jsonb`),

    calculatedAt: timestamp("calculated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_material_reconciliation_v2_scope_unique").on(
      t.scopeType,
      t.scopeId,
    ),
    index("read_material_reconciliation_v2_material_idx")
      .on(t.materialItemId)
      .where(sql`material_item_id IS NOT NULL`),
    index("read_material_reconciliation_v2_packaging_lot_idx")
      .on(t.packagingLotId)
      .where(sql`packaging_lot_id IS NOT NULL`),
    index("read_material_reconciliation_v2_raw_bag_idx")
      .on(t.rawBagId)
      .where(sql`raw_bag_id IS NOT NULL`),
    index("read_material_reconciliation_v2_po_idx")
      .on(t.poId)
      .where(sql`po_id IS NOT NULL`),
    index("read_material_reconciliation_v2_overall_idx").on(t.overallConfidence),
  ],
);

/** Per-(day, machine, product) quality + unit rollup. Inputs to OEE
 *  Quality and Performance factors. The metric layer reads from
 *  here; OEE refuses to compute until production_calendars and
 *  station_standards exist regardless of how full this table is.
 *
 *  station_id is intentionally nullable: today's projector
 *  attributes outputs at machine granularity (readBagMetrics has
 *  machine_ids[], not station_id per output unit). Phase D / E
 *  may extend the projector to attribute per-station as the floor
 *  workflow gains finer-grained station scans.
 *
 *  Empty by default — populated by the BAG_FINALIZED projector
 *  pathway in lib/projector/station-daily.ts. */
export const readStationQualityDaily = pgTable(
  "read_station_quality_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    stationId: uuid("station_id").references(() => stations.id, {
      onDelete: "cascade",
    }),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "cascade",
    }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** Mirrors stationStandards.output_unit lexicon. */
    outputUnit: text("output_unit").notNull(),
    totalUnits: integer("total_units").notNull().default(0),
    goodUnits: integer("good_units").notNull().default(0),
    rejectUnits: integer("reject_units").notNull().default(0),
    scrapUnits: integer("scrap_units").notNull().default(0),
    reworkUnits: integer("rework_units").notNull().default(0),
    damagedUnits: integer("damaged_units").notNull().default(0),
    /** Active runtime in minutes — computed from stage events of
     *  the relevant kind for this (day, machine). */
    activeMinutes: integer("active_minutes").notNull().default(0),
    /** Planned production minutes — only filled when a production
     *  calendar matches the day. NULL means OEE Availability is
     *  Insufficient data. */
    plannedMinutes: integer("planned_minutes"),
    /** "HIGH" | "MEDIUM" | "LOW" — confidence in the rollup. LOW
     *  surfaces when the projector had to estimate any component. */
    dataConfidence: text("data_confidence").notNull().default("HIGH"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_station_quality_daily_unique").on(
      t.day,
      t.machineId,
      t.productId,
      t.outputUnit,
    ),
    index("read_station_quality_daily_day_idx").on(t.day),
  ],
);

// ─── Phase H read-models ─────────────────────────────────────────

/** Per-lot live state. One row per packaging_lot. Includes both
 *  count-based qty and weight-based qty so the metric layer can
 *  serve roll dashboards and packaging-inventory dashboards from
 *  the same table. confidence reflects how the lot's quantity
 *  was sourced (HIGH = direct measurement, MEDIUM = entered net
 *  weight, LOW = inferred). */
export const readMaterialLotState = pgTable(
  "read_material_lot_state",
  {
    packagingLotId: uuid("packaging_lot_id")
      .primaryKey()
      .references(() => packagingLots.id, { onDelete: "cascade" }),
    packagingMaterialId: uuid("packaging_material_id").notNull(),
    materialKind: text("material_kind").notNull(),
    lotNumber: text("lot_number"),
    rollNumber: text("roll_number"),
    status: materialLotStatusEnum("status").notNull(),
    initialQuantity: integer("initial_quantity"),
    currentQuantityEstimate: integer("current_quantity_estimate"),
    initialWeightGrams: integer("initial_weight_grams"),
    currentWeightGramsEstimate: integer("current_weight_grams_estimate"),
    unitOfMeasure: text("unit_of_measure").notNull(),
    consumedEstimated: integer("consumed_estimated").notNull().default(0),
    consumedActual: integer("consumed_actual"),
    adjustedQuantity: integer("adjusted_quantity").notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    confidence: text("confidence").notNull().default("HIGH"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_material_lot_state_status_idx").on(t.status),
    index("read_material_lot_state_material_idx").on(t.packagingMaterialId),
  ],
);

/** Per-(day, material, lot, product, machine) consumption rollup.
 *  Drives the inventory burn-down dashboards + variance reports. */
export const readMaterialConsumptionDaily = pgTable(
  "read_material_consumption_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    packagingLotId: uuid("packaging_lot_id").references(
      () => packagingLots.id,
      { onDelete: "set null" },
    ),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    stationId: uuid("station_id").references(() => stations.id, {
      onDelete: "set null",
    }),
    estimatedConsumedUnits: integer("estimated_consumed_units").notNull().default(0),
    actualConsumedUnits: integer("actual_consumed_units"),
    estimatedConsumedGrams: integer("estimated_consumed_grams").notNull().default(0),
    actualConsumedGrams: integer("actual_consumed_grams"),
    unitOfMeasure: text("unit_of_measure").notNull(),
    varianceQty: integer("variance_qty"),
    variancePct: numeric("variance_pct", { precision: 7, scale: 3 }),
    confidence: text("confidence").notNull().default("MEDIUM"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_material_consumption_daily_unique").on(
      t.day,
      t.packagingMaterialId,
      t.packagingLotId,
      t.productId,
      t.machineId,
    ),
    index("read_material_consumption_daily_day_idx").on(t.day),
  ],
);

/** Per-roll usage projection. One row per roll lot. Drives the
 *  Active Rolls + Roll Variance panels. */
export const readRollUsage = pgTable(
  "read_roll_usage",
  {
    packagingLotId: uuid("packaging_lot_id")
      .primaryKey()
      .references(() => packagingLots.id, { onDelete: "cascade" }),
    rollNumber: text("roll_number"),
    materialKind: text("material_kind").notNull(),
    materialRole: text("material_role"),
    machineId: uuid("machine_id").references(() => machines.id, {
      onDelete: "set null",
    }),
    mountedAt: timestamp("mounted_at", { withTimezone: true }),
    unmountedAt: timestamp("unmounted_at", { withTimezone: true }),
    startingWeightGrams: integer("starting_weight_grams"),
    endingWeightGrams: integer("ending_weight_grams"),
    expectedUsedGrams: integer("expected_used_grams"),
    actualUsedGrams: integer("actual_used_grams"),
    varianceGrams: integer("variance_grams"),
    variancePct: numeric("variance_pct", { precision: 7, scale: 3 }),
    blistersProduced: integer("blisters_produced"),
    projectedRemainingGrams: integer("projected_remaining_grams"),
    projectedBlistersRemaining: integer("projected_blisters_remaining"),
    confidence: text("confidence").notNull().default("MEDIUM"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("read_roll_usage_machine_idx").on(t.machineId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit log (every write goes here)
// ─────────────────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorRole: userRoleEnum("actor_role"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_action_idx").on(t.action),
    index("audit_log_created_idx").on(t.createdAt),
  ],
);

/** PT-7C — PackTrack shortage recommendations read model.
 *  One row per (material × product-or-shared). Rebuilt by
 *  lib/projector/packtrack-recommendations.ts using the PT-7B
 *  pure helpers. PT-7D's /material-alerts page reads this; PT-7E
 *  may eventually post sendable rows to PackTrack's inbox. */
export const readMaterialRecommendations = pgTable(
  "read_material_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recommendationId: uuid("recommendation_id").notNull().defaultRandom(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => packagingMaterials.id, { onDelete: "cascade" }),
    materialCode: text("material_code").notNull(),
    materialName: text("material_name").notNull(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    productName: text("product_name"),
    productSku: text("product_sku"),
    compatibilityRole: text("compatibility_role"),
    currentOnHand: numeric("current_on_hand", { precision: 20, scale: 6 }),
    acceptedInventory: numeric("accepted_inventory", { precision: 20, scale: 6 }),
    projectedDemand: numeric("projected_demand", { precision: 20, scale: 6 }),
    projectedShortageQuantity: numeric("projected_shortage_quantity", {
      precision: 20,
      scale: 6,
    }),
    recommendedOrderQuantity: numeric("recommended_order_quantity", {
      precision: 20,
      scale: 6,
    }),
    neededByDate: date("needed_by_date"),
    confidence: text("confidence").notNull(),
    severity: text("severity").notNull(),
    reason: text("reason").notNull(),
    sourceSignals: jsonb("source_signals").notNull().default(sql`'[]'::jsonb`),
    missingInputs: jsonb("missing_inputs").notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    sendableToPackTrack: boolean("sendable_to_packtrack").notNull().default(false),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    lastSendError: text("last_send_error"),
    /** PT-7E — outbound bookkeeping. Populated by
     *  sendMaterialRecommendationToPackTrackAction on success. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastSentResponse: jsonb("last_sent_response"),
    /** Self-FK applied via SQL — drizzle's typed builder can't
     *  express the self-reference cleanly here. Index below. */
    supersededBy: uuid("superseded_by"),
    recommendedSupplierHint: text("recommended_supplier_hint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("read_material_recommendations_recommendation_id_unique").on(
      t.recommendationId,
    ),
    uniqueIndex("read_material_recommendations_active_product_unique")
      .on(t.materialId, t.productId)
      .where(
        sql`product_id IS NOT NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL AND superseded_by IS NULL`,
      ),
    uniqueIndex("read_material_recommendations_active_material_unique")
      .on(t.materialId)
      .where(
        sql`product_id IS NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL AND superseded_by IS NULL`,
      ),
    index("read_material_recommendations_material_idx").on(t.materialId),
    index("read_material_recommendations_product_idx")
      .on(t.productId)
      .where(sql`product_id IS NOT NULL`),
    index("read_material_recommendations_material_code_idx").on(t.materialCode),
    index("read_material_recommendations_confidence_idx").on(t.confidence),
    index("read_material_recommendations_severity_idx").on(t.severity),
    index("read_material_recommendations_sendable_idx")
      .on(t.sendableToPackTrack)
      .where(sql`sendable_to_packtrack = true`),
    index("read_material_recommendations_generated_idx").on(t.generatedAt),
    index("read_material_recommendations_expires_idx")
      .on(t.expiresAt)
      .where(sql`expires_at IS NOT NULL`),
    index("read_material_recommendations_sent_idx")
      .on(t.sentAt)
      .where(sql`sent_at IS NOT NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// LOT-1B — Finished Lot / Recall Passport schema
// ─────────────────────────────────────────────────────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerCode: text("customer_code").notNull(),
    name: text("name").notNull(),
    zohoCustomerId: text("zoho_customer_id"),
    nexusCustomerId: text("nexus_customer_id"),
    supplierLotVisible: boolean("supplier_lot_visible")
      .notNull()
      .default(false),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("customers_customer_code_unique").on(t.customerCode),
    index("customers_zoho_idx")
      .on(t.zohoCustomerId)
      .where(sql`zoho_customer_id IS NOT NULL`),
    index("customers_nexus_idx")
      .on(t.nexusCustomerId)
      .where(sql`nexus_customer_id IS NOT NULL`),
    index("customers_active_idx")
      .on(t.active)
      .where(sql`active = true`),
  ],
);

export const finishedLotRawBags = pgTable(
  "finished_lot_raw_bags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    inventoryBagId: uuid("inventory_bag_id")
      .notNull()
      .references(() => inventoryBags.id, { onDelete: "restrict" }),
    workflowBagId: uuid("workflow_bag_id").references(() => workflowBags.id, {
      onDelete: "set null",
    }),
    quantityConsumedPills: integer("quantity_consumed_pills"),
    quantityConsumedWeight: numeric("quantity_consumed_weight", {
      precision: 20,
      scale: 6,
    }),
    weightUnit: text("weight_unit"),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    derivedFromEventId: uuid("derived_from_event_id").references(
      () => workflowEvents.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("finished_lot_raw_bags_triple_unique").on(
      t.finishedLotId,
      t.inventoryBagId,
      t.workflowBagId,
    ),
    index("finished_lot_raw_bags_lot_idx").on(t.finishedLotId),
    index("finished_lot_raw_bags_bag_idx").on(t.inventoryBagId),
    index("finished_lot_raw_bags_workflow_idx")
      .on(t.workflowBagId)
      .where(sql`workflow_bag_id IS NOT NULL`),
    index("finished_lot_raw_bags_confidence_idx").on(t.confidence),
  ],
);

export const finishedLotOutputs = pgTable(
  "finished_lot_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    outputType: text("output_type").notNull(),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull().default("each"),
    traceCodePrinted: text("trace_code_printed"),
    printPayload: jsonb("print_payload").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("finished_lot_outputs_lot_idx").on(t.finishedLotId),
    index("finished_lot_outputs_type_idx").on(t.outputType),
    index("finished_lot_outputs_trace_printed_idx")
      .on(t.traceCodePrinted)
      .where(sql`trace_code_printed IS NOT NULL`),
  ],
);

export const finishedLotPackagingLots = pgTable(
  "finished_lot_packaging_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    packagingLotId: uuid("packaging_lot_id")
      .notNull()
      .references(() => packagingLots.id, { onDelete: "restrict" }),
    materialId: uuid("material_id").references(() => packagingMaterials.id, {
      onDelete: "set null",
    }),
    quantityUsed: numeric("quantity_used", { precision: 20, scale: 6 }),
    unit: text("unit"),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("finished_lot_packaging_lots_unique").on(
      t.finishedLotId,
      t.packagingLotId,
    ),
    index("finished_lot_packaging_lots_lot_idx").on(t.finishedLotId),
    index("finished_lot_packaging_lots_lot_pkg_idx").on(t.packagingLotId),
    index("finished_lot_packaging_lots_material_idx")
      .on(t.materialId)
      .where(sql`material_id IS NOT NULL`),
  ],
);

export const finishedLotQcEvents = pgTable(
  "finished_lot_qc_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    workflowEventId: uuid("workflow_event_id")
      .notNull()
      .references(() => workflowEvents.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("finished_lot_qc_events_pair_unique").on(
      t.finishedLotId,
      t.workflowEventId,
    ),
    index("finished_lot_qc_events_lot_idx").on(t.finishedLotId),
    index("finished_lot_qc_events_type_idx").on(t.eventType),
    index("finished_lot_qc_events_occurred_idx").on(t.occurredAt),
  ],
);

export const shipmentFinishedLots = pgTable(
  "shipment_finished_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    quantity: integer("quantity"),
    unit: text("unit"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    notes: text("notes"),
    /** LOT-1G — Nexus send-state. Populated by
     *  sendFinishedLotToNexusAction. */
    nexusSentAt: timestamp("nexus_sent_at", { withTimezone: true }),
    nexusLastSentResponse: jsonb("nexus_last_sent_response"),
    nexusLastSendError: text("nexus_last_send_error"),
    /** COMMERCIAL-TRACE-2 — invoice allocation state. UNALLOCATED until
     *  the allocation engine (COMMERCIAL-TRACE-4) writes a row in
     *  finished_lot_invoice_allocations referencing this shipment-lot
     *  pair. Free-text so future statuses (e.g. PARTIALLY_ALLOCATED)
     *  don't force an enum migration. */
    invoiceAllocationStatus: text("invoice_allocation_status")
      .notNull()
      .default("UNALLOCATED"),
    lastInvoiceAllocationAt: timestamp("last_invoice_allocation_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_finished_lots_pair_unique").on(
      t.shipmentId,
      t.finishedLotId,
    ),
    index("shipment_finished_lots_shipment_idx").on(t.shipmentId),
    index("shipment_finished_lots_lot_idx").on(t.finishedLotId),
    index("shipment_finished_lots_customer_idx")
      .on(t.customerId)
      .where(sql`customer_id IS NOT NULL`),
    index("shipment_finished_lots_nexus_sent_at_idx")
      .on(t.nexusSentAt)
      .where(sql`nexus_sent_at IS NOT NULL`),
    index("shipment_finished_lots_invoice_allocation_status_idx").on(
      t.invoiceAllocationStatus,
    ),
    index("shipment_finished_lots_last_invoice_allocation_at_idx")
      .on(t.lastInvoiceAllocationAt)
      .where(sql`last_invoice_allocation_at IS NOT NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// COMMERCIAL-TRACE-2 — Zoho invoice ingest + finished-lot allocation
// ─────────────────────────────────────────────────────────────────────────────
//
// The hinge between Zoho commercial truth and Luma physical truth:
//   invoice number → invoice line → product/SKU/Zoho item
//   → finished_lot(s) → shipment_finished_lot → recall passport
//
// Schema-only phase. No engine, no live Zoho calls, no UI. Visibility
// (owner decision 2026-05-15) is enforced at the API edge via
// lib/production/commercial-trace.ts — customer scope NEVER exposes
// supplier lot, internal receipt number, raw bag QR, operator names,
// or machine/station accountability.

export const zohoInvoices = pgTable(
  "zoho_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** External Zoho identifier (text). Source of truth for cross-sync
     *  identity — same Zoho invoice always maps to the same row. */
    zohoInvoiceId: text("zoho_invoice_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    zohoCustomerId: text("zoho_customer_id"),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    invoiceDate: date("invoice_date"),
    status: text("status"),
    currency: text("currency"),
    subtotal: numeric("subtotal", { precision: 20, scale: 4 }),
    total: numeric("total", { precision: 20, scale: 4 }),
    balance: numeric("balance", { precision: 20, scale: 4 }),
    /** Verbatim Zoho payload — kept for replay + audit. */
    rawPayload: jsonb("raw_payload").notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("zoho_invoices_zoho_invoice_id_unique").on(t.zohoInvoiceId),
    index("zoho_invoices_invoice_number_idx").on(t.invoiceNumber),
    index("zoho_invoices_zoho_customer_id_idx")
      .on(t.zohoCustomerId)
      .where(sql`zoho_customer_id IS NOT NULL`),
    index("zoho_invoices_customer_id_idx")
      .on(t.customerId)
      .where(sql`customer_id IS NOT NULL`),
    index("zoho_invoices_invoice_date_idx")
      .on(t.invoiceDate)
      .where(sql`invoice_date IS NOT NULL`),
    index("zoho_invoices_status_idx")
      .on(t.status)
      .where(sql`status IS NOT NULL`),
  ],
);

export const zohoInvoiceLines = pgTable(
  "zoho_invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** UUID FK to the parent zoho_invoices(id). Naming follows the
     *  COMMERCIAL-TRACE-2 spec verbatim; not to be confused with the
     *  parent's `zoho_invoice_id` text column (Zoho's external id). */
    zohoInvoiceId: uuid("zoho_invoice_id")
      .notNull()
      .references(() => zohoInvoices.id, { onDelete: "cascade" }),
    /** Zoho's line-item identifier. Nullable for legacy/manually-imported
     *  invoices that pre-date the line-id field. */
    zohoInvoiceLineId: text("zoho_invoice_line_id"),
    zohoItemId: text("zoho_item_id"),
    sku: text("sku"),
    itemName: text("item_name").notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unit: text("unit"),
    rate: numeric("rate", { precision: 20, scale: 6 }),
    amount: numeric("amount", { precision: 20, scale: 4 }),
    rawPayload: jsonb("raw_payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("zoho_invoice_lines_invoice_idx").on(t.zohoInvoiceId),
    index("zoho_invoice_lines_line_id_idx")
      .on(t.zohoInvoiceLineId)
      .where(sql`zoho_invoice_line_id IS NOT NULL`),
    index("zoho_invoice_lines_item_id_idx")
      .on(t.zohoItemId)
      .where(sql`zoho_item_id IS NOT NULL`),
    index("zoho_invoice_lines_sku_idx")
      .on(t.sku)
      .where(sql`sku IS NOT NULL`),
    /** Partial unique so a Zoho upsert is idempotent on (parent, line-id)
     *  when Zoho supplies a line-id; legacy lines without one are
     *  tolerated. */
    uniqueIndex("zoho_invoice_lines_invoice_line_id_unique")
      .on(t.zohoInvoiceId, t.zohoInvoiceLineId)
      .where(sql`zoho_invoice_line_id IS NOT NULL`),
  ],
);

export const finishedLotInvoiceAllocations = pgTable(
  "finished_lot_invoice_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceLineId: uuid("invoice_line_id")
      .notNull()
      .references(() => zohoInvoiceLines.id, { onDelete: "cascade" }),
    finishedLotId: uuid("finished_lot_id")
      .notNull()
      .references(() => finishedLots.id, { onDelete: "cascade" }),
    shipmentFinishedLotId: uuid("shipment_finished_lot_id").references(
      () => shipmentFinishedLots.id,
      { onDelete: "set null" },
    ),
    /** Positive only (CHECK constraint enforced in migration 0036).
     *  numeric so partial allocations across multiple finished lots
     *  preserve full precision. */
    quantityAllocated: numeric("quantity_allocated", {
      precision: 20,
      scale: 6,
    }).notNull(),
    unit: text("unit"),
    /** Free-text confidence band — HIGH / MEDIUM / LOW / MISSING.
     *  Free-text so future bands extend without an enum migration; see
     *  lib/production/commercial-trace.ts for the vocabulary. */
    confidence: text("confidence").notNull(),
    /** Free-text source — 'PACK_OUT_SCAN', 'ENGINE_SHIPMENT', 'MANUAL',
     *  'ZOHO_IMPORT', etc. */
    source: text("source").notNull(),
    /** Free-text status — SUGGESTED / CONFIRMED / REJECTED /
     *  NEEDS_REVIEW. SUGGESTED is the default from the allocation
     *  engine; CONFIRMED requires explicit operator action. */
    status: text("status").notNull().default("SUGGESTED"),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedByUserId: uuid("confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("finished_lot_invoice_allocations_line_idx").on(t.invoiceLineId),
    index("finished_lot_invoice_allocations_lot_idx").on(t.finishedLotId),
    index("finished_lot_invoice_allocations_shipment_lot_idx")
      .on(t.shipmentFinishedLotId)
      .where(sql`shipment_finished_lot_id IS NOT NULL`),
    index("finished_lot_invoice_allocations_confidence_idx").on(t.confidence),
    index("finished_lot_invoice_allocations_source_idx").on(t.source),
    index("finished_lot_invoice_allocations_status_idx").on(t.status),
    index("finished_lot_invoice_allocations_confirmed_idx").on(t.confirmed),
    index("finished_lot_invoice_allocations_confirmed_at_idx")
      .on(t.confirmedAt)
      .where(sql`confirmed_at IS NOT NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types for the rest of the codebase
// ─────────────────────────────────────────────────────────────────────────────

export type Company = typeof companies.$inferSelect;
export type User = typeof users.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type TabletType = typeof tabletTypes.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type Station = typeof stations.$inferSelect;
export type StationOperatorSession = typeof stationOperatorSessions.$inferSelect;
export type ReadMaterialReconciliationV2 = typeof readMaterialReconciliationV2.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PoLine = typeof poLines.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type Receive = typeof receives.$inferSelect;
export type SmallBox = typeof smallBoxes.$inferSelect;
export type InventoryBag = typeof inventoryBags.$inferSelect;
export type PackagingMaterial = typeof packagingMaterials.$inferSelect;
export type ProductPackagingSpec = typeof productPackagingSpecs.$inferSelect;
export type PackagingLot = typeof packagingLots.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type BatchHold = typeof batchHolds.$inferSelect;
export type FinishedLot = typeof finishedLots.$inferSelect;
export type FinishedLotInput = typeof finishedLotInputs.$inferSelect;
export type QrCard = typeof qrCards.$inferSelect;
export type WorkflowBag = typeof workflowBags.$inferSelect;
export type WorkflowEvent = typeof workflowEvents.$inferSelect;
export type ZohoPush = typeof zohoPushes.$inferSelect;
export type ReadStationLive = typeof readStationLive.$inferSelect;
export type ReadBagState = typeof readBagState.$inferSelect;
export type ReadDailyThroughput = typeof readDailyThroughput.$inferSelect;
export type ReadMaterialBurn = typeof readMaterialBurn.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type RawItemWeightStandard = typeof rawItemWeightStandards.$inferSelect;
export type RawBagAllocationSession = typeof rawBagAllocationSessions.$inferSelect;
export type RawBagAllocationEvent = typeof rawBagAllocationEvents.$inferSelect;
export type ProductComponentRequirement = typeof productComponentRequirements.$inferSelect;
export type ReadMaterialUsageLearning = typeof readMaterialUsageLearning.$inferSelect;
export type Item = typeof items.$inferSelect;
export type ItemConversion = typeof itemConversions.$inferSelect;
export type ExternalSystem = typeof externalSystems.$inferSelect;
export type ExternalItemMapping = typeof externalItemMappings.$inferSelect;
export type ExternalInventorySnapshot = typeof externalInventorySnapshots.$inferSelect;
export type ProductionRoute = typeof productionRoutes.$inferSelect;
export type OperationType = typeof operationTypes.$inferSelect;
export type RouteOperation = typeof routeOperations.$inferSelect;
export type ProductRouteAssignment = typeof productRouteAssignments.$inferSelect;
export type RouteStationPermission = typeof routeStationPermissions.$inferSelect;
export type QualityCheck = typeof qualityChecks.$inferSelect;
export type RouteQualityCheck = typeof routeQualityChecks.$inferSelect;
// COMMERCIAL-TRACE-2 — Zoho invoice ingest + allocation tables.
export type ZohoInvoice = typeof zohoInvoices.$inferSelect;
export type ZohoInvoiceLine = typeof zohoInvoiceLines.$inferSelect;
export type FinishedLotInvoiceAllocation =
  typeof finishedLotInvoiceAllocations.$inferSelect;
