// Phase H.x7 — Roll variance panel.
//
// Read-only view of every roll in read_roll_usage with configured /
// expected vs actual usage. The variance row shows where waste is
// concentrating (machine, supplier, role). Honest empty states:
// rolls without a weigh-back show actual = "—" and confidence
// MEDIUM at best.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type RollVarianceRow = {
  packaging_lot_id: string;
  roll_number: string | null;
  material_role: string | null;
  material_kind: string;
  material_name: string;
  machine_name: string | null;
  mounted_at: string | null;
  unmounted_at: string | null;
  starting_weight_grams: number | null;
  ending_weight_grams: number | null;
  expected_used_grams: number | null;
  actual_used_grams: number | null;
  variance_grams: number | null;
  variance_pct: string | null;
  blisters_produced: number | null;
  confidence: string;
  supplier: string | null;
  source_system: string | null;
  external_po_id: string | null;
};

type Summary = {
  total_rolls: number;
  with_weighback: number;
  total_variance_grams: number | null;
  rolls_over_5pct: number;
};

export default async function RollVariancePage() {
  await requireAdmin();

  const rowsQ = await db.execute<RollVarianceRow>(sql`
    SELECT
      rru.packaging_lot_id::text                   AS packaging_lot_id,
      rru.roll_number                              AS roll_number,
      rru.material_role                            AS material_role,
      rru.material_kind                            AS material_kind,
      pm.name                                      AS material_name,
      m.name                                       AS machine_name,
      rru.mounted_at::text                         AS mounted_at,
      rru.unmounted_at::text                       AS unmounted_at,
      rru.starting_weight_grams                    AS starting_weight_grams,
      rru.ending_weight_grams                      AS ending_weight_grams,
      rru.expected_used_grams                      AS expected_used_grams,
      rru.actual_used_grams                        AS actual_used_grams,
      rru.variance_grams                           AS variance_grams,
      rru.variance_pct::text                       AS variance_pct,
      rru.blisters_produced                        AS blisters_produced,
      rru.confidence                               AS confidence,
      pl.supplier                                  AS supplier,
      CASE
        WHEN eim.external_system_id IS NOT NULL THEN es.code
        WHEN po.id IS NOT NULL                  THEN 'LUMA_PO'
        ELSE 'LUMA_RECEIVE'
      END                                          AS source_system,
      COALESCE(eim.external_item_code, po.po_number) AS external_po_id
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    ORDER BY rru.unmounted_at DESC NULLS LAST, rru.mounted_at DESC
    LIMIT 200
  `);
  const rows = rowsQ as unknown as RollVarianceRow[];

  const summaryQ = await db.execute<Summary>(sql`
    SELECT
      COUNT(*)::int                                                        AS total_rolls,
      COUNT(*) FILTER (WHERE actual_used_grams IS NOT NULL)::int           AS with_weighback,
      SUM(variance_grams)::int                                             AS total_variance_grams,
      COUNT(*) FILTER (WHERE ABS(COALESCE(variance_pct, 0)) > 5)::int      AS rolls_over_5pct
    FROM read_roll_usage
  `);
  const s = (summaryQ as unknown as Summary[])[0] ?? {
    total_rolls: 0,
    with_weighback: 0,
    total_variance_grams: null,
    rolls_over_5pct: 0,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roll variance"
        description="Counter-segment yield × standard = expected grams. Actual grams = weigh-back OR full net weight when DEPLETED. Variance > 5% per roll is flagged. Rolls without a weigh-back AND not yet DEPLETED show actual = — at MEDIUM confidence."
      />

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Rolls tracked" value={String(s.total_rolls)} />
          <Stat
            label="With weigh-back (HIGH)"
            value={`${s.with_weighback} / ${s.total_rolls}`}
          />
          <Stat
            label="Total variance"
            value={s.total_variance_grams != null ? `${s.total_variance_grams} g` : "—"}
          />
          <Stat label="Rolls > 5% variance" value={String(s.rolls_over_5pct)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detail</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No rolls tracked yet. Variance appears once a roll is mounted, used, and weighed back.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Roll #</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-left p-2">Machine</th>
                    <th className="text-right p-2">Starting (g)</th>
                    <th className="text-right p-2">Ending (g)</th>
                    <th className="text-right p-2">Expected (g)</th>
                    <th className="text-right p-2">Actual (g)</th>
                    <th className="text-right p-2">Variance (g)</th>
                    <th className="text-right p-2">Variance %</th>
                    <th className="text-right p-2">Blisters made</th>
                    <th className="text-left p-2">Supplier</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pct = r.variance_pct != null ? Number(r.variance_pct) : null;
                    const flag = pct != null && Math.abs(pct) > 5;
                    return (
                      <tr key={r.packaging_lot_id} className="border-t border-border/40">
                        <td className="p-2">{r.roll_number ?? r.packaging_lot_id.slice(0, 8)}</td>
                        <td className="p-2">{r.material_role ?? "—"}</td>
                        <td className="p-2">{r.machine_name ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">
                          {r.starting_weight_grams ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.ending_weight_grams ?? "—"}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.expected_used_grams ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.actual_used_grams ?? "—"}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.variance_grams ?? "—"}
                        </td>
                        <td
                          className={
                            "p-2 text-right tabular-nums" +
                            (flag ? " text-rose-700 font-semibold" : "")
                          }
                        >
                          {pct != null ? `${pct.toFixed(2)}%` : "—"}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.blisters_produced ?? "—"}
                        </td>
                        <td className="p-2">{r.supplier ?? "—"}</td>
                        <td className="p-2 font-mono text-[10px]">{r.source_system ?? "—"}</td>
                        <td className="p-2">{r.confidence}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-page px-3 py-2">
      <div className="text-[10px] uppercase text-text-muted tracking-wider">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
