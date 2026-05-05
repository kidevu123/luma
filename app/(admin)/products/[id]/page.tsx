import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { getProductWithBom } from "@/lib/db/queries/products";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BomEditor } from "./bom-editor";

export const dynamic = "force-dynamic";

export default async function ProductBomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const [product, tablets, materials] = await Promise.all([
    getProductWithBom(id),
    listTabletTypes(),
    listPackagingMaterials(),
  ]);
  if (!product) notFound();
  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/products"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> All products
        </Link>
        <PageHeader
          title={product.name}
          description={`SKU ${product.sku} · ${product.kind}`}
          actions={
            <StatusPill kind={product.isActive ? "ok" : "neutral"}>
              {product.isActive ? "Active" : "Inactive"}
            </StatusPill>
          }
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Spec</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <SpecRow label="Tablets per unit" value={product.tabletsPerUnit ?? "—"} />
            <SpecRow label="Units per display" value={product.unitsPerDisplay ?? "—"} />
            <SpecRow label="Displays per case" value={product.displaysPerCase ?? "—"} />
            <SpecRow
              label="Default shelf life"
              value={product.defaultShelfLifeDays ? `${product.defaultShelfLifeDays} days` : "—"}
            />
            <SpecRow label="Zoho item id" value={product.zohoItemId ?? "—"} mono />
          </CardContent>
        </Card>

        <BomEditor
          productId={product.id}
          tablets={tablets.map((t) => ({ id: t.id, name: t.name }))}
          materials={materials.map((m) => ({
            id: m.id,
            sku: m.sku,
            name: m.name,
            kind: m.kind,
            uom: m.uom,
          }))}
          allowed={product.allowed}
          specs={product.specs}
        />
      </div>
    </div>
  );
}

function SpecRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span
        className={`font-semibold tabular-nums${mono ? " font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
