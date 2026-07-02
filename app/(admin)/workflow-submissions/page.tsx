// Workflow submissions — supervisor search across all production bags.
// Fills the TabletTracker gap: single page to find any bag by receipt,
// product, or bag number, with stage, operator, counts, and inline
// event history.

import { db } from "@/lib/db";
import {
  workflowBags,
  inventoryBags,
  tabletTypes,
  smallBoxes,
  receives,
  purchaseOrders,
  products,
  readBagState,
  readBagMetrics,
  workflowEvents,
} from "@/lib/db/schema";
import { eq, desc, and, or, ilike, gte, lte, count, sql, inArray } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { WorkflowTable } from "./workflow-table";
import type { WorkflowBagRow } from "./workflow-table";
import { coerceEventCount } from "./workflow-table-helpers";
import { deriveWorkflowDisplayStatus } from "@/lib/production/workflow-display-status";
import { ClipboardList } from "lucide-react";

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
  const user = await requireSession();
  const canAdminRepair = user.role === "OWNER" || user.role === "ADMIN";

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
        ilike(inventoryBags.internalReceiptNumber, `%${q}%`),
        ilike(tabletTypes.name, `%${q}%`),
        ilike(receives.receiveName, `%${q}%`),
        ilike(purchaseOrders.poNumber, `%${q}%`),
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
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
      bagNumber: workflowBags.bagNumber,
      inventoryBagNumber: inventoryBags.bagNumber,
      tabletTypeName: tabletTypes.name,
      receiveName: receives.receiveName,
      poNumber: purchaseOrders.poNumber,
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
      productName: products.name,
      productSku: products.sku,
      productKind: products.kind,
      // P2-PARTIAL-KEEP: true when a QR card is still ASSIGNED to this bag —
      // i.e. the traveler is HELD (a partial bottle bag kept for reuse), not yet
      // released. Correlated EXISTS (no fan-out, safe under the GROUP BY). Drives
      // the supervisor held-partial warning so it matches the actual held
      // population (any held QR), not only the explicit keep-partial flag.
      heldQrAssigned: sql<boolean>`EXISTS (SELECT 1 FROM qr_cards qc WHERE qc.assigned_workflow_bag_id = ${workflowBags.id} AND qc.status = 'ASSIGNED')`,
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      isPaused: readBagState.isPaused,
      operatorCode: readBagState.currentOperatorCode,
      lastEventAt: readBagState.lastEventAt,
      recoveryStatus: readBagState.recoveryStatus,
      excludedFromOutput: readBagState.excludedFromOutput,
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
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(workflowEvents, eq(workflowEvents.workflowBagId, workflowBags.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      workflowBags.id,
      workflowBags.receiptNumber,
      inventoryBags.internalReceiptNumber,
      workflowBags.bagNumber,
      inventoryBags.bagNumber,
      tabletTypes.name,
      receives.receiveName,
      purchaseOrders.poNumber,
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
      readBagState.recoveryStatus,
      readBagState.excludedFromOutput,
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

  const wfIds = rows.map((r) => r.id);
  const eventRows =
    wfIds.length > 0
      ? await db
          .select({
            workflowBagId: workflowEvents.workflowBagId,
            eventType: workflowEvents.eventType,
            payload: workflowEvents.payload,
          })
          .from(workflowEvents)
          .where(inArray(workflowEvents.workflowBagId, wfIds))
      : [];

  const eventsByWf = new Map<
    string,
    Array<{ eventType: string; payload: Record<string, unknown> | null }>
  >();
  for (const ev of eventRows) {
    const list = eventsByWf.get(ev.workflowBagId) ?? [];
    list.push({
      eventType: ev.eventType,
      payload: (ev.payload as Record<string, unknown> | null) ?? null,
    });
    eventsByWf.set(ev.workflowBagId, list);
  }

  const bags: WorkflowBagRow[] = rows.map((r) => {
    const events = eventsByWf.get(r.id) ?? [];
    const display = deriveWorkflowDisplayStatus({
      readStage: r.stage,
      isFinalized: r.isFinalized,
      isPaused: r.isPaused,
      events,
    });
    return {
    id: r.id,
    receiptNumber: r.receiptNumber ?? null,
    bagNumber: r.bagNumber ?? null,
    inventoryBagNumber: r.inventoryBagNumber ?? null,
    tabletTypeName: r.tabletTypeName ?? null,
    receiveName: r.receiveName ?? null,
    poNumber: r.poNumber ?? null,
    startedAt: r.startedAt.toISOString(),
    finalizedAt: r.finalizedAt?.toISOString() ?? null,
    productName: r.productName ?? null,
    productSku: r.productSku ?? null,
    productKind: r.productKind ?? null,
    heldQrAssigned: r.heldQrAssigned ?? false,
    stage: r.stage ?? null,
    isFinalized: r.isFinalized ?? null,
    isPaused: r.isPaused ?? null,
    displayStage: display.badgeLabel === "—" ? null : display.badgeLabel,
    displayStageHelp: display.helpText,
    operatorCode: r.operatorCode ?? null,
    lastEventAt: r.lastEventAt?.toISOString() ?? null,
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
    eventCount: coerceEventCount(r.eventCount),
    recoveryStatus: r.recoveryStatus ?? null,
    excludedFromOutput: r.excludedFromOutput ?? null,
  };
  });

  const qVal = typeof sp["q"] === "string" ? sp["q"] : "";
  const stageVal = typeof sp["stage"] === "string" ? sp["stage"] : "all";
  const finalizedVal = finalized;
  const fromVal = typeof sp["from"] === "string" ? sp["from"] : "";
  const toVal = typeof sp["to"] === "string" ? sp["to"] : "";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workflow submissions"
        description="Search production bags and correct station submission counts or recover wrong-route workflows. QC Review remains for damage, rework, and scrap."
      />

      {/* Filter bar */}
      <form
        method="get"
        className="rounded-xl border border-border bg-surface px-4 py-3 space-y-3"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="lg:col-span-2 space-y-1">
            <Label htmlFor="q-filter">Search (receipt #, product, bag #)</Label>
            <Input
              id="q-filter"
              type="search"
              name="q"
              defaultValue={qVal}
              placeholder="e.g. RCP-001 or Omega-3"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="stage-filter">Stage</Label>
            <Select id="stage-filter" name="stage" defaultValue={stageVal}>
              <option value="all">All stages</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="finalized-filter">Finalized</Label>
            <Select id="finalized-filter" name="finalized" defaultValue={finalizedVal}>
              <option value="all">All</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </div>
          <div className="flex gap-2 items-end pb-0.5">
            <Button type="submit">Filter</Button>
            <Button type="button" variant="secondary" asChild>
              <a href="/workflow-submissions">Reset</a>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/60">
          <div className="space-y-1">
            <Label htmlFor="from-filter">Started from</Label>
            <Input id="from-filter" type="date" name="from" defaultValue={fromVal} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to-filter">Started to</Label>
            <Input id="to-filter" type="date" name="to" defaultValue={toVal} />
          </div>
        </div>
      </form>

      {/* Count */}
      <div className="text-[11px] text-text-subtle">
        Showing{" "}
        <span className="font-mono text-text-strong">{bags.length}</span>
        {bags.length === 200 && (
          <span className="text-warn-600"> (limit 200 — narrow filters to see more)</span>
        )}{" "}
        bag{bags.length === 1 ? "" : "s"}
      </div>

      {bags.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No bags match the current filters"
          description="Adjust the search or date range above to broaden results."
        />
      ) : (
        <WorkflowTable bags={bags} canAdminRepair={canAdminRepair} />
      )}
    </div>
  );
}
