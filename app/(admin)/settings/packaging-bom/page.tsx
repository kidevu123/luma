// Phase H.x5 — packaging BOM editor. For each product/SKU, configure
// which packaging materials are required and at what scope (per
// unit, per display, per case). The metric API + future projector
// hook read these rows to compute consumption at PACKAGING_COMPLETE.

import Link from "next/link";
import { db } from "@/lib/db";
import { eq, asc, sql } from "drizzle-orm";
import {
  products,
  packagingMaterials,
  productPackagingSpecs,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import {
  type PackagingBomScope,
} from "@/lib/production/packaging-bom-kinds";
import { getCompatibleMaterialsForProduct } from "@/lib/production/product-material-compatibility";
import {
  savePackagingBomLineAction,
  deletePackagingBomLineAction,
} from "./actions";
import { Info, PackageCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function PackagingBomPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const productList = await db
    .select({ id: products.id, sku: products.sku, name: products.name, kind: products.kind })
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(asc(products.name));

  const productId = sp.product;
  const product = productId
    ? productList.find((p) => p.id === productId) ?? null
    : null;

  const bomRows = product
    ? await db
        .select({
          productId: productPackagingSpecs.productId,
          packagingMaterialId: productPackagingSpecs.packagingMaterialId,
          perScope: productPackagingSpecs.perScope,
          qtyPerUnit: productPackagingSpecs.qtyPerUnit,
          wasteAllowancePercent: productPackagingSpecs.wasteAllowancePercent,
          materialSku: packagingMaterials.sku,
          materialName: packagingMaterials.name,
          materialKind: packagingMaterials.kind,
          materialUom: packagingMaterials.uom,
        })
        .from(productPackagingSpecs)
        .innerJoin(
          packagingMaterials,
          eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId),
        )
        .where(eq(productPackagingSpecs.productId, product.id))
        .orderBy(asc(productPackagingSpecs.perScope))
    : [];

  const productsWithoutBom = productId
    ? []
    : await db.execute<{ id: string; sku: string; name: string }>(sql`
        SELECT p.id, p.sku, p.name
        FROM products p
        WHERE p.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM product_packaging_specs pps WHERE pps.product_id = p.id
          )
        ORDER BY p.name
        LIMIT 50;
      `);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging BOM"
        description="Physical packaging consumed at each packaging level: per finished unit (card / bottle), per display, per master case. PVC and foil rolls are NOT configured here — they're machine consumables tracked under blister material standards + roll usage."
      />

      {/* Info panel */}
      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-[12px] leading-relaxed text-sky-800">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-sky-600" />
          <div>
            <p className="font-semibold text-sky-900">How packaging BOM is structured:</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5 text-sky-700">
              <li>
                <strong>Per finished unit</strong>: the printed card (CARD route) or
                the bottle + cap + label + induction seal + desiccant (BOTTLE route).
              </li>
              <li>
                <strong>Per display</strong>: 1 display box + any per-display
                insert. A display contains N finished units (via product structure,
                not BOM).
              </li>
              <li>
                <strong>Per master case</strong>: 1 case box + any case label /
                insert. A case contains N displays (via product structure).
              </li>
            </ul>
            <p className="mt-2 text-sky-600">
              PVC / foil / blister-foil rolls are calculated from{" "}
              <Link href="/settings/blister-standards" className="underline hover:text-sky-800">
                blister material standards
              </Link>
              {" + "}
              <Link href="/roll-variance" className="underline hover:text-sky-800">
                roll usage
              </Link>
              , not from this page.
            </p>
          </div>
        </div>
      </div>

      {/* Product picker */}
      <form
        method="get"
        className="rounded-xl border border-border bg-surface px-4 py-3 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-[280px] space-y-1">
          <Label htmlFor="product-picker">Product</Label>
          <Select id="product-picker" name="product" defaultValue={productId ?? ""}>
            <option value="">— pick a product —</option>
            {productList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name} · {p.kind}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">Open</Button>
      </form>

      {!product ? (
        <div className="rounded-xl border border-warn-200 bg-warn-50/60 px-4 py-3 text-sm text-warn-800 leading-relaxed">
          Pick a product to view + edit its packaging BOM.
          {productsWithoutBom.length > 0 && (
            <div className="mt-3">
              <strong>
                {productsWithoutBom.length} product
                {productsWithoutBom.length === 1 ? "" : "s"} with no BOM
              </strong>{" "}
              — packaging consumption cannot be computed until configured:
              <ul className="mt-1.5 space-y-0.5 text-[12px]">
                {productsWithoutBom.slice(0, 8).map((p) => (
                  <li key={p.id} className="font-mono">
                    <Link
                      href={`/settings/packaging-bom?product=${p.id}`}
                      className="text-brand-700 hover:text-brand-800 underline"
                    >
                      {p.sku}
                    </Link>{" "}
                    {p.name}
                  </li>
                ))}
                {productsWithoutBom.length > 8 && (
                  <li className="text-warn-600">
                    …and {productsWithoutBom.length - 8} more.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Product header */}
          <div className="rounded-xl border border-border bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold text-brand-700">
              {product.sku} — {product.name}
            </h2>
            <p className="mt-0.5 text-[12px] text-text-muted">
              {bomRows.length === 0
                ? "No BOM lines yet. Add the first one below."
                : `${bomRows.length} BOM line${bomRows.length === 1 ? "" : "s"} configured.`}
            </p>
          </div>

          {/* Three scope-specific forms */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {await Promise.all(
              (["UNIT", "DISPLAY", "CASE"] as const).map(async (scope) => {
                const compatibleRows = await getCompatibleMaterialsForProduct(
                  db,
                  product.id,
                  null,
                  scope,
                );
                return (
                  <ScopeBomForm
                    key={scope}
                    scope={scope}
                    productId={product.id}
                    materials={compatibleRows.map((r) => ({
                      id: r.materialId,
                      sku: r.materialSku,
                      name: r.materialName,
                      kind: r.materialKind,
                      uom: r.uom,
                      defaultForProduct: r.defaultForProduct,
                    }))}
                  />
                );
              }),
            )}
          </div>

          {/* Existing BOM rows */}
          {bomRows.length === 0 ? (
            <EmptyState
              icon={PackageCheck}
              title="No BOM lines yet"
              description="Add lines using the forms above."
            />
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Material</TH>
                  <TH>Kind</TH>
                  <TH>Per</TH>
                  <TH className="text-right">Qty</TH>
                  <TH className="text-right">Waste %</TH>
                  <TH>UoM</TH>
                  <TH>{""}</TH>
                </TR>
              </THead>
              <tbody>
                {bomRows.map((r) => (
                  <TR key={`${r.packagingMaterialId}-${r.perScope}`}>
                    <TD>
                      <div className="font-mono text-[11px] text-text-muted">{r.materialSku}</div>
                      <div className="font-medium text-text-strong">{r.materialName}</div>
                    </TD>
                    <TD>{r.materialKind}</TD>
                    <TD>{r.perScope}</TD>
                    <TD className="text-right font-mono">{r.qtyPerUnit}</TD>
                    <TD className="text-right font-mono">
                      {Number(r.wasteAllowancePercent ?? 0)}%
                    </TD>
                    <TD className="font-mono text-xs">{r.materialUom}</TD>
                    <TD className="text-right">
                      <form
                        action={async () => {
                          "use server";
                          await deletePackagingBomLineAction({
                            productId: r.productId,
                            packagingMaterialId: r.packagingMaterialId,
                            perScope: r.perScope as "UNIT" | "DISPLAY" | "CASE",
                          });
                        }}
                      >
                        <button
                          type="submit"
                          className="text-[11px] text-text-subtle hover:text-red-600 transition-colors"
                        >
                          delete
                        </button>
                      </form>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}
    </div>
  );
}

function ScopeBomForm({
  scope,
  productId,
  materials,
}: {
  scope: PackagingBomScope;
  productId: string;
  materials: ReadonlyArray<{
    id: string;
    sku: string;
    name: string;
    kind: string;
    uom: string;
    defaultForProduct: boolean;
  }>;
}) {
  const labels: Record<PackagingBomScope, { title: string; hint: string }> = {
    UNIT: {
      title: "Per finished unit",
      hint: "Materials consumed per card (CARD route) or bottle (BOTTLE route).",
    },
    DISPLAY: {
      title: "Per display",
      hint: "1 display box + any per-display insert. Card count per display comes from product structure, not here.",
    },
    CASE: {
      title: "Per master case",
      hint: "1 case box + any case label / insert. Displays per case comes from product structure, not here.",
    },
  };
  return (
    <form
      action={async (fd) => {
        "use server";
        await savePackagingBomLineAction(fd);
      }}
      className="rounded-xl border border-border bg-surface px-4 py-4 space-y-3"
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="perScope" value={scope} />
      <h3 className="text-sm font-semibold text-text-strong">
        {labels[scope].title}
      </h3>
      <p className="text-[11px] text-text-muted">{labels[scope].hint}</p>
      {materials.length === 0 ? (
        <p className="text-[12px] text-warn-700 leading-relaxed">
          <strong>Product material compatibility missing</strong> for {scope} scope.
          No materials are approved for this product yet — configure them under{" "}
          <Link
            href={`/settings/product-material-compatibility?product=${productId}`}
            className="underline hover:text-warn-800"
          >
            product material compatibility
          </Link>{" "}
          first.
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor={`material-${scope}`}>Material</Label>
            <Select id={`material-${scope}`} name="packagingMaterialId" required defaultValue="">
              <option value="">— select —</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.sku} — {m.name} ({m.kind} · {m.uom})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`qty-${scope}`}>Quantity per {scope.toLowerCase()}</Label>
            <Input id={`qty-${scope}`} name="qtyPerUnit" type="number" min={1} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`waste-${scope}`}>Waste %</Label>
            <Input
              id={`waste-${scope}`}
              name="wasteAllowancePercent"
              type="number"
              min={0}
              max={100}
              step="0.01"
              defaultValue="0"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`notes-${scope}`}>Notes (optional)</Label>
            <Input id={`notes-${scope}`} name="notes" placeholder="any context…" />
          </div>
          <Button type="submit">Save {scope.toLowerCase()} line</Button>
        </>
      )}
    </form>
  );
}
