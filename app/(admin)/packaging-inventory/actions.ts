"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { packagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

export async function scrapLotAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) throw new Error("Invalid lot id.");
  await db
    .update(packagingLots)
    .set({ status: "SCRAPPED" })
    .where(eq(packagingLots.id, id.data));
  revalidatePath("/packaging-inventory");
}

export async function deleteLotAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) throw new Error("Invalid lot id.");
  try {
    await db.delete(packagingLots).where(eq(packagingLots.id, id.data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    if (msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint")) {
      throw new Error("Lot is linked to production records — scrap it instead of deleting.");
    }
    throw new Error(msg);
  }
  revalidatePath("/packaging-inventory");
}
