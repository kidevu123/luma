// Phase E — operator productivity dedicated page. OP-1E: switched to
// employee_id-keyed rows when accountability resolved at finalize
// time. Legacy code-only rows still appear, marked LOW confidence so
// the audit trail stays honest.

import Link from "next/link";
import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { laborRates } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { MissingState } from "@/components/production/missing-state";
import { deriveOperatorRows } from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";

export const dynamic = "force-dynamic";

export default async function OperatorProductivityPage() {
  await requireSession();
  const range = lastNDays(7);
  const [operators, laborCount] = await Promise.all([
    deriveOperatorRows(range),
    db.select({ n: count() }).from(laborRates),
  ]);
  const hasLaborRates = (laborCount[0]?.n ?? 0) > 0;
  const legacyCount = operators.filter((r) => r.confidence === "LOW").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operator productivity"
        description={`Window: last 7 days. Source: lib/production/metrics.ts → deriveOperatorRows. ${operators.length} operator(s) with activity${
          legacyCount > 0
            ? ` (${legacyCount} legacy code-only — LOW confidence)`
            : ""
        }.`}
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
              "Per-operator rollups update at BAG_FINALIZED time. Once bags finalise with an accountable employee (or legacy operator code), rows appear here.",
          }}
        />
      ) : (
        <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Operator</th>
                <th className="text-left px-3 py-2">Code</th>
                <th className="text-right px-3 py-2">Bags finalized</th>
                <th className="text-right px-3 py-2">Active minutes</th>
                <th className="text-right px-3 py-2">Bags / hour</th>
                <th className="text-right px-3 py-2">Damages</th>
                <th className="text-right px-3 py-2">Labor cost</th>
                <th className="text-left px-3 py-2">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {operators.map((r) => {
                const minutes = Math.round(r.activeSeconds / 60);
                const unitsPerHour =
                  r.bagsFinalized > 0 && r.activeSeconds > 0
                    ? Math.round(
                        (r.bagsFinalized / r.activeSeconds) * 3600,
                      )
                    : 0;
                return (
                  <tr key={r.groupKey} className="border-t border-slate-800">
                    <td className="px-3 py-2">
                      <span className="text-slate-100">{r.displayName}</span>
                      {r.confidence === "LOW" && (
                        <span className="ml-2 rounded bg-amber-900/40 text-amber-200 border border-amber-700/40 px-1.5 py-0.5 text-[10px]">
                          legacy code only
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-400 text-[11px]">
                      {r.operatorCode ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {r.bagsFinalized.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {minutes.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {unitsPerHour.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {r.damages.toLocaleString()}
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
                      <ConfidenceBadge confidence={r.confidence} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-slate-500 leading-relaxed space-y-1">
        <p>
          <strong className="text-slate-300">Honest disclosure:</strong>{" "}
          rows marked <em>legacy code only</em> were attributed by typed
          operator code without a stable employee match — typos can
          inflate the leaderboard. New rows post-OP-1B / OP-1C key on
          employees.id directly. Rework / correction columns remain
          gated on the QC subsystem phase.
        </p>
      </div>
    </div>
  );
}
