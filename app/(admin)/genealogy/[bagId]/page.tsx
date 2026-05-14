// Bag genealogy timeline. Reads deriveBagGenealogy — no inline
// queries. Renders the event stream chronologically with badges
// for stage / status, plus a header summary block.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  workflowBags,
  readBagState,
  products,
  inventoryBags,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { MetricCard } from "@/components/production/metric-card";
import { MissingState } from "@/components/production/missing-state";
import { deriveBagGenealogy } from "@/lib/production/metrics";

export const dynamic = "force-dynamic";

const STAGE_BADGES: Record<string, { label: string; cls: string }> = {
  CARD_ASSIGNED: { label: "Started", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  BLISTER_COMPLETE: { label: "Blister", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  SEALING_COMPLETE: { label: "Seal", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  PACKAGING_SNAPSHOT: { label: "Pack", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  PACKAGING_COMPLETE: { label: "Pack", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  BAG_PAUSED: { label: "Pause", cls: "bg-amber-500/10 text-amber-200 border-amber-500/40" },
  BAG_RESUMED: { label: "Resume", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40" },
  BAG_FINALIZED: { label: "Finalized", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40" },
  CARD_FORCE_RELEASED: { label: "Force release", cls: "bg-rose-500/10 text-rose-300 border-rose-500/40" },
  PACKAGING_DAMAGE_RETURN: { label: "Damage", cls: "bg-rose-500/10 text-rose-300 border-rose-500/40" },
  REWORK_SENT: { label: "Rework sent", cls: "bg-sky-500/10 text-sky-300 border-sky-500/40" },
  REWORK_RECEIVED: { label: "Rework rec", cls: "bg-sky-500/10 text-sky-300 border-sky-500/40" },
  SCRAP_RECORDED: { label: "Scrap", cls: "bg-rose-700/20 text-rose-200 border-rose-700/60" },
  SUBMISSION_CORRECTED: { label: "Corrected", cls: "bg-amber-500/10 text-amber-200 border-amber-500/40" },
  FINISHED_GOODS_RELEASED: { label: "Released", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40" },
};

export default async function BagGenealogyPage({
  params,
}: {
  params: Promise<{ bagId: string }>;
}) {
  await requireSession();
  const { bagId } = await params;

  const [bag] = await db
    .select({
      id: workflowBags.id,
      receiptNumber: workflowBags.receiptNumber,
      bagNumber: workflowBags.bagNumber,
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
      productName: products.name,
      productSku: products.sku,
      productKind: products.kind,
      receivedQty: inventoryBags.pillCount,
      stage: readBagState.stage,
      isPaused: readBagState.isPaused,
      isFinalized: readBagState.isFinalized,
      currentOperator: readBagState.currentOperatorCode,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(eq(workflowBags.id, bagId))
    .limit(1);
  if (!bag) notFound();

  const genealogy = await deriveBagGenealogy(bagId);

  return (
    <div className="space-y-5">
      <Link
        href="/genealogy"
        className="inline-flex items-center gap-1 text-[12px] text-slate-400 hover:text-cyan-300"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        all bags
      </Link>
      <PageHeader
        title={`Bag ${bag.id.slice(0, 8)}…`}
        description={
          bag.productName
            ? `${bag.productName} (${bag.productSku ?? ""}) · ${bag.productKind}`
            : "Product not yet mapped"
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <MetricCard label="Events" metric={genealogy.summary.eventCount} size="sm" />
        <MetricCard label="Span" metric={genealogy.summary.spanMinutes} size="sm" />
        <MetricCard label="Stations" metric={genealogy.summary.distinctStations} size="sm" />
        <MetricCard
          label="Stage"
          metric={{
            value: bag.stage ?? "—",
            unit: null,
            confidence: bag.stage ? "HIGH" : "MISSING",
            missingInputs: bag.stage ? [] : ["read_bag_state"],
          }}
          size="sm"
        />
        <MetricCard
          label="Received"
          metric={{
            value: bag.receivedQty ?? "—",
            unit: bag.receivedQty != null ? "tablets" : null,
            confidence: bag.receivedQty != null ? "HIGH" : "MISSING",
            missingInputs: bag.receivedQty != null ? [] : ["inventory_bag"],
          }}
          size="sm"
        />
      </div>

      {bag.isFinalized && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
          Finalized at {bag.finalizedAt?.toISOString().replace("T", " ").slice(0, 19)}
        </div>
      )}
      {bag.isPaused && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
          Currently paused
        </div>
      )}

      <h2 className="text-sm font-semibold text-slate-200 mt-6">Timeline</h2>

      {genealogy.confidence === "MISSING" || genealogy.events.length === 0 ? (
        <MissingState
          metric={{
            value: null,
            unit: null,
            confidence: "MISSING",
            missingInputs: genealogy.missingInputs,
            label: "No events recorded for this bag",
          }}
        />
      ) : (
        <ol className="relative border-l-2 border-slate-800 pl-5 space-y-3">
          {genealogy.events.map((e) => {
            const badge = STAGE_BADGES[e.eventType];
            return (
              <li key={e.eventId} className="relative">
                <span
                  className="absolute -left-[11px] top-1.5 h-3.5 w-3.5 rounded-full bg-slate-900 border-2 border-cyan-500"
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-2 text-[12px] text-slate-300">
                  <span className="font-mono text-slate-400">
                    {e.occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    #{e.sequence}
                  </span>
                  {badge ? (
                    <span
                      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider border-slate-700 bg-slate-800/60 text-slate-300 font-mono"
                      title="Generic workflow event — no styled badge mapped."
                    >
                      {e.eventType}
                    </span>
                  )}
                  {e.machineName && (
                    <span className="text-slate-300">{e.machineName}</span>
                  )}
                  {e.stationLabel && e.stationLabel !== e.machineName && (
                    <span className="text-slate-500">· {e.stationLabel}</span>
                  )}
                  {e.employeeName && (
                    <span className="text-slate-400">· {e.employeeName}</span>
                  )}
                </div>
                {e.notes && (
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {e.notes}
                  </div>
                )}
                {!!e.payload && Object.keys(e.payload as Record<string, unknown>).length > 0 && (
                  <details className="mt-1 text-[11px]">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
                      payload
                    </summary>
                    <pre className="mt-1 rounded-md bg-slate-950 border border-slate-800 p-2 text-[10px] text-slate-300 overflow-x-auto">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-3">
        <ConfidenceBadge confidence={genealogy.confidence} /> Sourced direct
        from workflow_events for bag {bagId.slice(0, 8)}…
      </div>
    </div>
  );
}
