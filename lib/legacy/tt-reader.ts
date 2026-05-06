// TabletTracker SQLite reader. Opens a (gzipped) .db file via sql.js
// and exposes typed iterators for every table we care about. Pure-JS
// — no native build step, works the same in Docker as it does in dev.
//
// We load the entire DB into memory because it's 1.1 MB on the live
// system; the simplicity is worth the modest memory cost.

import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic | null = null;

/** Locate sql-wasm.wasm without relying on import.meta.url (which
 *  Next.js bundles into a numeric module ID, breaking createRequire).
 *  We try a few well-known paths in order — first hit wins. Covers
 *  both Next dev (cwd = repo root) and Next standalone (cwd = /app). */
function findWasmPath(): string {
  const candidates = [
    join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    "/app/node_modules/sql.js/dist/sql-wasm.wasm",
    join(process.cwd(), ".next", "standalone", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `sql-wasm.wasm not found. Tried: ${candidates.join(", ")}. ` +
      "If running in a non-standard layout, ensure sql.js is installed " +
      "and adjust findWasmPath() accordingly.",
  );
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  const wasmBinary = await readFile(findWasmPath());
  const ab = wasmBinary.buffer.slice(
    wasmBinary.byteOffset,
    wasmBinary.byteOffset + wasmBinary.byteLength,
  ) as ArrayBuffer;
  SQL = await initSqlJs({ wasmBinary: ab });
  return SQL;
}

export async function openTtDb(filePath: string): Promise<Database> {
  const sqlJs = await loadSqlJs();
  let bytes = await readFile(filePath);
  // Auto-gunzip if the path ends with .gz OR the magic bytes match.
  if (
    filePath.endsWith(".gz") ||
    (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
  ) {
    bytes = gunzipSync(bytes);
  }
  return new sqlJs.Database(bytes);
}

/** Run a SELECT and yield rows as plain objects. */
export function selectAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
): T[] {
  const out: T[] = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) {
    out.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return out;
}

/** Read row counts for every user table. Useful for the importer's
 *  pre-flight summary. */
export function tableCounts(db: Database): Record<string, number> {
  const tables = selectAll<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = selectAll<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM "${name}"`,
    );
    out[name] = row?.n ?? 0;
  }
  return out;
}

// ── Typed row shapes ──────────────────────────────────────────────
//
// Field shapes match the .schema output captured 2026-05-06. SQLite
// returns numbers for INTEGER / REAL columns and strings for TEXT;
// nullable columns can come back as null. We coerce dates / booleans
// at the importer layer rather than here.

export type TtTabletType = {
  id: number;
  tablet_type_name: string;
  inventory_item_id: string | null;
  category: string | null;
  category_id: number | null;
  is_variety_pack: number | null;
  tablets_per_bottle: number | null;
  bottles_per_pack: number | null;
  variety_pack_contents: string | null;
  is_bottle_only: number | null;
};

export type TtProductDetails = {
  id: number;
  product_name: string;
  tablet_type_id: number | null;
  packages_per_display: number | null;
  tablets_per_package: number | null;
  is_bottle_product: number | null;
  is_variety_pack: number | null;
  tablets_per_bottle: number | null;
  bottles_per_display: number | null;
  variety_pack_contents: string | null;
  category: string | null;
  displays_per_case: number | null;
};

export type TtProductAllowedTabletType = {
  id: number;
  product_details_id: number;
  tablet_type_id: number;
};

export type TtMachine = {
  id: number;
  machine_name: string;
  cards_per_turn: number;
  is_active: number | null;
  machine_role: string;
  area_name: string | null;
  machine_category: string | null;
  raw_materials_json: string | null;
  components_json: string | null;
  compressor_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type TtCompressor = {
  id: number;
  compressor_name: string;
  status: string;
  machine_id: number | null;
  notes: string | null;
  is_active: number;
  created_at: number | null;
  updated_at: number | null;
  cost: number | null;
  tank_size: string | null;
};

export type TtWorkflowStation = {
  id: number;
  station_scan_token: string;
  label: string;
  station_code: string | null;
  machine_id: number | null;
  station_kind: string | null;
};

export type TtQrCard = {
  id: number;
  label: string | null;
  scan_token: string;
  status: string;
  assigned_workflow_bag_id: number | null;
};

export type TtEmployee = {
  id: number;
  username: string;
  full_name: string;
  password_hash: string;
  is_active: number | null;
  preferred_language: string | null;
  role: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type TtPurchaseOrder = {
  id: number;
  po_number: string;
  zoho_po_id: string | null;
  tablet_type: string | null;
  zoho_status: string | null;
  ordered_quantity: number;
  current_good_count: number;
  current_damaged_count: number;
  remaining_quantity: number;
  closed: number;
  internal_status: string | null;
  parent_po_number: string | null;
  machine_good_count: number;
  machine_damaged_count: number;
  vendor_id: string | null;
  vendor_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type TtPoLine = {
  id: number;
  po_id: number;
  po_number: string | null;
  inventory_item_id: string;
  line_item_name: string | null;
  quantity_ordered: number;
  good_count: number;
  damaged_count: number;
  machine_good_count: number;
  machine_damaged_count: number;
  zoho_line_item_id: string | null;
  created_at: string | null;
};

export type TtShipment = {
  id: number;
  po_id: number | null;
  tracking_number: string | null;
  carrier: string | null;
  carrier_code: string | null;
  shipped_date: string | null;
  estimated_delivery: string | null;
  actual_delivery: string | null;
  tracking_status: string | null;
  last_checkpoint: string | null;
  delivered_at: string | null;
  last_checked_at: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type TtReceiving = {
  id: number;
  po_id: number | null;
  shipment_id: number | null;
  received_date: string | null;
  delivery_photo_path: string | null;
  delivery_photo_zoho_id: string | null;
  total_small_boxes: number | null;
  received_by: string | null;
  notes: string | null;
  receive_name: string | null;
  closed: number | null;
  status: string | null;
  created_at: string | null;
};

export type TtSmallBox = {
  id: number;
  receiving_id: number | null;
  box_number: number | null;
  total_bags: number | null;
  notes: string | null;
  batch_number_default: string | null;
  created_at: string | null;
};

export type TtBag = {
  id: number;
  small_box_id: number | null;
  bag_number: number | null;
  bag_label_count: number | null;
  pill_count: number | null;
  status: string | null;
  tablet_type_id: number | null;
  zoho_receive_pushed: number;
  zoho_receive_id: string | null;
  zoho_receive_overs_id: string | null;
  reserved_for_bottles: number | null;
  batch_number: string | null;
  batch_source: string | null;
  bag_weight_kg: number | null;
  estimated_tablets_from_weight: number | null;
  created_at: string | null;
};

export type TtWorkflowBag = {
  id: number;
  created_at: number; // ms epoch
  product_id: number | null;
  box_number: string | null;
  bag_number: string | null;
  receipt_number: string | null;
  inventory_bag_id: number | null;
};

export type TtWorkflowEvent = {
  id: number;
  event_type: string;
  payload: string;
  occurred_at: number; // ms epoch
  workflow_bag_id: number;
  station_id: number | null;
  user_id: number | null;
  device_id: string | null;
};

export type TtWarehouseSubmission = {
  id: number;
  // 30+ columns; we read everything as a generic record and let the
  // importer JSON-stash the entire row. A few well-known fields are
  // pulled out for indexing:
  submission_type: string | null;
  bag_id: number | null;
  employee_name: string | null;
  created_at: string | null;
  // Catch-all for the rest:
  [key: string]: unknown;
};

export type TtMachineCount = {
  id: number;
  tablet_type_id: number | null;
  machine_count: number;
  employee_name: string;
  count_date: string;
  machine_id: number | null;
  box_number: string | null;
  bag_number: string | null;
  created_at: string | null;
};

export type TtSubmissionBagDeduction = {
  id: number;
  submission_id: number;
  bag_id: number;
  tablets_deducted: number;
  created_at: string | null;
};

export type TtBlisterRoll = {
  id: number;
  machine_id: number;
  material_type: string;
  roll_code: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  start_press_count: number;
  end_press_count: number | null;
  blisters_per_press: number;
  total_blisters: number | null;
  status: string;
};

export type TtPoDamageCloseoutLine = {
  id: number;
  po_id: number;
  po_line_id: number;
  inventory_item_id: string | null;
  damage_weight_kg: number | null;
  estimated_damaged_tablets: number | null;
  grams_per_tablet: number | null;
  weight_missing: number;
  weight_source: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
};

export type TtAppSetting = {
  id: number;
  setting_key: string;
  setting_value: string;
  description: string | null;
  updated_at: string | null;
};
