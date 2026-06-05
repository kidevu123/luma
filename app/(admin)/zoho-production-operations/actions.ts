"use server";

import { requireSession } from "@/lib/auth-guards";
import {
  listConsolidatedProductionOutputOps,
  processConsolidatedProductionOutputCommit,
  processNextQueuedConsolidatedProductionOutputCommit,
  queueConsolidatedProductionOutputOp,
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
): Promise<void> {
  const session = await requireSession();
  if (session.role !== "OWNER" && session.role !== "ADMIN") return;
  const opId = String(formData.get("opId") ?? "");
  if (!opId) return;

  await queueConsolidatedProductionOutputOp(opId, session);
  revalidatePath("/zoho-production-operations");
}

export async function loadConsolidatedProductionOutputOpsAction() {
  await requireSession();
  return listConsolidatedProductionOutputOps(100);
}
