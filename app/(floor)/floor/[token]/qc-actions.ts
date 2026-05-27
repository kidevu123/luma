"use server";

// QC-2 — floor-side QC server actions.
//
// Three event types fire from the floor PWA:
//   - reportPackagingDamageAction → PACKAGING_DAMAGE_RETURN
//   - reworkSentAction            → REWORK_SENT
//   - reworkReceivedAction        → REWORK_RECEIVED
//
// Each action:
//   - Validates input shape with zod.
//   - Authorizes the station via the URL scan token (matches the OP-1C
//     floor-PWA contract — actions are anonymous but station-bound).
//   - Resolves accountability through resolveStationAccountability:
//     active operator session wins; per-form supervisor override is
//     allowed; refuses to fire when no employee_id resolves and no
//     LEGACY_TEXT fallback was supplied.
//   - Builds the payload to match the QC-1 contract in
//     lib/production/qc-events.ts and runs it through that module's
//     validator as a defense-in-depth check before projectEvent.
//   - For events covered by the workflow_events_linked_event_resolution
//     _unique partial-unique (REWORK_SENT linked to a source), the
//     action takes a FOR UPDATE lock on the source row inside the
//     transaction so concurrent supervisors converting the same damage
//     return cannot both land. The DB partial-unique is the backstop.
//
// No UI is wired yet — QC-3 builds the floor surface. The actions are
// safe to call from any client that supplies a valid station scan
// token in the form (matches existing floor-PWA pattern).

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations, workflowEvents } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  validateQcPayload,
  type PackagingDamageReturnPayload,
  type ReworkSentPayload,
  type ReworkReceivedPayload,
  type QCReasonCode,
  type QCUnit,
} from "@/lib/production/qc-events";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StationRow = typeof stations.$inferSelect;

async function resolveStation(token: string): Promise<StationRow | null> {
  if (!UUID_RE.test(token)) return null;
  const [row] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  return row ?? null;
}

async function authStation(
  token: string,
  stationIdFromForm: string,
): Promise<StationRow> {
  const station = await resolveStation(token);
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) throw new Error("Station mismatch.");
  return station;
}

type ActionResult = { ok?: true; conflict?: true; error?: string };

// ─── Shared form-field schemas ─────────────────────────────────────────

const optionalCoercedJsonArray = z
  .string()
  .max(2000)
  .optional()
  .nullable()
  .transform((raw): string[] | null => {
    if (raw == null || raw.trim().length === 0) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
        return v as string[];
      }
      return null;
    } catch {
      return null;
    }
  });

const baseFloorFields = {
  token: z.string(),
  stationId: z.string().uuid(),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  bagId: z.string().uuid(),
  quantity: z.coerce.number().int().positive(),
  unit: z.string().min(1).max(40),
  reasonCode: z.string().min(1).max(40),
  notes: z.string().max(2000).optional().nullable(),
  photoKeys: optionalCoercedJsonArray,
  overrideEmployeeCode: z.string().max(40).optional().nullable(),
} as const;

// ─── Pre-check helper: assert no conflicting resolution exists ─────────
//
// The migration's partial-unique key
// workflow_events_linked_event_resolution_unique
// only constrains event_type IN ('SCRAP_RECORDED','REWORK_SENT'). Pre-
// checking against the source row's id avoids two supervisors landing
// scrap on the same damage return. FOR UPDATE on the source serializes
// concurrent attempts at the DB level; the partial-unique is the
// final backstop if a row commits between our SELECT and our INSERT.
async function assertNoLinkedConflict(
  tx: Parameters<typeof projectEvent>[0],
  linkedEventId: string,
  eventType: "SCRAP_RECORDED" | "REWORK_SENT",
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Lock the source row so concurrent conversions wait until our tx
  // commits. The source must exist — otherwise the link is bogus.
  const source = await tx.execute(
    sql`SELECT id FROM workflow_events WHERE id = ${linkedEventId} FOR UPDATE`,
  );
  if ((source as unknown as Array<unknown>).length === 0) {
    return { ok: false, reason: "Linked event not found." };
  }
  const dup = await tx.execute(
    sql`SELECT 1 FROM workflow_events
        WHERE payload->>'linked_event_id' = ${linkedEventId}
          AND event_type = ${eventType}::workflow_event_type
        LIMIT 1`,
  );
  if ((dup as unknown as Array<unknown>).length > 0) {
    return {
      ok: false,
      reason: `Source event already has a ${eventType} resolution.`,
    };
  }
  return { ok: true };
}

// ─── 1. reportPackagingDamageAction → PACKAGING_DAMAGE_RETURN ──────────

const damageSchema = z.object({
  ...baseFloorFields,
  productId: z.string().uuid().optional().nullable(),
  machineId: z.string().uuid().optional().nullable(),
  materialLotId: z.string().uuid().optional().nullable(),
  packagingLotId: z.string().uuid().optional().nullable(),
  dispositionSuggestion: z
    .enum(["SCRAP", "REWORK", "INSPECT"])
    .optional()
    .nullable(),
});

export async function reportPackagingDamageAction(
  formData: FormData,
): Promise<ActionResult> {
  const parsed = damageSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    clientEventId: formData.get("clientEventId"),
    bagId: formData.get("bagId"),
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    notes: formData.get("notes") || null,
    photoKeys: formData.get("photoKeys") || null,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || null,
    productId: formData.get("productId") || null,
    machineId: formData.get("machineId") || null,
    materialLotId: formData.get("materialLotId") || null,
    packagingLotId: formData.get("packagingLotId") || null,
    dispositionSuggestion: formData.get("dispositionSuggestion") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  try {
    const station = await authStation(input.token, input.stationId);
    const result = await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: station.id,
        overrideEmployeeCode: input.overrideEmployeeCode ?? null,
      });
      if (!accountability.accountabilitySource) {
        return {
          error:
            "No operator on shift. Open a shift on this station before reporting damage.",
        } as ActionResult;
      }

      const payload: PackagingDamageReturnPayload = {
        client_event_id: input.clientEventId,
        quantity: input.quantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: input.photoKeys ?? null,
        bag_id: input.bagId,
        product_id: input.productId ?? null,
        station_id: station.id,
        machine_id: input.machineId ?? null,
        material_lot_id: input.materialLotId ?? null,
        packaging_lot_id: input.packagingLotId ?? null,
        damage_type: input.reasonCode as QCReasonCode,
        disposition_suggestion: input.dispositionSuggestion ?? null,
        // Damage is packaging-material loss by definition. Raw-product
        // damage is opt-in (operator-supplied flag, optional via the
        // future floor UI). Defaults preserve the QC-0 contract.
        affects_packaging_material: true,
        affects_raw_product: false,
        accountable_employee_id: accountability.accountableEmployeeId,
        accountability_source: accountability.accountabilitySource,
        accountable_employee_name_snapshot:
          accountability.accountableEmployeeNameSnapshot ?? "",
        entered_by_user_id: accountability.enteredByUserId,
      };
      const v = validateQcPayload("PACKAGING_DAMAGE_RETURN", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }
      await projectEvent(tx, {
        workflowBagId: input.bagId,
        stationId: station.id,
        eventType: "PACKAGING_DAMAGE_RETURN",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
        enteredByUserId: accountability.enteredByUserId,
      });
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.qc.packaging_damage",
          targetType: "WorkflowBag",
          targetId: input.bagId,
          after: {
            station_id: station.id,
            reason_code: input.reasonCode,
            quantity: input.quantity,
            unit: input.unit,
            accountable_employee_id: accountability.accountableEmployeeId,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath(`/floor/${input.token}`);
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

// ─── 2. reworkSentAction → REWORK_SENT ─────────────────────────────────

const reworkSentSchema = z.object({
  ...baseFloorFields,
  fromStationId: z.string().uuid().optional().nullable(),
  toStationId: z.string().uuid().optional().nullable(),
  linkedEventId: z.string().uuid().optional().nullable(),
  expectedReturnQuantity: z.coerce.number().int().positive().optional().nullable(),
});

export async function reworkSentAction(
  formData: FormData,
): Promise<ActionResult> {
  const parsed = reworkSentSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    clientEventId: formData.get("clientEventId"),
    bagId: formData.get("bagId"),
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    notes: formData.get("notes") || null,
    photoKeys: formData.get("photoKeys") || null,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || null,
    fromStationId: formData.get("fromStationId") || null,
    toStationId: formData.get("toStationId") || null,
    linkedEventId: formData.get("linkedEventId") || null,
    expectedReturnQuantity: formData.get("expectedReturnQuantity") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  try {
    const station = await authStation(input.token, input.stationId);
    const result = await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: station.id,
        overrideEmployeeCode: input.overrideEmployeeCode ?? null,
      });
      if (!accountability.accountabilitySource) {
        return {
          error:
            "No operator on shift. Open a shift on this station before sending rework.",
        } as ActionResult;
      }

      // If we're linking to a source event, prevent double-conversion.
      if (input.linkedEventId) {
        const guard = await assertNoLinkedConflict(
          tx,
          input.linkedEventId,
          "REWORK_SENT",
        );
        if (!guard.ok) {
          return { conflict: true, error: guard.reason } as ActionResult;
        }
      }

      const payload: ReworkSentPayload = {
        client_event_id: input.clientEventId,
        quantity: input.quantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: input.photoKeys ?? null,
        bag_id: input.bagId,
        from_station_id: input.fromStationId ?? station.id,
        to_station_id: input.toStationId ?? null,
        linked_event_id: input.linkedEventId ?? null,
        rework_reason: input.reasonCode as QCReasonCode,
        expected_return_quantity: input.expectedReturnQuantity ?? null,
        accountable_employee_id: accountability.accountableEmployeeId,
        accountability_source: accountability.accountabilitySource,
        accountable_employee_name_snapshot:
          accountability.accountableEmployeeNameSnapshot ?? "",
        entered_by_user_id: accountability.enteredByUserId,
      };
      const v = validateQcPayload("REWORK_SENT", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }
      await projectEvent(tx, {
        workflowBagId: input.bagId,
        stationId: station.id,
        eventType: "REWORK_SENT",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
        enteredByUserId: accountability.enteredByUserId,
      });
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.qc.rework_sent",
          targetType: "WorkflowBag",
          targetId: input.bagId,
          after: {
            station_id: station.id,
            reason_code: input.reasonCode,
            quantity: input.quantity,
            unit: input.unit,
            linked_event_id: input.linkedEventId ?? null,
            accountable_employee_id: accountability.accountableEmployeeId,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath(`/floor/${input.token}`);
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

// ─── 3. reworkReceivedAction → REWORK_RECEIVED ─────────────────────────
//
// linked_event_id is REQUIRED — a receive must point at the REWORK_SENT
// it acknowledges. Not constrained by the partial-unique (partial
// receives may legitimately stack), so no FOR-UPDATE conflict guard;
// the action only verifies the linked REWORK_SENT exists.

const reworkReceivedSchema = z.object({
  ...baseFloorFields,
  fromStationId: z.string().uuid().optional().nullable(),
  toStationId: z.string().uuid().optional().nullable(),
  linkedEventId: z.string().uuid(),
  receivedQuantity: z.coerce.number().int().positive(),
  partial: z
    .string()
    .transform((s) => s === "true" || s === "1" || s === "on"),
});

export async function reworkReceivedAction(
  formData: FormData,
): Promise<ActionResult> {
  const parsed = reworkReceivedSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    clientEventId: formData.get("clientEventId"),
    bagId: formData.get("bagId"),
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    notes: formData.get("notes") || null,
    photoKeys: formData.get("photoKeys") || null,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || null,
    fromStationId: formData.get("fromStationId") || null,
    toStationId: formData.get("toStationId") || null,
    linkedEventId: formData.get("linkedEventId"),
    receivedQuantity: formData.get("receivedQuantity"),
    partial: (formData.get("partial") as string) ?? "false",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  try {
    const station = await authStation(input.token, input.stationId);
    const result = await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: station.id,
        overrideEmployeeCode: input.overrideEmployeeCode ?? null,
      });
      if (!accountability.accountabilitySource) {
        return {
          error:
            "No operator on shift. Open a shift on this station before receiving rework.",
        } as ActionResult;
      }

      // Verify the linked REWORK_SENT exists. Not a conflict check —
      // partial receives may legitimately stack.
      const linked = await tx.execute(
        sql`SELECT id FROM workflow_events
            WHERE id = ${input.linkedEventId}
              AND event_type = 'REWORK_SENT'
            LIMIT 1`,
      );
      if ((linked as unknown as Array<unknown>).length === 0) {
        return {
          error: "Linked REWORK_SENT event not found.",
        } as ActionResult;
      }

      const payload: ReworkReceivedPayload = {
        client_event_id: input.clientEventId,
        quantity: input.quantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: input.photoKeys ?? null,
        bag_id: input.bagId,
        from_station_id: input.fromStationId ?? null,
        to_station_id: input.toStationId ?? station.id,
        linked_event_id: input.linkedEventId,
        received_quantity: input.receivedQuantity,
        partial: input.partial,
        accountable_employee_id: accountability.accountableEmployeeId,
        accountability_source: accountability.accountabilitySource,
        accountable_employee_name_snapshot:
          accountability.accountableEmployeeNameSnapshot ?? "",
        entered_by_user_id: accountability.enteredByUserId,
      };
      const v = validateQcPayload("REWORK_RECEIVED", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }
      await projectEvent(tx, {
        workflowBagId: input.bagId,
        stationId: station.id,
        eventType: "REWORK_RECEIVED",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
        enteredByUserId: accountability.enteredByUserId,
      });
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.qc.rework_received",
          targetType: "WorkflowBag",
          targetId: input.bagId,
          after: {
            station_id: station.id,
            received_quantity: input.receivedQuantity,
            partial: input.partial,
            linked_event_id: input.linkedEventId,
            accountable_employee_id: accountability.accountableEmployeeId,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath(`/floor/${input.token}`);
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

