"use server";

import { revalidatePath } from "next/cache";
import { enqueueZohoAssemblyOpsForFinishedLot } from "@/lib/zoho/assembly-enqueue";

export async function createZohoQueueAction(
  lotId: string,
): Promise<{ enqueued: number; existing: number; error?: string }> {
  try {
    const result = await enqueueZohoAssemblyOpsForFinishedLot(lotId);
    if (!result) {
      return { enqueued: 0, existing: 0, error: "Finished lot not found or has no assembly plan." };
    }
    revalidatePath(`/finished-lots/${lotId}`);
    return { enqueued: result.enqueued, existing: result.existing };
  } catch (err) {
    return {
      enqueued: 0,
      existing: 0,
      error: err instanceof Error ? err.message : "Unexpected error during enqueue.",
    };
  }
}
