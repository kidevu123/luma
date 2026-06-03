// START-3 + PARTIAL-BAG-RESTART — admin start production fallback.
//
// Default: redirect to live floor (normal workflow).
// With ?inventoryBagId=: render the supervisor start form for that bag
// (used from Available Partial Bags).

import { db } from "@/lib/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  productAllowedTablets,
  products,
  stations,
} from "@/lib/db/schema";
import { FIRST_OP_STATION_KINDS } from "@/lib/production/first-op-product";
import { requireLead } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { StartProductionForm } from "./start-production-form";
import { Info } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ inventoryBagId?: string }>;
};

export default async function StartProductionPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  if (!sp.inventoryBagId?.trim()) {
    redirect("/floor-board");
  }

  await requireLead();

  const [activeStations, allowedRows] = await Promise.all([
    db
      .select({ id: stations.id, label: stations.label, kind: stations.kind })
      .from(stations)
      .where(
        and(
          eq(stations.isActive, true),
          inArray(stations.kind, [
            ...FIRST_OP_STATION_KINDS,
          ] as (
            | "BLISTER"
            | "HANDPACK_BLISTER"
            | "BOTTLE_HANDPACK"
            | "COMBINED"
          )[]),
        ),
      )
      .orderBy(asc(stations.label)),
    db
      .select({
        tabletTypeId: productAllowedTablets.tabletTypeId,
        productId: products.id,
        productName: products.name,
        productSku: products.sku,
        productKind: products.kind,
      })
      .from(productAllowedTablets)
      .innerJoin(products, eq(products.id, productAllowedTablets.productId))
      .where(eq(products.isActive, true)),
  ]);

  const stationCount = activeStations.length;
  const stationReady = stationCount > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Start production"
        description="Restart a partial raw bag — pick station and finished product for this new run."
      />

      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          This run uses a new workflow bag. Choose the finished product for this
          restart; the previous run&apos;s product is shown on the partial-bags
          list for reference only and is not applied automatically.
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center h-6 px-2.5 rounded-md border text-[11px] font-mono ${
            stationReady
              ? "border-sky-200 bg-sky-50 text-sky-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {stationCount} active station{stationCount === 1 ? "" : "s"}
        </span>
      </div>

      <StartProductionForm
        stations={activeStations}
        allowedProductsByTabletType={groupAllowedProductsByTabletType(allowedRows)}
        initialInventoryBagId={sp.inventoryBagId.trim()}
      />
    </div>
  );
}

function groupAllowedProductsByTabletType(
  rows: Array<{
    tabletTypeId: string;
    productId: string | null;
    productName: string | null;
    productSku: string | null;
    productKind: string | null;
  }>,
): Record<string, Array<{ id: string; name: string; sku: string; kind: string }>> {
  const out: Record<string, Array<{ id: string; name: string; sku: string; kind: string }>> = {};
  for (const r of rows) {
    if (!r.productId) continue;
    const list = out[r.tabletTypeId] ?? [];
    list.push({
      id: r.productId,
      name: r.productName ?? "(unnamed)",
      sku: r.productSku ?? "",
      kind: r.productKind ?? "",
    });
    out[r.tabletTypeId] = list;
  }
  return out;
}
