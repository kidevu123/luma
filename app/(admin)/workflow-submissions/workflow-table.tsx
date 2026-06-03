"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { loadBagEventsAction } from "./load-events-action";
import type { BagGenealogyResult } from "@/lib/production/types";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  extractSubmissionLines,
  formatWorkflowDatetime,
  formatWorkflowTimestamp,
  getPayloadRecord,
} from "./workflow-table-helpers";

// ── Types ─────────────────────────────────────────────────────────

export type WorkflowBagRow = {
  id: string;
  receiptNumber: string | null;
  bagNumber: number | null;
  inventoryBagNumber: number | null;
  tabletTypeName: string | null;
  receiveName: string | null;
  poNumber: string | null;
  /** ISO string — serialized at the RSC boundary. */
  startedAt: string;
  finalizedAt: string | null;
  productName: string | null;
  productSku: string | null;
  productKind: string | null;
  stage: string | null;
  isFinalized: boolean | null;
  isPaused: boolean | null;
  /** Display-only badge label (may differ from read_bag_state.stage). */
  displayStage: string | null;
  displayStageHelp: string | null;
  operatorCode: string | null;
  lastEventAt: string | null;
  masterCases: number | null;
  displaysMade: number | null;
  looseCards: number | null;
  damagedPackaging: number | null;
  rippedCards: number | null;
  unitsYielded: number | null;
  inputPillCount: number | null;
  activeSeconds: number | null;
  blisterSeconds: number | null;
  sealingSeconds: number | null;
  packagingSeconds: number | null;
  eventCount: number;
};

// ── Stage pill colors (light theme) ──────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  STARTED:   "bg-sky-50 text-sky-700 border-sky-200",
  BLISTERED: "bg-cyan-50 text-cyan-700 border-cyan-200",
  PARTIAL:   "bg-amber-50 text-amber-800 border-amber-200",
  SEALED:    "bg-blue-50 text-blue-700 border-blue-200",
  PACKAGED:  "bg-amber-50 text-amber-700 border-amber-200",
  FINALIZED: "bg-good-50/80 text-good-700 border-good-200",
  PAUSED:    "bg-warn-50/80 text-warn-700 border-warn-200",
};

// ── Event type badges for timeline (light theme) ─────────────────

const EVENT_BADGES: Record<string, { label: string; cls: string }> = {
  CARD_ASSIGNED:             { label: "Started",      cls: "bg-sky-50 text-sky-700 border-sky-200" },
  BLISTER_COMPLETE:          { label: "Blister",      cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  SEALING_COMPLETE:          { label: "Seal",         cls: "bg-blue-50 text-blue-700 border-blue-200" },
  PACKAGING_SNAPSHOT:        { label: "Pack snap",    cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  PACKAGING_COMPLETE:        { label: "Pack",         cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  BAG_PAUSED:                { label: "Pause",        cls: "bg-warn-50/80 text-warn-700 border-warn-200" },
  BAG_RESUMED:               { label: "Resume",       cls: "bg-good-50/80 text-good-700 border-good-200" },
  BAG_FINALIZED:             { label: "Finalized",    cls: "bg-good-50/80 text-good-700 border-good-200" },
  CARD_FORCE_RELEASED:       { label: "Force release",cls: "bg-red-50 text-red-700 border-red-200" },
  PACKAGING_DAMAGE_RETURN:   { label: "Damage",       cls: "bg-red-50 text-red-700 border-red-200" },
  REWORK_SENT:               { label: "Rework sent",  cls: "bg-sky-50 text-sky-700 border-sky-200" },
  REWORK_RECEIVED:           { label: "Rework rec",   cls: "bg-sky-50 text-sky-700 border-sky-200" },
  SCRAP_RECORDED:            { label: "Scrap",        cls: "bg-red-50 text-red-700 border-red-200" },
  SUBMISSION_CORRECTED:      { label: "Corrected",    cls: "bg-warn-50/80 text-warn-700 border-warn-200" },
  FINISHED_GOODS_RELEASED:   { label: "Released",     cls: "bg-good-50/80 text-good-700 border-good-200" },
  BOTTLE_HANDPACK_COMPLETE:  { label: "Handpack",     cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  BOTTLE_CAP_SEAL_COMPLETE:  { label: "Cap/seal",     cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  BOTTLE_STICKER_COMPLETE:   { label: "Sticker",      cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
};

const SUBMISSION_EVENT_TYPES = new Set([
  "BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
]);

// ── Helpers ───────────────────────────────────────────────────────

function fmtSeconds(s: number | null): string {
  if (s === null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildBagLabel(bag: WorkflowBagRow): {
  primary: string;
  secondary: string;
  isLegacyFallback: boolean;
} {
  const shortId = `${bag.id.slice(0, 8)}…`;
  const bagNumber = bag.inventoryBagNumber ?? bag.bagNumber;
  const context = bag.tabletTypeName ?? bag.productName;
  const parts = [
    bag.poNumber ? `PO ${bag.poNumber}` : null,
    context,
    bagNumber != null ? `Bag ${bagNumber}` : null,
  ].filter((part): part is string => part != null && part.trim() !== "");

  if (parts.length > 0) {
    return {
      primary: parts.join(" · "),
      secondary: `Workflow ${shortId}`,
      isLegacyFallback: false,
    };
  }

  return {
    primary: `Legacy bag ${shortId}`,
    secondary: "Missing received-bag context",
    isLegacyFallback: true,
  };
}

// ── Row expand state ──────────────────────────────────────────────

type ExpandState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: BagGenealogyResult }
  | { status: "error"; message: string };

// ── Expanded row content (light theme) ───────────────────────────

function ExpandedContent({
  bag,
  genealogy,
}: {
  bag: WorkflowBagRow;
  genealogy: BagGenealogyResult;
}) {
  const submissionEvents = genealogy.events.filter((e) =>
    SUBMISSION_EVENT_TYPES.has(e.eventType),
  );

  let totalCountSum = 0;
  for (const e of submissionEvents) {
    const p = getPayloadRecord(e.payload);
    const ct = p["count_total"];
    if (typeof ct === "number") totalCountSum += ct;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 bg-surface-2/40 border-t border-border/60">
      {/* Timeline */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mb-2">
          Timeline ({genealogy.events.length} events)
        </div>
        {genealogy.events.length === 0 ? (
          <div className="text-[11px] text-text-muted">No events recorded.</div>
        ) : (
          <ol className="relative border-l border-border pl-4 space-y-2 max-h-[400px] overflow-y-auto">
            {genealogy.events.map((e) => {
              const badge = EVENT_BADGES[e.eventType];
              const p = getPayloadRecord(e.payload);
              return (
                <li key={e.eventId} className="relative">
                  <span
                    className="absolute -left-[9px] top-1 h-2.5 w-2.5 rounded-full bg-surface border border-brand-500"
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
                    <span className="font-mono text-text-subtle text-[10px]">
                      {formatWorkflowTimestamp(e.occurredAt)}
                    </span>
                    {badge ? (
                      <span
                        className={`inline-flex items-center h-4 px-1 rounded border text-[9px] font-medium uppercase tracking-wider ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-4 px-1 rounded border text-[9px] font-mono uppercase tracking-wider border-border bg-surface-2 text-text-muted">
                        {e.eventType}
                      </span>
                    )}
                    {e.machineName && (
                      <span className="text-text-strong text-[10px]">{e.machineName}</span>
                    )}
                    {e.stationLabel && e.stationLabel !== e.machineName && (
                      <span className="text-text-muted text-[10px]">· {e.stationLabel}</span>
                    )}
                    {e.employeeName && (
                      <span className="text-text-muted text-[10px]">· {e.employeeName}</span>
                    )}
                  </div>
                  {e.notes && (
                    <div className="mt-0.5 text-[10px] text-text-muted">{e.notes}</div>
                  )}
                  {Object.keys(p).length > 0 && (
                    <details className="mt-0.5 text-[10px]">
                      <summary className="cursor-pointer text-text-subtle hover:text-text-muted">
                        payload
                      </summary>
                      <pre className="mt-1 rounded bg-surface border border-border p-1.5 text-[9px] text-text-strong overflow-x-auto max-w-sm">
                        {JSON.stringify(p, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Submission entries */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mb-2">
          Submission entries ({submissionEvents.length})
        </div>
        {submissionEvents.length === 0 ? (
          <div className="text-[11px] text-text-muted">No submission events recorded.</div>
        ) : (
          <div className="space-y-2">
            {submissionEvents.map((e) => {
              const p = getPayloadRecord(e.payload);
              const lines = extractSubmissionLines(e.eventType, p);
              const badge = EVENT_BADGES[e.eventType];
              return (
                <div
                  key={e.eventId}
                  className="rounded border border-border bg-surface px-3 py-2"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    {badge ? (
                      <span className={`inline-flex items-center h-4 px-1 rounded border text-[9px] font-medium uppercase tracking-wider ${badge.cls}`}>
                        {badge.label}
                      </span>
                    ) : (
                      <span className="font-mono text-[9px] text-text-muted">{e.eventType}</span>
                    )}
                    <span className="font-mono text-[10px] text-text-subtle">
                      {formatWorkflowTimestamp(e.occurredAt)}
                    </span>
                    {e.stationLabel && (
                      <span className="text-[10px] text-text-muted">{e.stationLabel}</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {lines.map(({ label, value }) => (
                      <div key={label} className="flex items-baseline justify-between gap-1 text-[11px]">
                        <span className="text-text-muted">{label}:</span>
                        <span className="font-mono tabular-nums text-text-strong">
                          {value !== null ? value.toLocaleString() : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Batch totals */}
            <div className="rounded border border-border bg-surface-2/60 px-3 py-2 mt-1">
              <div className="text-[9.5px] uppercase tracking-[0.10em] text-text-subtle mb-1.5">
                Batch totals (read_bag_metrics)
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                {[
                  ["Sum count_total", totalCountSum > 0 ? totalCountSum : null],
                  ["Units yielded", bag.unitsYielded],
                  ["Cases", bag.masterCases],
                  ["Displays", bag.displaysMade],
                  ["Loose", bag.looseCards],
                  ["Damaged", bag.damagedPackaging],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-baseline justify-between gap-1">
                    <span className="text-text-muted">{label}:</span>
                    <span className="font-mono tabular-nums text-text-strong">
                      {value !== null && value !== undefined ? Number(value).toLocaleString() : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────

function BagRow({ bag }: { bag: WorkflowBagRow }) {
  const [expand, setExpand] = useState<ExpandState>({ status: "idle" });

  const toggle = useCallback(async () => {
    if (expand.status === "loading") return;

    if (expand.status === "loaded" || expand.status === "error") {
      setExpand({ status: "idle" });
      return;
    }

    setExpand({ status: "loading" });
    try {
      const data = await loadBagEventsAction(bag.id);
      setExpand({ status: "loaded", data });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setExpand({ status: "error", message });
    }
  }, [expand.status, bag.id]);

  const isOpen = expand.status === "loaded" || expand.status === "error";

  const stageLabel = bag.isPaused
    ? "PAUSED"
    : (bag.displayStage ?? bag.stage ?? null);
  const stageColor = stageLabel
    ? (STAGE_COLORS[stageLabel] ?? "border-border bg-surface-2 text-text-muted")
    : "border-border bg-surface-2 text-text-subtle";

  const shortId = bag.id.slice(0, 8);
  const bagLabel = buildBagLabel(bag);

  return (
    <>
      <TR>
        <TD className="text-[12px]">
          {bag.receiptNumber ? (
            <Link
              href={`/recall?receipt=${encodeURIComponent(bag.receiptNumber)}`}
              className="font-mono text-brand-700 hover:text-brand-800 hover:underline"
            >
              {bag.receiptNumber}
            </Link>
          ) : (
            <span className="font-mono text-text-subtle">—</span>
          )}
        </TD>

        <TD className="text-[12px]">
          {bag.productName ? (
            <div>
              <span className="text-text-strong font-medium">{bag.productName}</span>
              {bag.productSku && (
                <span className="ml-1.5 font-mono text-[10px] text-text-muted bg-surface-2 border border-border px-1 rounded">
                  {bag.productSku}
                </span>
              )}
            </div>
          ) : (
            <span className="text-text-subtle">—</span>
          )}
        </TD>

        <TD className="text-[12px]">
          <div
            className={cn(
              "font-medium",
              bagLabel.isLegacyFallback ? "font-mono text-text-muted" : "text-text-strong",
            )}
            title={`Workflow bag ${shortId}`}
          >
            {bagLabel.primary}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-text-subtle">
            {bagLabel.secondary}
          </div>
        </TD>

        <TD>
          {stageLabel ? (
            <span
              className={cn(
                "inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-medium uppercase tracking-wider",
                stageColor,
              )}
              title={bag.displayStageHelp ?? undefined}
            >
              {stageLabel}
            </span>
          ) : (
            <span className="text-[11px] text-text-subtle">—</span>
          )}
          {bag.displayStageHelp ? (
            <p className="mt-1 max-w-[12rem] text-[10px] text-text-muted leading-snug">
              {bag.displayStageHelp}
            </p>
          ) : null}
        </TD>

        <TD className="text-[12px] font-mono tabular-nums text-text-strong">
          {bag.masterCases !== null || bag.displaysMade !== null || bag.looseCards !== null ? (
            <span>
              {bag.masterCases ?? 0}
              <span className="text-text-subtle"> | </span>
              {bag.displaysMade ?? 0}
              <span className="text-text-subtle"> | </span>
              {bag.looseCards ?? 0}
            </span>
          ) : (
            <span className="text-text-subtle">— | — | —</span>
          )}
        </TD>

        <TD className="text-[11px] font-mono tabular-nums text-text-muted">
          {(bag.damagedPackaging ?? 0) > 0 || (bag.rippedCards ?? 0) > 0 ? (
            <span className="text-warn-700 font-medium">
              {bag.damagedPackaging ?? 0}d / {bag.rippedCards ?? 0}r
            </span>
          ) : (
            "—"
          )}
        </TD>

        <TD className="text-[12px] text-center">
          <span className="inline-flex items-center justify-center h-5 min-w-[24px] px-1.5 rounded bg-surface-2 border border-border font-mono text-[10px] text-text-strong tabular-nums">
            {bag.eventCount}
          </span>
        </TD>

        <TD className="text-[12px] font-mono tabular-nums text-text-muted">
          {fmtSeconds(bag.activeSeconds)}
        </TD>

        <TD className="text-[12px] font-mono text-text-muted">
          {bag.operatorCode ?? "—"}
        </TD>

        <TD className="text-[11px] font-mono text-text-subtle tabular-nums whitespace-nowrap">
          {formatWorkflowDatetime(bag.startedAt)}
        </TD>

        <TD className="text-center">
          <button
            type="button"
            onClick={() => { void toggle(); }}
            className="inline-flex items-center justify-center h-6 w-6 rounded text-text-subtle hover:text-text hover:bg-surface-2 transition-colors"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {expand.status === "loading" ? (
              <span className="h-3 w-3 rounded-full border border-text-subtle border-t-transparent animate-spin" />
            ) : isOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </TD>
      </TR>

      {isOpen && (
        <tr>
          <td colSpan={11} className="p-0">
            {expand.status === "loaded" && (
              <ExpandedContent bag={bag} genealogy={expand.data} />
            )}
            {expand.status === "error" && (
              <div className="px-4 py-3 text-[12px] text-crit-700 bg-crit-50/40 border-t border-crit-200">
                Failed to load events: {expand.message}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main table component ──────────────────────────────────────────

export function WorkflowTable({ bags }: { bags: WorkflowBagRow[] }) {
  return (
    <DataTable>
      <THead>
        <TR>
          <TH>Receipt #</TH>
          <TH>Product</TH>
          <TH>Bag</TH>
          <TH>Stage</TH>
          <TH>Cases | Disp | Loose</TH>
          <TH>Dmg / Rip</TH>
          <TH>Events</TH>
          <TH>Duration</TH>
          <TH>Operator</TH>
          <TH>Started</TH>
          <TH>{""}</TH>
        </TR>
      </THead>
      <tbody>
        {bags.map((bag) => (
          <BagRow key={bag.id} bag={bag} />
        ))}
      </tbody>
    </DataTable>
  );
}
