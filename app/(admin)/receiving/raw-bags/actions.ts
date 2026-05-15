"use server";

// INTAKE-WORKFLOW-1 — server actions for /receiving/raw-bags.

import { revalidatePath } from "next/cache";
import { requireLead } from "@/lib/auth-guards";
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
  }
  return result;
}

export async function lookupRawBagAction(value: string): Promise<RawBagLookupResult> {
  await requireLead();
  return findRawBagByReceiptOrQr(value);
}
