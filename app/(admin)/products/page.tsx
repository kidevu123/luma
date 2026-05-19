import Link from "next/link";
import { Plus, Boxes, Settings2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listProducts } from "@/lib/db/queries/products";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ProductDialog } from "./product-dialog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await requireAdmin();
  const rows = await listProducts();
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
        <DataTable>
          <THead>
            <TR>
              <TH>SKU</TH>
              <TH>Name</TH>
              <TH>Kind</TH>
              <TH className="text-right">tabs/unit</TH>
              <TH className="text-right">units/display</TH>
              <TH className="text-right">displays/case</TH>
              <TH className="text-right">tablets</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-xs">{r.sku}</TD>
                <TD className="font-medium">
                  <Link href={`/products/${r.id}`} className="hover:underline">
                    {r.name}
                  </Link>
                </TD>
                <TD>
                  <StatusPill kind={r.kind === "VARIETY" ? "info" : "neutral"}>
                    {r.kind}
                  </StatusPill>
                </TD>
                <TD className="text-right tabular-nums">{r.tabletsPerUnit ?? "—"}</TD>
                <TD className="text-right tabular-nums">{r.unitsPerDisplay ?? "—"}</TD>
                <TD className="text-right tabular-nums">{r.displaysPerCase ?? "—"}</TD>
                <TD className="text-right tabular-nums">
                  {r.allowedCount > 0 ? (
                    r.allowedCount
                  ) : (
                    <span className="text-amber-600 text-xs">none</span>
                  )}
                </TD>
                <TD>
                  <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                    {r.isActive ? "Active" : "Inactive"}
                  </StatusPill>
                </TD>
                <TD className="text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/products/${r.id}`}
                      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
                    >
                      <Settings2 className="h-3 w-3" />
                      BOM
                    </Link>
                    <ProductDialog row={r} triggerLabel="Edit" />
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
