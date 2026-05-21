// Material reconciliation — per-bag pill-count audit. One row per bag:
// received, finished, scrap, remaining, variance. Honest about
// confidence — rows where the projector had to estimate inputs are
// tagged "estimated". Variance signals recording gaps or typos.

import Link from "next/link";
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import {
  readMaterialReconciliation,
  workflowBags,
  products,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { MissingState } from "@/components/production/missing-state";

export const dynamic = "force-dynamic";

export default async function MaterialReconciliationPage() {
  await requireSession();
  const rows = await db
    .select({
      bagId: readMaterialReconciliation.workflowBagId,
      received: readMaterialReconciliation.receivedQty,
      consumed: readMaterialReconciliation.consumedQty,
      finished: readMaterialReconciliation.finishedQty,
      scrap: readMaterialReconciliation.scrapQty,
      remaining: readMaterialReconciliation.remainingQty,
      variance: readMaterialReconciliation.varianceQty,
      variancePct: readMaterialReconciliation.variancePct,
      isEstimated: readMaterialReconciliation.isEstimated,
      missingInputs: readMaterialReconciliation.missingInputs,
      productName: products.name,
      productSku: products.sku,
    })
    .from(readMaterialReconciliation)
    .leftJoin(workflowBags, eq(workflowBags.id, readMaterialReconciliation.workflowBagId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .orderBy(desc(readMaterialReconciliation.updatedAt))
    .limit(200);

  // Summary computed from loaded rows (no extra query needed).
  const withVariance = rows.filter((r) => Math.abs(Number(r.variancePct ?? 0)) > 1).length;
  const highVariance = rows.filter((r) => Math.abs(Number(r.variancePct ?? 0)) > 5).length;
  const estimated = rows.filter((r) => r.isEstimated).length;
  const missing = rows.filter((r) => r.received == null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material reconciliation"
        description="Per-bag pill-count audit. Variance signals recording gaps, missed counter reads, or counter typos."
      />

      {rows.length === 0 ? (
        <MissingState
          metric={{
            value: null,
            unit: null,
            confidence: "MISSING",
            missingInputs: ["read_material_reconciliation"],
            label: "No reconciliation rows yet",
            explanation:
              "Rows populate at BAG_FINALIZED time. Run scripts/rebuild-read-models.ts to materialise from existing bags.",
          }}
        />
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Rows loaded" value={String(rows.length)} />
            <StatCard label="Variance > 1%" value={String(withVariance)} tone={withVariance > 0 ? "warn" : "good"} />
            <StatCard label="Variance > 5%" value={String(highVariance)} tone={highVariance > 0 ? "crit" : "good"} />
            <StatCard label="Estimated" value={String(estimated)} tone={estimated > 0 ? "warn" : "good"} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Per-bag detail</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-1">
              <DataTable className="border-0 rounded-none">
                <THead>
                  <TR>
                    <TH>Bag</TH>
                    <TH>Product</TH>
                    <TH className="text-right">Received</TH>
                    <TH className="text-right">Finished</TH>
                    <TH className="text-right">Scrap</TH>
                    <TH className="text-right">Remaining</TH>
                    <TH className="text-right">Variance</TH>
                    <TH className="text-right">Var %</TH>
                    <TH>Confidence</TH>
                    <TH>Missing inputs</TH>
                  </TR>
                </THead>
                <tbody>
                  {rows.map((r) => {
                    const pct = Math.abs(Number(r.variancePct ?? 0));
                    const confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING" =
                      r.received == null
                        ? "MISSING"
                        : r.isEstimated
                          ? "LOW"
                          : pct <= 1
                            ? "HIGH"
                            : pct <= 5
                              ? "MEDIUM"
                              : "LOW";
                    const varianceCls =
                      pct > 5
                        ? "text-crit-700 font-semibold"
                        : pct > 1
                          ? "text-warn-700"
                          : r.variance != null
                            ? "text-good-700"
                            : "text-text-subtle";

                    return (
                      <TR key={r.bagId}>
                        <TD>
                          <Link
                            href={`/genealogy/${r.bagId}`}
                            className="font-mono text-[11px] text-brand-700 hover:text-brand-800"
                          >
                            {r.bagId.slice(0, 8)}…
                          </Link>
                        </TD>
                        <TD>
                          <div className="font-medium text-text text-[13px]">
                            {r.productName ?? "—"}
                          </div>
                          {r.productSku && (
                            <div className="text-[10px] text-text-subtle font-mono">{r.productSku}</div>
                          )}
                        </TD>
                        <TD className="text-right font-mono text-[12px] text-text">
                          {r.received ?? "—"}
                        </TD>
                        <TD className="text-right font-mono text-[12px] text-text">
                          {r.finished ?? "—"}
                        </TD>
                        <TD className="text-right font-mono text-[12px] text-text-muted">
                          {r.scrap ?? "—"}
                        </TD>
                        <TD className="text-right font-mono text-[12px] text-text-muted">
                          {r.remaining ?? "—"}
                        </TD>
                        <TD className={`text-right font-mono text-[12px] ${varianceCls}`}>
                          {r.variance ?? "—"}
                        </TD>
                        <TD className={`text-right font-mono text-[12px] ${varianceCls}`}>
                          {r.variancePct != null
                            ? `${Number(r.variancePct).toFixed(2)}%`
                            : "—"}
                        </TD>
                        <TD>
                          <ConfidenceBadge confidence={confidence} />
                        </TD>
                        <TD>
                          {r.missingInputs ? (
                            <span className="text-[10px] font-mono text-text-subtle">
                              {r.missingInputs}
                            </span>
                          ) : (
                            <span className="text-[10px] text-text-subtle">—</span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </DataTable>
            </CardContent>
          </Card>

          <div className="rounded-xl border border-border/60 bg-surface-2/30 px-4 py-3 text-[11px] text-text-muted leading-relaxed">
            <span className="font-semibold text-text">Estimation note:</span> Until explicit{" "}
            <code className="font-mono">MATERIAL_CONSUMED</code>,{" "}
            <code className="font-mono">SCRAP_RECORDED</code>, and remaining-inventory events are
            emitted by the floor, the projector tags every row <em>estimated</em>. Variance shown
            is{" "}
            <code className="font-mono">received − finished − damaged − scrap − remaining</code>.
            {missing > 0 && (
              <span className="block mt-1 text-text-subtle">
                {missing} {missing === 1 ? "row is" : "rows are"} missing received quantity — these
                show confidence: no data.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "crit" | "neutral";
}) {
  const valueCls =
    tone === "good" ? "text-good-700" :
    tone === "warn" ? "text-warn-700" :
    tone === "crit" ? "text-crit-700" :
    "text-text-strong";
  return (
    <div className="rounded-xl border border-border/60 bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}
