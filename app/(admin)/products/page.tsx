import { Plus, Boxes } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listProducts } from "@/lib/db/queries/products";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { ProductDialog } from "./product-dialog";
import { ProductsBrowser } from "./products-browser";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await requireAdmin();
  const raw = await listProducts();
  const rows = raw.map((r) => ({
    ...r,
    allowedCount: Math.max(0, Math.round(Number(r.allowedCount))),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description="Finished goods. Create a product, then configure its allowed tablets and packaging BOM on the product page."
        actions={<ProductDialog triggerLabel="New product" triggerIcon={<Plus className="h-4 w-4" aria-hidden />} />}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No products yet"
          description="Create your first product so receiving + packaging have something to point at."
          action={<ProductDialog triggerLabel="Create product" triggerIcon={<Plus className="h-4 w-4" aria-hidden />} />}
        />
      ) : (
        <ProductsBrowser rows={rows} />
      )}
    </div>
  );
}
