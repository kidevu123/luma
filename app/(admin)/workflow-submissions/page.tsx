// Workflow submissions — supervisor search across all production bags.
// Fills the TabletTracker gap: single page to find any bag by receipt,
// product, or bag number, with stage, operator, counts, and inline
// event history.

import { db } from "@/lib/db";
import {
  workflowBags,
  products,
  readBagState,
  readBagMetrics,
  workflowEvents,
} from "@/lib/db/schema";
import { eq, desc, and, or, ilike, gte, lte, count } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { WorkflowTable } from "./workflow-table";
import type { WorkflowBagRow } from "./workflow-table";

export const dynamic = "force-dynamic";

const STAGES = [
  "STARTED",
  "BLISTERED",
  "SEALED",
  "PACKAGED",
  "FINALIZED",
] as const;

export default async function WorkflowSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();

  const sp = await searchParams;

  const q = typeof sp["q"] === "string" && sp["q"].trim() !== "" ? sp["q"].trim() : null;
  const stage = typeof sp["stage"] === "string" && sp["stage"] !== "all" ? sp["stage"] : null;
  const finalized = typeof sp["finalized"] === "string" ? sp["finalized"] : "all";
  const from = typeof sp["from"] === "string" && sp["from"] !== "" ? sp["from"] : null;
  const to = typeof sp["to"] === "string" && sp["to"] !== "" ? sp["to"] : null;

  const conditions = [];

  if (q !== null) {
    conditions.push(
      or(
        ilike(workflowBags.receiptNumber, `%${q}%`),
        ilike(products.name, `%${q}%`),
      ),
    );
  }

  if (stage !== null) {
    conditions.push(eq(readBagState.stage, stage));
  }

  if (finalized === "yes") {
    conditions.push(eq(readBagState.isFinalized, true));
  } else if (finalized === "no") {
    conditions.push(eq(readBagState.isFinalized, false));
  }

  if (from !== null) {
    conditions.push(gte(workflowBags.startedAt, new Date(from)));
  }

  if (to !== null) {
    conditions.push(lte(workflowBags.startedAt, new Date(`${to}T23:59:59`)));
  }

  const rows = await db
    .select({
      id: workflowBags.id,
      receiptNumber: workflowBags.receiptNumber,
      bagNumber: workflowBags.bagNumber,
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
      productName: products.name,
      productSku: products.sku,
      productKind: products.kind,
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      isPaused: readBagState.isPaused,
      operatorCode: readBagState.currentOperatorCode,
      lastEventAt: readBagState.lastEventAt,
      masterCases: readBagMetrics.masterCases,
      displaysMade: readBagMetrics.displaysMade,
      looseCards: readBagMetrics.looseCards,
      damagedPackaging: readBagMetrics.damagedPackaging,
      rippedCards: readBagMetrics.rippedCards,
      unitsYielded: readBagMetrics.unitsYielded,
      inputPillCount: readBagMetrics.inputPillCount,
      activeSeconds: readBagMetrics.activeSeconds,
      blisterSeconds: readBagMetrics.blisterSeconds,
      sealingSeconds: readBagMetrics.sealingSeconds,
      packagingSeconds: readBagMetrics.packagingSeconds,
      eventCount: count(workflowEvents.id),
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(workflowEvents, eq(workflowEvents.workflowBagId, workflowBags.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      workflowBags.id,
      workflowBags.receiptNumber,
      workflowBags.bagNumber,
      workflowBags.startedAt,
      workflowBags.finalizedAt,
      products.name,
      products.sku,
      products.kind,
      readBagState.stage,
      readBagState.isFinalized,
      readBagState.isPaused,
      readBagState.currentOperatorCode,
      readBagState.lastEventAt,
      readBagMetrics.masterCases,
      readBagMetrics.displaysMade,
      readBagMetrics.looseCards,
      readBagMetrics.damagedPackaging,
      readBagMetrics.rippedCards,
      readBagMetrics.unitsYielded,
      readBagMetrics.inputPillCount,
      readBagMetrics.activeSeconds,
      readBagMetrics.blisterSeconds,
      readBagMetrics.sealingSeconds,
      readBagMetrics.packagingSeconds,
    )
    .orderBy(desc(workflowBags.startedAt))
    .limit(200);

  // Map DB rows to WorkflowBagRow — ensures null safety and correct types
  const bags: WorkflowBagRow[] = rows.map((r) => ({
    id: r.id,
    receiptNumber: r.receiptNumber ?? null,
    bagNumber: r.bagNumber ?? null,
    startedAt: r.startedAt,
    finalizedAt: r.finalizedAt ?? null,
    productName: r.productName ?? null,
    productSku: r.productSku ?? null,
    productKind: r.productKind ?? null,
    stage: r.stage ?? null,
    isFinalized: r.isFinalized ?? null,
    isPaused: r.isPaused ?? null,
    operatorCode: r.operatorCode ?? null,
    lastEventAt: r.lastEventAt ?? null,
    masterCases: r.masterCases ?? null,
    displaysMade: r.displaysMade ?? null,
    looseCards: r.looseCards ?? null,
    damagedPackaging: r.damagedPackaging ?? null,
    rippedCards: r.rippedCards ?? null,
    unitsYielded: r.unitsYielded ?? null,
    inputPillCount: r.inputPillCount ?? null,
    activeSeconds: r.activeSeconds ?? null,
    blisterSeconds: r.blisterSeconds ?? null,
    sealingSeconds: r.sealingSeconds ?? null,
    packagingSeconds: r.packagingSeconds ?? null,
    eventCount: r.eventCount,
  }));

  const qVal = typeof sp["q"] === "string" ? sp["q"] : "";
  const stageVal = typeof sp["stage"] === "string" ? sp["stage"] : "all";
  const finalizedVal = finalized;
  const fromVal = typeof sp["from"] === "string" ? sp["from"] : "";
  const toVal = typeof sp["to"] === "string" ? sp["to"] : "";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workflow submissions"
        description="Search all production bags — receipt grouping, stage, operator, counts, and inline event history."
      />

      {/* Filter form */}
      <form
        method="get"
        className="rounded-md border border-slate-800/70 bg-slate-900/50 px-4 py-3"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          {/* Search */}
          <div className="lg:col-span-2">
            <label className="block text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 mb-1">
              Search (receipt #, product, bag #)
            </label>
            <input
              type="search"
              name="q"
              defaultValue={qVal}
              placeholder="e.g. RCP-001 or Omega-3"
              className="w-full h-8 rounded bg-slate-950 border border-slate-700/70 px-2.5 text-[12px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50"
            />
          </div>

          {/* Stage */}
          <div>
            <label className="block text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 mb-1">
              Stage
            </label>
            <select
              name="stage"
              defaultValue={stageVal}
              className="w-full h-8 rounded bg-slate-950 border border-slate-700/70 px-2 text-[12px] text-slate-200 focus:outline-none focus:border-cyan-500/50"
            >
              <option value="all">All stages</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Finalized */}
          <div>
            <label className="block text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 mb-1">
              Finalized
            </label>
            <select
              name="finalized"
              defaultValue={finalizedVal}
              className="w-full h-8 rounded bg-slate-950 border border-slate-700/70 px-2 text-[12px] text-slate-200 focus:outline-none focus:border-cyan-500/50"
            >
              <option value="all">All</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          {/* Submit */}
          <div className="flex gap-2">
            <button
              type="submit"
              className="h-8 px-4 rounded bg-cyan-600 hover:bg-cyan-500 text-[12px] font-semibold text-white transition-colors"
            >
              Filter
            </button>
            <a
              href="/workflow-submissions"
              className="inline-flex items-center h-8 px-3 rounded border border-slate-700/70 bg-slate-800/40 text-[12px] text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
            >
              Reset
            </a>
          </div>
        </div>

        {/* Date range row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-800/60">
          <div>
            <label className="block text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 mb-1">
              Started from
            </label>
            <input
              type="date"
              name="from"
              defaultValue={fromVal}
              className="w-full h-8 rounded bg-slate-950 border border-slate-700/70 px-2.5 text-[12px] text-slate-200 focus:outline-none focus:border-cyan-500/50"
            />
          </div>
          <div>
            <label className="block text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 mb-1">
              Started to
            </label>
            <input
              type="date"
              name="to"
              defaultValue={toVal}
              className="w-full h-8 rounded bg-slate-950 border border-slate-700/70 px-2.5 text-[12px] text-slate-200 focus:outline-none focus:border-cyan-500/50"
            />
          </div>
        </div>
      </form>

      {/* Count */}
      <div className="text-[11px] text-slate-500">
        Showing{" "}
        <span className="font-mono text-slate-300">{bags.length}</span>
        {bags.length === 200 && (
          <span className="text-amber-400/80"> (limit 200 — narrow filters to see more)</span>
        )}{" "}
        bag{bags.length === 1 ? "" : "s"}
      </div>

      {/* Table */}
      <WorkflowTable bags={bags} />
    </div>
  );
}
