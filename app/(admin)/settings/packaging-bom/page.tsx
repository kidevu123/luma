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
import { PageHeader } from "@/components/ui/page-header";
import {
  savePackagingBomLineAction,
  deletePackagingBomLineAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function PackagingBomPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [productList, materialList] = await Promise.all([
    db
      .select({ id: products.id, sku: products.sku, name: products.name, kind: products.kind })
      .from(products)
      .where(eq(products.isActive, true))
      .orderBy(asc(products.name)),
    db
      .select({
        id: packagingMaterials.id,
        sku: packagingMaterials.sku,
        name: packagingMaterials.name,
        kind: packagingMaterials.kind,
        uom: packagingMaterials.uom,
      })
      .from(packagingMaterials)
      .where(eq(packagingMaterials.isActive, true))
      .orderBy(asc(packagingMaterials.name)),
  ]);

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

  // Products with no BOM (warning surface).
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
        description="Configure required packaging materials per finished product. The metric API consumes these at packaging-complete time once Phase H.x3 wires the live projector hook."
      />

      {/* Product picker */}
      <form
        method="get"
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3 flex flex-wrap items-end gap-2"
      >
        <label className="block flex-1 min-w-[280px]">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">Product</span>
          <select
            name="product"
            defaultValue={productId ?? ""}
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            <option value="">— pick a product —</option>
            {productList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name} · {p.kind}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-9 px-3 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm"
        >
          Open
        </button>
      </form>

      {!product ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200 leading-relaxed">
          Pick a product to view + edit its packaging BOM.
          {productsWithoutBom.length > 0 && (
            <div className="mt-3 text-amber-300">
              <strong>
                {productsWithoutBom.length} product
                {productsWithoutBom.length === 1 ? "" : "s"} with no BOM
              </strong>{" "}
              — packaging consumption cannot be computed until configured:
              <ul className="mt-1.5 space-y-0.5 text-amber-100 text-[12px]">
                {productsWithoutBom.slice(0, 8).map((p) => (
                  <li key={p.id} className="font-mono">
                    <Link
                      href={`/settings/packaging-bom?product=${p.id}`}
                      className="text-cyan-300 hover:text-cyan-200"
                    >
                      {p.sku}
                    </Link>{" "}
                    {p.name}
                  </li>
                ))}
                {productsWithoutBom.length > 8 && (
                  <li className="text-amber-300/70">
                    …and {productsWithoutBom.length - 8} more.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3">
            <h2 className="text-[11px] uppercase tracking-[0.10em] text-cyan-300 font-semibold">
              {product.sku} — {product.name}
            </h2>
            <p className="mt-1 text-[12px] text-slate-400">
              {bomRows.length === 0
                ? "No BOM lines yet. Add the first one below."
                : `${bomRows.length} BOM line${bomRows.length === 1 ? "" : "s"} configured.`}
            </p>
          </div>

          {/* New / update line form */}
          <form
            action={async (fd) => {
              "use server";
              await savePackagingBomLineAction(fd);
            }}
            className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
          >
            <input type="hidden" name="productId" value={product.id} />
            <h3 className="md:col-span-4 text-sm font-semibold text-slate-100">
              Add / update BOM line
            </h3>
            <SelectField
              name="packagingMaterialId"
              label="Material"
              required
              options={materialList.map((m) => ({
                value: m.id,
                label: `${m.sku} — ${m.name} (${m.kind} · ${m.uom})`,
              }))}
            />
            <SelectField
              name="perScope"
              label="Per"
              required
              options={[
                { value: "UNIT", label: "per finished unit (card / bottle)" },
                { value: "DISPLAY", label: "per display" },
                { value: "CASE", label: "per master case" },
              ]}
            />
            <Field
              name="qtyPerUnit"
              label="Quantity"
              type="number"
              min={1}
              required
            />
            <Field
              name="wasteAllowancePercent"
              label="Waste %"
              type="number"
              min={0}
              max={100}
              step="0.01"
              defaultValue="0"
            />
            <Field
              name="notes"
              label="Notes (optional)"
              placeholder="any context…"
            />
            <div className="md:col-span-4 flex justify-end">
              <button
                type="submit"
                className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
              >
                Save line
              </button>
            </div>
          </form>

          {/* Existing rows */}
          <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="text-left px-3 py-2">Material</th>
                  <th className="text-left px-3 py-2">Kind</th>
                  <th className="text-left px-3 py-2">Per</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">Waste %</th>
                  <th className="text-left px-3 py-2">UoM</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {bomRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                      No BOM lines yet.
                    </td>
                  </tr>
                ) : (
                  bomRows.map((r) => (
                    <tr key={`${r.packagingMaterialId}-${r.perScope}`} className="border-t border-slate-800">
                      <td className="px-3 py-2 text-slate-200">
                        <div className="font-mono text-[11px] text-slate-400">{r.materialSku}</div>
                        <div>{r.materialName}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{r.materialKind}</td>
                      <td className="px-3 py-2 text-slate-300">{r.perScope}</td>
                      <td className="px-3 py-2 text-right text-slate-100 font-mono">
                        {r.qtyPerUnit}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300 font-mono">
                        {Number(r.wasteAllowancePercent ?? 0)}%
                      </td>
                      <td className="px-3 py-2 text-slate-300 font-mono">{r.materialUom}</td>
                      <td className="px-3 py-2 text-right">
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
                            className="text-[11px] text-rose-300 hover:text-rose-200"
                          >
                            delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  min,
  max,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(max != null ? { max } : {})}
        {...(step ? { step } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  options,
  required,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
      >
        <option value="">— select —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

