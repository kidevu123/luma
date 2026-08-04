"use server";

import { requireSession } from "@/lib/auth-guards";
import {
  listConsolidatedProductionOutputOps,
  processConsolidatedProductionOutputCommit,
  processNextQueuedConsolidatedProductionOutputCommit,
  queueConsolidatedProductionOutputOp,
  retryConsolidatedProductionOutputPreview,
} from "@/lib/db/queries/zoho-production-output-consolidated";
import { revalidatePath } from "next/cache";

export async function processProductionOutputOpAction(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  if (session.role !== "OWNER" && session.role !== "ADMIN") return;
  const opId = String(formData.get("opId") ?? "");
  if (!opId) return;

  await processConsolidatedProductionOutputCommit(opId, session);
  revalidatePath("/zoho-production-operations");
}

export async function processNextQueuedProductionOutputAction(): Promise<void> {
  const session = await requireSession();
  if (session.role !== "OWNER" && session.role !== "ADMIN") return;

  await processNextQueuedConsolidatedProductionOutputCommit(session);
  revalidatePath("/zoho-production-operations");
}

export async function queueProductionOutputOpAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (session.role !== "OWNER" && session.role !== "ADMIN")
    return { ok: false, error: "Not authorized." };
  const opId = String(formData.get("opId") ?? "");
  if (!opId) return { ok: false, error: "Missing operation id." };

  const result = await queueConsolidatedProductionOutputOp(opId, session);
  revalidatePath("/zoho-production-operations");
  return result;
}

export async function loadConsolidatedProductionOutputOpsAction() {
  await requireSession();
  return listConsolidatedProductionOutputOps(100);
}

export async function retryPreviewProductionOutputOpAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (session.role !== "OWNER" && session.role !== "ADMIN")
    return { ok: false, error: "Not authorized." };
  const opId = String(formData.get("opId") ?? "");
  if (!opId) return { ok: false, error: "Missing operation id." };

  const result = await retryConsolidatedProductionOutputPreview(opId, session);
  revalidatePath("/zoho-production-operations");
  // retryConsolidatedProductionOutputPreview returns { ok: false; reason: string }
  // on failure — normalise the key to `error` for a consistent surface.
  if (!result.ok) return { ok: false, error: result.reason };
  return { ok: true };
}
