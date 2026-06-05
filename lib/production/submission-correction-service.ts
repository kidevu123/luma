// Shared submission correction execution — used by QC review and workflow submissions.

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import type { CurrentUser } from "@/lib/auth";
import {
  validateQcPayload,
  type SubmissionCorrectedPayload,
  type QCReasonCode,
} from "@/lib/production/qc-events";
import {
  buildCorrectedValueFromFields,
  buildOriginalValueSnapshot,
  isCorrectableSubmissionEventType,
} from "@/lib/production/submission-correction-fields";
import { evaluateSubmissionCorrectionEligibility } from "@/lib/production/submission-correction-eligibility";
import {
  applySubmissionCorrectionDownstreamEffects,
  loadZohoOutputCommittedForWorkflowBag,
} from "@/lib/production/correction-downstream-effects";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SubmissionCorrectionActionResult =
  | { ok: true; warnings?: string[] }
  | { error: string };

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
      originalPayload: Record<string, unknown>;
    }
  | { ok: false; reason: string }
> {
  const rows = (await tx.execute(
    sql`SELECT
          workflow_bag_id        AS "workflowBagId",
          employee_id            AS "employeeId",
          event_type             AS "eventType",
          payload                AS "payload",
          payload->>'accountability_source'                  AS "source",
          payload->>'accountable_employee_name_snapshot'     AS "nameSnapshot"
        FROM workflow_events
        WHERE id = ${linkedEventId}
        FOR UPDATE`,
  )) as unknown as Array<{
    workflowBagId: string;
    employeeId: string | null;
    eventType: string;
    payload: Record<string, unknown> | null;
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
    originalPayload: (r.payload ?? {}) as Record<string, unknown>,
  };
}

export function revalidateSubmissionCorrectionPaths(finishedLotId?: string | null) {
  revalidatePath("/workflow-submissions");
  revalidatePath("/qc-review");
  revalidatePath("/floor-board");
  revalidatePath("/packaging-output");
  if (finishedLotId) {
    revalidatePath(`/finished-lots/${finishedLotId}`);
    revalidatePath("/finished-lots");
    revalidatePath("/zoho-production-operations");
  }
}

const fieldCorrectionSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  correctedEventId: z.string().uuid(),
  correctionReason: z.string().min(1).max(40),
  notes: z.string().max(2000).optional().nullable(),
  fieldValuesJson: z.string().min(2).max(20000),
});

export async function executeSubmissionFieldCorrection(
  actor: CurrentUser,
  input: z.infer<typeof fieldCorrectionSchema>,
): Promise<SubmissionCorrectionActionResult> {
  let fieldValues: Record<string, number | null>;
  try {
    fieldValues = JSON.parse(input.fieldValuesJson) as Record<string, number | null>;
  } catch {
    return { error: "fieldValues must be valid JSON." };
  }

  let finishedLotId: string | null = null;
  let warnings: string[] = [];

  try {
    const result = await db.transaction(async (tx) => {
      const linked = await loadLinkedEventAccountability(
        tx,
        input.correctedEventId,
      );
      if (!linked.ok) return { error: linked.reason } as SubmissionCorrectionActionResult;

      if (!isCorrectableSubmissionEventType(linked.eventType)) {
        return {
          error: `Event type ${linked.eventType} is not correctable from this form.`,
        } as SubmissionCorrectionActionResult;
      }

      const zohoCommitted = await loadZohoOutputCommittedForWorkflowBag(
        tx,
        linked.workflowBagId,
      );
      const hasFinishedLot = await tx.execute(sql`
        SELECT 1 FROM finished_lots
        WHERE workflow_bag_id = ${linked.workflowBagId}::uuid
        LIMIT 1
      `);
      const eligibility = evaluateSubmissionCorrectionEligibility({
        eventType: linked.eventType,
        isCorrectableEventType: true,
        zohoOutputCommitted: zohoCommitted,
        hasFinishedLot: (hasFinishedLot as unknown as unknown[]).length > 0,
      });
      if (!eligibility.eligible) {
        return {
          error: eligibility.blockers[0]?.message ?? "Correction blocked.",
        } as SubmissionCorrectionActionResult;
      }
      warnings = eligibility.warnings.map((w) => w.message);

      const originalValue = buildOriginalValueSnapshot(
        linked.eventType,
        linked.originalPayload,
      );
      const correctedValue = buildCorrectedValueFromFields(
        linked.eventType,
        linked.originalPayload,
        fieldValues,
      );
      if (Object.keys(correctedValue).length === 0) {
        return {
          error: "No field values changed. Update at least one count.",
        } as SubmissionCorrectionActionResult;
      }

      const payload: SubmissionCorrectedPayload = {
        client_event_id: input.clientEventId,
        corrected_event_id: input.correctedEventId,
        corrected_event_type: linked.eventType,
        original_value: originalValue,
        corrected_value: correctedValue,
        correction_reason: input.correctionReason as QCReasonCode,
        preserves_original_accountable_employee: true,
        notes: input.notes ?? null,
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
          error: v.issues[0]?.message ?? "Invalid correction payload.",
        } as SubmissionCorrectionActionResult;
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

      const downstream = await applySubmissionCorrectionDownstreamEffects(tx, {
        workflowBagId: linked.workflowBagId,
        actor,
      });
      finishedLotId = downstream.finishedLotId;

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "admin.submission_corrected",
          targetType: "WorkflowBag",
          targetId: linked.workflowBagId,
          after: {
            corrected_event_id: input.correctedEventId,
            corrected_event_type: linked.eventType,
            correction_reason: input.correctionReason,
            corrected_value: correctedValue,
            preserved_accountable_employee_id: linked.accountableEmployeeId,
            entered_by_user_id: actor.id,
          },
        },
        tx,
      );

      return { ok: true as const, warnings };
    });

    if ("error" in result) return result;
    revalidateSubmissionCorrectionPaths(finishedLotId);
    return {
      ok: true,
      ...(result.warnings ? { warnings: result.warnings } : {}),
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

/** Legacy JSON-based correction — QC review compatibility. */
const jsonCorrectionSchema = z.object({
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  correctedEventId: z.string().uuid(),
  correctedEventType: z.string().min(1).max(60),
  correctionReason: z.string().min(1).max(40),
  originalValueJson: z.string().min(2).max(20000),
  correctedValueJson: z.string().min(2).max(20000),
  notes: z.string().max(2000).optional().nullable(),
  photoKeys: z.array(z.string()).max(20).optional().nullable(),
});

export async function executeSubmissionJsonCorrection(
  actor: CurrentUser,
  input: z.infer<typeof jsonCorrectionSchema>,
): Promise<SubmissionCorrectionActionResult> {
  let originalValue: unknown;
  let correctedValue: unknown;
  try {
    originalValue = JSON.parse(input.originalValueJson);
    correctedValue = JSON.parse(input.correctedValueJson);
  } catch {
    return { error: "originalValue / correctedValue must be valid JSON." };
  }

  let finishedLotId: string | null = null;

  try {
    const result = await db.transaction(async (tx) => {
      const linked = await loadLinkedEventAccountability(
        tx,
        input.correctedEventId,
      );
      if (!linked.ok) return { error: linked.reason } as SubmissionCorrectionActionResult;

      const zohoCommitted = await loadZohoOutputCommittedForWorkflowBag(
        tx,
        linked.workflowBagId,
      );
      const hasFinishedLot = await tx.execute(sql`
        SELECT 1 FROM finished_lots
        WHERE workflow_bag_id = ${linked.workflowBagId}::uuid
        LIMIT 1
      `);
      const eligibility = evaluateSubmissionCorrectionEligibility({
        eventType: linked.eventType,
        isCorrectableEventType: isCorrectableSubmissionEventType(linked.eventType),
        zohoOutputCommitted: zohoCommitted,
        hasFinishedLot: (hasFinishedLot as unknown as unknown[]).length > 0,
      });
      if (!eligibility.eligible) {
        return {
          error: eligibility.blockers[0]?.message ?? "Correction blocked.",
        } as SubmissionCorrectionActionResult;
      }

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
        } as SubmissionCorrectionActionResult;
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

      const downstream = await applySubmissionCorrectionDownstreamEffects(tx, {
        workflowBagId: linked.workflowBagId,
        actor,
      });
      finishedLotId = downstream.finishedLotId;

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

      return { ok: true as const };
    });

    if ("error" in result) return result;
    revalidateSubmissionCorrectionPaths(finishedLotId);
    return { ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Server error.",
    };
  }
}

export { fieldCorrectionSchema, jsonCorrectionSchema };
