// Genealogy search page. Lists recent bags + a manual lookup form.
// The search form posts to /genealogy?bag=<id>; valid IDs redirect
// to /genealogy/[bagId] for the timeline view.

import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { count, desc, eq } from "drizzle-orm";
import { workflowBags, products, readBagState } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata = { title: "Bag Genealogy" };

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

  const [recent, [totalRow], [finalizedRow], [pausedRow]] = await Promise.all([
    db
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
      .limit(50),
    db.select({ n: count() }).from(workflowBags),
    db.select({ n: count() }).from(readBagState).where(eq(readBagState.isFinalized, true)),
    db.select({ n: count() }).from(readBagState).where(eq(readBagState.isPaused, true)),
  ]);

  const total = totalRow?.n ?? 0;
  const finalized = finalizedRow?.n ?? 0;
  const paused = pausedRow?.n ?? 0;
  const inFlight = Math.max(0, total - finalized - paused);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bag genealogy"
        description="Per-bag chronological event history. Search by bag UUID or pick from the recent list."
      />

      {total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total bags" value={String(total)} />
          <StatCard label="Finalized" value={String(finalized)} />
          <StatCard label="In flight" value={String(inFlight)} />
          <StatCard label="Paused" value={String(paused)} />
        </div>
      )}

      <form
        action="/genealogy"
        method="get"
        className="rounded-xl border border-border/70 bg-surface-2/30 p-4 flex flex-col sm:flex-row gap-2 items-end"
      >
        <label className="flex-1 block">
          <span className="text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle block mb-1.5">
            Bag UUID
          </span>
          <input
            type="text"
            name="bag"
            placeholder="Paste bag UUID…"
            className="w-full h-9 px-2.5 rounded-md bg-surface border border-border text-sm text-text font-mono placeholder:text-text-subtle focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700/20"
          />
        </label>
        <button
          type="submit"
          className="h-9 px-4 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium shrink-0"
        >
          Open
        </button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Recent bags (last {recent.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          <DataTable className="border-0 rounded-none">
            <THead>
              <TR>
                <TH>Bag</TH>
                <TH>Product</TH>
                <TH>Stage</TH>
                <TH>Status</TH>
                <TH>Last event</TH>
                <TH className="text-right">View</TH>
              </TR>
            </THead>
            <tbody>
              {recent.length === 0 ? (
                <EmptyRow colSpan={6}>No bags recorded yet.</EmptyRow>
              ) : (
                recent.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      <span className="font-mono text-[11px] text-text">{b.id.slice(0, 8)}…</span>
                      {b.receiptNumber && (
                        <div className="text-[10px] text-text-subtle">
                          receipt {b.receiptNumber}
                          {b.bagNumber ? ` · bag ${b.bagNumber}` : ""}
                        </div>
                      )}
                    </TD>
                    <TD>
                      <div className="font-medium text-text text-[13px]">
                        {b.productName ?? <span className="text-text-subtle">—</span>}
                      </div>
                      {b.productSku && (
                        <div className="text-[10px] text-text-subtle font-mono">{b.productSku}</div>
                      )}
                    </TD>
                    <TD>
                      <span className="text-[11px] text-text-muted">{b.stage ?? "—"}</span>
                    </TD>
                    <TD>
                      {b.isFinalized ? (
                        <StatusChip tone="good">Finalized</StatusChip>
                      ) : b.isPaused ? (
                        <StatusChip tone="warn">Paused</StatusChip>
                      ) : (
                        <StatusChip tone="info">In flight</StatusChip>
                      )}
                    </TD>
                    <TD>
                      <span className="font-mono text-[11px] text-text-muted">
                        {b.lastEventAt
                          ? b.lastEventAt.toISOString().slice(0, 19).replace("T", " ")
                          : "—"}
                      </span>
                    </TD>
                    <TD className="text-right">
                      <Link
                        href={`/genealogy/${b.id}`}
                        className="text-[11px] text-brand-700 hover:text-brand-800 font-medium"
                      >
                        Open →
                      </Link>
                    </TD>
                  </TR>
                ))
              )}
            </tbody>
          </DataTable>
        </CardContent>
      </Card>

      <p className="text-[11px] text-text-subtle">
        Reads chronologically off the append-only workflow_events log — no derivation, no projection lag.
      </p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text-strong">{value}</div>
    </div>
  );
}

function StatusChip({
  tone,
  children,
}: {
  tone: "good" | "warn" | "info";
  children: ReactNode;
}) {
  const cls: Record<string, string> = {
    good: "bg-good-50 text-good-700 border-good-500/40",
    warn: "bg-warn-50 text-warn-700 border-warn-500/40",
    info: "bg-info-50 text-info-700 border-info-500/40",
  };
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider ${cls[tone]}`}
    >
      {children}
    </span>
  );
}
