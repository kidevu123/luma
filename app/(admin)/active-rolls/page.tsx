// Phase H.x7 — Active rolls panel.
//
// Read-only admin view of every currently-mounted PVC/foil roll
// across every machine. Surfaces source_system, supplier, lot id,
// confidence, estimated-vs-actual labels per the H.x7 spec.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type ActiveRollRow = {
  packaging_lot_id: string;
  roll_number: string | null;
  material_role: string | null;
  material_kind: string;
  material_name: string;
  machine_id: string | null;
  machine_name: string | null;
  mounted_at: string | null;
  starting_weight_grams: number | null;
  current_weight_grams_estimate: number | null;
  expected_used_grams: number | null;
  actual_used_grams: number | null;
  variance_grams: number | null;
  blisters_produced: number | null;
  projected_remaining_grams: number | null;
  projected_blisters_remaining: number | null;
  confidence: string;
  supplier: string | null;
  source_system: string | null;
  external_po_id: string | null;
  weighback_at: string | null;
};

export default async function ActiveRollsPage() {
  await requireAdmin();

  const rowsQ = await db.execute<ActiveRollRow>(sql`
    WITH last_weigh AS (
      SELECT DISTINCT ON (ev.packaging_lot_id)
        ev.packaging_lot_id, ev.occurred_at
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_WEIGHED'
      ORDER BY ev.packaging_lot_id, ev.occurred_at DESC, ev.id DESC
    )
    SELECT
      rru.packaging_lot_id::text                      AS packaging_lot_id,
      rru.roll_number                                 AS roll_number,
      rru.material_role                               AS material_role,
      rru.material_kind                               AS material_kind,
      pm.name                                         AS material_name,
      rru.machine_id::text                            AS machine_id,
      m.name                                          AS machine_name,
      rru.mounted_at::text                            AS mounted_at,
      rru.starting_weight_grams                       AS starting_weight_grams,
      pl.current_weight_grams_estimate                AS current_weight_grams_estimate,
      rru.expected_used_grams                         AS expected_used_grams,
      rru.actual_used_grams                           AS actual_used_grams,
      rru.variance_grams                              AS variance_grams,
      rru.blisters_produced                           AS blisters_produced,
      rru.projected_remaining_grams                   AS projected_remaining_grams,
      rru.projected_blisters_remaining                AS projected_blisters_remaining,
      rru.confidence                                  AS confidence,
      pl.supplier                                     AS supplier,
      CASE
        WHEN eim.external_system_id IS NOT NULL THEN es.code
        WHEN po.id IS NOT NULL                  THEN 'LUMA_PO'
        ELSE 'LUMA_RECEIVE'
      END                                             AS source_system,
      COALESCE(eim.external_item_code, po.po_number) AS external_po_id,
      lw.occurred_at::text                            AS weighback_at
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    LEFT JOIN last_weigh lw ON lw.packaging_lot_id = rru.packaging_lot_id
    WHERE rru.mounted_at IS NOT NULL
      AND rru.unmounted_at IS NULL
    ORDER BY rru.material_role, rru.mounted_at DESC
  `);
  const rows = rowsQ as unknown as ActiveRollRow[];

  // Group by machine for the per-machine summary at the top.
  const byMachine = new Map<string, ActiveRollRow[]>();
  for (const r of rows) {
    const key = r.machine_id ?? "unassigned";
    const arr = byMachine.get(key) ?? [];
    arr.push(r);
    byMachine.set(key, arr);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Active rolls"
        description="PVC and foil rolls currently mounted on a machine. 'Estimated' values come from configured or learned standards; 'Actual' values come from weigh-back."
      />

      {rows.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              No active rolls mounted across any machine.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>By machine</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from(byMachine.entries()).map(([machineId, machineRows]) => {
                const first = machineRows[0]!;
                const pvc = machineRows.find((r) => r.material_role === "PVC");
                const foil = machineRows.find((r) => r.material_role === "FOIL");
                return (
                  <div
                    key={machineId}
                    className="rounded border border-border bg-page p-3 text-sm"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold">
                          {first.machine_name ?? "Unassigned machine"}
                        </div>
                        <div className="text-[11px] text-text-muted font-mono">
                          {machineId.slice(0, 8)}
                        </div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        {pvc ? (
                          <RoleBadge label="PVC" roll={pvc} />
                        ) : (
                          <span className="text-text-muted">No PVC mounted</span>
                        )}
                        {foil ? (
                          <RoleBadge label="FOIL" roll={foil} />
                        ) : (
                          <span className="text-text-muted">No FOIL mounted</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Detail</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-text-muted uppercase">
                    <tr>
                      <th className="text-left p-2">Role</th>
                      <th className="text-left p-2">Roll #</th>
                      <th className="text-left p-2">Machine</th>
                      <th className="text-left p-2">Mounted</th>
                      <th className="text-right p-2">Starting (g)</th>
                      <th className="text-right p-2">Current est. (g)</th>
                      <th className="text-right p-2">Blisters made</th>
                      <th className="text-right p-2">Projected remaining (g)</th>
                      <th className="text-right p-2">Projected blisters left</th>
                      <th className="text-left p-2">Source</th>
                      <th className="text-left p-2">Conf.</th>
                      <th className="text-left p-2">Estimate vs actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.packaging_lot_id} className="border-t border-border/40">
                        <td className="p-2">{r.material_role ?? "—"}</td>
                        <td className="p-2">{r.roll_number ?? r.packaging_lot_id.slice(0, 8)}</td>
                        <td className="p-2">{r.machine_name ?? "—"}</td>
                        <td className="p-2">
                          {r.mounted_at
                            ? new Date(r.mounted_at).toLocaleString()
                            : "—"}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.starting_weight_grams ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.current_weight_grams_estimate ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.blisters_produced ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.projected_remaining_grams ?? ""}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.projected_blisters_remaining ?? ""}
                        </td>
                        <td className="p-2 font-mono text-[10px]">{r.source_system ?? "—"}</td>
                        <td className="p-2">{r.confidence}</td>
                        <td className="p-2">
                          {r.weighback_at != null
                            ? "Actual (weigh-back)"
                            : r.blisters_produced != null && r.blisters_produced > 0
                              ? r.expected_used_grams != null
                                ? "Counter segments + standard"
                                : "Counter segments only (standard missing)"
                              : "Mounted, no segments yet"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function RoleBadge({ label, roll }: { label: string; roll: ActiveRollRow }) {
  return (
    <span className="rounded border border-border/70 bg-surface px-2 py-1 text-[11px] tabular-nums">
      <span className="font-semibold mr-1">{label}</span>
      {roll.roll_number ?? roll.packaging_lot_id.slice(0, 8)} ·{" "}
      {roll.current_weight_grams_estimate != null
        ? `${roll.current_weight_grams_estimate} g`
        : roll.starting_weight_grams != null
          ? `${roll.starting_weight_grams} g (no weigh-back)`
          : "no weight"}{" "}
      · {roll.confidence}
    </span>
  );
}
