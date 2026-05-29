"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireLead, requireAdmin } from "@/lib/auth-guards";
import {
  createFinishedLot,
  setFinishedLotStatus,
  type FinishedLotStatus,
} from "@/lib/db/queries/finished-lots";
import { compact } from "@/lib/db/compact";

const lotSchema = z.object({
  productId: z.string().uuid(),
  workflowBagId: z.string().uuid().optional().nullable(),
  finishedLotNumber: z.string().min(1).max(60),
  producedOn: z.string().date(),
  expiryDate: z.string().date(),
  unitsProduced: z.coerce.number().int().min(0).max(10_000_000),
  displaysProduced: z.coerce.number().int().min(0).optional().nullable(),
  casesProduced: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  inputs: z
    .array(
      z.object({
        batchId: z.string().uuid(),
        qtyConsumed: z.coerce.number().int().min(0),
      }),
    )
    .optional(),
});

export async function createFinishedLotAction(payload: unknown) {
  const actor = await requireLead();
  const parsed = lotSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    const { lot } = await createFinishedLot(compact(parsed.data), actor);
    revalidatePath("/finished-lots");
    revalidatePath("/floor-board");
    revalidatePath("/packaging-output");
    revalidatePath("/zoho-operations");
    return { ok: true as const, id: lot.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function createFinishedLotAndRedirect(payload: unknown) {
  const r = await createFinishedLotAction(payload);
  if (r && "error" in r && r.error) return { error: r.error };
  if (r && "ok" in r && r.id) redirect(`/finished-lots/${r.id}`);
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["PENDING_QC", "RELEASED", "ON_HOLD", "SHIPPED", "RECALLED"]),
  reason: z.string().max(500).optional(),
});

export async function setFinishedLotStatusAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await setFinishedLotStatus(
      parsed.data.id,
      parsed.data.status as FinishedLotStatus,
      actor,
      parsed.data.reason,
    );
    revalidatePath(`/finished-lots/${parsed.data.id}`);
    revalidatePath("/finished-lots");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Status change failed." };
  }
}
