// Predictive analysis — what's the system telling us we can do?
//
// Three forecasts:
//   1. Daily production capacity — based on 30d avg active seconds
//      per bag, how many bags fit in a single 8h shift? Compared to
//      actual avg-bags-per-day to flag where ramp-up is possible.
//   2. Material runway — for every packaging material with stock,
//      days-of-supply at current burn rate. Materials below a
//      threshold flagged as "order soon".
//   3. Per-product max producible — for every active product, how
//      many MORE finished units could you make right now given
//      current packaging stocks + raw bag inventory? Bottlenecked
//      by the most-constrained input (materials or pills).

import Link from "next/link";
import { ArrowLeft, AlertTriangle, TrendingUp, Package } from "lucide-react";
import { db } from "@/lib/db";
import { sql, gte, eq, isNotNull } from "drizzle-orm";
import {
  readBagMetrics,
  readMaterialBurn,
  packagingLots,
  packagingMaterials,
  products,
  productPackagingSpecs,
  inventoryBags,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const SHIFT_HOURS = 8;
const RUNWAY_LOW = 7; // days
const RUNWAY_CRITICAL = 3;

function fmtDays(d: number | null): string {
  if (d == null) return "—";
  if (!isFinite(d)) return "∞";
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 30) return `${d.toFixed(1)} days`;
  return `${(d / 30).toFixed(1)} months`;
}

export default async function ForecastPage() {
  await requireSession();

  // ── Daily production capacity ─────────────────────────────────────────
  const since30 = new Date();
  since30.setUTCDate(since30.getUTCDate() - 30);
  const since7 = new Date();
  since7.setUTCDate(since7.getUTCDate() - 7);

  const recent = await db
    .select()
    .from(readBagMetrics)
    .where(gte(readBagMetrics.finalizedAt, since30));
  const recent7 = recent.filter(
    (b) => (b.finalizedAt as unknown as Date) >= since7,
  );

  const avgActive30 =
    recent.length > 0
      ? recent.reduce((s, b) => s + b.activeSeconds, 0) / recent.length
      : 0;
  const avgActive7 =
    recent7.length > 0
      ? recent7.reduce((s, b) => s + b.activeSeconds, 0) / recent7.length
      : 0;

  // Per-shift capacity = (shift seconds) / avg active seconds per bag
  const shiftSec = SHIFT_HOURS * 3600;
  const bagsPerShift30 =
    avgActive30 > 0 ? Math.floor(shiftSec / avgActive30) : 0;
  const bagsPerShift7 =
    avgActive7 > 0 ? Math.floor(shiftSec / avgActive7) : 0;

  const avgUnits30 =
    recent.length > 0
      ? recent.reduce((s, b) => s + b.unitsYielded, 0) / recent.length
      : 0;

  // Actual bags per day (last 30d)
  const dayBuckets = new Map<string, number>();
  for (const b of recent) {
    const d = (b.finalizedAt as unknown as Date).toISOString().slice(0, 10);
    dayBuckets.set(d, (dayBuckets.get(d) ?? 0) + 1);
  }
  const actualBagsPerDay =
    dayBuckets.size > 0
      ? Array.from(dayBuckets.values()).reduce((s, n) => s + n, 0) /
        dayBuckets.size
      : 0;

  const capacityUtilization =
    bagsPerShift30 > 0 ? (actualBagsPerDay / bagsPerShift30) * 100 : 0;

  // ── Material runway ──────────────────────────────────────────────────
  const sinceStr30 = since30.toISOString().slice(0, 10);
  const burnByMaterial = await db
    .select({
      materialId: readMaterialBurn.packagingMaterialId,
      total: sql<number>`COALESCE(SUM(${readMaterialBurn.qtyConsumed}),0)::int`,
    })
    .from(readMaterialBurn)
    .where(sql`${readMaterialBurn.day} >= ${sinceStr30}`)
    .groupBy(readMaterialBurn.packagingMaterialId);
  const burnByMaterialId = new Map(
    burnByMaterial.map((r) => [r.materialId, r.total]),
  );

  const stockByMaterial = await db
    .select({
      materialId: packagingLots.packagingMaterialId,
      stock: sql<number>`COALESCE(SUM(${packagingLots.qtyOnHand}),0)::int`,
    })
    .from(packagingLots)
    .groupBy(packagingLots.packagingMaterialId);
  const stockById = new Map(
    stockByMaterial.map((r) => [r.materialId, r.stock]),
  );

  const materials = await db
    .select()
    .from(packagingMaterials)
    .orderBy(packagingMaterials.name);

  const runwayRows = materials.map((m) => {
    const stock = stockById.get(m.id) ?? 0;
    const burn30 = burnByMaterialId.get(m.id) ?? 0;
    const dailyBurn = burn30 / 30;
    const days = dailyBurn > 0 ? stock / dailyBurn : null;
    const tone: "ok" | "warn" | "danger" | "neutral" =
      days == null
        ? "neutral"
        : days < RUNWAY_CRITICAL
          ? "danger"
          : days < RUNWAY_LOW
            ? "warn"
            : "ok";
    return {
      material: m,
      stock,
      dailyBurn,
      days,
      tone,
    };
  });
  // Most-pressed first.
  runwayRows.sort((a, b) => {
    if (a.days == null && b.days == null) return 0;
    if (a.days == null) return 1;
    if (b.days == null) return -1;
    return a.days - b.days;
  });

  // ── Per-product producibility ────────────────────────────────────────
  // For each active product, walk its BOM specs and ask: with current
  // material stock × per_unit, how many MORE units can I make? Take
  // the min across BOM rows. This bounds "additional units we can
  // ship before running out of any input" today.
  const productList = await db
    .select()
    .from(products)
    .where(eq(products.isActive, true));
  const allSpecs = await db
    .select({
      productId: productPackagingSpecs.productId,
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
    })
    .from(productPackagingSpecs);
  const specsByProduct = new Map<string, typeof allSpecs>();
  for (const s of allSpecs) {
    const list = specsByProduct.get(s.productId) ?? [];
    list.push(s);
    specsByProduct.set(s.productId, list);
  }

  const producibilityRows = productList.map((p) => {
    const specs = specsByProduct.get(p.id) ?? [];
    const limits: { material: string; canMake: number }[] = [];
    let limit: number | null = null;
    for (const s of specs) {
      const stock = stockById.get(s.packagingMaterialId) ?? 0;
      // Convert stock + per-scope to per-unit equivalent.
      const unitsPerDisplay = p.unitsPerDisplay ?? 1;
      const displaysPerCase = p.displaysPerCase ?? 1;
      let perUnit = s.qtyPerUnit;
      if (s.perScope === "DISPLAY") perUnit = s.qtyPerUnit / unitsPerDisplay;
      else if (s.perScope === "CASE")
        perUnit = s.qtyPerUnit / (unitsPerDisplay * displaysPerCase);
      const canMake = perUnit > 0 ? Math.floor(stock / perUnit) : 0;
      const matName =
        materials.find((m) => m.id === s.packagingMaterialId)?.name ?? "—";
      limits.push({ material: matName, canMake });
      if (limit == null || canMake < limit) limit = canMake;
    }
    return {
      product: p,
      limit,
      limits,
    };
  });
  producibilityRows.sort((a, b) => {
    if (a.limit == null && b.limit == null) return 0;
    if (a.limit == null) return 1;
    if (b.limit == null) return -1;
    return a.limit - b.limit;
  });

  // ── Raw bag inventory days-of-supply ─────────────────────────────────
  const bagInv = await db
    .select({
      tabletTypeId: inventoryBags.tabletTypeId,
      pillCount: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}),0)::int`,
      bagCount: sql<number>`COUNT(*)::int`,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.status, "AVAILABLE"))
    .groupBy(inventoryBags.tabletTypeId);
  const totalAvailablePills = bagInv.reduce((s, r) => s + r.pillCount, 0);
  // Average pills consumed per bag-finalized event.
  const avgPillsPerBag =
    recent.length > 0
      ? recent.reduce((s, b) => s + (b.inputPillCount ?? 0), 0) / recent.length
      : 0;
  const dailyPillBurn =
    actualBagsPerDay > 0 && avgPillsPerBag > 0
      ? actualBagsPerDay * avgPillsPerBag
      : 0;
  const pillsRunwayDays =
    dailyPillBurn > 0 ? totalAvailablePills / dailyPillBurn : null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/metrics"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Metrics
        </Link>
        <PageHeader
          title="Forecast"
          description="Production capacity, material runway, and producibility — based on 30-day rolling averages."
        />
      </div>

      {/* Production capacity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-brand-700" /> Production capacity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Stat
              label="Bags / 8h shift (30d avg)"
              value={bagsPerShift30 ? bagsPerShift30.toString() : "—"}
              hint={`avg ${Math.round(avgActive30)}s active per bag`}
            />
            <Stat
              label="Bags / 8h shift (7d avg)"
              value={bagsPerShift7 ? bagsPerShift7.toString() : "—"}
              hint={`avg ${Math.round(avgActive7)}s active per bag`}
            />
            <Stat
              label="Actual bags / day (30d)"
              value={actualBagsPerDay > 0 ? actualBagsPerDay.toFixed(1) : "—"}
              hint={`${dayBuckets.size} active production days`}
            />
            <Stat
              label="Capacity utilization"
              value={
                bagsPerShift30 > 0 ? `${capacityUtilization.toFixed(0)}%` : "—"
              }
              hint={
                bagsPerShift30 > 0 && capacityUtilization < 70
                  ? "headroom available"
                  : "near capacity"
              }
            />
          </div>
          <div className="rounded-md bg-surface-2/40 p-3 text-xs text-text-muted leading-relaxed">
            {bagsPerShift30 > 0 ? (
              <>
                Based on the last 30 days of finalized bags, one operator at
                one machine averages{" "}
                <span className="font-semibold text-text">
                  {bagsPerShift30} bag{bagsPerShift30 === 1 ? "" : "s"}
                </span>{" "}
                per 8-hour shift, yielding{" "}
                <span className="font-semibold text-text">
                  ~{Math.round(avgUnits30 * bagsPerShift30).toLocaleString()}
                </span>{" "}
                units per shift. Your actual run rate is{" "}
                <span className="font-semibold text-text">
                  {actualBagsPerDay.toFixed(1)}
                </span>{" "}
                bags/day —{" "}
                {capacityUtilization < 70
                  ? "you have headroom to add more bags or reduce idle time."
                  : capacityUtilization > 95
                    ? "you're at capacity. To grow output you'll need another machine, an extra shift, or to reduce cycle time."
                    : "running at a healthy pace."}
              </>
            ) : (
              "No finalized bags yet. Capacity forecasts populate after the first few completed cycles."
            )}
          </div>
        </CardContent>
      </Card>

      {/* Material runway */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Material runway
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable>
            <THead>
              <TR>
                <TH>Material</TH>
                <TH>SKU</TH>
                <TH className="text-right">Stock on hand</TH>
                <TH className="text-right">Daily burn (30d)</TH>
                <TH className="text-right">Days of supply</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <tbody>
              {runwayRows.length === 0 ? (
                <TR>
                  <TD className="text-center text-text-muted" colSpan={6}>
                    No packaging materials configured. Add some at /packaging.
                  </TD>
                </TR>
              ) : (
                runwayRows.map((r) => (
                  <TR key={r.material.id}>
                    <TD className="font-medium">{r.material.name}</TD>
                    <TD className="font-mono text-xs text-text-muted">
                      {r.material.sku}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {r.stock.toLocaleString()} {r.material.uom}
                    </TD>
                    <TD className="text-right tabular-nums text-text-muted">
                      {r.dailyBurn > 0 ? r.dailyBurn.toFixed(1) : "—"}
                    </TD>
                    <TD className="text-right tabular-nums font-semibold">
                      {fmtDays(r.days)}
                    </TD>
                    <TD>
                      {r.tone === "danger" && (
                        <StatusPill kind="danger">order now</StatusPill>
                      )}
                      {r.tone === "warn" && (
                        <StatusPill kind="warn">order soon</StatusPill>
                      )}
                      {r.tone === "ok" && <StatusPill kind="ok">ok</StatusPill>}
                      {r.tone === "neutral" && (
                        <StatusPill kind="neutral">no burn yet</StatusPill>
                      )}
                    </TD>
                  </TR>
                ))
              )}
            </tbody>
          </DataTable>
          <p className="text-[11px] text-text-subtle mt-2 leading-relaxed">
            Threshold: red &lt; {RUNWAY_CRITICAL} days · amber &lt;{" "}
            {RUNWAY_LOW} days. Daily burn is the 30-day average from
            read_material_burn.
          </p>
        </CardContent>
      </Card>

      {/* Per-product producibility */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-emerald-700" /> Producibility (units
            you can still make)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH>SKU</TH>
                <TH className="text-right">Max units producible</TH>
                <TH>Bottleneck</TH>
              </TR>
            </THead>
            <tbody>
              {producibilityRows.length === 0 ? (
                <TR>
                  <TD className="text-center text-text-muted" colSpan={4}>
                    No active products. Add some at /products.
                  </TD>
                </TR>
              ) : (
                producibilityRows.map((r) => {
                  const bottleneck = r.limits
                    .filter((l) => l.canMake === r.limit)
                    .map((l) => l.material)
                    .join(", ");
                  return (
                    <TR key={r.product.id}>
                      <TD className="font-medium">{r.product.name}</TD>
                      <TD className="font-mono text-xs text-text-muted">
                        {r.product.sku}
                      </TD>
                      <TD className="text-right tabular-nums font-semibold">
                        {r.limit == null
                          ? "—"
                          : r.limit.toLocaleString()}
                      </TD>
                      <TD className="text-xs text-text-muted">
                        {r.limits.length === 0
                          ? "no BOM"
                          : bottleneck || "no constraint"}
                      </TD>
                    </TR>
                  );
                })
              )}
            </tbody>
          </DataTable>
          <p className="text-[11px] text-text-subtle mt-2 leading-relaxed">
            Bottleneck = the BOM material with the smallest stock-per-unit
            ratio. Order more of THAT material to unblock additional output
            for the product.
          </p>
        </CardContent>
      </Card>

      {/* Raw pill inventory runway */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-text-subtle" /> Raw bag inventory
            runway
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat
              label="Bags available"
              value={bagInv
                .reduce((s, r) => s + r.bagCount, 0)
                .toLocaleString()}
            />
            <Stat
              label="Pills available"
              value={totalAvailablePills.toLocaleString()}
            />
            <Stat
              label="Daily pill burn (avg)"
              value={
                dailyPillBurn > 0
                  ? Math.round(dailyPillBurn).toLocaleString()
                  : "—"
              }
              {...(avgPillsPerBag > 0
                ? {
                    hint: `${Math.round(avgPillsPerBag)} pills × ${actualBagsPerDay.toFixed(1)} bags/day`,
                  }
                : {})}
            />
            <Stat
              label="Days of supply"
              value={fmtDays(pillsRunwayDays)}
            />
          </div>
          <p className="text-[11px] text-text-subtle mt-2 leading-relaxed">
            How long the current AVAILABLE inventory will last at the
            current 30-day pace, in pill-count terms. For per-tablet detail,
            see /floor-board.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums tracking-tight mt-0.5 truncate">
        {value}
      </div>
      {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
    </div>
  );
}
