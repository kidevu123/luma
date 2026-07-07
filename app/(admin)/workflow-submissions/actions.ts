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
import {
  applyWrongProductCorrectionInTx,
  listWrongProductCorrectionCandidates,
  loadWrongProductCorrectionContext,
} from "@/lib/production/wrong-product-correction-service";
import type {
  WrongProductCorrectionPreview,
  WrongProductCorrectionVerdict,
} from "@/lib/production/wrong-product-correction";

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
  /** ADMIN-CORRECTION-WIZARD-1 — the product staff SHOULD have used.
   *  Optional recorded intent; drives "start correct workflow" guidance. */
  intendedProductId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  correctionMode: z
    .enum(["QUARANTINE_AND_RESTART", "QUARANTINE_ONLY"])
    .optional(),
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
    intendedProductId: formData.get("intendedProductId") || null,
    correctionMode: formData.get("correctionMode") || undefined,
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

      // ADMIN-CORRECTION-WIZARD-1 — record the intended product (if the
      // admin selected one) so downstream guidance can say exactly which
      // workflow to start. Recorded intent only; no conversion happens.
      let intendedProduct: { id: string; kind: string } | null = null;
      if (parsed.data.intendedProductId) {
        const [ip] = await tx
          .select({ id: products.id, kind: products.kind })
          .from(products)
          .where(eq(products.id, parsed.data.intendedProductId));
        if (!ip) throw new Error("Intended product not found.");
        intendedProduct = ip;
      }

      const payloadInput = {
        client_event_id: randomUUID(),
        recovery_kind: parsed.data.recoveryKind as WorkflowRecoveryKind,
        reason: parsed.data.reason,
        notes: parsed.data.notes ?? null,
        entered_by_user_id: actor.id,
        original_product_id: bag.productId,
        intended_product_id: intendedProduct?.id ?? null,
        intended_route: intendedProduct?.kind ?? null,
        correction_mode:
          parsed.data.correctionMode ??
          ("QUARANTINE_ONLY" as const),
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
            intended_product_id: intendedProduct?.id ?? null,
            correction_mode: parsed.data.correctionMode ?? "QUARANTINE_ONLY",
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

// ── ADMIN-CORRECTION-WIZARD-1 · wrong-product correction ─────────────────────

export type WrongProductCorrectionOptions = {
  currentProduct: { id: string; name: string; sku: string; kind: string } | null;
  /** Safe direct-remap candidates: active, same route, allowed tablet type. */
  candidates: Array<{ id: string; sku: string; name: string; kind: string }>;
  /** All active products — used by the wrong-route flow to record which
   *  product SHOULD have been run (intent only, never a conversion). */
  allActiveProducts: Array<{ id: string; sku: string; name: string; kind: string }>;
  hasFinishedLot: boolean;
  lotStatus: string | null;
  zohoOutputCommitted: boolean;
  error?: string;
};

export async function loadWrongProductCorrectionOptionsAction(
  workflowBagId: string,
): Promise<WrongProductCorrectionOptions> {
  await requireAdmin();
  const empty: WrongProductCorrectionOptions = {
    currentProduct: null,
    candidates: [],
    allActiveProducts: [],
    hasFinishedLot: false,
    lotStatus: null,
    zohoOutputCommitted: false,
  };
  const parsedId = z.string().uuid().safeParse(workflowBagId);
  if (!parsedId.success) return { ...empty, error: "Invalid workflow id." };

  try {
    return await db.transaction(async (tx) => {
      const ctx = await loadWrongProductCorrectionContext(tx, {
        workflowBagId: parsedId.data,
        newProductId: null,
      });
      const candidates = ctx.oldProduct
        ? await listWrongProductCorrectionCandidates(tx, {
            currentProductId: ctx.oldProduct.id,
            currentProductKind: ctx.oldProduct.kind,
            tabletTypeId: ctx.tabletTypeId,
          })
        : [];
      const allActiveProducts = await tx
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          kind: products.kind,
        })
        .from(products)
        .where(eq(products.isActive, true))
        .orderBy(products.name);
      return {
        currentProduct: ctx.oldProduct
          ? {
              id: ctx.oldProduct.id,
              name: ctx.oldProduct.name,
              sku: ctx.oldProduct.sku,
              kind: ctx.oldProduct.kind,
            }
          : null,
        candidates,
        allActiveProducts,
        hasFinishedLot: Boolean(ctx.lot),
        lotStatus: ctx.lot?.status ?? null,
        zohoOutputCommitted: ctx.zohoOutputCommitted,
      };
    });
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "Failed to load correction options.",
    };
  }
}

export type WrongProductCorrectionPreviewResult = {
  verdict: WrongProductCorrectionVerdict | null;
  preview: WrongProductCorrectionPreview | null;
  error?: string;
};

export async function previewWrongProductCorrectionAction(
  workflowBagId: string,
  newProductId: string,
): Promise<WrongProductCorrectionPreviewResult> {
  await requireAdmin();
  const parsed = z
    .object({ workflowBagId: z.string().uuid(), newProductId: z.string().uuid() })
    .safeParse({ workflowBagId, newProductId });
  if (!parsed.success) {
    return { verdict: null, preview: null, error: "Invalid preview request." };
  }
  try {
    return await db.transaction(async (tx) => {
      const ctx = await loadWrongProductCorrectionContext(tx, {
        workflowBagId: parsed.data.workflowBagId,
        newProductId: parsed.data.newProductId,
      });
      return { verdict: ctx.verdict, preview: ctx.preview };
    });
  } catch (err) {
    return {
      verdict: null,
      preview: null,
      error: err instanceof Error ? err.message : "Preview failed.",
    };
  }
}

const wrongProductCorrectionApplySchema = z.object({
  workflowBagId: z.string().uuid(),
  newProductId: z.string().uuid(),
  reason: z.string().trim().min(10, "Enter a detailed reason (min 10 chars).").max(500),
  notes: z.string().trim().max(2000).optional().nullable(),
  confirm: z.literal("true"),
});

export async function applyWrongProductCorrectionAction(
  _prev: CorrectionActionResult | null,
  formData: FormData,
): Promise<CorrectionActionResult> {
  const actor = await requireAdmin();
  const parsed = wrongProductCorrectionApplySchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    newProductId: formData.get("newProductId"),
    reason: formData.get("reason"),
    notes: formData.get("notes") || null,
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid correction request.",
    };
  }

  try {
    await db.transaction(async (tx) => {
      await applyWrongProductCorrectionInTx(tx, {
        workflowBagId: parsed.data.workflowBagId,
        newProductId: parsed.data.newProductId,
        reason: parsed.data.reason,
        notes: parsed.data.notes ?? null,
        actor,
      });
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Wrong-product correction failed.",
    };
  }

  revalidateSubmissionCorrectionPaths();
  revalidatePath("/packaging-output");
  revalidatePath("/zoho-production-operations");
  revalidatePath("/finished-lots");
  revalidatePath("/po-closeout");
  return { ok: true };
}
