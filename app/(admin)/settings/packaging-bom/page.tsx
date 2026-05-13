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
  allowedKindsForScope,
  type PackagingBomScope,
  type PackagingMaterialKind,
} from "@/lib/production/packaging-bom-kinds";
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
        description="Physical packaging consumed at each packaging level: per finished unit (card / bottle), per display, per master case. PVC and foil rolls are NOT configured here — they're machine consumables tracked under blister material standards + roll usage."
      />

      <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-3 text-[12px] leading-relaxed text-sky-100">
        <p className="font-semibold text-sky-100">How packaging BOM is structured:</p>
        <ul className="mt-1 list-disc pl-5 space-y-0.5 text-sky-200/90">
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
        <p className="mt-2 text-sky-200/80">
          PVC / foil / blister-foil rolls are calculated from{" "}
          <Link
            href="/settings/blister-standards"
            className="underline hover:text-sky-50"
          >
            blister material standards
          </Link>
          {" + "}
          <Link href="/roll-variance" className="underline hover:text-sky-50">
            roll usage
          </Link>
          , not from this page.
        </p>
      </div>

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

          {/* Three scope-specific forms — each shows only materials
              whose kind is valid at that scope. Server still
              re-validates via lib/production/packaging-bom-kinds. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {(["UNIT", "DISPLAY", "CASE"] as const).map((scope) => {
              const allowedKinds = allowedKindsForScope(scope) as ReadonlyArray<string>;
              const scopeMaterials = materialList.filter((m) =>
                allowedKinds.includes(m.kind as PackagingMaterialKind),
              );
              return (
                <ScopeBomForm
                  key={scope}
                  scope={scope}
                  productId={product.id}
                  materials={scopeMaterials}
                />
              );
            })}
          </div>

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
      className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 space-y-3"
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="perScope" value={scope} />
      <h3 className="text-sm font-semibold text-slate-100">
        {labels[scope].title}
      </h3>
      <p className="text-[11px] text-slate-400">{labels[scope].hint}</p>
      {materials.length === 0 ? (
        <p className="text-[12px] text-amber-300">
          No active materials of a kind valid for {scope}. Add the right
          packaging-material kind under{" "}
          <Link
            href="/settings/materials"
            className="underline hover:text-amber-200"
          >
            materials
          </Link>{" "}
          first.
        </p>
      ) : (
        <>
          <SelectField
            name="packagingMaterialId"
            label="Material"
            required
            options={materials.map((m) => ({
              value: m.id,
              label: `${m.sku} — ${m.name} (${m.kind} · ${m.uom})`,
            }))}
          />
          <Field
            name="qtyPerUnit"
            label={`Quantity per ${scope.toLowerCase()}`}
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
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Save {scope.toLowerCase()} line
          </button>
        </>
      )}
    </form>
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

