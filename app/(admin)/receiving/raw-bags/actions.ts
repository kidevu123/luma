"use server";

// INTAKE-WORKFLOW-1 — server actions for /receiving/raw-bags.

import { revalidatePath } from "next/cache";
import { requireAdmin, requireLead } from "@/lib/auth-guards";
import { syncPurchaseOrdersFromZoho, type PoSyncResult } from "@/lib/zoho/po-sync";
import {
  createRawBagIntakeAtomic,
  findRawBagByReceiptOrQr,
  type CreateRawBagIntakeResult,
  type RawBagLookupResult,
} from "@/lib/db/queries/raw-bag-intake";

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

export async function lookupRawBagAction(value: string): Promise<RawBagLookupResult> {
  await requireLead();
  return findRawBagByReceiptOrQr(value);
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
