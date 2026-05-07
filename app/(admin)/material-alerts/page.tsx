// Phase H.x7 — Material alerts panel.
//
// Read-only list of material conditions that need an admin's attention:
//   • Lots below par level
//   • Active rolls projected to run out within 8 hours
//   • Held / scrapped lots that are still flagged active
//   • Bags with allocation sessions still OPEN past a threshold
//
// Every alert carries enough context (source_system, supplier, lot id,
// confidence) for the admin to act without leaving the page.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type ShortageRow = {
  material_id: string;
  material_name: string;
  material_kind: string;
  par_level: number | null;
  total_on_hand: number | null;
  uom: string;
};

type RunoutRow = {
  packaging_lot_id: string;
  roll_number: string | null;
  material_name: string;
  material_role: string | null;
  machine_name: string | null;
  current_weight_grams_estimate: number | null;
  projected_blisters_remaining: number | null;
  confidence: string;
};

type HeldRow = {
  lot_id: string;
  material_name: string;
  status: string;
  qty_on_hand: number;
  uom: string;
  supplier: string | null;
};

type OpenAllocationRow = {
  session_id: string;
  inventory_bag_id: string;
  product_name: string | null;
  opened_at: string;
  hours_open: number;
};

export default async function MaterialAlertsPage() {
  await requireAdmin();

  const shortageQ = await db.execute<ShortageRow>(sql`
    SELECT
      pm.id::text                    AS material_id,
      pm.name                        AS material_name,
      pm.kind::text                  AS material_kind,
      pm.par_level                   AS par_level,
      SUM(pl.qty_on_hand)::int       AS total_on_hand,
      pm.uom                         AS uom
    FROM packaging_materials pm
    LEFT JOIN packaging_lots pl
      ON pl.packaging_material_id = pm.id
     AND pl.status IN ('AVAILABLE','IN_USE')
    WHERE pm.is_active = true
      AND pm.par_level IS NOT NULL
    GROUP BY pm.id
    HAVING COALESCE(SUM(pl.qty_on_hand), 0) < pm.par_level
    ORDER BY pm.par_level - COALESCE(SUM(pl.qty_on_hand), 0) DESC
    LIMIT 50
  `);
  const shortages = shortageQ as unknown as ShortageRow[];

  const runoutQ = await db.execute<RunoutRow>(sql`
    SELECT
      rru.packaging_lot_id::text                 AS packaging_lot_id,
      rru.roll_number                            AS roll_number,
      pm.name                                    AS material_name,
      rru.material_role                          AS material_role,
      m.name                                     AS machine_name,
      pl.current_weight_grams_estimate           AS current_weight_grams_estimate,
      rru.projected_blisters_remaining           AS projected_blisters_remaining,
      rru.confidence                             AS confidence
    FROM read_roll_usage rru
    JOIN packaging_lots pl ON pl.id = rru.packaging_lot_id
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN machines m ON m.id = rru.machine_id
    WHERE rru.mounted_at IS NOT NULL
      AND rru.unmounted_at IS NULL
      AND rru.projected_blisters_remaining IS NOT NULL
      AND rru.projected_blisters_remaining < 5000
    ORDER BY rru.projected_blisters_remaining ASC
    LIMIT 50
  `);
  const runouts = runoutQ as unknown as RunoutRow[];

  const heldQ = await db.execute<HeldRow>(sql`
    SELECT
      pl.id::text             AS lot_id,
      pm.name                 AS material_name,
      pl.status::text         AS status,
      pl.qty_on_hand          AS qty_on_hand,
      pm.uom                  AS uom,
      pl.supplier             AS supplier
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    WHERE pl.status IN ('HELD','SCRAPPED')
    ORDER BY pl.received_at DESC
    LIMIT 50
  `);
  const held = heldQ as unknown as HeldRow[];

  const openAllocQ = await db.execute<OpenAllocationRow>(sql`
    SELECT
      s.id::text                                    AS session_id,
      s.inventory_bag_id::text                      AS inventory_bag_id,
      p.name                                        AS product_name,
      s.opened_at::text                             AS opened_at,
      EXTRACT(EPOCH FROM (now() - s.opened_at))/3600 AS hours_open
    FROM raw_bag_allocation_sessions s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.allocation_status = 'OPEN'
      AND s.opened_at < now() - INTERVAL '12 hours'
    ORDER BY s.opened_at ASC
    LIMIT 50
  `);
  const openAllocs = openAllocQ as unknown as OpenAllocationRow[];

  const totalAlerts = shortages.length + runouts.length + held.length + openAllocs.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material alerts"
        description={`${totalAlerts} active alert${totalAlerts === 1 ? "" : "s"}. Read-only — clicking through to the related panels is the path to act.`}
      />

      {totalAlerts === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              No alerts. Inventory is above par, no rolls are projected to run out, no held lots,
              no stale open allocations.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Below par level ({shortages.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {shortages.length === 0 ? (
            <p className="text-sm text-text-muted">
              No materials below par. Materials without a configured par level do not appear here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Material</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-right p-2">Par level</th>
                  <th className="text-right p-2">On hand</th>
                  <th className="text-right p-2">Short by</th>
                </tr>
              </thead>
              <tbody>
                {shortages.map((s) => (
                  <tr key={s.material_id} className="border-t border-border/40">
                    <td className="p-2">{s.material_name}</td>
                    <td className="p-2">{s.material_kind}</td>
                    <td className="p-2 text-right tabular-nums">
                      {s.par_level} {s.uom}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {s.total_on_hand ?? 0} {s.uom}
                    </td>
                    <td className="p-2 text-right tabular-nums text-rose-700 font-semibold">
                      {(s.par_level ?? 0) - (s.total_on_hand ?? 0)} {s.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active rolls running out ({runouts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {runouts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No active rolls projected to run out. Rolls with no standard configured cannot
              project a runout — they will not appear here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Roll</th>
                  <th className="text-left p-2">Role</th>
                  <th className="text-left p-2">Machine</th>
                  <th className="text-right p-2">Current est. (g)</th>
                  <th className="text-right p-2">Blisters left</th>
                  <th className="text-left p-2">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {runouts.map((r) => (
                  <tr key={r.packaging_lot_id} className="border-t border-border/40">
                    <td className="p-2">
                      {r.roll_number ?? r.packaging_lot_id.slice(0, 8)}
                      <span className="text-[11px] text-text-muted ml-1">{r.material_name}</span>
                    </td>
                    <td className="p-2">{r.material_role ?? "—"}</td>
                    <td className="p-2">{r.machine_name ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">
                      {r.current_weight_grams_estimate ?? "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums text-amber-700 font-semibold">
                      {r.projected_blisters_remaining ?? "—"}
                    </td>
                    <td className="p-2">{r.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Held / scrapped lots ({held.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {held.length === 0 ? (
            <p className="text-sm text-text-muted">No held or scrapped lots.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Lot id</th>
                  <th className="text-left p-2">Material</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-right p-2">Qty on hand</th>
                  <th className="text-left p-2">Supplier</th>
                </tr>
              </thead>
              <tbody>
                {held.map((h) => (
                  <tr key={h.lot_id} className="border-t border-border/40">
                    <td className="p-2 font-mono text-[10px]">{h.lot_id.slice(0, 8)}</td>
                    <td className="p-2">{h.material_name}</td>
                    <td className="p-2">{h.status}</td>
                    <td className="p-2 text-right tabular-nums">
                      {h.qty_on_hand} {h.uom}
                    </td>
                    <td className="p-2">{h.supplier ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stale open allocations ({openAllocs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {openAllocs.length === 0 ? (
            <p className="text-sm text-text-muted">
              No allocation sessions older than 12 hours. (Sessions normally close within a shift.)
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Session</th>
                  <th className="text-left p-2">Inventory bag</th>
                  <th className="text-left p-2">Product</th>
                  <th className="text-right p-2">Open for</th>
                  <th className="text-left p-2">Opened at</th>
                </tr>
              </thead>
              <tbody>
                {openAllocs.map((a) => (
                  <tr key={a.session_id} className="border-t border-border/40">
                    <td className="p-2 font-mono text-[10px]">{a.session_id.slice(0, 8)}</td>
                    <td className="p-2 font-mono text-[10px]">{a.inventory_bag_id.slice(0, 8)}</td>
                    <td className="p-2">{a.product_name ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums text-amber-700">
                      {Number(a.hours_open).toFixed(1)} h
                    </td>
                    <td className="p-2">{new Date(a.opened_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
