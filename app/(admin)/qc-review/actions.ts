"use server";

// QC-2 — admin-side QC server actions.
//
// Two event types fire from the admin /qc-review surface (QC-4 builds
// the UI; QC-2 only ships the actions):
//   - scrapRecordedAction        → SCRAP_RECORDED
//   - submissionCorrectedAction  → SUBMISSION_CORRECTED
//
// Strict rules baked in here (per QC-0 plan §4):
//   - Both actions require an admin/owner role via requireAdmin().
//   - When a scrap or correction is linked to a prior event, the
//     PRIOR event's accountable employee is preserved exactly — the
//     supervisor is recorded as entered_by_user_id, never as the
//     accountable employee. Operator metrics roll up against the
//     operator who typed wrong; the supervisor doesn't get false-
//     positive damage credit.
//   - SCRAP_RECORDED under the workflow_events_linked_event_resolution
//     _unique partial-unique: a SELECT FOR UPDATE on the source row
//     serializes concurrent supervisors converting the same damage
//     return. The DB partial-unique is the backstop if a row commits
//     between our SELECT and our INSERT.
//   - SUBMISSION_CORRECTED is intentionally NOT under the partial-
//     unique (corrections can be chained — the latest landed
//     correction is the canonical state).
//   - Neither action moves material inventory. Material decrement on
//     scrap (with affects_packaging_material=true + material_lot_id)
//     is deferred to QC-5 — see "Material decrement deferral" in
//     docs/QC_SUBSYSTEM_IMPLEMENTATION_PLAN.md §13.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { workflowEvents } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { resolveAdminAccountability } from "@/lib/production/station-operator-session";
import {
  validateQcPayload,
  type ScrapRecordedPayload,
  type SubmissionCorrectedPayload,
  type ReworkSentPayload,
  type ReworkReceivedPayload,
  type QCReasonCode,
  type QCUnit,
} from "@/lib/production/qc-events";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult = { ok?: true; conflict?: true; error?: string };

const optionalUuid = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (typeof v === "string" && UUID_RE.test(v) ? v : null));

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

// Look up the linked event's accountable identity. Returns the row's
// employee_id + the accountability payload fields needed to "preserve
// the original accountable employee" per QC-0 §4. Pure read.
async function loadLinkedEventAccountability(
  tx: Parameters<typeof projectEvent>[0],
  linkedEventId: string,
): Promise<
  | {
      ok: true;
      workflowBagId: string;
      accountableEmployeeId: string | null;
      accountabilitySource: string | null;
      nameSnapshot: string | null;
      eventType: string;
    }
  | { ok: false; reason: string }
> {
  const rows = (await tx.execute(
    sql`SELECT
          workflow_bag_id        AS "workflowBagId",
          employee_id            AS "employeeId",
          event_type             AS "eventType",
          payload->>'accountability_source'                  AS "source",
          payload->>'accountable_employee_name_snapshot'     AS "nameSnapshot"
        FROM workflow_events
        WHERE id = ${linkedEventId}
        FOR UPDATE`,
  )) as unknown as Array<{
    workflowBagId: string;
    employeeId: string | null;
    eventType: string;
    source: string | null;
    nameSnapshot: string | null;
  }>;
  if (rows.length === 0) {
    return { ok: false, reason: "Linked event not found." };
  }
  const r = rows[0]!;
  return {
    ok: true,
    workflowBagId: r.workflowBagId,
    accountableEmployeeId: r.employeeId,
    accountabilitySource: r.source,
    nameSnapshot: r.nameSnapshot,
    eventType: r.eventType,
  };
}

async function hasExistingResolution(
  tx: Parameters<typeof projectEvent>[0],
  linkedEventId: string,
  eventType: "SCRAP_RECORDED" | "REWORK_SENT",
): Promise<boolean> {
  const dup = (await tx.execute(
    sql`SELECT 1 FROM workflow_events
        WHERE payload->>'linked_event_id' = ${linkedEventId}
          AND event_type = ${eventType}::workflow_event_type
        LIMIT 1`,
  )) as unknown as Array<unknown>;
  return dup.length > 0;
}

// ─── 4. scrapRecordedAction → SCRAP_RECORDED ───────────────────────────

const scrapSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  workflowBagId: optionalUuid,
  materialLotId: optionalUuid,
  packagingLotId: optionalUuid,
  linkedEventId: optionalUuid,
  quantity: z.coerce.number().int().positive(),
  unit: z.string().min(1).max(40),
  reasonCode: z.string().min(1).max(40),
  scrapQuantity: z.coerce.number().int().positive(),
  scrapUnit: z.string().min(1).max(40),
  affectsRawProduct: z
    .string()
    .transform((s) => s === "true" || s === "1" || s === "on"),
  affectsPackagingMaterial: z
    .string()
    .transform((s) => s === "true" || s === "1" || s === "on"),
  /** Required when no linkedEventId is supplied; the supervisor picks
   *  the operator the scrap should be charged to. */
  overrideEmployeeId: optionalUuid,
  notes: z.string().max(2000).optional().nullable(),
  photoKeys: optionalCoercedJsonArray,
});

export async function scrapRecordedAction(
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireAdmin();
  const parsed = scrapSchema.safeParse({
    clientEventId: formData.get("clientEventId"),
    workflowBagId: formData.get("workflowBagId") || null,
    materialLotId: formData.get("materialLotId") || null,
    packagingLotId: formData.get("packagingLotId") || null,
    linkedEventId: formData.get("linkedEventId") || null,
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    scrapQuantity: formData.get("scrapQuantity"),
    scrapUnit: formData.get("scrapUnit"),
    affectsRawProduct: (formData.get("affectsRawProduct") as string) ?? "false",
    affectsPackagingMaterial:
      (formData.get("affectsPackagingMaterial") as string) ?? "false",
    overrideEmployeeId: formData.get("overrideEmployeeId") || null,
    notes: formData.get("notes") || null,
    photoKeys: formData.get("photoKeys") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  if (!input.affectsRawProduct && !input.affectsPackagingMaterial) {
    return {
      error:
        "Scrap must affect raw product, packaging material, or both — neither flag is set.",
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Accountability resolution.
      //
      // If linked → preserve the source's accountable employee
      // exactly (the supervisor is entered_by, not accountable).
      // If not linked → the supervisor must pick an operator
      // explicitly via overrideEmployeeId; we refuse otherwise to
      // avoid pinning scrap on the supervisor by accident.
      let accountableEmployeeId: string | null = null;
      let accountabilitySource: string | null = null;
      let nameSnapshot: string | null = null;
      let workflowBagIdForEvent: string | null = input.workflowBagId;

      if (input.linkedEventId) {
        const linked = await loadLinkedEventAccountability(
          tx,
          input.linkedEventId,
        );
        if (!linked.ok) return { error: linked.reason } as ActionResult;
        const dup = await hasExistingResolution(
          tx,
          input.linkedEventId,
          "SCRAP_RECORDED",
        );
        if (dup) {
          return {
            conflict: true,
            error:
              "This source event already has a SCRAP_RECORDED resolution.",
          } as ActionResult;
        }
        accountableEmployeeId = linked.accountableEmployeeId;
        accountabilitySource = linked.accountabilitySource;
        nameSnapshot = linked.nameSnapshot;
        // If caller didn't supply a workflow_bag_id, default to the
        // linked event's bag so genealogy stays connected.
        workflowBagIdForEvent = workflowBagIdForEvent ?? linked.workflowBagId;
      } else {
        if (!input.overrideEmployeeId) {
          return {
            error:
              "Ad-hoc scrap requires the accountable operator to be selected explicitly.",
          } as ActionResult;
        }
        // Supervisor explicitly picks the accountable operator. We
        // use resolveAdminAccountability's supervisor-override path
        // to fetch the operator row + name snapshot.
        const admin = await resolveAdminAccountability(tx, {
          actor,
          overrideEmployeeId: input.overrideEmployeeId,
        });
        if (!admin.accountabilitySource) {
          return {
            error: "Selected employee not found.",
          } as ActionResult;
        }
        accountableEmployeeId = admin.accountableEmployeeId;
        accountabilitySource = admin.accountabilitySource;
        nameSnapshot = admin.accountableEmployeeNameSnapshot;
      }

      // Build payload + validate.
      const payload: ScrapRecordedPayload = {
        client_event_id: input.clientEventId,
        quantity: input.quantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: input.photoKeys ?? null,
        bag_id: workflowBagIdForEvent ?? null,
        material_lot_id: input.materialLotId ?? null,
        packaging_lot_id: input.packagingLotId ?? null,
        linked_event_id: input.linkedEventId ?? null,
        scrap_quantity: input.scrapQuantity,
        scrap_unit: input.scrapUnit as QCUnit,
        scrap_reason: input.reasonCode as QCReasonCode,
        affects_raw_product: input.affectsRawProduct,
        affects_packaging_material: input.affectsPackagingMaterial,
        correction_actor_user_id: actor.id,
        correction_actor_employee_id: actor.employeeId,
        accountable_employee_id: accountableEmployeeId,
        accountability_source:
          (accountabilitySource as ScrapRecordedPayload["accountability_source"]) ??
          "SUPERVISOR_OVERRIDE",
        accountable_employee_name_snapshot: nameSnapshot ?? "",
        entered_by_user_id: actor.id,
      };
      const v = validateQcPayload("SCRAP_RECORDED", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }

      // Scrap must have a workflow_bag_id for projectEvent (the
      // workflow_events.workflow_bag_id column is NOT NULL). If
      // neither input nor linked event gave us one, refuse — ad-hoc
      // bag-less scrap belongs to QC-5's material-only path.
      if (!workflowBagIdForEvent) {
        return {
          error:
            "Scrap currently requires a workflow_bag_id (material-only scrap path lands in QC-5).",
        } as ActionResult;
      }

      await projectEvent(tx, {
        workflowBagId: workflowBagIdForEvent,
        eventType: "SCRAP_RECORDED",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId,
        accountabilitySource:
          (accountabilitySource as Parameters<
            typeof projectEvent
          >[1]["accountabilitySource"]) ?? "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: nameSnapshot,
        enteredByUserId: actor.id,
      });
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "admin.qc.scrap_recorded",
          targetType: "WorkflowBag",
          targetId: workflowBagIdForEvent,
          after: {
            scrap_quantity: input.scrapQuantity,
            scrap_unit: input.scrapUnit,
            reason_code: input.reasonCode,
            linked_event_id: input.linkedEventId ?? null,
            accountable_employee_id: accountableEmployeeId,
            entered_by_user_id: actor.id,
            affects_raw_product: input.affectsRawProduct,
            affects_packaging_material: input.affectsPackagingMaterial,
            material_lot_id: input.materialLotId ?? null,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath("/qc-review");
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

// ─── 5. submissionCorrectedAction → SUBMISSION_CORRECTED ───────────────

const correctionSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  correctedEventId: z.string().uuid(),
  correctedEventType: z.string().min(1).max(60),
  correctionReason: z.string().min(1).max(40),
  originalValueJson: z.string().min(2).max(20000),
  correctedValueJson: z.string().min(2).max(20000),
  notes: z.string().max(2000).optional().nullable(),
  photoKeys: optionalCoercedJsonArray,
});

export async function submissionCorrectedAction(
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireAdmin();
  const parsed = correctionSchema.safeParse({
    clientEventId: formData.get("clientEventId"),
    correctedEventId: formData.get("correctedEventId"),
    correctedEventType: formData.get("correctedEventType"),
    correctionReason: formData.get("correctionReason"),
    originalValueJson: formData.get("originalValueJson"),
    correctedValueJson: formData.get("correctedValueJson"),
    notes: formData.get("notes") || null,
    photoKeys: formData.get("photoKeys") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  let originalValue: unknown;
  let correctedValue: unknown;
  try {
    originalValue = JSON.parse(input.originalValueJson);
    correctedValue = JSON.parse(input.correctedValueJson);
  } catch {
    return { error: "originalValue / correctedValue must be valid JSON." };
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Preserve original accountable employee EXACTLY.
      const linked = await loadLinkedEventAccountability(
        tx,
        input.correctedEventId,
      );
      if (!linked.ok) return { error: linked.reason } as ActionResult;

      const payload: SubmissionCorrectedPayload = {
        client_event_id: input.clientEventId,
        corrected_event_id: input.correctedEventId,
        corrected_event_type: input.correctedEventType,
        original_value: originalValue,
        corrected_value: correctedValue,
        correction_reason: input.correctionReason as QCReasonCode,
        preserves_original_accountable_employee: true,
        notes: input.notes ?? null,
        photo_keys: input.photoKeys ?? null,
        accountable_employee_id: linked.accountableEmployeeId,
        accountability_source:
          (linked.accountabilitySource as SubmissionCorrectedPayload["accountability_source"]) ??
          "SUPERVISOR_OVERRIDE",
        accountable_employee_name_snapshot: linked.nameSnapshot ?? "",
        entered_by_user_id: actor.id,
      };
      const v = validateQcPayload("SUBMISSION_CORRECTED", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }

      await projectEvent(tx, {
        workflowBagId: linked.workflowBagId,
        eventType: "SUBMISSION_CORRECTED",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: linked.accountableEmployeeId,
        accountabilitySource:
          (linked.accountabilitySource as Parameters<
            typeof projectEvent
          >[1]["accountabilitySource"]) ?? "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: linked.nameSnapshot,
        enteredByUserId: actor.id,
      });
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "admin.qc.submission_corrected",
          targetType: "WorkflowBag",
          targetId: linked.workflowBagId,
          after: {
            corrected_event_id: input.correctedEventId,
            corrected_event_type: input.correctedEventType,
            correction_reason: input.correctionReason,
            preserved_accountable_employee_id: linked.accountableEmployeeId,
            entered_by_user_id: actor.id,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath("/qc-review");
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

// ─── QC-4: admin rework conversions ────────────────────────────────────
//
// The floor reworkSentAction / reworkReceivedAction are station-token
// authed and serve the operator-driven path. /qc-review needs admin-
// flavored variants that:
//   - require requireAdmin() (no scan token),
//   - preserve the linked event's accountable employee when linked
//     (mirrors scrap/correction),
//   - respect the workflow_events_linked_event_resolution_unique
//     partial-unique on REWORK_SENT,
//   - accept partial REWORK_RECEIVED so a supervisor can close out
//     a half-returned rework cleanly.
//
// These do NOT emit any new event type; same five workflow_event
// types as QC-1/QC-2. Material decrement is still deferred to QC-5.

const adminReworkSentSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  workflowBagId: z.string().uuid().optional().nullable(),
  linkedEventId: z.string().uuid(),
  fromStationId: optionalUuid,
  toStationId: optionalUuid,
  quantity: z.coerce.number().int().positive(),
  unit: z.string().min(1).max(40),
  reasonCode: z.string().min(1).max(40),
  notes: z.string().max(2000).optional().nullable(),
});

export async function adminReworkSentFromDamageAction(
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireAdmin();
  const parsed = adminReworkSentSchema.safeParse({
    clientEventId: formData.get("clientEventId"),
    workflowBagId: formData.get("workflowBagId") || null,
    linkedEventId: formData.get("linkedEventId"),
    fromStationId: formData.get("fromStationId") || null,
    toStationId: formData.get("toStationId") || null,
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const linked = await loadLinkedEventAccountability(tx, input.linkedEventId);
      if (!linked.ok) return { error: linked.reason } as ActionResult;
      const dup = await hasExistingResolution(
        tx,
        input.linkedEventId,
        "REWORK_SENT",
      );
      if (dup) {
        return {
          conflict: true,
          error:
            "This source event already has a REWORK_SENT resolution.",
        } as ActionResult;
      }
      const workflowBagIdForEvent = input.workflowBagId ?? linked.workflowBagId;

      const payload: ReworkSentPayload = {
        client_event_id: input.clientEventId,
        quantity: input.quantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: null,
        bag_id: workflowBagIdForEvent,
        from_station_id: input.fromStationId ?? null,
        to_station_id: input.toStationId ?? null,
        linked_event_id: input.linkedEventId,
        rework_reason: input.reasonCode as QCReasonCode,
        expected_return_quantity: input.quantity,
        accountable_employee_id: linked.accountableEmployeeId,
        accountability_source:
          (linked.accountabilitySource as ReworkSentPayload["accountability_source"]) ??
          "SUPERVISOR_OVERRIDE",
        accountable_employee_name_snapshot: linked.nameSnapshot ?? "",
        entered_by_user_id: actor.id,
      };
      const v = validateQcPayload("REWORK_SENT", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }

      await projectEvent(tx, {
        workflowBagId: workflowBagIdForEvent,
        stationId: input.fromStationId ?? null,
        eventType: "REWORK_SENT",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: linked.accountableEmployeeId,
        accountabilitySource:
          (linked.accountabilitySource as Parameters<
            typeof projectEvent
          >[1]["accountabilitySource"]) ?? "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: linked.nameSnapshot,
        enteredByUserId: actor.id,
      });
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "admin.qc.rework_sent_from_damage",
          targetType: "WorkflowBag",
          targetId: workflowBagIdForEvent,
          after: {
            linked_event_id: input.linkedEventId,
            quantity: input.quantity,
            unit: input.unit,
            reason_code: input.reasonCode,
            accountable_employee_id: linked.accountableEmployeeId,
            entered_by_user_id: actor.id,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath("/qc-review");
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

const adminReworkReceivedSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  linkedEventId: z.string().uuid(),
  /** Quantity originally sent — required to round-trip the payload's
   *  shared base. Pulled from the rework-in-flight row. */
  sentQuantity: z.coerce.number().int().positive(),
  receivedQuantity: z.coerce.number().int().positive(),
  unit: z.string().min(1).max(40),
  reasonCode: z.string().min(1).max(40),
  partial: z
    .string()
    .transform((s) => s === "true" || s === "1" || s === "on"),
  notes: z.string().max(2000).optional().nullable(),
});

export async function adminReworkReceivedAction(
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireAdmin();
  const parsed = adminReworkReceivedSchema.safeParse({
    clientEventId: formData.get("clientEventId"),
    linkedEventId: formData.get("linkedEventId"),
    sentQuantity: formData.get("sentQuantity"),
    receivedQuantity: formData.get("receivedQuantity"),
    unit: formData.get("unit"),
    reasonCode: formData.get("reasonCode"),
    partial: (formData.get("partial") as string) ?? "false",
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      // Pull the linked REWORK_SENT and its accountable employee +
      // bag id. We refuse if it's not actually REWORK_SENT — admin
      // shouldn't be receiving against a damage row directly.
      const sent = (await tx.execute(
        sql`SELECT
              workflow_bag_id   AS "workflowBagId",
              employee_id       AS "employeeId",
              event_type::text  AS "eventType",
              payload->>'accountability_source'                AS "source",
              payload->>'accountable_employee_name_snapshot'   AS "nameSnapshot"
            FROM workflow_events
            WHERE id = ${input.linkedEventId}
              AND event_type = 'REWORK_SENT'
            FOR UPDATE`,
      )) as unknown as Array<{
        workflowBagId: string;
        employeeId: string | null;
        eventType: string;
        source: string | null;
        nameSnapshot: string | null;
      }>;
      if (sent.length === 0) {
        return {
          error: "Linked REWORK_SENT not found.",
        } as ActionResult;
      }
      const linked = sent[0]!;

      const payload: ReworkReceivedPayload = {
        client_event_id: input.clientEventId,
        quantity: input.sentQuantity,
        unit: input.unit as QCUnit,
        reason_code: input.reasonCode as QCReasonCode,
        notes: input.notes ?? null,
        photo_keys: null,
        bag_id: linked.workflowBagId,
        from_station_id: null,
        to_station_id: null,
        linked_event_id: input.linkedEventId,
        received_quantity: input.receivedQuantity,
        partial: input.partial,
        accountable_employee_id: linked.employeeId,
        accountability_source:
          (linked.source as ReworkReceivedPayload["accountability_source"]) ??
          "SUPERVISOR_OVERRIDE",
        accountable_employee_name_snapshot: linked.nameSnapshot ?? "",
        entered_by_user_id: actor.id,
      };
      const v = validateQcPayload("REWORK_RECEIVED", payload);
      if (!v.ok) {
        return {
          error: v.issues[0]?.message ?? "Invalid QC payload.",
        } as ActionResult;
      }

      await projectEvent(tx, {
        workflowBagId: linked.workflowBagId,
        eventType: "REWORK_RECEIVED",
        payload,
        clientEventId: input.clientEventId,
        accountableEmployeeId: linked.employeeId,
        accountabilitySource:
          (linked.source as Parameters<
            typeof projectEvent
          >[1]["accountabilitySource"]) ?? "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: linked.nameSnapshot,
        enteredByUserId: actor.id,
      });
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "admin.qc.rework_received",
          targetType: "WorkflowBag",
          targetId: linked.workflowBagId,
          after: {
            linked_event_id: input.linkedEventId,
            sent_quantity: input.sentQuantity,
            received_quantity: input.receivedQuantity,
            partial: input.partial,
            accountable_employee_id: linked.employeeId,
            entered_by_user_id: actor.id,
          },
        },
        tx,
      );
      return { ok: true } as ActionResult;
    });

    revalidatePath("/qc-review");
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

// Pure helpers exported for tests so the accountability-preservation
// branch can be exercised without standing up the full action.
export const __testInternals = {
  loadLinkedEventAccountability,
  hasExistingResolution,
};
