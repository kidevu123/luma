import { and, desc, eq } from "drizzle-orm";
import type { db as DbType } from "@/lib/db";
import {
  batches,
  inventoryBags,
  rawBagAllocationSessions,
} from "@/lib/db/schema";

type DbClient = typeof DbType;

export async function loadFloorAllocationPanelForWorkflowBag(
  db: DbClient,
  workflowBagId: string,
  inventoryBagId: string | null,
) {
  if (!inventoryBagId) return null;

  const sessions = await db
    .select({
      id: rawBagAllocationSessions.id,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, workflowBagId),
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.openedAt))
    .limit(3);

  const session =
    sessions.find((s) => s.allocationStatus === "OPEN") ?? sessions[0] ?? null;

  const [bag] = await db
    .select({
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagNumber: inventoryBags.bagNumber,
      batchNumber: batches.batchNumber,
    })
    .from(inventoryBags)
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  const starting = session?.startingBalanceQty ?? null;
  const consumedEstimate =
    session?.consumedQty ??
    (starting != null && session?.endingBalanceQty != null
      ? starting - session.endingBalanceQty
      : null);

  return {
    receiptLabel:
      bag?.internalReceiptNumber != null
        ? String(bag.internalReceiptNumber)
        : bag?.bagNumber != null
          ? String(bag.bagNumber)
          : null,
    humanLot: bag?.batchNumber != null ? String(bag.batchNumber) : null,
    startingBalanceQty: starting,
    consumedQtyEstimate: consumedEstimate,
    endingBalanceEstimate: session?.endingBalanceQty ?? null,
    sessionStatus: session?.allocationStatus ?? null,
    missingReason: session
      ? null
      : sessions.length > 0
        ? ("legacy_run" as const)
        : ("start_path_gap" as const),
  };
}
