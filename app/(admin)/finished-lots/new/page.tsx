import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireLead } from "@/lib/auth-guards";
import { listProducts } from "@/lib/db/queries/products";
import { listFinalizedBagsWithoutLot } from "@/lib/db/queries/finished-lots";
import { PageHeader } from "@/components/ui/page-header";
import { IssueLotForm } from "./issue-form";

export const dynamic = "force-dynamic";

export default async function NewFinishedLotPage() {
  await requireLead();
  const [products, finalizedBags] = await Promise.all([
    listProducts(),
    listFinalizedBagsWithoutLot(),
  ]);
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
          description="Pick a finalized bag (optional) and fill in the lot details. Genealogy is inferred from the bag's consumption events."
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
          finalizedAt: r.bag.finalizedAt as unknown as string | null,
          productId: r.bag.productId ?? null,
          productName: r.product?.name ?? null,
        }))}
      />
    </div>
  );
}
