// Genealogy search page. Lists recent bags + a manual lookup
// form. The search form posts to /genealogy?bag=<id>; valid IDs
// redirect to /genealogy/[bagId] for the timeline view.

import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { workflowBags, products, readBagState } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ConfidenceBadge } from "@/components/production/confidence-badge";

export const dynamic = "force-dynamic";

export default async function GenealogySearchPage({
  searchParams,
}: {
  searchParams: Promise<{ bag?: string; q?: string }>;
}) {
  await requireSession();
  const sp = await searchParams;
  if (sp.bag && /^[0-9a-f-]{36}$/i.test(sp.bag)) {
    redirect(`/genealogy/${sp.bag}`);
  }
  const recent = await db
    .select({
      id: workflowBags.id,
      receiptNumber: workflowBags.receiptNumber,
      bagNumber: workflowBags.bagNumber,
      productName: products.name,
      productSku: products.sku,
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      isPaused: readBagState.isPaused,
      lastEventAt: readBagState.lastEventAt,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .orderBy(desc(workflowBags.startedAt))
    .limit(50);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Bag genealogy"
        description="Per-bag chronological event history. Search by bag UUID or pick from the recent list."
      />
      <form
        action="/genealogy"
        method="get"
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 flex flex-col sm:flex-row gap-2 items-end"
      >
        <label className="flex-1 block">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">
            Bag UUID
          </span>
          <input
            type="text"
            name="bag"
            placeholder="bag-uuid…"
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
        >
          Open
        </button>
      </form>

      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Bag</th>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-left px-3 py-2">Stage</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Last event</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No bags recorded yet.
                </td>
              </tr>
            ) : (
              recent.map((b) => (
                <tr key={b.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {b.id.slice(0, 8)}…
                    {b.receiptNumber && (
                      <div className="text-[10px] text-slate-500">
                        receipt {b.receiptNumber}
                        {b.bagNumber ? ` · bag ${b.bagNumber}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-200">
                    {b.productName ?? <span className="text-slate-500">—</span>}
                    {b.productSku && (
                      <div className="text-[10px] text-slate-500 font-mono">
                        {b.productSku}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{b.stage ?? "—"}</td>
                  <td className="px-3 py-2">
                    {b.isFinalized ? (
                      <span className="text-emerald-300 text-[11px]">finalized</span>
                    ) : b.isPaused ? (
                      <span className="text-amber-300 text-[11px]">paused</span>
                    ) : (
                      <span className="text-cyan-300 text-[11px]">in flight</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {b.lastEventAt ? b.lastEventAt.toISOString().slice(0, 19).replace("T", " ") : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/genealogy/${b.id}`}
                      className="text-[11px] text-cyan-300 hover:text-cyan-200"
                    >
                      open →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <ConfidenceBadge confidence="HIGH" /> Reads chronologically off the
        append-only workflow_events log — no derivation, no projection lag.
      </div>
    </div>
  );
}
