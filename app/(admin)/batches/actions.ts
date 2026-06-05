"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireLead, requireAdmin } from "@/lib/auth-guards";
import {
  createBatch,
  setBatchStatus,
  openHold,
  closeHold,
  bulkReleaseQuarantinedBatches,
  assessBulkReleaseCandidates,
  getBatchWithHolds,
} from "@/lib/db/queries/batches";

const STATUS = z.enum([
  "QUARANTINE",
  "RELEASED",
  "ON_HOLD",
  "RECALLED",
  "EXPIRED",
  "DEPLETED",
]);

const createSchema = z.object({
  kind: z.enum(["TABLET", "PACKAGING"]),
  batchNumber: z.string().min(1).max(80),
  tabletTypeId: z.union([z.string().uuid(), z.literal("").transform(() => null)]).nullable(),
  packagingMaterialId: z.union([z.string().uuid(), z.literal("").transform(() => null)]).nullable(),
  vendorName: z.string().max(120).optional().nullable(),
  vendorLotNumber: z.string().max(120).optional().nullable(),
  manufacturedAt: z.string().date().optional().nullable(),
  expiryDate: z.string().date().optional().nullable(),
  qtyReceived: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(1000).optional().nullable(),
  blockForReview: z
    .union([z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true" || v === "1"),
});

export async function createBatchAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireLead();
  const parsed = createSchema.safeParse({
    kind: formData.get("kind"),
    batchNumber: formData.get("batchNumber"),
    tabletTypeId: formData.get("tabletTypeId") || "",
    packagingMaterialId: formData.get("packagingMaterialId") || "",
    vendorName: formData.get("vendorName") || null,
    vendorLotNumber: formData.get("vendorLotNumber") || null,
    manufacturedAt: formData.get("manufacturedAt") || null,
    expiryDate: formData.get("expiryDate") || null,
    qtyReceived: formData.get("qtyReceived") || 0,
    notes: formData.get("notes") || null,
    blockForReview: formData.get("blockForReview") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  if (parsed.data.kind === "TABLET" && !parsed.data.tabletTypeId) {
    return { error: "Tablet batch requires a tablet type." };
  }
  if (parsed.data.kind === "PACKAGING" && !parsed.data.packagingMaterialId) {
    return { error: "Packaging batch requires a packaging material." };
  }
  const { blockForReview, ...batchInput } = parsed.data;
  try {
    await createBatch(
      {
        ...batchInput,
        initialStatus: blockForReview ? "QUARANTINE" : "RELEASED",
      },
      actor,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/batches");
  return { ok: true };
}

export async function setStatusAction(
  batchId: string,
  next: string,
  note?: string,
  confirmRecallOverride?: boolean,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireLead();
  if (!z.string().uuid().safeParse(batchId).success) return { error: "Invalid batch." };
  const parsed = STATUS.safeParse(next);
  if (!parsed.success) return { error: "Invalid status." };
  if (parsed.data === "RELEASED" && !confirmRecallOverride) {
    const batch = await getBatchWithHolds(batchId);
    if (batch?.status === "RECALLED") {
      return {
        error:
          "This lot is recalled. Confirm override in the dialog before releasing.",
      };
    }
  }
  try {
    await setBatchStatus(batchId, parsed.data, actor, note);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/batches");
  return { ok: true };
}

export async function openHoldAction(
  batchId: string,
  reason: string,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireLead();
  if (!z.string().uuid().safeParse(batchId).success) return { error: "Invalid batch." };
  if (!reason.trim()) return { error: "Reason required." };
  try {
    await openHold(batchId, reason.trim(), actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/batches");
  return { ok: true };
}

export async function closeHoldAction(
  holdId: string,
  resolution: string,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireLead();
  if (!z.string().uuid().safeParse(holdId).success) return { error: "Invalid hold." };
  if (!resolution.trim()) return { error: "Resolution note required." };
  try {
    await closeHold(holdId, resolution.trim(), actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/batches");
  return { ok: true };
}

export async function bulkReleaseQuarantinedAction(
  batchIds?: string[],
): Promise<
  | {
      ok: true;
      releasedCount: number;
      skippedCount: number;
      skipped: Array<{ batchNumber: string; reason: string }>;
    }
  | { error: string }
> {
  const actor = await requireAdmin();
  const ids =
    batchIds && batchIds.length > 0
      ? batchIds.filter((id) => z.string().uuid().safeParse(id).success)
      : undefined;
  try {
    const result = await bulkReleaseQuarantinedBatches(actor, ids);
    revalidatePath("/batches");
    return {
      ok: true,
      releasedCount: result.releasedCount,
      skippedCount: result.skipped.length,
      skipped: result.skipped.map((s) => ({
        batchNumber: s.batchNumber,
        reason: s.reason,
      })),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Bulk release failed." };
  }
}

export async function previewBulkReleaseAction(): Promise<
  | {
      ok: true;
      eligibleCount: number;
      skippedCount: number;
    }
  | { error: string }
> {
  await requireAdmin();
  try {
    const result = await assessBulkReleaseCandidates();
    return {
      ok: true,
      eligibleCount: result.eligible.length,
      skippedCount: result.skipped.length,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Preview failed." };
  }
}
