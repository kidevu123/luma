import Link from "next/link";
import { Plus, Boxes } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listProducts } from "@/lib/db/queries/products";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ProductDialog } from "./product-dialog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await requireAdmin();
  const [rows, tabletTypes] = await Promise.all([listProducts(), listTabletTypes()]);
  const tabletTypeOptions = tabletTypes.map((t) => ({ id: t.id, name: t.name }));
  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description="Finished goods. Each product has a kind (card, bottle, variety) and packaging spec (tablets/unit, units/display, displays/case)."
        actions={<ProductDialog triggerLabel="New product" triggerIcon={<Plus className="h-4 w-4" aria-hidden />} tabletTypes={tabletTypeOptions} />}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No products yet"
          description="Create your first product so receiving + packaging have something to point at."
          action={<ProductDialog triggerLabel="Create product" triggerIcon={<Plus className="h-4 w-4" aria-hidden />} tabletTypes={tabletTypeOptions} />}
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
              <TH className="text-right">allowed tablets</TH>
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
                <TD className="text-right tabular-nums">{r.allowedCount}</TD>
                <TD>
                  <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                    {r.isActive ? "Active" : "Inactive"}
                  </StatusPill>
                </TD>
                <TD className="text-right">
                  <ProductDialog row={r} triggerLabel="Edit" tabletTypes={tabletTypeOptions} />
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
