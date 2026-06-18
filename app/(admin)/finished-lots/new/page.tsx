import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireLead } from "@/lib/auth-guards";
import { listProducts } from "@/lib/db/queries/products";
import { listFinalizedBagsWithoutLot } from "@/lib/db/queries/finished-lots";
import { PageHeader } from "@/components/ui/page-header";
import { IssueLotForm } from "./issue-form";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  inventoryBags,
  products as productsTable,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { loadRepairStartingBalanceHints } from "@/lib/production/issue-lot-with-allocation-closeout";

export const dynamic = "force-dynamic";

export default async function NewFinishedLotPage({
  searchParams,
}: {
  searchParams?: Promise<{ bagId?: string | string[] }>;
}) {
  await requireLead();
  const params = await searchParams;
  const requestedBagId = Array.isArray(params?.bagId)
    ? params?.bagId[0]
    : params?.bagId;
  const [products, finalizedBags] = await Promise.all([
    listProducts(),
    listFinalizedBagsWithoutLot(),
  ]);

  const bagIds = finalizedBags.map((r) => r.bag.id);
  const allocationHints: Record<
    string,
    {
      sessionId: string;
      startingBalanceQty: number | null;
      receiptNumber: string | null;
      inventoryBagId: string;
      productSku: string | null;
    }
  > = {};

  if (bagIds.length > 0) {
    const rows = await db
      .select({
        workflowBagId: rawBagAllocationSessions.workflowBagId,
        sessionId: rawBagAllocationSessions.id,
        startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
        receiptNumber: inventoryBags.internalReceiptNumber,
        inventoryBagId: rawBagAllocationSessions.inventoryBagId,
        productSku: productsTable.sku,
      })
      .from(rawBagAllocationSessions)
      .innerJoin(
        inventoryBags,
        eq(inventoryBags.id, rawBagAllocationSessions.inventoryBagId),
      )
      .leftJoin(productsTable, eq(productsTable.id, rawBagAllocationSessions.productId))
      .where(
        and(eq(rawBagAllocationSessions.allocationStatus, "OPEN")),
      );

    for (const row of rows) {
      if (!row.workflowBagId || !bagIds.includes(row.workflowBagId)) continue;
      allocationHints[row.workflowBagId] = {
        sessionId: row.sessionId,
        startingBalanceQty: row.startingBalanceQty,
        receiptNumber: row.receiptNumber,
        inventoryBagId: row.inventoryBagId,
        productSku: row.productSku,
      };
    }
  }

  const repairBagIds = bagIds.filter((id) => !allocationHints[id]);
  const repairStartingHints =
    repairBagIds.length > 0
      ? await loadRepairStartingBalanceHints(repairBagIds)
      : {};

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/finished-lots"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Finished lots
        </Link>
        <PageHeader
          title="Issue finished lot"
          description="For workflow bags, Luma calculates tablet consumption from finished units and product setup. Confirm only when physical use differed."
        />
      </div>
      <IssueLotForm
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          tabletsPerUnit: p.tabletsPerUnit ?? null,
          defaultShelfLifeDays: p.defaultShelfLifeDays ?? null,
        }))}
        finalizedBags={finalizedBags.map((r) => ({
          id: r.bag.id,
          finalizedAt:
            r.bag.finalizedAt instanceof Date
              ? r.bag.finalizedAt.toISOString()
              : r.bag.finalizedAt ?? null,
          productId: r.bag.productId ?? null,
          productName: r.product?.name ?? null,
          receiptNumber: r.receiptNumber ?? null,
          masterCases: r.metrics?.masterCases ?? null,
          displaysMade: r.metrics?.displaysMade ?? null,
          looseCards: r.metrics?.looseCards ?? null,
          unitsYielded: r.metrics?.unitsYielded ?? null,
        }))}
        allocationHints={allocationHints}
        repairStartingHints={repairStartingHints}
        initialBagId={requestedBagId ?? null}
      />
    </div>
  );
}
