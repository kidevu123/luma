"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  approveZohoProductionOutputOp,
  voidZohoProductionOutputOp,
  type ZohoProductionOutputPreviewMetadata,
} from "@/lib/db/queries/zoho-production-output";

const approveInputSchema = z.object({
  finishedLotId: z.string().uuid(),
  opId: z.string().uuid(),
});

const voidInputSchema = z.object({
  finishedLotId: z.string().uuid(),
  opId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Void reason is required.")
    .max(500, "Void reason must be 500 characters or fewer."),
});

export type ApproveZohoProductionOutputResult =
  | { ok: true; metadata: ZohoProductionOutputPreviewMetadata }
  | { ok: false; message: string };

export type VoidZohoProductionOutputResult =
  | { ok: true }
  | { ok: false; message: string };

export async function approveZohoProductionOutputAction(
  input: z.input<typeof approveInputSchema>,
): Promise<ApproveZohoProductionOutputResult> {
  const actor = await requireAdmin();
  const parsed = approveInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid approval input.",
    };
  }

  const result = await approveZohoProductionOutputOp(parsed.data.opId, actor);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }

  revalidatePath(`/finished-lots/${parsed.data.finishedLotId}`);
  return { ok: true, metadata: result.metadata };
}

export async function voidZohoProductionOutputAction(
  input: z.input<typeof voidInputSchema>,
): Promise<VoidZohoProductionOutputResult> {
  const actor = await requireAdmin();
  const parsed = voidInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid void input.",
    };
  }

  const result = await voidZohoProductionOutputOp(
    parsed.data.opId,
    parsed.data.reason,
    actor,
  );
  if (!result.ok) {
    return { ok: false, message: result.error };
  }

  revalidatePath(`/finished-lots/${parsed.data.finishedLotId}`);
  return { ok: true };
}
