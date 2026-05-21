"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { packagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

export async function scrapLotAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return { error: "Invalid lot id." };
  try {
    await db
      .update(packagingLots)
      .set({ status: "SCRAPPED" })
      .where(eq(packagingLots.id, id.data));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Scrap failed." };
  }
  revalidatePath("/packaging-inventory");
  return { ok: true };
}

export async function deleteLotAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return { error: "Invalid lot id." };
  try {
    await db.delete(packagingLots).where(eq(packagingLots.id, id.data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    if (msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint")) {
      return { error: "Lot is linked to production records — scrap it instead of deleting." };
    }
    return { error: msg };
  }
  revalidatePath("/packaging-inventory");
  return { ok: true };
}
