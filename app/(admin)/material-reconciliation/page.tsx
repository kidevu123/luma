// Material reconciliation page. One row per bag: received, finished,
// scrap, remaining, variance. Honest about confidence — every row
// shows its own confidence pill, and rows where the projector had
// to estimate inputs are tagged "estimated".

import Link from "next/link";
import { db } from "@/lib/db";
import { desc, eq, gt } from "drizzle-orm";
import {
  readMaterialReconciliation,
  workflowBags,
  products,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material reconciliation"
        description="Per-bag pill-count audit. Variance signals recording gaps (missed counter, unrecorded scrap) or counter typos. Estimated rows are computed today from received − finished − damaged because explicit consumed/scrap/remaining events haven't been wired yet."
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
        <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Bag</th>
                <th className="text-left px-3 py-2">Product</th>
                <th className="text-right px-3 py-2">Received</th>
                <th className="text-right px-3 py-2">Finished</th>
                <th className="text-right px-3 py-2">Scrap</th>
                <th className="text-right px-3 py-2">Remaining</th>
                <th className="text-right px-3 py-2">Variance</th>
                <th className="text-right px-3 py-2">Variance %</th>
                <th className="text-left px-3 py-2">Confidence</th>
                <th className="text-left px-3 py-2">Missing inputs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING" =
                  r.received == null
                    ? "MISSING"
                    : r.isEstimated
                      ? "LOW"
                      : Math.abs(Number(r.variancePct ?? 0)) <= 1
                        ? "HIGH"
                        : Math.abs(Number(r.variancePct ?? 0)) <= 5
                          ? "MEDIUM"
                          : "LOW";
                const varianceCls =
                  Math.abs(Number(r.variancePct ?? 0)) > 5
                    ? "text-rose-300"
                    : Math.abs(Number(r.variancePct ?? 0)) > 1
                      ? "text-amber-300"
                      : "text-slate-300";
                return (
                  <tr key={r.bagId} className="border-t border-slate-800">
                    <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                      <Link
                        href={`/genealogy/${r.bagId}`}
                        className="text-cyan-300 hover:text-cyan-200"
                      >
                        {r.bagId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-300">
                      {r.productName ?? "—"}
                      {r.productSku && (
                        <div className="text-[10px] text-slate-500 font-mono">
                          {r.productSku}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {r.received ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {r.finished ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500 font-mono">
                      {r.scrap ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500 font-mono">
                      {r.remaining ?? "—"}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${varianceCls}`}>
                      {r.variance ?? "—"}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${varianceCls}`}>
                      {r.variancePct != null ? `${Number(r.variancePct).toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <ConfidenceBadge confidence={confidence} />
                    </td>
                    <td className="px-3 py-2 text-[10px] text-slate-500">
                      {r.missingInputs ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-slate-500 leading-relaxed">
        <strong className="text-slate-300">Honest disclosure:</strong> until
        explicit MATERIAL_CONSUMED, SCRAP_RECORDED, and remaining-inventory
        events are emitted by the floor, the projector tags every row{" "}
        <span className="text-slate-300">estimated</span>. Variance shown is{" "}
        <code className="text-slate-300">received − finished − damaged − scrap − remaining</code>.
      </div>
    </div>
  );
}
