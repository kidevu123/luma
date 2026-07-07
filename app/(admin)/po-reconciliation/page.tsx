import { formatDateEst } from "@/lib/ui/luma-display";
// Phase H.x3.5 — PO reconciliation list.
//
// One row per PO with totals + confidence. Filter by vendor/raw item
// is supported via search params; a future phase can add chips.

import Link from "next/link";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { listPoSummaries } from "@/lib/production/po-reconciliation";

export const dynamic = "force-dynamic";

export const metadata = { title: "PO Reconciliation" };

export default async function PoReconciliationListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vendor?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const all = await listPoSummaries();
  const filtered = all.filter((p) => {
    if (sp.q && !p.po_number.toLowerCase().includes(sp.q.toLowerCase())) return false;
    if (sp.vendor && (p.vendor_name ?? "").toLowerCase() !== sp.vendor.toLowerCase()) return false;
    return true;
  });

  // Distinct vendors for the dropdown.
  type VendorRow = { vendor_name: string };
  const vendors = (await db.execute<VendorRow>(sql`
    SELECT DISTINCT vendor_name FROM purchase_orders WHERE vendor_name IS NOT NULL ORDER BY vendor_name
  `)) as unknown as VendorRow[];

  return (
    <div className="space-y-5">
      <PageHeader
        title="PO reconciliation"
        description="Reconcile vendor declared counts vs. our internal estimate, finished output, known loss, and remaining inventory per purchase order."
      />

      <div className="flex items-center justify-end text-xs">
        <Link
          href="/po-reconciliation-v2"
          className="text-cyan-700 hover:text-cyan-800 underline"
        >
          Multi-scope variance lens →
        </Link>
      </div>

      <form className="flex flex-wrap gap-2 items-end" action="/po-reconciliation">
        <label className="text-sm">
          <div className="text-[11px] uppercase text-text-muted mb-0.5">PO number</div>
          <input
            type="text"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="search…"
            className="block bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <div className="text-[11px] uppercase text-text-muted mb-0.5">Vendor</div>
          <select
            name="vendor"
            defaultValue={sp.vendor ?? ""}
            className="block bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
          >
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.vendor_name} value={v.vendor_name}>
                {v.vendor_name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5"
        >
          Apply
        </button>
      </form>

      <div className="rounded-2xl border border-border bg-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-page text-text-muted text-xs uppercase">
            <tr>
              <th className="text-left p-3">PO</th>
              <th className="text-left p-3">Vendor</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Bags</th>
              <th className="text-left p-3">Opened</th>
              <th className="text-left p-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-text-muted">
                  No POs match the filter.
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.po_id} className="border-t border-border/40">
                  <td className="p-3 font-mono">{p.po_number}</td>
                  <td className="p-3">{p.vendor_name ?? "—"}</td>
                  <td className="p-3">{p.status}</td>
                  <td className="p-3 text-right tabular-nums">{p.bag_count}</td>
                  <td className="p-3 tabular-nums">
                    {formatDateEst(p.opened_at)}
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/po-reconciliation/${p.po_id}`}
                      className="text-brand-700 hover:underline text-sm"
                    >
                      Open report →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
