// Production capacity forecast — answers "how much can we make right now?"
//
// For each active product, walks the pill → unit → display → case chain
// and finds the bottleneck at each level given current stock.

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { eq, inArray, and, sql } from "drizzle-orm";
import {
  products,
  productAllowedTablets,
  inventoryBags,
  productPackagingSpecs,
  packagingMaterials,
  packagingLots,
} from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { MetricsTabs } from "@/components/ui/metrics-tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { sortCapacityRows } from "@/lib/production/capacity";

export const dynamic = "force-dynamic";

// ─── Data loading ──────────────────────────────────────────────────

async function loadCapacity() {
  // 1. All active products
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      tabletsPerUnit: products.tabletsPerUnit,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(products.name);

  if (productRows.length === 0) return [];

  const productIds = productRows.map((p) => p.id);

  // 2. Available tablet count per product (sum across all allowed tablet types)
  const tabletRows = await db
    .select({
      productId: productAllowedTablets.productId,
      tabletsAvailable: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}), 0)::int`,
    })
    .from(productAllowedTablets)
    .leftJoin(
      inventoryBags,
      and(
        eq(inventoryBags.tabletTypeId, productAllowedTablets.tabletTypeId),
        eq(inventoryBags.status, "AVAILABLE"),
      ),
    )
    .where(inArray(productAllowedTablets.productId, productIds))
    .groupBy(productAllowedTablets.productId);

  const tabletsByProduct = new Map(tabletRows.map((r) => [r.productId, r.tabletsAvailable]));

  // 3. Packaging specs with available stock (summed across lots per material)
  const specRows = await db
    .select({
      productId: productPackagingSpecs.productId,
      materialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
      materialName: packagingMaterials.name,
      materialSku: packagingMaterials.sku,
      materialKind: packagingMaterials.kind,
      materialUom: packagingMaterials.uom,
      stockOnHand: sql<number>`COALESCE(SUM(${packagingLots.qtyOnHand}), 0)::int`,
    })
    .from(productPackagingSpecs)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, productPackagingSpecs.packagingMaterialId))
    .leftJoin(
      packagingLots,
      and(
        eq(packagingLots.packagingMaterialId, productPackagingSpecs.packagingMaterialId),
        inArray(packagingLots.status, ["AVAILABLE", "IN_USE"]),
      ),
    )
    .where(inArray(productPackagingSpecs.productId, productIds))
    .groupBy(
      productPackagingSpecs.productId,
      productPackagingSpecs.packagingMaterialId,
      productPackagingSpecs.qtyPerUnit,
      productPackagingSpecs.perScope,
      packagingMaterials.name,
      packagingMaterials.sku,
      packagingMaterials.kind,
      packagingMaterials.uom,
    );

  // 4. Build capacity for each product
  return productRows.map((product) => {
    const tablets = tabletsByProduct.get(product.id) ?? 0;
    const specs = specRows.filter((s) => s.productId === product.id);

    const unitSpecs = specs.filter((s) => s.perScope === "UNIT");
    const displaySpecs = specs.filter((s) => s.perScope === "DISPLAY");
    const caseSpecs = specs.filter((s) => s.perScope === "CASE");

    // ── Unit level ──────────────────────────────────────────────────
    const unitsFromTablets =
      product.tabletsPerUnit && product.tabletsPerUnit > 0
        ? Math.floor(tablets / product.tabletsPerUnit)
        : null;

    // For each packaging material at UNIT scope, max units it can support
    const unitMaterialLimits = unitSpecs.map((s) => ({
      name: s.materialName,
      sku: s.materialSku,
      kind: s.materialKind,
      onHand: s.stockOnHand,
      qtyPerUnit: s.qtyPerUnit,
      maxUnits: s.qtyPerUnit > 0 ? Math.floor(s.stockOnHand / s.qtyPerUnit) : 0,
    }));

    const unitsFromMaterials =
      unitMaterialLimits.length > 0
        ? Math.min(...unitMaterialLimits.map((m) => m.maxUnits))
        : null;

    const allUnitConstraints = [unitsFromTablets, unitsFromMaterials].filter(
      (v): v is number => v !== null,
    );
    const runnableUnits = allUnitConstraints.length > 0 ? Math.min(...allUnitConstraints) : null;

    // Find what's limiting units
    let unitBottleneck = "Unconfigured";
    if (runnableUnits !== null) {
      if (unitsFromTablets !== null && runnableUnits === unitsFromTablets && unitsFromTablets < (unitsFromMaterials ?? Infinity)) {
        unitBottleneck = `Pills (${fmt(tablets)} ÷ ${product.tabletsPerUnit})`;
      } else if (unitMaterialLimits.length > 0) {
        const limiting = unitMaterialLimits.find((m) => m.maxUnits === runnableUnits);
        unitBottleneck = limiting ? `${limiting.name} (${fmt(limiting.onHand)} on hand)` : "Packaging";
      } else if (unitsFromTablets !== null) {
        unitBottleneck = `Pills (${fmt(tablets)} ÷ ${product.tabletsPerUnit})`;
      }
    }

    // ── Display level ───────────────────────────────────────────────
    const unitsPerDisplay = product.unitsPerDisplay;
    const displaysFromUnits =
      runnableUnits !== null && unitsPerDisplay && unitsPerDisplay > 0
        ? Math.floor(runnableUnits / unitsPerDisplay)
        : null;

    const displayMaterialLimits = displaySpecs.map((s) => ({
      name: s.materialName,
      sku: s.materialSku,
      kind: s.materialKind,
      onHand: s.stockOnHand,
      qtyPerUnit: s.qtyPerUnit,
      maxDisplays: s.qtyPerUnit > 0 ? Math.floor(s.stockOnHand / s.qtyPerUnit) : 0,
    }));

    const displaysFromMaterials =
      displayMaterialLimits.length > 0
        ? Math.min(...displayMaterialLimits.map((m) => m.maxDisplays))
        : null;

    const allDisplayConstraints = [displaysFromUnits, displaysFromMaterials].filter(
      (v): v is number => v !== null,
    );
    const runnableDisplays =
      allDisplayConstraints.length > 0 ? Math.min(...allDisplayConstraints) : null;

    let displayBottleneck = unitsPerDisplay ? "Unconfigured" : "No display configured";
    if (runnableDisplays !== null) {
      if (
        displaysFromUnits !== null &&
        runnableDisplays === displaysFromUnits &&
        displaysFromUnits < (displaysFromMaterials ?? Infinity)
      ) {
        displayBottleneck = `Units (${fmt(runnableUnits ?? 0)} ÷ ${unitsPerDisplay})`;
      } else if (displayMaterialLimits.length > 0) {
        const limiting = displayMaterialLimits.find((m) => m.maxDisplays === runnableDisplays);
        displayBottleneck = limiting
          ? `${limiting.name} (${fmt(limiting.onHand)} on hand)`
          : "Packaging";
      }
    }

    // ── Case level ──────────────────────────────────────────────────
    const displaysPerCase = product.displaysPerCase;
    const casesFromDisplays =
      runnableDisplays !== null && displaysPerCase && displaysPerCase > 0
        ? Math.floor(runnableDisplays / displaysPerCase)
        : null;

    const caseMaterialLimits = caseSpecs.map((s) => ({
      name: s.materialName,
      sku: s.materialSku,
      kind: s.materialKind,
      onHand: s.stockOnHand,
      qtyPerUnit: s.qtyPerUnit,
      maxCases: s.qtyPerUnit > 0 ? Math.floor(s.stockOnHand / s.qtyPerUnit) : 0,
    }));

    const casesFromMaterials =
      caseMaterialLimits.length > 0
        ? Math.min(...caseMaterialLimits.map((m) => m.maxCases))
        : null;

    const allCaseConstraints = [casesFromDisplays, casesFromMaterials].filter(
      (v): v is number => v !== null,
    );
    const runnableCases =
      allCaseConstraints.length > 0 ? Math.min(...allCaseConstraints) : null;

    return {
      product,
      tablets,
      unitsFromTablets,
      unitMaterialLimits,
      unitsFromMaterials,
      runnableUnits,
      unitBottleneck,
      displaysFromUnits,
      displayMaterialLimits,
      displaysFromMaterials,
      runnableDisplays,
      displayBottleneck,
      casesFromDisplays,
      caseMaterialLimits,
      casesFromMaterials,
      runnableCases,
    };
  });
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString();
}

// ─── UI helpers ─────────────────────────────────────────────────────

function CapCell({
  runnable,
  label,
  bottleneck,
  unconfigured,
}: {
  runnable: number | null;
  label: string;
  bottleneck: string;
  unconfigured?: boolean;
}) {
  if (unconfigured) {
    return (
      <td className="p-3 text-center">
        <span className="text-[10px] text-text-muted">—</span>
      </td>
    );
  }
  const color =
    runnable === null
      ? "text-text-muted"
      : runnable === 0
        ? "text-red-600 font-semibold"
        : runnable < 10
          ? "text-amber-600 font-semibold"
          : "text-emerald-700 font-semibold";
  return (
    <td className="p-3 text-center">
      <div className={`text-sm tabular-nums ${color}`}>{fmt(runnable)}</div>
      <div className="text-[10px] text-text-muted mt-0.5">{label}</div>
    </td>
  );
}

// ─── Page ────────────────────────────────────────────────────────────

export default async function ProductionCapacityPage() {
  await requireAdmin();
  const rows = sortCapacityRows(await loadCapacity());

  return (
    <div className="space-y-5">
      <MetricsTabs />
      <PageHeader
        title="Production capacity"
        description="Given current pill stock and packaging on hand, how many complete units, displays, and cases can we build right now."
      />

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-text-muted">
            No active products configured.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] text-text-muted uppercase border-b border-border/60">
                <tr>
                  <th className="text-left p-3 pl-5">Product</th>
                  {/* Pills */}
                  <th className="text-right p-3 border-l border-border/30">Pills on hand</th>
                  {/* Units */}
                  <th className="text-center p-3 border-l border-border/30 bg-surface-2/30" colSpan={2}>Blister units</th>
                  {/* Displays */}
                  <th className="text-center p-3 border-l border-border/30" colSpan={2}>Display boxes</th>
                  {/* Cases */}
                  <th className="text-center p-3 border-l border-border/30 bg-surface-2/30" colSpan={2}>Master cases</th>
                </tr>
                <tr className="text-[9px]">
                  <th></th>
                  <th className="text-right p-1 pr-3 border-l border-border/30 text-text-muted/70">count</th>
                  <th className="text-center p-1 border-l border-border/30 bg-surface-2/30 text-text-muted/70">runnable</th>
                  <th className="text-left p-1 bg-surface-2/30 text-text-muted/70">bottleneck</th>
                  <th className="text-center p-1 border-l border-border/30 text-text-muted/70">runnable</th>
                  <th className="text-left p-1 text-text-muted/70">bottleneck</th>
                  <th className="text-center p-1 border-l border-border/30 bg-surface-2/30 text-text-muted/70">runnable</th>
                  <th className="text-left p-1 bg-surface-2/30 text-text-muted/70">bottleneck</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const noDisplay = !r.product.unitsPerDisplay;
                  const noCase = !r.product.displaysPerCase;
                  return (
                    <tr key={r.product.id} className="border-t border-border/40 hover:bg-surface-2/20 transition-colors">
                      {/* Product */}
                      <td className="p-3 pl-5">
                        <div className="font-medium text-sm">{r.product.name}</div>
                        <div className="font-mono text-[10px] text-text-muted">{r.product.sku}</div>
                      </td>

                      {/* Pills */}
                      <td className="p-3 text-right tabular-nums border-l border-border/30">
                        {r.product.tabletsPerUnit ? (
                          <>
                            <div className="text-sm font-medium">{fmt(r.tablets)}</div>
                            <div className="text-[10px] text-text-muted">
                              {r.product.tabletsPerUnit} per unit
                            </div>
                          </>
                        ) : (
                          <span className="text-[10px] text-text-muted">—</span>
                        )}
                      </td>

                      {/* Units — runnable */}
                      <td className="p-3 text-center border-l border-border/30 bg-surface-2/10">
                        <RunnableCell value={r.runnableUnits} />
                        {r.unitMaterialLimits.length > 0 && (
                          <div className="text-[9px] text-text-muted mt-1">
                            {r.unitMaterialLimits.map((m) => (
                              <span key={m.sku} className="block">
                                {m.name.replace(/[- ]*Blister Card/i, "").trim()}: {fmt(m.onHand)}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      {/* Units — bottleneck */}
                      <td className="p-3 bg-surface-2/10">
                        <div className="text-[10px] text-text-muted max-w-[180px]">
                          {r.runnableUnits !== null ? r.unitBottleneck : "Unconfigured"}
                        </div>
                      </td>

                      {/* Displays — runnable */}
                      <td className="p-3 text-center border-l border-border/30">
                        {noDisplay ? (
                          <span className="text-[10px] text-text-muted">—</span>
                        ) : (
                          <>
                            <RunnableCell value={r.runnableDisplays} />
                            {r.displayMaterialLimits.length > 0 && (
                              <div className="text-[9px] text-text-muted mt-1">
                                {r.displayMaterialLimits.map((m) => (
                                  <span key={m.sku} className="block">
                                    boxes: {fmt(m.onHand)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      {/* Displays — bottleneck */}
                      <td className="p-3">
                        {!noDisplay && (
                          <div className="text-[10px] text-text-muted max-w-[180px]">
                            {r.product.unitsPerDisplay} units/display ·{" "}
                            {r.runnableDisplays !== null ? r.displayBottleneck : "Unconfigured"}
                          </div>
                        )}
                      </td>

                      {/* Cases — runnable */}
                      <td className="p-3 text-center border-l border-border/30 bg-surface-2/10">
                        {noCase ? (
                          <span className="text-[10px] text-text-muted">—</span>
                        ) : (
                          <>
                            <RunnableCell value={r.runnableCases} />
                            {r.caseMaterialLimits.length > 0 && (
                              <div className="text-[9px] text-text-muted mt-1">
                                {r.caseMaterialLimits.map((m) => (
                                  <span key={m.sku} className="block">
                                    cases: {fmt(m.onHand)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      {/* Cases — bottleneck */}
                      <td className="p-3 bg-surface-2/10">
                        {!noCase && (
                          <div className="text-[10px] text-text-muted max-w-[180px]">
                            {r.product.displaysPerCase} displays/case ·{" "}
                            {r.runnableCases !== null ? "OK" : "Unconfigured"}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-text-muted px-1">
        Pills: AVAILABLE inventory bags only. Packaging: AVAILABLE + IN_USE lots.
        Quantities are floor-divided — partial displays/cases not counted.
        Bottleneck = the constraint that limits the runnable count at that level.
      </p>
    </div>
  );
}

function RunnableCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[10px] text-text-muted">—</span>;
  const color =
    value === 0
      ? "text-red-600"
      : value < 5
        ? "text-amber-600"
        : "text-emerald-700";
  return <span className={`text-base font-semibold tabular-nums ${color}`}>{fmt(value)}</span>;
}
