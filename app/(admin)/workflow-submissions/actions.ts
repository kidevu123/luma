"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  finishedLots,
  products,
  qrCards,
  readBagState,
  stations,
  workflowBags,
  workflowEvents,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import {
  executeSubmissionFieldCorrection,
  fieldCorrectionSchema,
  revalidateSubmissionCorrectionPaths,
} from "@/lib/production/submission-correction-service";
import {
  buildRouteSummary,
  evaluateWorkflowRecoveryEligibility,
  WORKFLOW_RECOVERY_EVENT_TYPE,
  workflowRecoveryPayloadSchema,
  type WorkflowRecoveryKind,
} from "@/lib/production/workflow-recovery";
import { loadZohoOutputCommittedForWorkflowBag } from "@/lib/production/correction-downstream-effects";

const missingBlisterCloseoutSchema = z.object({
  workflowBagId: z.string().uuid(),
  countTotal: z.preprocess((value) => {
    if (value == null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }, z.number().int().nonnegative()),
  notes: z.string().trim().min(10, "Enter a reason for the repair.").max(500),
});

type RepairResult = { ok?: true; error?: string };

type CorrectionActionResult = { ok?: true; error?: string; warnings?: string[] };

const recoverySchema = z.object({
  workflowBagId: z.string().uuid(),
  recoveryKind: z.enum(["WRONG_ROUTE", "WRONG_PRODUCT", "WRONG_QR_ASSIGNMENT"]),
  reason: z.string().trim().min(10).max(500),
  notes: z.string().trim().max(2000).optional().nullable(),
  confirm: z.literal("true"),
});

async function resolveSingleBlisterStation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowBagId: string,
): Promise<{ id: string; label: string; kind: string }> {
  const rows = await tx
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
    })
    .from(workflowEvents)
    .innerJoin(stations, eq(stations.id, workflowEvents.stationId))
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        inArray(stations.kind, ["BLISTER"]),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt), desc(workflowEvents.id));

  const unique = new Map(rows.map((row) => [row.id, row]));
  if (unique.size === 0) {
    throw new Error(
      "No blister station lineage found for this bag. Use admin recovery, not a blind repair.",
    );
  }
  if (unique.size > 1) {
    throw new Error(
      "Multiple blister stations touched this bag. Admin recovery needs explicit station selection.",
    );
  }
  return [...unique.values()][0]!;
}

export async function adminBackfillMissingBlisterCloseoutAction(
  _prevState: RepairResult | null,
  formData: FormData,
): Promise<RepairResult> {
  const actor = await requireAdmin();
  const parsed = missingBlisterCloseoutSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    countTotal: formData.get("countTotal"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Invalid missing blister close-out repair.",
    };
  }

  try {
    await db.transaction(async (tx) => {
      const [state] = await tx
        .select({
          stage: readBagState.stage,
          isFinalized: readBagState.isFinalized,
          isPaused: readBagState.isPaused,
        })
        .from(readBagState)
        .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
      if (!state) {
        throw new Error("Bag state not found.");
      }
      if (state.isFinalized) {
        throw new Error("Finalized bags cannot be repaired from this tool.");
      }
      if (state.stage !== "STARTED") {
        throw new Error(
          `This repair only applies to STARTED bags (currently ${state.stage}).`,
        );
      }

      const existingSubmissions = await tx
        .select({ eventType: workflowEvents.eventType })
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.workflowBagId, parsed.data.workflowBagId),
            inArray(workflowEvents.eventType, [
              "BLISTER_COMPLETE",
              "HANDPACK_BLISTER_COMPLETE",
              "SEALING_COMPLETE",
              "PACKAGING_COMPLETE",
            ]),
          ),
        )
        .limit(1);
      if (existingSubmissions.length > 0) {
        throw new Error(
          "This bag already has a submission event. Use a specific correction workflow.",
        );
      }

      const blisterStation = await resolveSingleBlisterStation(
        tx,
        parsed.data.workflowBagId,
      );
      const repairPayload = {
        admin_repair: true,
        repair_kind: "MISSING_BLISTER_CLOSEOUT",
        repair_source: "workflow_submissions_admin",
        repair_note: parsed.data.notes,
      };
      const clientIdBase = `admin-missing-blister-closeout:${parsed.data.workflowBagId}`;

      if (state.isPaused) {
        await projectEvent(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: blisterStation.id,
          eventType: "BAG_RESUMED",
          payload: {
            ...repairPayload,
            resume_reason: "admin_missing_blister_closeout",
          },
          clientEventId: `${clientIdBase}:resume`,
          enteredByUserId: actor.id,
          accountabilitySource: "SUPERVISOR_OVERRIDE",
          accountableEmployeeNameSnapshot: actor.email,
        });
      }

      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: blisterStation.id,
        eventType: "BLISTER_COMPLETE",
        payload: {
          count_total: parsed.data.countTotal,
          ...repairPayload,
        },
        clientEventId: `${clientIdBase}:blister-complete`,
        enteredByUserId: actor.id,
        accountabilitySource: "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: actor.email,
      });

      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: blisterStation.id,
        eventType: "BAG_RELEASED",
        payload: {
          station_kind: blisterStation.kind,
          released_at_stage: "BLISTERED",
          ...repairPayload,
        },
        clientEventId: `${clientIdBase}:release`,
        enteredByUserId: actor.id,
        accountabilitySource: "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: actor.email,
      });

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "workflow_submissions.missing_blister_closeout_repair",
          targetType: "WorkflowBag",
          targetId: parsed.data.workflowBagId,
          before: {
            stage: state.stage,
            is_paused: state.isPaused,
            station_id: blisterStation.id,
          },
          after: {
            stage: "BLISTERED",
            released_from_station: blisterStation.id,
            count_total: parsed.data.countTotal,
            notes: parsed.data.notes,
          },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : "Missing blister close-out repair failed.",
    };
  }

  revalidatePath("/workflow-submissions");
  revalidatePath("/floor-board");
  return { ok: true };
}

export async function workflowSubmissionCorrectAction(
  _prev: CorrectionActionResult | null,
  formData: FormData,
): Promise<CorrectionActionResult> {
  const actor = await requireAdmin();
  const parsed = fieldCorrectionSchema.safeParse({
    clientEventId: formData.get("clientEventId"),
    correctedEventId: formData.get("correctedEventId"),
    correctionReason: formData.get("correctionReason"),
    notes: formData.get("notes") || null,
    fieldValuesJson: formData.get("fieldValuesJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid correction." };
  }
  const result = await executeSubmissionFieldCorrection(actor, parsed.data);
  if ("error" in result) return { error: result.error };
  return {
    ok: true,
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
  };
}

export async function workflowRecoveryAction(
  _prev: CorrectionActionResult | null,
  formData: FormData,
): Promise<CorrectionActionResult> {
  const actor = await requireAdmin();
  const parsed = recoverySchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    recoveryKind: formData.get("recoveryKind"),
    reason: formData.get("reason"),
    notes: formData.get("notes") || null,
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid recovery request." };
  }

  try {
    await db.transaction(async (tx) => {
      const [state] = await tx
        .select({
          stage: readBagState.stage,
          isFinalized: readBagState.isFinalized,
          recoveryStatus: readBagState.recoveryStatus,
          excludedFromOutput: readBagState.excludedFromOutput,
        })
        .from(readBagState)
        .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
      if (!state) throw new Error("Bag state not found.");

      const [bag] = await tx
        .select({
          productId: workflowBags.productId,
          productName: products.name,
          productKind: products.kind,
        })
        .from(workflowBags)
        .leftJoin(products, eq(products.id, workflowBags.productId))
        .where(eq(workflowBags.id, parsed.data.workflowBagId));
      if (!bag) throw new Error("Workflow bag not found.");

      const events = await tx
        .select({
          eventType: workflowEvents.eventType,
          payload: workflowEvents.payload,
        })
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowBagId, parsed.data.workflowBagId))
        .orderBy(desc(workflowEvents.occurredAt))
        .limit(20);

      // P2-PARTIAL-KEEP: detect whether this recovery would disturb a QR that
      // is currently held for a partial bottle bag, so the override is clearly
      // audited (and, when a release actually happens, flagged on the event).
      const [assignedCard] = await tx
        .select({ id: qrCards.id })
        .from(qrCards)
        .where(eq(qrCards.assignedWorkflowBagId, parsed.data.workflowBagId))
        .limit(1);
      const bagRemainsPartial = events.some(
        (e) =>
          e.eventType === "BAG_FINALIZED" &&
          (e.payload as Record<string, unknown> | null)?.bag_remains_partial ===
            true,
      );
      const heldPartialBottle =
        bag.productKind === "BOTTLE" &&
        Boolean(assignedCard) &&
        (state.isFinalized || bagRemainsPartial);

      const [lot] = await tx
        .select({ id: finishedLots.id, status: finishedLots.status })
        .from(finishedLots)
        .where(eq(finishedLots.workflowBagId, parsed.data.workflowBagId))
        .limit(1);

      const zohoCommitted = await loadZohoOutputCommittedForWorkflowBag(
        tx,
        parsed.data.workflowBagId,
      );

      const eligibility = evaluateWorkflowRecoveryEligibility({
        alreadyRecovered: Boolean(state.excludedFromOutput || state.recoveryStatus),
        zohoOutputCommitted: zohoCommitted,
        isFinalized: state.isFinalized,
        finishedLotExists: Boolean(lot),
      });
      if (!eligibility.eligible) {
        throw new Error(eligibility.blockers[0]?.message ?? "Recovery blocked.");
      }

      const resetAllowed = eligibility.resetAllowed;
      const routeSummary = buildRouteSummary({
        productName: bag.productName,
        productKind: bag.productKind,
        stage: state.stage,
        eventTypes: events.map((e) => e.eventType),
      });

      let finishedLotAction: "NONE" | "ON_HOLD" | "EXTERNAL_RECOVERY_REQUIRED" =
        "NONE";
      let zohoOutputAction: "NONE" | "VOID_UNCOMMITTED" | "BLOCKED_COMMITTED" =
        "NONE";
      if (zohoCommitted) {
        finishedLotAction = "EXTERNAL_RECOVERY_REQUIRED";
        zohoOutputAction = "BLOCKED_COMMITTED";
      } else if (lot) {
        finishedLotAction = "ON_HOLD";
        zohoOutputAction = "VOID_UNCOMMITTED";
      }

      const payloadInput = {
        client_event_id: randomUUID(),
        recovery_kind: parsed.data.recoveryKind as WorkflowRecoveryKind,
        reason: parsed.data.reason,
        notes: parsed.data.notes ?? null,
        entered_by_user_id: actor.id,
        original_product_id: bag.productId,
        intended_product_id: null,
        original_route_summary: routeSummary,
        source_inventory_released: resetAllowed,
        finished_lot_existed: Boolean(lot),
        finished_lot_id: lot?.id ?? null,
        finished_lot_action: finishedLotAction,
        zoho_output_action: zohoOutputAction,
        reset_allowed: resetAllowed,
        reset_performed: resetAllowed,
      };
      const validated = workflowRecoveryPayloadSchema.safeParse(payloadInput);
      if (!validated.success) {
        throw new Error(validated.error.issues[0]?.message ?? "Invalid recovery payload.");
      }

      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        eventType: WORKFLOW_RECOVERY_EVENT_TYPE,
        payload: validated.data,
        clientEventId: validated.data.client_event_id,
        enteredByUserId: actor.id,
        accountabilitySource: "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: actor.email,
      });

      if (resetAllowed) {
        await tx
          .update(qrCards)
          .set({ status: "IDLE", assignedWorkflowBagId: null })
          .where(eq(qrCards.assignedWorkflowBagId, parsed.data.workflowBagId));

        await projectEvent(tx, {
          workflowBagId: parsed.data.workflowBagId,
          eventType: "CARD_FORCE_RELEASED",
          payload: {
            recovery_kind: parsed.data.recoveryKind,
            reason: parsed.data.reason,
            admin_recovery: true,
            ...(heldPartialBottle ? { held_partial_bottle: true } : {}),
          },
          clientEventId: `workflow-recovery-release:${parsed.data.workflowBagId}`,
          enteredByUserId: actor.id,
          accountabilitySource: "SUPERVISOR_OVERRIDE",
          accountableEmployeeNameSnapshot: actor.email,
        });
      }

      // P2-PARTIAL-KEEP: a recovery on a QR held for a partial bottle bag is a
      // deliberate supervisor override of the partial-keep protection — record
      // it explicitly (independent of whether a hard reset/release ran).
      if (heldPartialBottle) {
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: "ADMIN",
            action: "workflow_recovery.held_partial_bottle_override",
            targetType: "WorkflowBag",
            targetId: parsed.data.workflowBagId,
            after: {
              recovery_kind: parsed.data.recoveryKind,
              reason: parsed.data.reason,
              qr_released: resetAllowed,
              product_name: bag.productName,
            },
          },
          tx,
        );
      }

      if (lot && !zohoCommitted && finishedLotAction === "ON_HOLD") {
        await tx
          .update(finishedLots)
          .set({ status: "ON_HOLD" })
          .where(eq(finishedLots.id, lot.id));

        const ops = await tx
          .select({ id: zohoProductionOutputOps.id })
          .from(zohoProductionOutputOps)
          .where(
            and(
              eq(zohoProductionOutputOps.finishedLotId, lot.id),
              isNull(zohoProductionOutputOps.voidedAt),
            ),
          );
        for (const op of ops) {
          await tx
            .update(zohoProductionOutputOps)
            .set({
              status: "VOIDED",
              voidedAt: new Date(),
              voidedByUserId: actor.id,
              voidReason: "Voided after wrong-route recovery.",
              updatedAt: new Date(),
            })
            .where(eq(zohoProductionOutputOps.id, op.id));
        }
      }

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "workflow_submissions.recovery",
          targetType: "WorkflowBag",
          targetId: parsed.data.workflowBagId,
          after: {
            recovery_kind: parsed.data.recoveryKind,
            reset_allowed: resetAllowed,
            zoho_committed: zohoCommitted,
            finished_lot_id: lot?.id ?? null,
          },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Recovery failed.",
    };
  }

  revalidateSubmissionCorrectionPaths();
  revalidatePath("/packaging-output");
  revalidatePath("/zoho-production-operations");
  return { ok: true };
}
