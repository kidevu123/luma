"use server";

import { requireSession } from "@/lib/auth-guards";
import { dryRunZohoAssemblyOperation } from "@/lib/zoho/dry-run-client";
import type { DryRunOperationResult } from "@/lib/zoho/dry-run-client";

export async function dryRunValidationAction(
  id: string,
): Promise<{ result?: DryRunOperationResult; error?: string }> {
  await requireSession();

  try {
    const result = await dryRunZohoAssemblyOperation(id);
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error." };
  }
}
