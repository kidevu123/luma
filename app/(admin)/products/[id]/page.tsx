import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { getProductWithBom } from "@/lib/db/queries/products";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BomEditor } from "./bom-editor";
import { ZohoMappingForm } from "./zoho-mapping-form";
import { db } from "@/lib/db";
import { productPackagingSpecs } from "@/lib/db/schema";
import { floorReadinessLevel, floorReadinessLabel } from "@/lib/production/product-floor-readiness";

export const dynamic = "force-dynamic";

export default async function ProductBomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const [product, tablets, materials, assignedRows] = await Promise.all([
    getProductWithBom(id),
    listTabletTypes(),
    listPackagingMaterials(),
    db.selectDistinct({ id: productPackagingSpecs.packagingMaterialId })
      .from(productPackagingSpecs),
  ]);
  if (!product) notFound();
  // Material IDs assigned to ANY product — used by BomEditor to hide
  // already-claimed PACKAGING items from the picker dropdown globally.
  const globallyAssignedIds = assignedRows.map((r) => r.id);
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
          productName={product.name}
          globallyAssignedIds={globallyAssignedIds}
          tablets={tablets.map((t) => ({ id: t.id, name: t.name }))}
          materials={materials.map((m) => ({
            id: m.id,
            sku: m.sku,
            name: m.name,
            kind: m.kind,
            uom: m.uom,
            category: m.category,
          }))}
          allowed={product.allowed}
          specs={product.specs}
          {...(product.lotSummary ? { lotSummary: product.lotSummary } : {})}
        />
      </div>

      <FloorReadinessCard
        isActive={product.isActive}
        tabletMappingCount={product.allowed.length}
        tabletNames={product.allowed.map((a) => a.tabletName)}
      />

      <Card>
        <CardHeader>
          <CardTitle>Zoho assembly mapping</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[11px] text-text-muted mb-4 leading-relaxed">
            These IDs map Luma product levels to existing Zoho composite items. Luma will use
            these later for tablet receiving and assembly jobs. They must match the Zoho item IDs
            exactly — Luma does not create or validate Zoho items.
          </p>
          <ZohoMappingForm
            productId={product.id}
            kind={product.kind}
            unitsPerDisplay={product.unitsPerDisplay ?? null}
            displaysPerCase={product.displaysPerCase ?? null}
            zohoItemIdFallback={product.zohoItemId ?? null}
            zohoItemIdUnit={product.zohoItemIdUnit ?? null}
            zohoItemIdDisplay={product.zohoItemIdDisplay ?? null}
            zohoItemIdCase={product.zohoItemIdCase ?? null}
          />
        </CardContent>
      </Card>
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

// ── Floor readiness ──────────────────────────────────────────────────────────

function FloorReadinessCard({
  isActive,
  tabletMappingCount,
  tabletNames,
}: {
  isActive: boolean;
  tabletMappingCount: number;
  tabletNames: string[];
}) {
  const level = floorReadinessLevel({ isActive, tabletMappingCount });

  const styles = {
    ready: {
      container: "border-emerald-200 bg-emerald-50/60",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />,
      title: "text-emerald-900",
      body: "text-emerald-800/80",
    },
    "no-tablet-mapping": {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    inactive: {
      container: "border-border bg-surface-2/40",
      icon: <XCircle className="h-4 w-4 text-text-muted flex-shrink-0 mt-0.5" />,
      title: "text-text-muted",
      body: "text-text-subtle",
    },
  }[level];

  const detail =
    level === "ready"
      ? `Tablet types: ${tabletNames.join(", ")}`
      : level === "no-tablet-mapping"
        ? "Open the Bill of Materials section below and check the tablet types this product should use."
        : "Activate this product to allow it to appear in floor station pickers.";

  return (
    <div className={`rounded-xl border px-4 py-3 flex gap-3 ${styles.container}`}>
      {styles.icon}
      <div className="space-y-0.5">
        <p className={`text-sm font-semibold ${styles.title}`}>
          {floorReadinessLabel(level)}
        </p>
        <p className={`text-xs ${styles.body}`}>{detail}</p>
      </div>
    </div>
  );
}
