"use server";

import { revalidatePath } from "next/cache";
import { requireLead } from "@/lib/auth-guards";
import { editReceive, type ReceiveEditInput } from "@/lib/db/queries/receive-edits";

export type ReceiveEditFormData = {
  notes?: string;
  isClosed: boolean;
};

export async function editReceiveAction(
  receiveId: string,
  raw: ReceiveEditFormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireLead();

  const input: ReceiveEditInput = {
    isClosed: raw.isClosed,
    notes: raw.notes ?? null,
  };

  const result = await editReceive(receiveId, input, actor);

  if (result.ok) {
    revalidatePath(`/inbound/${receiveId}`);
    revalidatePath(`/inbound/${receiveId}/edit`);
    revalidatePath("/inbound");
    revalidatePath("/reports/audit-log");
  }

  return result;
}
