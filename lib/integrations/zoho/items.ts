// Phase H.x0.5 — Zoho item / inventory foundation (stubs).
//
// Defines the contract for the eventual Zoho item-catalog sync. No
// live API calls. Each function throws ZohoNotConfiguredError until a
// follow-up phase wires the real client.
//
// Companion docs: docs/ZOHO_ITEM_SYNC_PLAN.md.
//
// Once implemented, calls go through lib/zoho/client.ts (which already
// handles OAuth + per-company creds for the existing Zoho push flow).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  externalInventorySnapshots,
  externalItemMappings,
  externalSystems,
} from "@/lib/db/schema";

export class ZohoNotConfiguredError extends Error {
  constructor(message = "Zoho API not configured.") {
    super(message);
    this.name = "ZohoNotConfiguredError";
  }
}

export type ZohoItemSummary = {
  externalItemId: string;
  externalItemCode: string;
  externalItemName: string;
  unitOfMeasure: string;
  itemType?: string;
  /** Raw Zoho payload preserved verbatim for downstream debugging. */
  raw: Record<string, unknown>;
};

export type ZohoInventorySnapshot = {
  externalItemId: string;
  itemCode: string;
  itemName: string;
  quantityOnHand: number;
  quantityAvailable: number;
  unitOfMeasure: string;
  warehouseName: string | null;
  raw: Record<string, unknown>;
};

export type ExternalItemMappingType =
  | "RAW_MATERIAL"
  | "PACKAGING_MATERIAL"
  | "COMPONENT"
  | "INTERMEDIATE_GOOD"
  | "FINISHED_GOOD"
  | "SELLABLE_SKU"
  | "UNKNOWN";

// ── Live API stubs ─────────────────────────────────────────────────
//
// These call out to Zoho. In H.x0.5 they are deliberately stubs —
// invoking them throws a structured "not configured" error so callers
// can render a friendly setup hint. The eventual implementation will
// reuse lib/zoho/client.ts patterns (per-company OAuth, retries).

export async function listZohoItems(
  _opts: { page?: number; perPage?: number } = {},
): Promise<ZohoItemSummary[]> {
  throw new ZohoNotConfiguredError(
    "Zoho item sync not implemented yet. See docs/ZOHO_ITEM_SYNC_PLAN.md.",
  );
}

export async function listZohoInventorySnapshots(
  _opts: { page?: number; perPage?: number } = {},
): Promise<ZohoInventorySnapshot[]> {
  throw new ZohoNotConfiguredError(
    "Zoho inventory sync not implemented yet. See docs/ZOHO_ITEM_SYNC_PLAN.md.",
  );
}

// ── DB-backed mapping helpers (safe to call without Zoho creds) ────

/** Resolve the external_systems.id for the ZOHO seeded row. Returns
 *  null if migration 0014 hasn't run. Pure DB lookup; safe in tests. */
export async function getZohoSystemId(): Promise<string | null> {
  const [row] = await db
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, "ZOHO"))
    .limit(1);
  return row?.id ?? null;
}

/** Upsert an external_item_mappings row. The (system_id, external_item_id)
 *  unique constraint takes care of duplicate detection. */
export async function upsertExternalItemMapping(input: {
  externalSystemCode: string;
  externalItemId: string;
  externalItemCode?: string;
  externalItemName?: string;
  lumaItemId?: string;
  lumaProductId?: string;
  materialItemId?: string;
  mappingType?: ExternalItemMappingType;
  payload?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const [system] = await db
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, input.externalSystemCode))
    .limit(1);
  if (!system) return null;

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO "external_item_mappings"
      (external_system_id, external_item_id, external_item_code,
       external_item_name, luma_item_id, luma_product_id, material_item_id,
       mapping_type, payload, last_synced_at, updated_at)
    VALUES (
      ${system.id},
      ${input.externalItemId},
      ${input.externalItemCode ?? null},
      ${input.externalItemName ?? null},
      ${input.lumaItemId ?? null},
      ${input.lumaProductId ?? null},
      ${input.materialItemId ?? null},
      ${input.mappingType ?? "UNKNOWN"},
      ${sql.raw(`'${JSON.stringify(input.payload ?? {})}'::jsonb`)},
      now(),
      now()
    )
    ON CONFLICT (external_system_id, external_item_id)
    DO UPDATE SET
      external_item_code = EXCLUDED.external_item_code,
      external_item_name = EXCLUDED.external_item_name,
      luma_item_id       = COALESCE(EXCLUDED.luma_item_id, external_item_mappings.luma_item_id),
      luma_product_id    = COALESCE(EXCLUDED.luma_product_id, external_item_mappings.luma_product_id),
      material_item_id   = COALESCE(EXCLUDED.material_item_id, external_item_mappings.material_item_id),
      mapping_type       = EXCLUDED.mapping_type,
      payload            = EXCLUDED.payload,
      last_synced_at     = EXCLUDED.last_synced_at,
      updated_at         = EXCLUDED.updated_at
    RETURNING id
  `);
  const list = result as unknown as Array<{ id: string }>;
  return list[0] ?? null;
}

/** Append-only inventory snapshot. Used by sync job in a follow-up
 *  phase. Calling this never mutates Luma genealogy — it only stores
 *  what Zoho reported, with full payload. */
export async function recordExternalInventorySnapshot(input: {
  externalSystemCode: string;
  externalItemId: string;
  itemCode?: string;
  itemName?: string;
  quantityOnHand?: number | null;
  quantityAvailable?: number | null;
  unitOfMeasure?: string | null;
  warehouseName?: string | null;
  payload?: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const [system] = await db
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, input.externalSystemCode))
    .limit(1);
  if (!system) return null;

  const inserted = await db
    .insert(externalInventorySnapshots)
    .values({
      externalSystemId: system.id,
      externalItemId: input.externalItemId,
      itemCode: input.itemCode ?? null,
      itemName: input.itemName ?? null,
      quantityOnHand:
        input.quantityOnHand != null ? String(input.quantityOnHand) : null,
      quantityAvailable:
        input.quantityAvailable != null ? String(input.quantityAvailable) : null,
      unitOfMeasure: input.unitOfMeasure ?? null,
      warehouseName: input.warehouseName ?? null,
      payload: input.payload ?? {},
    })
    .returning({ id: externalInventorySnapshots.id });
  return inserted[0] ?? null;
}

/** Pure helper: classify a Zoho item summary into a Luma item_category
 *  suggestion. Conservative — returns UNKNOWN unless the Zoho item
 *  type is unambiguous. Admin must confirm before the mapping becomes
 *  authoritative. */
export function mapZohoItemToLumaItem(
  zohoItem: ZohoItemSummary,
): ExternalItemMappingType {
  const raw = (zohoItem.itemType ?? "").toLowerCase();
  if (raw.includes("inventory") && raw.includes("sales")) return "SELLABLE_SKU";
  if (raw.includes("inventory")) return "FINISHED_GOOD";
  if (raw.includes("packaging")) return "PACKAGING_MATERIAL";
  if (raw.includes("raw")) return "RAW_MATERIAL";
  if (raw.includes("component")) return "COMPONENT";
  if (raw.includes("intermediate")) return "INTERMEDIATE_GOOD";
  return "UNKNOWN";
}
