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
import { MissingState } from "@/components/production/missing-state";
import { deriveBagGenealogy } from "@/lib/production/metrics";
import type { MetricResult } from "@/lib/production/types";

export const dynamic = "force-dynamic";

// Light-surface badge styles per event type.
const STAGE_BADGES: Record<string, { label: string; cls: string }> = {
  CARD_ASSIGNED:           { label: "Started",      cls: "bg-info-50 text-info-700 border-info-500/40" },
  BLISTER_COMPLETE:        { label: "Blister",       cls: "bg-info-50 text-info-700 border-info-500/40" },
  SEALING_COMPLETE:        { label: "Seal",          cls: "bg-info-50 text-info-700 border-info-500/40" },
  PACKAGING_SNAPSHOT:      { label: "Pack",          cls: "bg-info-50 text-info-700 border-info-500/40" },
  PACKAGING_COMPLETE:      { label: "Pack",          cls: "bg-info-50 text-info-700 border-info-500/40" },
  BAG_PAUSED:              { label: "Pause",         cls: "bg-warn-50 text-warn-700 border-warn-500/40" },
  BAG_RESUMED:             { label: "Resume",        cls: "bg-good-50 text-good-700 border-good-500/40" },
  BAG_FINALIZED:           { label: "Finalized",     cls: "bg-good-50 text-good-700 border-good-500/40" },
  CARD_FORCE_RELEASED:     { label: "Force release", cls: "bg-crit-50 text-crit-700 border-crit-500/40" },
  PACKAGING_DAMAGE_RETURN: { label: "Damage",        cls: "bg-crit-50 text-crit-700 border-crit-500/40" },
  REWORK_SENT:             { label: "Rework sent",   cls: "bg-info-50 text-info-700 border-info-500/40" },
  REWORK_RECEIVED:         { label: "Rework rec",    cls: "bg-info-50 text-info-700 border-info-500/40" },
  SCRAP_RECORDED:          { label: "Scrap",         cls: "bg-crit-50 text-crit-700 border-crit-500/40" },
  SUBMISSION_CORRECTED:    { label: "Corrected",     cls: "bg-warn-50 text-warn-700 border-warn-500/40" },
  FINISHED_GOODS_RELEASED: { label: "Released",      cls: "bg-good-50 text-good-700 border-good-500/40" },
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
        className="inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text"
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

      {/* Summary stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <BagStat label="Events" metric={genealogy.summary.eventCount} />
        <BagStat label="Span" metric={genealogy.summary.spanMinutes} />
        <BagStat label="Stations" metric={genealogy.summary.distinctStations} />
        <BagStat
          label="Stage"
          metric={{
            value: bag.stage ?? "—",
            unit: null,
            confidence: bag.stage ? "HIGH" : "MISSING",
            missingInputs: bag.stage ? [] : ["read_bag_state"],
          }}
        />
        <BagStat
          label="Received"
          metric={{
            value: bag.receivedQty ?? "—",
            unit: bag.receivedQty != null ? "tablets" : null,
            confidence: bag.receivedQty != null ? "HIGH" : "MISSING",
            missingInputs: bag.receivedQty != null ? [] : ["inventory_bag"],
          }}
        />
      </div>

      {bag.isFinalized && (
        <div className="rounded-xl border border-good-500/30 bg-good-50 px-3 py-2 text-sm text-good-700 font-medium">
          Finalized at {bag.finalizedAt?.toISOString().replace("T", " ").slice(0, 19)}
        </div>
      )}
      {bag.isPaused && (
        <div className="rounded-xl border border-warn-500/30 bg-warn-50 px-3 py-2 text-sm text-warn-700 font-medium">
          Currently paused
        </div>
      )}

      <h2 className="text-sm font-semibold text-text-strong mt-2">Timeline</h2>

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
        <ol className="relative border-l-2 border-border pl-5 space-y-3">
          {genealogy.events.map((e) => {
            const badge = STAGE_BADGES[e.eventType];
            return (
              <li key={e.eventId} className="relative">
                <span
                  className="absolute -left-[11px] top-1.5 h-3.5 w-3.5 rounded-full bg-surface border-2 border-brand-700"
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-2 text-[12px] text-text">
                  <span className="font-mono text-text-muted">
                    {e.occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                  </span>
                  <span className="font-mono text-[11px] text-text-subtle">
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
                      className="inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider border-border bg-surface-2 text-text-muted font-mono"
                      title="Generic workflow event — no styled badge mapped."
                    >
                      {e.eventType}
                    </span>
                  )}
                  {e.machineName && (
                    <span className="text-text">{e.machineName}</span>
                  )}
                  {e.stationLabel && e.stationLabel !== e.machineName && (
                    <span className="text-text-muted">· {e.stationLabel}</span>
                  )}
                  {e.employeeName && (
                    <span className="text-text-muted">· {e.employeeName}</span>
                  )}
                </div>
                {e.notes && (
                  <div className="mt-0.5 text-[11px] text-text-subtle">{e.notes}</div>
                )}
                {!!e.payload && Object.keys(e.payload as Record<string, unknown>).length > 0 && (
                  <details className="mt-1 text-[11px]">
                    <summary className="cursor-pointer text-text-subtle hover:text-text-muted">
                      payload
                    </summary>
                    <pre className="mt-1 rounded-xl bg-surface-2 border border-border p-2 text-[10px] text-text overflow-x-auto">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex items-center gap-2 text-[11px] text-text-subtle pt-3">
        <ConfidenceBadge confidence={genealogy.confidence} /> Sourced direct
        from workflow_events for bag {bagId.slice(0, 8)}…
      </div>
    </div>
  );
}

function BagStat({ label, metric }: { label: string; metric: MetricResult }) {
  const isMissing = metric.confidence === "MISSING";
  return (
    <div className="rounded-xl border border-border/60 bg-surface-2/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.10em] font-semibold text-text-subtle">
          {label}
        </span>
        <ConfidenceBadge confidence={metric.confidence} />
      </div>
      <div
        className={`mt-1.5 text-lg font-semibold tabular-nums ${
          isMissing ? "text-text-subtle" : "text-text-strong"
        }`}
      >
        {isMissing
          ? (metric.label ?? "—")
          : `${metric.value ?? "—"}${metric.unit ? ` ${metric.unit}` : ""}`}
      </div>
    </div>
  );
}
