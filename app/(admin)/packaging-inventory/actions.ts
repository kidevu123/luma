"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { packagingLots, finishedLotPackagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

export async function scrapLotAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/packaging-inventory?err=Invalid+lot+id");
  await db
    .update(packagingLots)
    .set({ status: "SCRAPPED" })
    .where(eq(packagingLots.id, id.data));
  revalidatePath("/packaging-inventory");
}

export async function deleteLotAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/packaging-inventory?err=Invalid+lot+id");

  // Pre-check: lot status — only allow deletion of unassigned lots
  const [lot] = await db
    .select({ status: packagingLots.status })
    .from(packagingLots)
    .where(eq(packagingLots.id, id.data))
    .limit(1);

  if (!lot) redirect("/packaging-inventory?err=Lot+not+found");

  if (lot.status === "IN_USE") {
    redirect("/packaging-inventory?err=Cannot+delete+a+lot+that+is+IN_USE+—+scrap+it+instead");
  }
  if (lot.status === "DEPLETED") {
    redirect("/packaging-inventory?err=Cannot+delete+a+depleted+lot+—+scrap+it+to+archive+it");
  }

  // Pre-check: FK — finished_lot_packaging_lots uses ON DELETE RESTRICT
  const [linked] = await db
    .select({ id: finishedLotPackagingLots.id })
    .from(finishedLotPackagingLots)
    .where(eq(finishedLotPackagingLots.packagingLotId, id.data))
    .limit(1);

  if (linked) {
    redirect("/packaging-inventory?err=Lot+is+linked+to+finished+production+records+—+scrap+it+instead+of+deleting");
  }

  await db.delete(packagingLots).where(eq(packagingLots.id, id.data));
  revalidatePath("/packaging-inventory");
}
