"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  resetZohoAssemblyOpToPending,
  resolveZohoAssemblyOpManually,
} from "@/lib/db/queries/zoho-assembly";

export async function resetToPendingAction(
  id: string,
): Promise<{ error?: string }> {
  try {
    await requireAdmin();
    await resetZohoAssemblyOpToPending(id);
    revalidatePath(`/zoho-operations/${id}`);
    revalidatePath("/zoho-operations");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error." };
  }
}

export async function resolveManuallyAction(
  id: string,
  note: string,
): Promise<{ error?: string }> {
  if (!note.trim()) return { error: "A resolved note is required." };
  try {
    const user = await requireAdmin();
    await resolveZohoAssemblyOpManually(id, {
      note: note.trim(),
      resolvedByUserId: user.id,
    });
    revalidatePath(`/zoho-operations/${id}`);
    revalidatePath("/zoho-operations");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error." };
  }
}
