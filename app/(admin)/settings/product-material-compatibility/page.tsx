// PBOM-2 — Product material compatibility admin page.
//
// Gating layer in front of /settings/packaging-bom. Admins author
// which packaging materials are approved for each product / scope /
// role here; the BOM page reads from this matrix when building its
// per-scope dropdowns. PBOM-1's kind filter still applies — PVC /
// foil / blister-foil can't be registered here at all.
//
// Layout: pick a product → see grouped rows by scope (UNIT / DISPLAY
// / CASE) → add new compatible material via the form at the bottom.
// Readiness checklist surfaces missing scopes so the admin knows what
// to configure before the BOM page will accept lines.

import Link from "next/link";
import { db } from "@/lib/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  products,
  packagingMaterials,
  productMaterialCompatibility,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  COMPATIBILITY_ROLES,
  type CompatibilityRole,
} from "@/lib/production/product-material-compatibility";
import {
  allowedKindsForScope,
  type PackagingBomScope,
} from "@/lib/production/packaging-bom-kinds";
import {
  addCompatibilityAction,
  deactivateCompatibilityAction,
} from "./actions";

export const dynamic = "force-dynamic";

const SCOPES = ["UNIT", "DISPLAY", "CASE"] as const;

const SCOPE_LABEL: Record<PackagingBomScope, string> = {
  UNIT: "Per finished unit (CARD / BOTTLE per-unit)",
  DISPLAY: "Per display",
  CASE: "Per master case",
};

export default async function ProductMaterialCompatibilityPage({
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product material compatibility"
        description="Approve which packaging materials each product can use at each scope. /settings/packaging-bom reads from this matrix — empty matrix means empty BOM dropdowns (no silent fallback to the global material list)."
      />

      <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-3 text-[12px] text-sky-100 leading-relaxed">
        <p className="font-semibold">How this fits together</p>
        <ul className="mt-1 list-disc pl-5 space-y-0.5 text-sky-200/90">
          <li>
            <strong>Compatibility (this page)</strong>: which materials are
            allowed for a product at each scope.
          </li>
          <li>
            <strong>BOM</strong> (
            <Link
              href="/settings/packaging-bom"
              className="underline hover:text-sky-50"
            >
              /settings/packaging-bom
            </Link>
            ): how much of each compatible material is consumed per unit /
            display / case.
          </li>
          <li>
            <strong>Roll standards</strong> (
            <Link
              href="/settings/blister-standards"
              className="underline hover:text-sky-50"
            >
              /settings/blister-standards
            </Link>
            ): PVC + foil + blister-foil — NOT configured on this page.
          </li>
        </ul>
      </div>

      {/* Product picker */}
      <form
        method="get"
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3 flex flex-wrap items-end gap-2"
      >
        <label className="block flex-1 min-w-[280px]">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Product
          </span>
          <select
            name="product"
            defaultValue={productId ?? ""}
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100"
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
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200">
          Pick a product to view + edit its material compatibility.
        </div>
      ) : (
        <ProductCompatibilityEditor product={product} />
      )}
    </div>
  );
}

async function ProductCompatibilityEditor({
  product,
}: {
  product: { id: string; sku: string; name: string; kind: string };
}) {
  // Pull every compatibility row for this product (active + inactive)
  // joined to packaging_materials. Inactive rows surface in a separate
  // band so audit history stays visible without polluting the active
  // matrix.
  const rows = await db
    .select({
      id: productMaterialCompatibility.id,
      routeId: productMaterialCompatibility.routeId,
      materialId: productMaterialCompatibility.materialId,
      scope: productMaterialCompatibility.scope,
      compatibilityRole: productMaterialCompatibility.compatibilityRole,
      required: productMaterialCompatibility.required,
      defaultForProduct: productMaterialCompatibility.defaultForProduct,
      active: productMaterialCompatibility.active,
      notes: productMaterialCompatibility.notes,
      materialSku: packagingMaterials.sku,
      materialName: packagingMaterials.name,
      materialKind: packagingMaterials.kind,
      materialUom: packagingMaterials.uom,
    })
    .from(productMaterialCompatibility)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, productMaterialCompatibility.materialId),
    )
    .where(eq(productMaterialCompatibility.productId, product.id))
    .orderBy(
      desc(productMaterialCompatibility.active),
      asc(productMaterialCompatibility.scope),
      desc(productMaterialCompatibility.defaultForProduct),
    );

  // Eligible materials for the add-form (active + non-machine-consumable).
  const candidateMaterials = await db.execute<{
    id: string;
    sku: string;
    name: string;
    kind: string;
    uom: string;
  }>(sql`
    SELECT id, sku, name, kind::text AS kind, uom
    FROM packaging_materials
    WHERE is_active = true
      AND kind NOT IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    ORDER BY name
  `);

  // Readiness checklist: count of ACTIVE rows per scope.
  const scopeReadiness: Record<PackagingBomScope, number> = {
    UNIT: 0,
    DISPLAY: 0,
    CASE: 0,
  };
  for (const r of rows) {
    if (r.active) {
      scopeReadiness[r.scope as PackagingBomScope] += 1;
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3">
        <h2 className="text-[11px] uppercase tracking-[0.10em] text-cyan-300 font-semibold">
          {product.sku} — {product.name} · {product.kind}
        </h2>
        <ul className="mt-2 text-[12px] text-slate-300 space-y-0.5">
          {SCOPES.map((s) => (
            <li key={s}>
              {scopeReadiness[s] > 0 ? "✓" : "•"} {SCOPE_LABEL[s]}:{" "}
              <span
                className={
                  scopeReadiness[s] > 0
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              >
                {scopeReadiness[s]} compatible material{scopeReadiness[s] === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          <li>
            • Blister roll standards:{" "}
            <Link
              href="/settings/blister-standards"
              className="underline text-cyan-300 hover:text-cyan-200"
            >
              configured separately
            </Link>
          </li>
          <li>
            • Packaging BOM:{" "}
            <Link
              href={`/settings/packaging-bom?product=${product.id}`}
              className="underline text-cyan-300 hover:text-cyan-200"
            >
              configure consumption quantities
            </Link>
          </li>
        </ul>
      </div>

      {/* Active rows grouped by scope */}
      {SCOPES.map((scope) => {
        const scopeRows = rows.filter((r) => r.scope === scope && r.active);
        return (
          <div
            key={scope}
            className="rounded-md border border-slate-700/60 bg-slate-900/60"
          >
            <div className="px-3 py-2 border-b border-slate-800 bg-slate-900">
              <h3 className="text-sm font-semibold text-slate-100">
                {SCOPE_LABEL[scope]}
              </h3>
              <p className="text-[11px] text-slate-400">
                Allowed kinds at this scope:{" "}
                <span className="font-mono">
                  {allowedKindsForScope(scope).join(", ")}
                </span>
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="text-left px-3 py-2">Material</th>
                  <th className="text-left px-3 py-2">Kind</th>
                  <th className="text-left px-3 py-2">Role</th>
                  <th className="text-left px-3 py-2">Required</th>
                  <th className="text-left px-3 py-2">Default</th>
                  <th className="text-left px-3 py-2">Notes</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {scopeRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-3 text-center text-amber-300 text-[12px]"
                    >
                      No compatible materials configured for {scope} scope.
                    </td>
                  </tr>
                ) : (
                  scopeRows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-800">
                      <td className="px-3 py-2 text-slate-100">
                        <div className="font-mono text-[11px] text-slate-400">
                          {r.materialSku}
                        </div>
                        <div>{r.materialName}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-300 text-[12px]">
                        {r.materialKind}
                      </td>
                      <td className="px-3 py-2 text-slate-300 text-[12px]">
                        {r.compatibilityRole}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        {r.required ? (
                          <span className="text-amber-300">required</span>
                        ) : (
                          <span className="text-slate-500">optional</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        {r.defaultForProduct ? (
                          <span className="text-emerald-300">default</span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-400 text-[11px] italic">
                        {r.notes ?? ""}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form
                          action={async () => {
                            "use server";
                            await deactivateCompatibilityAction({ id: r.id });
                          }}
                        >
                          <button
                            type="submit"
                            className="text-[11px] text-rose-300 hover:text-rose-200"
                          >
                            deactivate
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* Add form */}
      <form
        action={async (fd) => {
          "use server";
          await addCompatibilityAction(fd);
        }}
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <input type="hidden" name="productId" value={product.id} />
        <h3 className="md:col-span-3 text-sm font-semibold text-slate-100">
          Add compatibility
        </h3>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Material
          </span>
          <select
            name="materialId"
            required
            defaultValue=""
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100"
          >
            <option value="">— select —</option>
            {candidateMaterials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.sku} — {m.name} ({m.kind} · {m.uom})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Scope
          </span>
          <select
            name="scope"
            required
            defaultValue=""
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100"
          >
            <option value="">— select —</option>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Role
          </span>
          <select
            name="compatibilityRole"
            required
            defaultValue=""
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100"
          >
            <option value="">— select —</option>
            {COMPATIBILITY_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-slate-300">
          <input type="checkbox" name="required" value="true" /> required
        </label>
        <label className="flex items-center gap-2 text-[12px] text-slate-300">
          <input type="checkbox" name="defaultForProduct" value="true" /> default for product
        </label>
        <label className="block md:col-span-3">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Notes
          </span>
          <input
            name="notes"
            placeholder="optional context"
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100"
          />
        </label>
        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Add compatibility
          </button>
        </div>
      </form>

      {/* Inactive history */}
      {rows.some((r) => !r.active) ? (
        <details className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-[12px] text-slate-400">
          <summary className="cursor-pointer">
            Show inactive history ({rows.filter((r) => !r.active).length})
          </summary>
          <ul className="mt-2 space-y-1">
            {rows
              .filter((r) => !r.active)
              .map((r) => (
                <li key={r.id} className="font-mono text-[11px]">
                  {r.scope} · {r.compatibilityRole as CompatibilityRole} ·{" "}
                  {r.materialSku} — {r.materialName}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
