"use server";

// INTAKE-WORKFLOW-1 — server actions for /receiving/raw-bags.

import { revalidatePath } from "next/cache";
import { requireAdmin, requireLead } from "@/lib/auth-guards";
import { syncPurchaseOrdersFromZoho, type PoSyncResult } from "@/lib/zoho/po-sync";
import { db } from "@/lib/db";
import { inventoryBags } from "@/lib/db/schema";
import {
  createRawBagIntakeAtomic,
  findRawBagByReceiptOrQr,
  type CreateRawBagIntakeResult,
  type RawBagLookupResult,
} from "@/lib/db/queries/raw-bag-intake";
import {
  loadReceiveBagReadinessEvaluations,
} from "@/lib/production/floor-readiness-loaders";
import type { FloorReadinessEvaluation } from "@/lib/production/floor-readiness";
import { inArray } from "drizzle-orm";

export async function createRawBagIntakeAction(
  raw: unknown,
): Promise<CreateRawBagIntakeResult> {
  const actor = await requireLead();
  const result = await createRawBagIntakeAtomic(raw, actor);
  if (result.ok) {
    revalidatePath("/receiving/raw-bags");
    revalidatePath("/inbound");
    revalidatePath("/recall");
    revalidatePath("/qr-cards");
  }
  return result;
}

export type RawBagLookupActionResult = RawBagLookupResult & {
  readiness?: FloorReadinessEvaluation | null;
};

export async function lookupRawBagAction(
  value: string,
): Promise<RawBagLookupActionResult> {
  await requireLead();
  const result = await findRawBagByReceiptOrQr(value);
  if (!result.found) return result;
  const evaluations = await loadReceiveBagReadinessEvaluations(db, [
    result.bag.id,
  ]);
  const readiness = evaluations.get(result.bag.id) ?? null;
  return { ...result, readiness };
}

export type IntakeBagReadinessSummary = {
  bagId: string;
  receiptNumber: string | null;
  evaluation: FloorReadinessEvaluation;
};

export async function loadIntakeBagReadinessAction(
  bagIds: readonly string[],
): Promise<readonly IntakeBagReadinessSummary[]> {
  await requireLead();
  if (bagIds.length === 0) return [];
  const evaluations = await loadReceiveBagReadinessEvaluations(db, bagIds);
  const rows = await db
    .select({
      id: inventoryBags.id,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
    })
    .from(inventoryBags)
    .where(inArray(inventoryBags.id, [...bagIds]));
  return rows
    .map((row) => {
      const evaluation = evaluations.get(row.id);
      if (!evaluation) return null;
      return {
        bagId: row.id,
        receiptNumber: row.internalReceiptNumber,
        evaluation,
      };
    })
    .filter((r): r is IntakeBagReadinessSummary => r != null);
}

export async function syncPurchaseOrdersFromZohoAction(): Promise<
  { ok: true; result: PoSyncResult } |
  { ok: false; error: string }
> {
  await requireAdmin();
  try {
    const result = await syncPurchaseOrdersFromZoho();
    revalidatePath("/receiving/raw-bags");
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
