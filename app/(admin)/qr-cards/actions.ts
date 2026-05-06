"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import { createQrCard, retireQrCard } from "@/lib/db/queries/qr-cards";

const createSchema = z.object({ label: z.string().min(1).max(80) });

export async function createQrCardAction(formData: FormData) {
  const actor = await requireAdmin();
  const parsed = createSchema.safeParse({ label: formData.get("label") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid label." };
  try {
    await createQrCard(parsed.data.label, actor);
    revalidatePath("/qr-cards");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function retireQrCardAction(id: string) {
  const actor = await requireAdmin();
  try {
    await retireQrCard(id, actor);
    revalidatePath("/qr-cards");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Retire failed." };
  }
}
