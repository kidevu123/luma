"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { loadBagEventsAction } from "./load-events-action";
import type { BagGenealogyResult } from "@/lib/production/types";

// ── Types ─────────────────────────────────────────────────────────

export type WorkflowBagRow = {
  id: string;
  receiptNumber: string | null;
  bagNumber: number | null;
  startedAt: Date;
  finalizedAt: Date | null;
  productName: string | null;
  productSku: string | null;
  productKind: string | null;
  stage: string | null;
  isFinalized: boolean | null;
  isPaused: boolean | null;
  operatorCode: string | null;
  lastEventAt: Date | null;
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

// ── Stage pill colors ─────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  STARTED: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  BLISTERED: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  SEALED: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  PACKAGED: "bg-amber-500/10 text-amber-200 border-amber-500/30",
  FINALIZED: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  PAUSED: "bg-amber-500/10 text-amber-200 border-amber-500/30",
};

// ── Event type badges for timeline ────────────────────────────────

const EVENT_BADGES: Record<string, { label: string; cls: string }> = {
  CARD_ASSIGNED: { label: "Started", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  BLISTER_COMPLETE: { label: "Blister", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  SEALING_COMPLETE: { label: "Seal", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  PACKAGING_SNAPSHOT: { label: "Pack snap", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
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
  BOTTLE_HANDPACK_COMPLETE: { label: "Handpack", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  BOTTLE_CAP_SEAL_COMPLETE: { label: "Cap/seal", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
  BOTTLE_STICKER_COMPLETE: { label: "Sticker", cls: "bg-cyan-500/10 text-cyan-300 border-cyan-500/40" },
};

// ── Submission event types that carry counts ──────────────────────

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

function fmtDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtTs(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function getPayload(e: { payload: unknown }): Record<string, unknown> {
  if (e.payload !== null && typeof e.payload === "object" && !Array.isArray(e.payload)) {
    return e.payload as Record<string, unknown>;
  }
  return {};
}

function extractSubmissionLines(
  eventType: string,
  payload: Record<string, unknown>,
): Array<{ label: string; value: number | null }> {
  const n = (k: string): number | null => {
    const v = payload[k];
    return typeof v === "number" ? v : null;
  };

  switch (eventType) {
    case "BLISTER_COMPLETE":
      return [{ label: "Blistered", value: n("count_total") }];
    case "SEALING_COMPLETE":
      return [
        { label: "Sealed", value: n("count_total") },
        { label: "Remaining", value: n("packs_remaining") },
      ];
    case "PACKAGING_COMPLETE":
      return [
        { label: "Cases", value: n("master_cases") },
        { label: "Displays", value: n("displays_made") },
        { label: "Loose cards", value: n("loose_cards") },
        { label: "Damaged", value: n("damaged_packaging") },
        { label: "Ripped", value: n("ripped_cards") },
      ];
    case "BOTTLE_HANDPACK_COMPLETE":
    case "BOTTLE_CAP_SEAL_COMPLETE":
    case "BOTTLE_STICKER_COMPLETE":
      return [{ label: "Count", value: n("count_total") }];
    default:
      return [];
  }
}

// ── Row expand state ──────────────────────────────────────────────

type ExpandState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: BagGenealogyResult }
  | { status: "error"; message: string };

// ── Expanded row content ──────────────────────────────────────────

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

  // Batch total: sum all count_total from submission events
  let totalCountSum = 0;
  for (const e of submissionEvents) {
    const p = getPayload(e);
    const ct = p["count_total"];
    if (typeof ct === "number") totalCountSum += ct;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 bg-slate-950/60 border-t border-slate-800/60">
      {/* Timeline */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-2">
          Timeline ({genealogy.events.length} events)
        </div>
        {genealogy.events.length === 0 ? (
          <div className="text-[11px] text-slate-500">No events recorded.</div>
        ) : (
          <ol className="relative border-l border-slate-800 pl-4 space-y-2 max-h-[400px] overflow-y-auto">
            {genealogy.events.map((e) => {
              const badge = EVENT_BADGES[e.eventType];
              const p = getPayload(e);
              return (
                <li key={e.eventId} className="relative">
                  <span
                    className="absolute -left-[9px] top-1 h-2.5 w-2.5 rounded-full bg-slate-900 border border-cyan-600"
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
                    <span className="font-mono text-slate-500 text-[10px]">
                      {fmtTs(e.occurredAt)}
                    </span>
                    {badge ? (
                      <span
                        className={`inline-flex items-center h-4 px-1 rounded border text-[9px] font-medium uppercase tracking-wider ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-4 px-1 rounded border text-[9px] font-mono uppercase tracking-wider border-slate-700 bg-slate-800/60 text-slate-300">
                        {e.eventType}
                      </span>
                    )}
                    {e.machineName && (
                      <span className="text-slate-300 text-[10px]">{e.machineName}</span>
                    )}
                    {e.stationLabel && e.stationLabel !== e.machineName && (
                      <span className="text-slate-500 text-[10px]">· {e.stationLabel}</span>
                    )}
                    {e.employeeName && (
                      <span className="text-slate-400 text-[10px]">· {e.employeeName}</span>
                    )}
                  </div>
                  {e.notes && (
                    <div className="mt-0.5 text-[10px] text-slate-500">{e.notes}</div>
                  )}
                  {Object.keys(p).length > 0 && (
                    <details className="mt-0.5 text-[10px]">
                      <summary className="cursor-pointer text-slate-600 hover:text-slate-400">
                        payload
                      </summary>
                      <pre className="mt-1 rounded bg-slate-900 border border-slate-800 p-1.5 text-[9px] text-slate-300 overflow-x-auto max-w-sm">
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
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-2">
          Submission entries ({submissionEvents.length})
        </div>
        {submissionEvents.length === 0 ? (
          <div className="text-[11px] text-slate-500">No submission events recorded.</div>
        ) : (
          <div className="space-y-2">
            {submissionEvents.map((e) => {
              const p = getPayload(e);
              const lines = extractSubmissionLines(e.eventType, p);
              const badge = EVENT_BADGES[e.eventType];
              return (
                <div
                  key={e.eventId}
                  className="rounded border border-slate-800/70 bg-slate-900/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    {badge ? (
                      <span className={`inline-flex items-center h-4 px-1 rounded border text-[9px] font-medium uppercase tracking-wider ${badge.cls}`}>
                        {badge.label}
                      </span>
                    ) : (
                      <span className="font-mono text-[9px] text-slate-400">{e.eventType}</span>
                    )}
                    <span className="font-mono text-[10px] text-slate-500">
                      {fmtTs(e.occurredAt)}
                    </span>
                    {e.stationLabel && (
                      <span className="text-[10px] text-slate-500">{e.stationLabel}</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {lines.map(({ label, value }) => (
                      <div key={label} className="flex items-baseline justify-between gap-1 text-[11px]">
                        <span className="text-slate-500">{label}:</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {value !== null ? value.toLocaleString() : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Batch totals row */}
            <div className="rounded border border-slate-700/60 bg-slate-800/40 px-3 py-2 mt-1">
              <div className="text-[9.5px] uppercase tracking-[0.10em] text-slate-400 mb-1.5">
                Batch totals (read_bag_metrics)
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Sum count_total:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {totalCountSum > 0 ? totalCountSum.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Units yielded:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {bag.unitsYielded !== null ? bag.unitsYielded.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Cases:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {bag.masterCases !== null ? bag.masterCases.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Displays:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {bag.displaysMade !== null ? bag.displaysMade.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Loose:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {bag.looseCards !== null ? bag.looseCards.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-slate-500">Damaged:</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {bag.damagedPackaging !== null ? bag.damagedPackaging.toLocaleString() : "—"}
                  </span>
                </div>
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

  const stageLabel = bag.isPaused ? "PAUSED" : (bag.stage ?? null);
  const stageColor = stageLabel ? (STAGE_COLORS[stageLabel] ?? "border-slate-700 bg-slate-800/40 text-slate-400") : "border-slate-700 bg-slate-800/40 text-slate-500";

  const shortId = bag.id.slice(0, 8);

  return (
    <>
      <tr className="border-t border-slate-800/50 hover:bg-slate-800/20 transition-colors">
        {/* Receipt # */}
        <td className="px-3 py-2 text-[12px]">
          {bag.receiptNumber ? (
            <Link
              href={`/recall?receipt=${encodeURIComponent(bag.receiptNumber)}`}
              className="font-mono text-cyan-300 hover:text-cyan-200"
            >
              {bag.receiptNumber}
            </Link>
          ) : (
            <span className="font-mono text-slate-500">—</span>
          )}
        </td>

        {/* Product */}
        <td className="px-3 py-2 text-[12px]">
          {bag.productName ? (
            <div>
              <span className="text-slate-200">{bag.productName}</span>
              {bag.productSku && (
                <span className="ml-1.5 font-mono text-[10px] text-slate-500 bg-slate-800/60 border border-slate-700/60 px-1 rounded">
                  {bag.productSku}
                </span>
              )}
            </div>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </td>

        {/* Bag */}
        <td className="px-3 py-2 text-[12px] font-mono">
          <span className="text-slate-400">{shortId}…</span>
          {bag.bagNumber !== null && (
            <span className="ml-1 text-slate-500">#{bag.bagNumber}</span>
          )}
        </td>

        {/* Stage */}
        <td className="px-3 py-2">
          {stageLabel ? (
            <span
              className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-medium uppercase tracking-wider ${stageColor}`}
            >
              {stageLabel}
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">—</span>
          )}
        </td>

        {/* Packaging output: cases | displays | loose */}
        <td className="px-3 py-2 text-[12px] font-mono tabular-nums text-slate-300">
          {bag.masterCases !== null || bag.displaysMade !== null || bag.looseCards !== null ? (
            <span>
              {bag.masterCases ?? 0}
              <span className="text-slate-600"> | </span>
              {bag.displaysMade ?? 0}
              <span className="text-slate-600"> | </span>
              {bag.looseCards ?? 0}
            </span>
          ) : (
            <span className="text-slate-600">— | — | —</span>
          )}
        </td>

        {/* Damaged / Ripped */}
        <td className="px-3 py-2 text-[11px] font-mono tabular-nums text-slate-500">
          {(bag.damagedPackaging ?? 0) > 0 || (bag.rippedCards ?? 0) > 0 ? (
            <span className="text-amber-300/80">
              {bag.damagedPackaging ?? 0}d / {bag.rippedCards ?? 0}r
            </span>
          ) : (
            "—"
          )}
        </td>

        {/* Events */}
        <td className="px-3 py-2 text-[12px] text-center">
          <span className="inline-flex items-center justify-center h-5 min-w-[24px] px-1.5 rounded bg-slate-800/60 border border-slate-700/60 font-mono text-[10px] text-slate-300 tabular-nums">
            {bag.eventCount}
          </span>
        </td>

        {/* Duration */}
        <td className="px-3 py-2 text-[12px] font-mono tabular-nums text-slate-400">
          {fmtSeconds(bag.activeSeconds)}
        </td>

        {/* Operator */}
        <td className="px-3 py-2 text-[12px] font-mono text-slate-400">
          {bag.operatorCode ?? "—"}
        </td>

        {/* Started */}
        <td className="px-3 py-2 text-[11px] font-mono text-slate-500 tabular-nums whitespace-nowrap">
          {fmtDatetime(bag.startedAt)}
        </td>

        {/* Expand */}
        <td className="px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => { void toggle(); }}
            className="inline-flex items-center justify-center h-6 w-6 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {expand.status === "loading" ? (
              <span className="h-3 w-3 rounded-full border border-slate-500 border-t-transparent animate-spin" />
            ) : isOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
      </tr>

      {/* Expanded content row */}
      {isOpen && (
        <tr>
          <td colSpan={11} className="p-0">
            {expand.status === "loaded" && (
              <ExpandedContent bag={bag} genealogy={expand.data} />
            )}
            {expand.status === "error" && (
              <div className="px-4 py-3 text-[12px] text-rose-300 bg-rose-500/5 border-t border-rose-500/20">
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
  if (bags.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center">
        <p className="text-[12.5px] font-semibold text-slate-400">No bags match the current filters</p>
        <p className="mt-1 text-[11px] text-slate-600">
          Adjust the search or date range above to broaden results.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-800/70">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-900/80 border-b border-slate-800/70">
            {[
              "Receipt #",
              "Product",
              "Bag",
              "Stage",
              "Cases | Disp | Loose",
              "Dmg / Rip",
              "Events",
              "Duration",
              "Operator",
              "Started",
              "",
            ].map((h, i) => (
              <th
                key={i}
                className="px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.10em] text-slate-500 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bags.map((bag) => (
            <BagRow key={bag.id} bag={bag} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
