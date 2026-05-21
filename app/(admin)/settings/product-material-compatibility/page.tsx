// PBOM-2 — Product material compatibility admin page.
//
// Gating layer in front of /settings/packaging-bom. Admins author
// which packaging materials are approved for each product / scope /
// role here; the BOM page reads from this matrix when building its
// per-scope dropdowns. PBOM-1's kind filter still applies — PVC /
// foil / blister-foil can't be registered here at all.

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
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
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
import { Info } from "lucide-react";

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

      {/* Info panel */}
      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-[12px] text-sky-800 leading-relaxed">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-sky-600" />
          <div>
            <p className="font-semibold text-sky-900">How this fits together</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5 text-sky-700">
              <li>
                <strong>Compatibility (this page)</strong>: which materials are
                allowed for a product at each scope.
              </li>
              <li>
                <strong>BOM</strong> (
                <Link href="/settings/packaging-bom" className="underline hover:text-sky-900">
                  /settings/packaging-bom
                </Link>
                ): how much of each compatible material is consumed per unit /
                display / case.
              </li>
              <li>
                <strong>Roll standards</strong> (
                <Link href="/settings/blister-standards" className="underline hover:text-sky-900">
                  /settings/blister-standards
                </Link>
                ): PVC + foil + blister-foil — NOT configured on this page.
              </li>
            </ul>
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
        <div className="rounded-xl border border-warn-200 bg-warn-50/60 px-4 py-3 text-sm text-warn-800">
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
      {/* Product header + readiness */}
      <div className="rounded-xl border border-border bg-surface px-4 py-3">
        <h2 className="text-sm font-semibold text-brand-700">
          {product.sku} — {product.name} · {product.kind}
        </h2>
        <ul className="mt-2 text-[12px] space-y-0.5">
          {SCOPES.map((s) => (
            <li key={s} className="text-text-muted">
              {scopeReadiness[s] > 0 ? "✓" : "•"} {SCOPE_LABEL[s]}:{" "}
              <span className={scopeReadiness[s] > 0 ? "text-good-700 font-medium" : "text-warn-700"}>
                {scopeReadiness[s]} compatible material{scopeReadiness[s] === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          <li className="text-text-muted">
            • Blister roll standards:{" "}
            <Link href="/settings/blister-standards" className="underline text-brand-700 hover:text-brand-800">
              configured separately
            </Link>
          </li>
          <li className="text-text-muted">
            • Packaging BOM:{" "}
            <Link href={`/settings/packaging-bom?product=${product.id}`} className="underline text-brand-700 hover:text-brand-800">
              configure consumption quantities
            </Link>
          </li>
        </ul>
      </div>

      {/* Active rows grouped by scope */}
      {SCOPES.map((scope) => {
        const scopeRows = rows.filter((r) => r.scope === scope && r.active);
        return (
          <div key={scope} className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
              <h3 className="text-sm font-semibold text-text-strong">
                {SCOPE_LABEL[scope]}
              </h3>
              <p className="text-[11px] text-text-muted">
                Allowed kinds at this scope:{" "}
                <span className="font-mono">{allowedKindsForScope(scope).join(", ")}</span>
              </p>
            </div>
            <DataTable>
              <THead>
                <TR>
                  <TH>Material</TH>
                  <TH>Kind</TH>
                  <TH>Role</TH>
                  <TH>Required</TH>
                  <TH>Default</TH>
                  <TH>Notes</TH>
                  <TH>{""}</TH>
                </TR>
              </THead>
              <tbody>
                {scopeRows.length === 0 ? (
                  <TR>
                    <TD colSpan={7} className="text-center text-warn-700 text-[12px]">
                      No compatible materials configured for {scope} scope.
                    </TD>
                  </TR>
                ) : (
                  scopeRows.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        <div className="font-mono text-[11px] text-text-muted">{r.materialSku}</div>
                        <div className="font-medium text-text-strong">{r.materialName}</div>
                      </TD>
                      <TD className="text-[12px]">{r.materialKind}</TD>
                      <TD className="text-[12px]">{r.compatibilityRole}</TD>
                      <TD className="text-[12px]">
                        {r.required ? (
                          <span className="text-warn-700 font-medium">required</span>
                        ) : (
                          <span className="text-text-subtle">optional</span>
                        )}
                      </TD>
                      <TD className="text-[12px]">
                        {r.defaultForProduct ? (
                          <span className="text-good-700 font-medium">default</span>
                        ) : (
                          <span className="text-text-subtle">—</span>
                        )}
                      </TD>
                      <TD className="text-[11px] text-text-muted italic">{r.notes ?? ""}</TD>
                      <TD className="text-right">
                        <form
                          action={async () => {
                            "use server";
                            await deactivateCompatibilityAction({ id: r.id });
                          }}
                        >
                          <button
                            type="submit"
                            className="text-[11px] text-text-subtle hover:text-red-600 transition-colors"
                          >
                            deactivate
                          </button>
                        </form>
                      </TD>
                    </TR>
                  ))
                )}
              </tbody>
            </DataTable>
          </div>
        );
      })}

      {/* Add compatibility form */}
      <div className="rounded-xl border border-border bg-surface px-4 py-4 space-y-4">
        <p className="text-sm font-semibold text-text-strong">Add compatibility</p>
        <form
          action={async (fd) => {
            "use server";
            await addCompatibilityAction(fd);
          }}
          className="grid grid-cols-1 md:grid-cols-3 gap-3"
        >
          <input type="hidden" name="productId" value={product.id} />
          <div className="space-y-1">
            <Label htmlFor="compat-material">Material</Label>
            <Select id="compat-material" name="materialId" required defaultValue="">
              <option value="">— select —</option>
              {candidateMaterials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.sku} — {m.name} ({m.kind} · {m.uom})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="compat-scope">Scope</Label>
            <Select id="compat-scope" name="scope" required defaultValue="">
              <option value="">— select —</option>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="compat-role">Role</Label>
            <Select id="compat-role" name="compatibilityRole" required defaultValue="">
              <option value="">— select —</option>
              {COMPATIBILITY_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-text-muted">
            <input
              type="checkbox"
              name="required"
              value="true"
              className="h-4 w-4 rounded border-border accent-brand-700"
            />
            required
          </label>
          <label className="flex items-center gap-2 text-[12px] text-text-muted">
            <input
              type="checkbox"
              name="defaultForProduct"
              value="true"
              className="h-4 w-4 rounded border-border accent-brand-700"
            />
            default for product
          </label>
          <div className="space-y-1 md:col-span-3">
            <Label htmlFor="compat-notes">Notes (optional)</Label>
            <Input id="compat-notes" name="notes" placeholder="optional context" />
          </div>
          <div className="md:col-span-3 flex justify-end">
            <Button type="submit">Add compatibility</Button>
          </div>
        </form>
      </div>

      {/* Inactive history */}
      {rows.some((r) => !r.active) && (
        <details className="rounded-xl border border-border bg-surface px-4 py-3 text-[12px] text-text-muted">
          <summary className="cursor-pointer font-medium text-text-muted hover:text-text">
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
      )}
    </div>
  );
}
