"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  MISSED_BLISTER_BAG_CONFIRM_STRING,
  loadMissedBlisterBagProposal,
  missedBlisterBagInputSchema,
  runMissedBlisterBagBackfill,
  type MissedBlisterBagProposal,
} from "@/lib/ops/missed-blister-bag-backfill";

export type MissedBagBackfillPreviewResult =
  | { ok: true; proposal: MissedBlisterBagProposal }
  | { ok: false; error: string };

export type MissedBagBackfillApplyResult =
  | { ok: true; proposal: MissedBlisterBagProposal }
  | { ok: false; error: string };

function parseFormInput(formData: FormData) {
  return missedBlisterBagInputSchema.safeParse({
    workflowCardToken: formData.get("workflowCardToken"),
    receiptNumber: formData.get("receiptNumber") || null,
    blisterStationId: formData.get("blisterStationId") || null,
    startDate: formData.get("startDate"),
    startTime: formData.get("startTime"),
    endDate: formData.get("endDate"),
    endTime: formData.get("endTime"),
    oldPvcRollNumber: formData.get("oldPvcRollNumber"),
    newPvcRollNumber: formData.get("newPvcRollNumber"),
    rollChangeCounter: formData.get("rollChangeCounter"),
    blisterCompleteCounter: formData.get("blisterCompleteCounter"),
    rollChangeDate: formData.get("rollChangeDate") || null,
    rollChangeTime: formData.get("rollChangeTime") || null,
    auditReason: formData.get("auditReason"),
  });
}

export async function previewMissedBagBackfillAction(
  formData: FormData,
): Promise<MissedBagBackfillPreviewResult> {
  await requireAdmin();
  const parsed = parseFormInput(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const loaded = await loadMissedBlisterBagProposal(parsed.data);
  if (!loaded.proposal) {
    return { ok: false, error: loaded.error ?? "Could not build proposal" };
  }
  return { ok: true, proposal: loaded.proposal };
}

export async function applyMissedBagBackfillAction(
  formData: FormData,
): Promise<MissedBagBackfillApplyResult> {
  const actor = await requireAdmin();
  const parsed = parseFormInput(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const confirm = formData.get("confirm");
  if (confirm !== MISSED_BLISTER_BAG_CONFIRM_STRING) {
    return { ok: false, error: "Confirmation phrase did not match" };
  }

  const result = await runMissedBlisterBagBackfill({
    ...parsed.data,
    apply: true,
    confirm: MISSED_BLISTER_BAG_CONFIRM_STRING,
  });

  if (!result.proposal) {
    return { ok: false, error: result.error ?? "Backfill failed" };
  }
  if (!result.applied) {
    return { ok: false, error: result.error ?? "Backfill was not applied" };
  }

  revalidatePath("/settings/missed-bag-backfill");
  revalidatePath("/floor-board");
  revalidatePath("/shift-review");
  revalidatePath("/active-rolls");

  void actor;
  return { ok: true, proposal: result.proposal };
}
