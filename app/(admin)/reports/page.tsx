// Throughput reports. All numbers come from read_daily_throughput,
// which the synchronous projector keeps current. Three views:
//   1. Last 14 days bag flow (totals across products/machines)
//   2. Top products in the last 30 days
//   3. Top machines in the last 30 days
//
// Why pre-aggregated read models? At Haute's volume the underlying
// event table will hit 100k rows in a year. Live aggregations stay
// fast for now, but the read model lets us add per-employee, per-
// shift, per-product cuts later without re-architecting.

import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
  readDailyThroughput,
  readMaterialBurn,
  products,
  machines,
  packagingMaterials,
} from "@/lib/db/schema";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { BarChart3 } from "lucide-react";

export const dynamic = "force-dynamic";

async function dailyTotals(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      day: readDailyThroughput.day,
      blistered: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsBlistered}),0)::int`,
      sealed: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsSealed}),0)::int`,
      packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
    .groupBy(readDailyThroughput.day)
    .orderBy(sql`${readDailyThroughput.day} DESC`);
}

async function topProducts(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      productId: readDailyThroughput.productId,
      productName: products.name,
      productSku: products.sku,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
      packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
    })
    .from(readDailyThroughput)
    .leftJoin(products, sql`${readDailyThroughput.productId} = ${products.id}`)
    .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
    .groupBy(readDailyThroughput.productId, products.name, products.sku)
    .orderBy(sql`SUM(${readDailyThroughput.bagsFinalized}) DESC`)
    .limit(10);
}

async function topMaterials(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      packagingMaterialId: readMaterialBurn.packagingMaterialId,
      materialName: packagingMaterials.name,
      materialSku: packagingMaterials.sku,
      uom: packagingMaterials.uom,
      consumed: sql<number>`COALESCE(SUM(${readMaterialBurn.qtyConsumed}),0)::int`,
    })
    .from(readMaterialBurn)
    .leftJoin(
      packagingMaterials,
      sql`${readMaterialBurn.packagingMaterialId} = ${packagingMaterials.id}`,
    )
    .where(sql`${readMaterialBurn.day} >= ${sinceStr}`)
    .groupBy(
      readMaterialBurn.packagingMaterialId,
      packagingMaterials.name,
      packagingMaterials.sku,
      packagingMaterials.uom,
    )
    .orderBy(sql`SUM(${readMaterialBurn.qtyConsumed}) DESC`)
    .limit(10);
}

async function topMachines(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      machineId: readDailyThroughput.machineId,
      machineName: machines.name,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
    })
    .from(readDailyThroughput)
    .leftJoin(machines, sql`${readDailyThroughput.machineId} = ${machines.id}`)
    .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
    .groupBy(readDailyThroughput.machineId, machines.name)
    .orderBy(sql`SUM(${readDailyThroughput.bagsFinalized}) DESC`)
    .limit(10);
}

export default async function ReportsPage() {
  await requireSession();
  const [days14, products30, machines30, materials30] = await Promise.all([
    dailyTotals(14),
    topProducts(30),
    topMachines(30),
    topMaterials(30),
  ]);

  const empty = days14.length === 0;
  const maxFinalized = Math.max(1, ...days14.map((d) => d.finalized));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Throughput backed by read_daily_throughput — the projector writes here on every stage event, so numbers refresh in real time."
      />

      {empty ? (
        <EmptyState
          icon={BarChart3}
          title="No throughput yet"
          description="As bags move through stations, this page populates automatically. Run a card scan + finalize on the floor to seed the first row."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Last 14 days</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable>
                <THead>
                  <TR>
                    <TH>Day</TH>
                    <TH className="text-right">Blistered</TH>
                    <TH className="text-right">Sealed</TH>
                    <TH className="text-right">Packaged</TH>
                    <TH className="text-right">Finalized</TH>
                    <TH>Finalized chart</TH>
                  </TR>
                </THead>
                <tbody>
                  {days14.map((d) => (
                    <TR key={d.day}>
                      <TD className="font-mono text-xs">{d.day}</TD>
                      <TD className="text-right tabular-nums">
                        {d.blistered.toLocaleString()}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {d.sealed.toLocaleString()}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {d.packaged.toLocaleString()}
                      </TD>
                      <TD className="text-right tabular-nums font-semibold">
                        {d.finalized.toLocaleString()}
                      </TD>
                      <TD>
                        <div className="h-2 bg-surface-2 rounded-full overflow-hidden w-32">
                          <div
                            className="h-full bg-brand-700"
                            style={{
                              width: `${Math.round((d.finalized / maxFinalized) * 100)}%`,
                            }}
                          />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            </CardContent>
          </Card>

          <div className="grid lg:grid-cols-2 gap-5">
            <Card>
              <CardHeader>
                <CardTitle>Top products (30 days)</CardTitle>
              </CardHeader>
              <CardContent>
                {products30.length === 0 ? (
                  <p className="text-sm text-text-muted">No data.</p>
                ) : (
                  <DataTable>
                    <THead>
                      <TR>
                        <TH>Product</TH>
                        <TH className="text-right">Finalized</TH>
                        <TH className="text-right">Packaged</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {products30.map((p) => (
                        <TR key={p.productId ?? "_"}>
                          <TD>
                            <div className="font-medium">{p.productName ?? "—"}</div>
                            {p.productSku && (
                              <div className="text-[11px] text-text-subtle font-mono">
                                {p.productSku}
                              </div>
                            )}
                          </TD>
                          <TD className="text-right tabular-nums font-semibold">
                            {p.finalized.toLocaleString()}
                          </TD>
                          <TD className="text-right tabular-nums">
                            {p.packaged.toLocaleString()}
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Top machines (30 days)</CardTitle>
              </CardHeader>
              <CardContent>
                {machines30.length === 0 ? (
                  <p className="text-sm text-text-muted">No data.</p>
                ) : (
                  <DataTable>
                    <THead>
                      <TR>
                        <TH>Machine</TH>
                        <TH className="text-right">Finalized</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {machines30.map((m) => (
                        <TR key={m.machineId ?? "_"}>
                          <TD className="font-medium">{m.machineName ?? "—"}</TD>
                          <TD className="text-right tabular-nums font-semibold">
                            {m.finalized.toLocaleString()}
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Material burn (30 days)</CardTitle>
            </CardHeader>
            <CardContent>
              {materials30.length === 0 ? (
                <div className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-sm text-text-muted">
                  <p className="font-medium text-text mb-1">No burn data yet</p>
                  <p className="text-xs leading-relaxed">
                    Material burn populates from product BOM × units produced when a finished lot is issued.
                  </p>
                </div>
              ) : (
                <>
                  <DataTable>
                    <THead>
                      <TR>
                        <TH>Material</TH>
                        <TH>SKU</TH>
                        <TH className="text-right">Consumed</TH>
                        <TH>UoM</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {materials30.map((m) => (
                        <TR key={m.packagingMaterialId ?? "_"}>
                          <TD className="font-medium">{m.materialName ?? "—"}</TD>
                          <TD className="font-mono text-xs text-text-muted">
                            {m.materialSku ?? "—"}
                          </TD>
                          <TD className="text-right tabular-nums font-semibold">
                            {m.consumed.toLocaleString()}
                          </TD>
                          <TD className="text-text-muted text-xs">{m.uom ?? "—"}</TD>
                        </TR>
                      ))}
                    </tbody>
                    {materials30.length > 1 && (
                      <tfoot>
                        <TR className="border-t-2 border-border/60 bg-surface-2/20">
                          <TD className="text-xs font-semibold text-text-subtle" colSpan={2}>
                            Total ({materials30.length} materials)
                          </TD>
                          <TD className="text-right tabular-nums font-bold">
                            —
                          </TD>
                          <TD />
                        </TR>
                      </tfoot>
                    )}
                  </DataTable>
                  <p className="text-[11px] text-text-subtle mt-2 leading-relaxed">
                    Figures reflect consumption recorded via finished lot issuance (BOM × units produced).
                    For detailed runway analysis, see{" "}
                    <a href="/metrics/forecast" className="underline">Forecast</a>.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
