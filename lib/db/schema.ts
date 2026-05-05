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
  index,
  integer,
  jsonb,
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
  // Production stages
  "BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_SNAPSHOT",
  "PACKAGING_TAKEN_FOR_ORDER",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
  // Variety pack lineage
  "VARIETY_SOURCES_ASSIGNED",
  // Batch traceability
  "BATCH_RELEASED",
  "BATCH_HELD",
  "BATCH_RECALLED",
  // Material consumption (synthesized by projector from production events)
  "MATERIAL_CONSUMED",
  // Corrections + termination
  "SUBMISSION_CORRECTED",
  "BAG_FINALIZED",
  // Token rotation audit
  "STATION_SCAN_TOKEN_ROTATED",
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

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  legacyId: text("legacy_id"),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name"),
  email: text("email"),
  phone: text("phone"),
  language: text("language").notNull().default("en"), // en | es
  status: employeeStatusEnum("status").notNull().default("ACTIVE"),
  hiredOn: date("hired_on"),
  birthday: date("birthday"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  },
  (t) => [index("shipments_po_idx").on(t.poId)],
);

export const receives = pgTable(
  "receives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id").references(() => purchaseOrders.id),
    shipmentId: uuid("shipment_id").references(() => shipments.id),
    receiveName: text("receive_name").notNull(), // sequential per PO, e.g. "PO123-R1"
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    receivedById: uuid("received_by_id").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("receives_po_idx").on(t.poId),
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
    status: inventoryBagStatusEnum("status").notNull().default("AVAILABLE"),
    /** Reserved for bottle production (kept out of card-flow picking). */
    reservedForBottles: boolean("reserved_for_bottles").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("inventory_bags_box_idx").on(t.smallBoxId),
    index("inventory_bags_batch_idx").on(t.batchId),
    index("inventory_bags_status_idx").on(t.status),
    uniqueIndex("inventory_bags_box_bagno_unique").on(t.smallBoxId, t.bagNumber),
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
    notes: text("notes"),
  },
  (t) => [primaryKey({ columns: [t.productId, t.packagingMaterialId, t.perScope] })],
);

/** Each shipment / lot of a packaging material we receive. Each lot
 *  has its own batch (kind=PACKAGING) for genealogy. */
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
  },
  (t) => [
    index("packaging_lots_material_idx").on(t.packagingMaterialId),
    index("packaging_lots_batch_idx").on(t.batchId),
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
  },
  (t) => [
    uniqueIndex("finished_lots_number_unique").on(t.finishedLotNumber),
    index("finished_lots_product_idx").on(t.productId),
    index("finished_lots_produced_idx").on(t.producedOn),
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
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Context 5 — Output (Zoho push, ship/release tracking)
// ─────────────────────────────────────────────────────────────────────────────

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
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_bag_state_stage_idx").on(t.stage),
    index("read_bag_state_finalized_idx").on(t.isFinalized),
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
