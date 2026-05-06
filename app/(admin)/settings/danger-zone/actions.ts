"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth-guards";
import {
  createSnapshot,
  deleteSnapshot,
  wipeProductionData,
  type WipeMode,
} from "@/lib/admin/snapshots";

const labelSchema = z.object({
  label: z.string().max(60).optional(),
});

export async function takeSnapshotAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = labelSchema.safeParse({
    label: formData.get("label") || undefined,
  });
  if (!parsed.success) return { error: "Invalid label." };
  try {
    const r = await createSnapshot(actor, parsed.data.label);
    revalidatePath("/settings/danger-zone");
    return { ok: true as const, ...r };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Snapshot failed." };
  }
}

const deleteSchema = z.object({
  filename: z.string().regex(/^[a-zA-Z0-9_.-]+\.sql\.gz$/, "Invalid filename"),
});

export async function deleteSnapshotAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = deleteSchema.safeParse({
    filename: formData.get("filename"),
  });
  if (!parsed.success) return { error: "Invalid filename." };
  try {
    await deleteSnapshot(parsed.data.filename, actor);
    revalidatePath("/settings/danger-zone");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Delete failed." };
  }
}

const wipeSchema = z.object({
  mode: z.enum(["production", "everything"]),
  confirm: z.string(),
});

const REQUIRED_PHRASE = "RESET MY DATABASE";

export async function wipeDatabaseAction(formData: FormData) {
  const actor = await requireOwner();
  const parsed = wipeSchema.safeParse({
    mode: formData.get("mode"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  if (parsed.data.confirm.trim() !== REQUIRED_PHRASE) {
    return {
      error: `Confirmation phrase must be exactly: ${REQUIRED_PHRASE}`,
    };
  }
  try {
    const r = await wipeProductionData(
      actor,
      parsed.data.mode as WipeMode,
    );
    revalidatePath("/settings/danger-zone");
    return { ok: true as const, ...r };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Wipe failed." };
  }
}
