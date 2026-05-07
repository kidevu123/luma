// Phase E — operator productivity dedicated page. Reads
// deriveOperatorMetrics. Labor cost is gated on labor_rates;
// when empty the column shows the canonical missing-data label.

import Link from "next/link";
import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { laborRates } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { MissingState } from "@/components/production/missing-state";
import { deriveOperatorMetrics } from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";

export const dynamic = "force-dynamic";

export default async function OperatorProductivityPage() {
  await requireSession();
  const range = lastNDays(7);
  const [bundle, laborCount] = await Promise.all([
    deriveOperatorMetrics(range),
    db.select({ n: count() }).from(laborRates),
  ]);
  const hasLaborRates = (laborCount[0]?.n ?? 0) > 0;

  // Reshape the bundle into one row per operator code.
  const operatorMap = new Map<
    string,
    {
      bagsFinalized?: number;
      activeMinutes?: number;
      damages?: number;
      unitsPerHour?: number;
    }
  >();
  for (const [k, v] of Object.entries(bundle)) {
    const dot = k.indexOf(".");
    if (dot < 0) continue;
    const op = k.slice(0, dot);
    const field = k.slice(dot + 1);
    if (op === "_status" || op === "_source") continue;
    const row = operatorMap.get(op) ?? {};
    if (typeof v.value === "number") {
      if (field === "bagsFinalized") row.bagsFinalized = v.value;
      if (field === "activeMinutes") row.activeMinutes = v.value;
      if (field === "damages") row.damages = v.value;
      if (field === "unitsPerHour") row.unitsPerHour = v.value;
    }
    operatorMap.set(op, row);
  }
  const operators = Array.from(operatorMap.entries()).sort(
    (a, b) => (b[1].bagsFinalized ?? 0) - (a[1].bagsFinalized ?? 0),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operator productivity"
        description={`Window: last 7 days. Source: lib/production/metrics.ts → deriveOperatorMetrics. ${operators.length} operators with activity.`}
      />

      {!hasLaborRates && (
        <div className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3 text-[12px] text-slate-400">
          <strong className="text-slate-200">Labor cost</strong>: No labor rate configured. Add rates at{" "}
          <Link href="/standards/labor-rates" className="text-cyan-300 hover:text-cyan-200">/standards/labor-rates</Link>{" "}
          to compute cost per operator-hour.
        </div>
      )}

      {operators.length === 0 ? (
        <MissingState
          metric={{
            value: null,
            unit: null,
            confidence: "MISSING",
            missingInputs: ["read_operator_daily"],
            label: "No operator activity in the last 7 days",
            explanation:
              "Per-operator rollups update at BAG_FINALIZED time. Once bags finalise with operator codes set, rows appear here.",
          }}
        />
      ) : (
        <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Operator</th>
                <th className="text-right px-3 py-2">Bags finalized</th>
                <th className="text-right px-3 py-2">Active minutes</th>
                <th className="text-right px-3 py-2">Bags / hour</th>
                <th className="text-right px-3 py-2">Damages</th>
                <th className="text-right px-3 py-2">Labor cost</th>
                <th className="text-left px-3 py-2">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {operators.map(([op, r]) => (
                <tr key={op} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-100 font-mono">{op}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {(r.bagsFinalized ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {(r.activeMinutes ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {(r.unitsPerHour ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {(r.damages ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {hasLaborRates ? (
                      <span className="text-slate-500 italic text-[11px]">
                        per-operator role mapping needed
                      </span>
                    ) : (
                      <span className="text-slate-400 text-[11px]">No labor rate configured</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <ConfidenceBadge confidence={r.bagsFinalized ? "HIGH" : "MISSING"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-slate-500 leading-relaxed">
        <strong className="text-slate-300">Honest disclosure:</strong> rework
        and correction columns are not yet populated — those events are
        gated on REWORK_SENT / SUBMISSION_CORRECTED emission flows that
        Phase F will wire. The metric API surfaces them; until they emit,
        the column would always read 0 and we choose not to show a column
        that's misleadingly empty.
      </div>
    </div>
  );
}
