"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireLead } from "@/lib/auth-guards";
import {
  createBatch,
  setBatchStatus,
  openHold,
  closeHold,
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
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  if (parsed.data.kind === "TABLET" && !parsed.data.tabletTypeId) {
    return { error: "Tablet batch requires a tablet type." };
  }
  if (parsed.data.kind === "PACKAGING" && !parsed.data.packagingMaterialId) {
    return { error: "Packaging batch requires a packaging material." };
  }
  try {
    await createBatch(parsed.data, actor);
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
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireLead();
  if (!z.string().uuid().safeParse(batchId).success) return { error: "Invalid batch." };
  const parsed = STATUS.safeParse(next);
  if (!parsed.success) return { error: "Invalid status." };
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
