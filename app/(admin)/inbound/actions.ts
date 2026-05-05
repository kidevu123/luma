"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireLead } from "@/lib/auth-guards";
import { createReceiveWithBoxes } from "@/lib/db/queries/receives";
import { compact } from "@/lib/db/compact";

const boxSchema = z.object({
  boxNumber: z.coerce.number().int().min(1),
  tabletTypeId: z.string().uuid(),
  batchNumber: z.string().min(1).max(80),
  vendorLotNumber: z.string().max(120).optional().nullable(),
  manufacturedAt: z.string().date().optional().nullable(),
  expiryDate: z.string().date().optional().nullable(),
  bagCount: z.coerce.number().int().min(1).max(500),
  pillCountPerBag: z.coerce.number().int().min(0).optional().nullable(),
});

const schema = z.object({
  receiveName: z.string().min(1).max(120),
  poId: z.union([z.string().uuid(), z.literal("").transform(() => null)]).nullable(),
  notes: z.string().max(1000).optional().nullable(),
  boxes: z.array(boxSchema).min(1, "Add at least one box."),
});

export async function createReceiveAction(
  payload: unknown,
): Promise<{ error?: string; receiveId?: string } | void> {
  const actor = await requireLead();
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  try {
    const { receive } = await createReceiveWithBoxes(
      compact({
        ...parsed.data,
        boxes: parsed.data.boxes.map((b) => compact(b)),
      }),
      actor,
    );
    revalidatePath("/inbound");
    revalidatePath("/batches");
    return { receiveId: receive.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function createReceiveAndRedirect(
  payload: unknown,
): Promise<{ error?: string } | void> {
  const r = await createReceiveAction(payload);
  if (r && "error" in r && r.error) return { error: r.error };
  if (r && "receiveId" in r && r.receiveId) redirect(`/inbound/${r.receiveId}`);
}
