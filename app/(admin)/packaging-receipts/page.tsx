// PT-4C — Packaging receipts admin list.
//
// Shows every packaging_lots row with the new PT-1 receipt fields
// (declared / counted / accepted / confidence / source / box / variance).
// Filters via search-params: source, confidence, has_variance,
// packtrack_only, supplier, date range.
//
// Receipt variance is rendered as a labelled bucket — never as
// "production loss". Distinct UI badges so the operator can read
// the lifecycle of each lot at a glance.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import Link from "next/link";

export const dynamic = "force-dynamic";

type ReceiptRow = {
  lot_id: string;
  material_sku: string | null;
  material_name: string | null;
  supplier: string | null;
  box_number: string | null;
  supplier_lot_number: string | null;
  declared_quantity: number | null;
  counted_quantity: number | null;
  accepted_quantity: number | null;
  qty_on_hand: number | null;
  uom: string | null;
  confidence: string | null;
  source_system: string | null;
  packtrack_po_id: string | null;
  packtrack_receipt_id: string | null;
  received_at: string | null;
  status: string;
  has_receipt_variance: boolean;
  receipt_variance: number | null;
  has_cycle_count: boolean;
};

export default async function PackagingReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string;
    confidence?: string;
    variance?: string;
    packtrack?: string;
    supplier?: string;
    from?: string;
    to?: string;
  }>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const conditions: string[] = ["1 = 1"];
  if (sp.source) conditions.push(`pl.source_system = '${sp.source.replace(/'/g, "''")}'`);
  if (sp.confidence)
    conditions.push(`pl.confidence = '${sp.confidence.replace(/'/g, "''")}'`);
  if (sp.variance === "1")
    conditions.push(
      `(pl.counted_quantity IS NOT NULL AND pl.declared_quantity IS NOT NULL AND pl.counted_quantity <> pl.declared_quantity)`,
    );
  if (sp.packtrack === "1")
    conditions.push(`pl.packtrack_receipt_id IS NOT NULL`);
  if (sp.supplier)
    conditions.push(`pl.supplier ILIKE '%${sp.supplier.replace(/'/g, "''")}%'`);
  if (sp.from)
    conditions.push(`pl.received_at >= '${sp.from.replace(/'/g, "''")}'`);
  if (sp.to)
    conditions.push(`pl.received_at <= '${sp.to.replace(/'/g, "''")}'`);

  const whereClause = sql.raw(conditions.join(" AND "));

  const rowsQ = await db.execute<ReceiptRow>(sql`
    SELECT
      pl.id::text                                        AS lot_id,
      pm.sku                                             AS material_sku,
      pm.name                                            AS material_name,
      pl.supplier                                        AS supplier,
      pl.box_number                                      AS box_number,
      pl.supplier_lot_number                             AS supplier_lot_number,
      pl.declared_quantity                               AS declared_quantity,
      pl.counted_quantity                                AS counted_quantity,
      pl.accepted_quantity                               AS accepted_quantity,
      pl.qty_on_hand                                     AS qty_on_hand,
      pm.uom                                             AS uom,
      pl.confidence                                      AS confidence,
      pl.source_system::text                             AS source_system,
      pl.packtrack_po_id                                 AS packtrack_po_id,
      pl.packtrack_receipt_id                            AS packtrack_receipt_id,
      pl.received_at::text                               AS received_at,
      pl.status::text                                    AS status,
      (pl.counted_quantity IS NOT NULL
        AND pl.declared_quantity IS NOT NULL
        AND pl.counted_quantity <> pl.declared_quantity) AS has_receipt_variance,
      (CASE WHEN pl.counted_quantity IS NOT NULL AND pl.declared_quantity IS NOT NULL
            THEN pl.counted_quantity - pl.declared_quantity ELSE NULL END) AS receipt_variance,
      EXISTS(
        SELECT 1 FROM material_inventory_events ev
        WHERE ev.packaging_lot_id = pl.id
          AND ev.event_type = 'PACKAGING_RECEIPT_ADJUSTED'
      )                                                  AS has_cycle_count
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    WHERE ${whereClause}
    ORDER BY pl.received_at DESC NULLS LAST
    LIMIT 200
  `);
  const rows = rowsQ as unknown as ReceiptRow[];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging receipts"
        description="Every packaging_lots row including manual Luma + PackTrack-origin receipts. Receipt variance is shown as a separate bucket — never as production loss."
      />

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="GET"
            className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm"
          >
            <Field label="Source">
              <select
                name="source"
                defaultValue={sp.source ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              >
                <option value="">All</option>
                <option value="PACKTRACK">PACKTRACK</option>
                <option value="MANUAL_LUMA">MANUAL_LUMA</option>
                <option value="ZOHO">ZOHO</option>
                <option value="IMPORT">IMPORT</option>
              </select>
            </Field>
            <Field label="Confidence">
              <select
                name="confidence"
                defaultValue={sp.confidence ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              >
                <option value="">All</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
                <option value="MISSING">MISSING</option>
              </select>
            </Field>
            <Field label="Variance">
              <select
                name="variance"
                defaultValue={sp.variance ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              >
                <option value="">All</option>
                <option value="1">Receipt variance only</option>
              </select>
            </Field>
            <Field label="PackTrack only">
              <select
                name="packtrack"
                defaultValue={sp.packtrack ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              >
                <option value="">All sources</option>
                <option value="1">PackTrack only</option>
              </select>
            </Field>
            <Field label="Supplier (contains)">
              <input
                name="supplier"
                defaultValue={sp.supplier ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              />
            </Field>
            <Field label="Received from">
              <input
                type="date"
                name="from"
                defaultValue={sp.from ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              />
            </Field>
            <Field label="Received to">
              <input
                type="date"
                name="to"
                defaultValue={sp.to ?? ""}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5"
              />
            </Field>
            <div className="flex items-end">
              <button
                type="submit"
                className="rounded bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium px-3 py-1.5"
              >
                Apply
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Receipts ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">No receipts match the filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Material</th>
                    <th className="text-left p-2">Supplier / Lot / Box</th>
                    <th className="text-right p-2">Declared</th>
                    <th className="text-right p-2">Counted</th>
                    <th className="text-right p-2">Accepted</th>
                    <th className="text-right p-2">On-hand</th>
                    <th className="text-left p-2">Badges</th>
                    <th className="text-left p-2">PackTrack ids</th>
                    <th className="text-left p-2">Received</th>
                    <th className="text-left p-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.lot_id} className="border-t border-border/40">
                      <td className="p-2">
                        <SourceBadge source={r.source_system} />
                      </td>
                      <td className="p-2">
                        <div className="font-mono">{r.material_sku ?? "—"}</div>
                        <div className="text-text-muted">{r.material_name ?? ""}</div>
                      </td>
                      <td className="p-2 text-[11px]">
                        <div>{r.supplier ?? "—"}</div>
                        <div className="text-text-muted font-mono">
                          {r.supplier_lot_number ? `lot ${r.supplier_lot_number}` : ""}
                          {r.box_number ? ` · box ${r.box_number}` : ""}
                        </div>
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.declared_quantity ?? "—"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.counted_quantity ?? "—"}
                      </td>
                      <td className="p-2 text-right tabular-nums font-semibold">
                        {r.accepted_quantity ?? "—"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.qty_on_hand ?? "—"}
                      </td>
                      <td className="p-2 space-y-1">
                        <ConfidenceBadge confidence={r.confidence} />
                        {r.has_receipt_variance && (
                          <Badge color="rose">
                            Receipt variance{" "}
                            {r.receipt_variance != null
                              ? `(${r.receipt_variance > 0 ? "+" : ""}${r.receipt_variance})`
                              : ""}
                          </Badge>
                        )}
                        {r.has_cycle_count && <Badge color="sky">Cycle-counted</Badge>}
                      </td>
                      <td className="p-2 text-[10px] font-mono">
                        {r.packtrack_po_id && <div>po {r.packtrack_po_id}</div>}
                        {r.packtrack_receipt_id && (
                          <div>rcpt {r.packtrack_receipt_id}</div>
                        )}
                        {!r.packtrack_po_id && !r.packtrack_receipt_id && "—"}
                      </td>
                      <td className="p-2">
                        {r.received_at
                          ? new Date(r.received_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="p-2">
                        <Link
                          href={`/packaging-receipts/${r.lot_id}/adjust`}
                          className="text-brand-700 hover:underline"
                        >
                          Adjust
                        </Link>
                      </td>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function Badge({
  color,
  children,
}: {
  color: "emerald" | "amber" | "rose" | "slate" | "sky";
  children: React.ReactNode;
}) {
  const cls = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    sky: "bg-sky-50 text-sky-700 border-sky-200",
  }[color];
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[10px] mr-1 ${cls}`}
    >
      {children}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence)
    return <Badge color="slate">No confidence</Badge>;
  switch (confidence) {
    case "HIGH":
      return <Badge color="emerald">Physically counted</Badge>;
    case "MEDIUM":
      return <Badge color="amber">Supplier-declared only</Badge>;
    case "LOW":
      return <Badge color="slate">Imported low confidence</Badge>;
    case "MISSING":
      return <Badge color="rose">Missing quantity</Badge>;
    default:
      return <Badge color="slate">{confidence}</Badge>;
  }
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <Badge color="slate">legacy</Badge>;
  switch (source) {
    case "PACKTRACK":
      return <Badge color="sky">PackTrack</Badge>;
    case "MANUAL_LUMA":
      return <Badge color="emerald">Manual Luma</Badge>;
    case "ZOHO":
      return <Badge color="amber">Zoho</Badge>;
    case "IMPORT":
      return <Badge color="slate">Imported</Badge>;
    default:
      return <Badge color="slate">{source}</Badge>;
  }
}
