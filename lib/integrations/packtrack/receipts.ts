// PT-3: PackTrack -> Luma packaging-receipt contract.
//
// PackTrack owns packaging procurement and receiving. When PackTrack
// receives a box, it sends a payload to Luma's webhook (or a manual
// receiver invokes importPackTrackPackagingReceipt directly during
// QA). Luma resolves the material via external_item_mappings,
// computes accepted_quantity + confidence, and writes one
// packaging_lots row + matching material_inventory_events rows.
//
// Strict invariants:
//   - Inventory IS NOT decremented from PackTrack input. Only
//     production consumption decrements.
//   - Idempotent on (packtrack_receipt_id, box_number). Re-import is
//     a no-op (returns the existing lot row).
//   - Unmapped material is rejected — never auto-creates "trusted"
//     inventory under a fabricated material id.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
  externalSystems,
  externalItemMappings,
  users,
} from "@/lib/db/schema";
import {
  computeAcceptance,
  classifyVarianceSeverity,
  type AcceptanceResult,
} from "@/lib/inbound/packaging-receipt";

// ── Wire-format payload from PackTrack ────────────────────────────

export const packTrackReceiptPayloadSchema = z.object({
  source_system: z.literal("PACKTRACK"),
  packtrack_po_id: z.string().min(1),
  packtrack_receipt_id: z.string().min(1),
  material_code: z.string().min(1),
  material_name: z.string().optional().nullable(),
  supplier: z.string().optional().nullable(),
  supplier_lot_number: z.string().optional().nullable(),
  box_number: z.string().min(1),
  declared_quantity: z.number().int().nonnegative(),
  counted_quantity: z.number().int().nonnegative().optional().nullable(),
  unit_of_measure: z.string().min(1),
  received_at: z.string(), // ISO-8601
  received_by: z.string().optional().nullable(), // user email or external id
  payload: z.unknown().optional(),
});

export type PackTrackPackagingReceiptPayload = z.infer<
  typeof packTrackReceiptPayloadSchema
>;

export type ValidationResult =
  | { ok: true; data: PackTrackPackagingReceiptPayload }
  | { ok: false; reason: string; issues?: unknown };

export function validatePackTrackReceiptPayload(
  raw: unknown,
): ValidationResult {
  const parsed = packTrackReceiptPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "Invalid PackTrack receipt payload.",
      issues: parsed.error.issues,
    };
  }
  // declared and counted both null is rejected — must have at least
  // one usable quantity. Import path may relax this; webhook does not.
  const dq = parsed.data.declared_quantity;
  const cq = parsed.data.counted_quantity ?? null;
  if (dq == null && cq == null) {
    return {
      ok: false,
      reason: "declared_quantity or counted_quantity must be present.",
    };
  }
  return { ok: true, data: parsed.data };
}

// ── Material mapping ──────────────────────────────────────────────

export type MaterialMappingResult =
  | {
      ok: true;
      materialId: string;
      materialName: string;
      externalSystemId: string;
    }
  | { ok: false; reason: string };

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Resolve PackTrack material_code → Luma packaging_materials.id via
 *  external_item_mappings. Returns a clear "Mapping missing" error
 *  rather than silently auto-creating inventory under a guessed
 *  material id. */
export async function mapPackTrackMaterialToLuma(
  tx: Tx,
  materialCode: string,
): Promise<MaterialMappingResult> {
  const [system] = await tx
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, "PACKTRACK"));
  if (!system) {
    return {
      ok: false,
      reason:
        "external_systems row for PACKTRACK is missing — supervisor must register the integration first.",
    };
  }
  const [mapping] = await tx
    .select({
      materialItemId: externalItemMappings.materialItemId,
    })
    .from(externalItemMappings)
    .where(
      and(
        eq(externalItemMappings.externalSystemId, system.id),
        eq(externalItemMappings.externalItemId, materialCode),
        eq(externalItemMappings.isActive, true),
      ),
    );
  if (!mapping?.materialItemId) {
    return {
      ok: false,
      reason: `external_item_mappings missing for material_code=${materialCode} — supervisor must map it before receipts can flow.`,
    };
  }
  const [mat] = await tx
    .select({ id: packagingMaterials.id, name: packagingMaterials.name })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, mapping.materialItemId));
  if (!mat) {
    return {
      ok: false,
      reason: `Mapped packaging_materials row not found for material_code=${materialCode}.`,
    };
  }
  return {
    ok: true,
    materialId: mat.id,
    materialName: mat.name,
    externalSystemId: system.id,
  };
}

// ── Idempotent upsert ─────────────────────────────────────────────

export type ImportOutcome =
  | {
      ok: true;
      lotId: string;
      created: boolean; // true when this call inserted; false on idempotent re-import
      acceptance: AcceptanceResult;
      eventsEmitted: string[];
    }
  | { ok: false; reason: string };

/** Insert (or short-circuit on duplicate) a packaging_lots row from
 *  a PackTrack payload, and emit the matching material_inventory_
 *  events rows in the same DB transaction.
 *
 *  Idempotent on (packtrack_receipt_id, box_number) — guaranteed by
 *  the partial unique index in migration 0021. A second call with
 *  the same key returns the existing lot row without writing.
 */
export async function upsertPackagingLotFromPackTrackReceipt(
  tx: Tx,
  args: {
    materialId: string;
    payload: PackTrackPackagingReceiptPayload;
    receivedByUserId?: string | null;
  },
): Promise<ImportOutcome> {
  const { materialId, payload } = args;

  // Idempotency: did we already import this (receipt, box) pair?
  const existing = await tx
    .select({
      id: packagingLots.id,
      acceptedQuantity: packagingLots.acceptedQuantity,
      declaredQuantity: packagingLots.declaredQuantity,
      countedQuantity: packagingLots.countedQuantity,
      confidence: packagingLots.confidence,
    })
    .from(packagingLots)
    .where(
      and(
        eq(packagingLots.packtrackReceiptId, payload.packtrack_receipt_id),
        eq(packagingLots.boxNumber, payload.box_number),
      ),
    )
    .limit(1);
  const prior = existing[0];
  if (prior) {
    return {
      ok: true,
      lotId: prior.id,
      created: false,
      acceptance: {
        acceptedQuantity: prior.acceptedQuantity ?? null,
        confidence:
          (prior.confidence as AcceptanceResult["confidence"]) ?? "MISSING",
        hasVariance:
          prior.declaredQuantity != null &&
          prior.countedQuantity != null &&
          prior.declaredQuantity !== prior.countedQuantity,
        variance:
          prior.declaredQuantity != null && prior.countedQuantity != null
            ? prior.countedQuantity - prior.declaredQuantity
            : null,
      },
      eventsEmitted: [],
    };
  }

  const acceptance = computeAcceptance({
    declaredQuantity: payload.declared_quantity,
    countedQuantity: payload.counted_quantity ?? null,
    source: "PACKTRACK",
  });
  if (acceptance.acceptedQuantity == null) {
    return {
      ok: false,
      reason: "Receipt has no usable declared or counted quantity.",
    };
  }

  // Resolve received_by_user_id (best-effort by email; null when not
  // matched — operator can attribute later).
  let receivedByUserId: string | null = args.receivedByUserId ?? null;
  if (!receivedByUserId && payload.received_by) {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, payload.received_by));
    receivedByUserId = u?.id ?? null;
  }

  const receivedAt = new Date(payload.received_at);

  // TODO(PACKAGING-RECONCILIATION-SLICE-C): call applyReceiptAttribution here
  // once source-system guard PM decision is made for PackTrack lots.

  const [inserted] = await tx
    .insert(packagingLots)
    .values({
      packagingMaterialId: materialId,
      qtyReceived: acceptance.acceptedQuantity, // back-compat
      qtyOnHand: acceptance.acceptedQuantity,
      receivedAt,
      supplier: payload.supplier ?? null,
      status: "AVAILABLE",
      confidence: acceptance.confidence,
      declaredQuantity: payload.declared_quantity,
      countedQuantity: payload.counted_quantity ?? null,
      acceptedQuantity: acceptance.acceptedQuantity,
      boxNumber: payload.box_number,
      supplierLotNumber: payload.supplier_lot_number ?? null,
      packtrackPoId: payload.packtrack_po_id,
      packtrackReceiptId: payload.packtrack_receipt_id,
      sourceSystem: "PACKTRACK",
      receivedByUserId,
    })
    .returning({ id: packagingLots.id });
  if (!inserted) {
    return { ok: false, reason: "Insert returned no lot id." };
  }
  const lotId = inserted.id;
  const eventsEmitted: string[] = [];

  // 1. MATERIAL_RECEIVED — generic ledger entry.
  await tx.insert(materialInventoryEvents).values({
    eventType: "MATERIAL_RECEIVED",
    packagingMaterialId: materialId,
    packagingLotId: lotId,
    actorUserId: receivedByUserId,
    quantityUnits: acceptance.acceptedQuantity,
    unitOfMeasure: payload.unit_of_measure,
    occurredAt: receivedAt,
    payload: {
      source: "packtrack.import",
      packtrack_po_id: payload.packtrack_po_id,
      packtrack_receipt_id: payload.packtrack_receipt_id,
      box_number: payload.box_number,
    },
    source: "packtrack.import",
  });
  eventsEmitted.push("MATERIAL_RECEIVED");

  // 2. PACKAGING_BOX_RECEIVED — declared from supplier label.
  await tx.insert(materialInventoryEvents).values({
    eventType: "PACKAGING_BOX_RECEIVED",
    packagingMaterialId: materialId,
    packagingLotId: lotId,
    actorUserId: receivedByUserId,
    quantityUnits: payload.declared_quantity,
    unitOfMeasure: payload.unit_of_measure,
    occurredAt: receivedAt,
    payload: {
      source_system: "PACKTRACK",
      packtrack_po_id: payload.packtrack_po_id,
      packtrack_receipt_id: payload.packtrack_receipt_id,
      box_number: payload.box_number,
      declared_quantity: payload.declared_quantity,
      supplier_lot_number: payload.supplier_lot_number ?? null,
    },
    source: "packtrack.import",
  });
  eventsEmitted.push("PACKAGING_BOX_RECEIVED");

  // 3. PACKAGING_BOX_COUNTED — only when counted_quantity present.
  if (payload.counted_quantity != null) {
    await tx.insert(materialInventoryEvents).values({
      eventType: "PACKAGING_BOX_COUNTED",
      packagingMaterialId: materialId,
      packagingLotId: lotId,
      actorUserId: receivedByUserId,
      quantityUnits: payload.counted_quantity,
      unitOfMeasure: payload.unit_of_measure,
      occurredAt: receivedAt,
      payload: {
        box_number: payload.box_number,
        counted_quantity: payload.counted_quantity,
        prior_declared_quantity: payload.declared_quantity,
        variance: payload.counted_quantity - payload.declared_quantity,
      },
      source: "packtrack.import",
    });
    eventsEmitted.push("PACKAGING_BOX_COUNTED");
  }

  // 4. PACKAGING_VARIANCE_RECORDED — only when counted ≠ declared.
  if (acceptance.hasVariance && acceptance.variance != null) {
    await tx.insert(materialInventoryEvents).values({
      eventType: "PACKAGING_VARIANCE_RECORDED",
      packagingMaterialId: materialId,
      packagingLotId: lotId,
      actorUserId: receivedByUserId,
      quantityUnits: Math.abs(acceptance.variance),
      unitOfMeasure: payload.unit_of_measure,
      occurredAt: receivedAt,
      payload: {
        declared_quantity: payload.declared_quantity,
        counted_quantity: payload.counted_quantity,
        variance: acceptance.variance,
        variance_pct:
          payload.declared_quantity > 0
            ? acceptance.variance / payload.declared_quantity
            : null,
        severity: classifyVarianceSeverity({
          variance: acceptance.variance,
          declared: payload.declared_quantity,
        }),
        kind: "RECEIPT_VARIANCE", // explicitly NOT production loss
      },
      source: "packtrack.import",
    });
    eventsEmitted.push("PACKAGING_VARIANCE_RECORDED");
  }

  return { ok: true, lotId, created: true, acceptance, eventsEmitted };
}

// ── Top-level orchestration ───────────────────────────────────────

export type ImportPackTrackReceiptResult =
  | {
      ok: true;
      lotId: string;
      created: boolean;
      acceptance: AcceptanceResult;
      eventsEmitted: string[];
    }
  | { ok: false; reason: string; code: "INVALID" | "MAPPING_MISSING" | "INSERT_FAILED" };

/** Runs validation + mapping + idempotent upsert in a single
 *  caller-provided transaction. The HTTP route or manual-import
 *  script wraps this. */
export async function importPackTrackPackagingReceipt(
  tx: Tx,
  args: {
    rawPayload: unknown;
    receivedByUserId?: string | null;
  },
): Promise<ImportPackTrackReceiptResult> {
  const validation = validatePackTrackReceiptPayload(args.rawPayload);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, code: "INVALID" };
  }
  const mapping = await mapPackTrackMaterialToLuma(
    tx,
    validation.data.material_code,
  );
  if (!mapping.ok) {
    return { ok: false, reason: mapping.reason, code: "MAPPING_MISSING" };
  }
  const upsert = await upsertPackagingLotFromPackTrackReceipt(tx, {
    materialId: mapping.materialId,
    payload: validation.data,
    ...(args.receivedByUserId != null
      ? { receivedByUserId: args.receivedByUserId }
      : {}),
  });
  if (!upsert.ok) {
    return { ok: false, reason: upsert.reason, code: "INSERT_FAILED" };
  }
  return {
    ok: true,
    lotId: upsert.lotId,
    created: upsert.created,
    acceptance: upsert.acceptance,
    eventsEmitted: upsert.eventsEmitted,
  };
}
