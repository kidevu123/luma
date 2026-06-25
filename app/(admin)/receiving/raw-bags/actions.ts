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
import {
  previewRawBagIntakeReceive,
  commitRawBagIntakeReceive,
  setRawBagReconciliationStatus,
} from "@/lib/zoho/raw-bag-intake-receive";
import {
  loadIntakeReceiveZohoSummary,
  loadIntakeReceiveZohoSummaryForBags,
  loadRawBagZohoReceivePanel,
  type IntakeReceiveZohoSummary,
  type RawBagZohoReceivePanelData,
} from "@/lib/zoho/raw-bag-receive-panel";
import {
  confirmHistoricalZohoReceive,
  verifyRawBagHistoricalZohoReceive,
} from "@/lib/zoho/raw-bag-intake-receive";
import type { PurchaseReceiveVerificationResult } from "@/lib/zoho/purchase-receive-verification";

export async function createRawBagIntakeAction(
  raw: unknown,
): Promise<CreateRawBagIntakeResult> {
  try {
    const actor = await requireLead();
    const result = await createRawBagIntakeAtomic(raw, actor);
    if (result.ok) {
      revalidatePath("/receiving/raw-bags");
      revalidatePath("/inbound");
      revalidatePath("/recall");
      revalidatePath("/qr-cards");
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
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

export async function loadIntakeReceiveZohoSummaryAction(input: {
  receiveId?: string;
  bagIds?: readonly string[];
}): Promise<IntakeReceiveZohoSummary | null> {
  await requireLead();
  if (input.receiveId) {
    return loadIntakeReceiveZohoSummary(input.receiveId);
  }
  if (input.bagIds && input.bagIds.length > 0) {
    return loadIntakeReceiveZohoSummaryForBags(input.bagIds);
  }
  return null;
}

export async function verifyHistoricalZohoReceiveAction(
  inventoryBagId: string,
  candidateZohoPurchaseReceiveId: string,
): Promise<
  | { ok: true; result: Extract<PurchaseReceiveVerificationResult, { ok: true }> }
  | { ok: false; error: string }
> {
  await requireAdmin();
  const result = await verifyRawBagHistoricalZohoReceive(
    inventoryBagId,
    candidateZohoPurchaseReceiveId,
  );
  if (!result.ok) {
    return { ok: false, error: result.reason };
  }
  return { ok: true, result };
}

export async function loadRawBagZohoReceivePanelAction(
  inventoryBagId: string,
): Promise<RawBagZohoReceivePanelData | null> {
  await requireLead();
  return loadRawBagZohoReceivePanel(inventoryBagId);
}

export async function previewRawBagZohoReceiveAction(
  inventoryBagId: string,
): Promise<
  | { ok: true; httpStatus: number; body: unknown }
  | { ok: false; error: string }
> {
  const actor = await requireLead();
  const result = await previewRawBagIntakeReceive(inventoryBagId, actor);
  if (result.ok) {
    revalidatePath("/receiving/raw-bags");
    return result;
  }
  return { ok: false, error: result.reason };
}

export async function commitRawBagZohoReceiveAction(
  inventoryBagId: string,
): Promise<
  | { ok: true; zohoPurchaseReceiveId: string }
  | { ok: false; error: string }
> {
  const actor = await requireAdmin();
  const result = await commitRawBagIntakeReceive(inventoryBagId, actor);
  if (result.ok) {
    revalidatePath("/receiving/raw-bags");
    revalidatePath("/zoho-production-operations");
    return result;
  }
  return { ok: false, error: result.reason };
}

export async function markReconciliationRequiredAction(
  inventoryBagId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireAdmin();
  const result = await setRawBagReconciliationStatus(
    inventoryBagId,
    "RECONCILIATION_REQUIRED",
    actor,
  );
  if (result.ok) {
    revalidatePath("/receiving/raw-bags");
    revalidatePath("/zoho-production-operations");
    return result;
  }
  return { ok: false, error: result.reason };
}

export async function confirmHistoricalZohoReceiveAction(
  inventoryBagId: string,
  input: {
    zohoPurchaseReceiveId: string;
    reconciliationNotes?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireAdmin();
  const result = await confirmHistoricalZohoReceive(
    inventoryBagId,
    input,
    actor,
  );
  if (result.ok) {
    revalidatePath("/receiving/raw-bags");
    revalidatePath("/zoho-production-operations");
    return result;
  }
  return { ok: false, error: result.reason };
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
