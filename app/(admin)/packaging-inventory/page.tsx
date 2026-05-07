// Phase H.x7 — Packaging inventory panel.
//
// Read-only view of every packaging_lots row across the seven roll +
// non-roll material kinds. Surfaces source_system, supplier, receipt
// number, lot id, weights, status, confidence — every integration
// field the H.x7 spec calls for. Empty state explicitly says "No
// packaging materials configured" / "No lots received yet" rather
// than rendering 0.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type LotRow = {
  lot_id: string;
  material_name: string;
  material_kind: string;
  material_sku: string;
  roll_number: string | null;
  status: string;
  qty_on_hand: number;
  uom: string;
  net_weight_grams: number | null;
  current_weight_grams_estimate: number | null;
  supplier: string | null;
  location: string | null;
  source_system: string | null;
  external_po_id: string | null;
  receipt_number: string | null;
  received_at: string | null;
  confidence: string | null;
};

type StatusCount = { status: string; n: number };
type KindCount = { kind: string; lots: number; total_grams: number | null; total_units: number | null };

export default async function PackagingInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const lotsQ = await db.execute<LotRow>(sql`
    SELECT
      pl.id::text                              AS lot_id,
      pm.name                                  AS material_name,
      pm.kind::text                            AS material_kind,
      pm.sku                                   AS material_sku,
      pl.roll_number                           AS roll_number,
      pl.status::text                          AS status,
      pl.qty_on_hand                           AS qty_on_hand,
      pm.uom                                   AS uom,
      pl.net_weight_grams                      AS net_weight_grams,
      pl.current_weight_grams_estimate         AS current_weight_grams_estimate,
      pl.supplier                              AS supplier,
      pl.location                              AS location,
      CASE
        WHEN eim.external_system_id IS NOT NULL THEN es.code
        WHEN po.id IS NOT NULL                  THEN 'LUMA_PO'
        ELSE 'LUMA_RECEIVE'
      END                                      AS source_system,
      COALESCE(eim.external_item_code, po.po_number) AS external_po_id,
      po.po_number                             AS receipt_number,
      pl.received_at::text                     AS received_at,
      pl.confidence                            AS confidence
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN external_item_mappings eim ON eim.material_item_id = pm.id AND eim.is_active = true
    LEFT JOIN external_systems es ON es.id = eim.external_system_id
    WHERE 1=1
    ${sp.kind ? sql`AND pm.kind::text = ${sp.kind}` : sql``}
    ${sp.status ? sql`AND pl.status::text = ${sp.status}` : sql``}
    ORDER BY pl.received_at DESC NULLS LAST
    LIMIT 500
  `);
  const lots = lotsQ as unknown as LotRow[];

  const statusCountsQ = await db.execute<StatusCount>(sql`
    SELECT status::text AS status, COUNT(*)::int AS n
    FROM packaging_lots
    GROUP BY status
    ORDER BY status
  `);
  const statusCounts = statusCountsQ as unknown as StatusCount[];

  const kindCountsQ = await db.execute<KindCount>(sql`
    SELECT
      pm.kind::text                                      AS kind,
      COUNT(pl.id)::int                                  AS lots,
      SUM(pl.net_weight_grams)::int                      AS total_grams,
      SUM(pl.qty_on_hand)::int                           AS total_units
    FROM packaging_materials pm
    LEFT JOIN packaging_lots pl ON pl.packaging_material_id = pm.id
    WHERE pm.is_active = true
    GROUP BY pm.kind
    ORDER BY pm.kind
  `);
  const kindCounts = kindCountsQ as unknown as KindCount[];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging inventory"
        description="Read-only view of every received packaging lot. Source system, supplier, receipt number, weights, and confidence are surfaced honestly — empty cells mean missing data, never zero."
      />

      <Card>
        <CardHeader>
          <CardTitle>Status breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {statusCounts.length === 0 ? (
            <p className="text-sm text-text-muted">No lots received yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {statusCounts.map((s) => (
                <span
                  key={s.status}
                  className="rounded border border-border/60 bg-page px-3 py-1 text-xs font-medium tabular-nums"
                >
                  <span className="text-text-muted uppercase mr-1">{s.status}</span>
                  {s.n}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By material kind</CardTitle>
        </CardHeader>
        <CardContent>
          {kindCounts.length === 0 ? (
            <p className="text-sm text-text-muted">No packaging materials configured.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-text-muted text-xs uppercase">
                  <tr>
                    <th className="text-left p-2">Kind</th>
                    <th className="text-right p-2">Lots</th>
                    <th className="text-right p-2">Total units</th>
                    <th className="text-right p-2">Total g (rolls)</th>
                  </tr>
                </thead>
                <tbody>
                  {kindCounts.map((k) => (
                    <tr key={k.kind} className="border-t border-border/40">
                      <td className="p-2">{k.kind}</td>
                      <td className="p-2 text-right tabular-nums">{k.lots}</td>
                      <td className="p-2 text-right tabular-nums">{k.total_units ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">{k.total_grams ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lots</CardTitle>
        </CardHeader>
        <CardContent>
          {lots.length === 0 ? (
            <p className="text-sm text-text-muted">No lots received yet for the current filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Lot id</th>
                    <th className="text-left p-2">Roll #</th>
                    <th className="text-left p-2">Material</th>
                    <th className="text-left p-2">Kind</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-right p-2">Net (g)</th>
                    <th className="text-right p-2">Current est. (g)</th>
                    <th className="text-right p-2">Qty on hand</th>
                    <th className="text-left p-2">Supplier</th>
                    <th className="text-left p-2">PO / receipt</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.lot_id} className="border-t border-border/40">
                      <td className="p-2 font-mono text-[10px]">{l.lot_id.slice(0, 8)}</td>
                      <td className="p-2">{l.roll_number ?? "—"}</td>
                      <td className="p-2">{l.material_name}</td>
                      <td className="p-2">{l.material_kind}</td>
                      <td className="p-2">{l.status}</td>
                      <td className="p-2 text-right tabular-nums">{l.net_weight_grams ?? ""}</td>
                      <td className="p-2 text-right tabular-nums">
                        {l.current_weight_grams_estimate ?? ""}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {l.qty_on_hand} {l.uom}
                      </td>
                      <td className="p-2">{l.supplier ?? "—"}</td>
                      <td className="p-2">{l.external_po_id ?? "—"}</td>
                      <td className="p-2 font-mono text-[10px]">{l.source_system ?? "—"}</td>
                      <td className="p-2">{l.confidence ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
