"use client";

import { BarRow, DonutChart } from "@/components/charts/inline-charts";
import { ThroughputChartWidget } from "./widgets/throughput-chart-widget";
import type { QueueHealthRow, ThroughputDataPoint } from "@/lib/floor-command/types";
import type { PauseReasonRow } from "../_loaders";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import { DataGapPanel } from "./data-gap-panel";

const STAGE_LABELS: Record<string, string> = {
  post_blister_staging: "Post blister",
  blister_queue: "Blister queue",
  sealing_queue: "Sealing",
  packaging_queue: "Packaging",
  bottle_fill_queue: "Bottle fill",
  finished_goods_queue: "Finished",
};

function panelClass() {
  return "rounded-lg border border-white/[0.08] bg-slate-900/50 flex flex-col h-[184px] overflow-hidden relative isolate";
}

function fmtSec(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const PAUSE_LABEL: Record<string, string> = {
  pvc_swap: "PVC swap",
  foil_swap: "Foil swap",
  shift_end: "Shift end",
  machine_jam: "Machine jam",
  qa_check: "QA check",
  other: "Other",
};

type Props = {
  throughputPoints: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
  queues: QueueHealthRow[];
  pauseReasons: PauseReasonRow[];
  dataGaps: FloorManagerSnapshot["dataGaps"];
};

export function CommandCenterCharts({
  throughputPoints,
  targetBagsPerHour,
  queues,
  pauseReasons,
  dataGaps,
}: Props) {
  const wipRows = queues
    .filter((q) => q.wip > 0)
    .map((q) => ({
      key: q.stageKey,
      label: STAGE_LABELS[q.stageKey] ?? q.stageKey.replace(/_/g, " "),
      wip: q.wip,
      oldestMin: q.oldestAgeSeconds
        ? Math.floor(q.oldestAgeSeconds / 60)
        : 0,
      status: q.queueStatus,
    }))
    .sort((a, b) => b.oldestMin - a.oldestMin);

  const maxWip = Math.max(1, ...wipRows.map((r) => r.wip));

  const sortedPause = [...pauseReasons].sort(
    (a, b) => b.totalSeconds - a.totalSeconds,
  );
  const topPause = sortedPause.slice(0, 5);
  const pauseColors = ["#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#64748b"];
  const pauseSegments: Array<{ label: string; value: number; color: string }> =
    topPause.map((r, i) => ({
      label: `${PAUSE_LABEL[r.reason] ?? r.reason} · ${fmtSec(r.totalSeconds)}`,
      value: Math.max(1, Math.round(r.totalSeconds / 60)),
      color: pauseColors[i % pauseColors.length] ?? "#64748b",
    }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-3 p-3 shrink-0 border-t border-white/[0.06]">
      <div className={panelClass()}>
        <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Production trend · shift
        </div>
        <div className="h-[130px] w-full">
          <ThroughputChartWidget
            data={throughputPoints}
            targetBagsPerHour={targetBagsPerHour}
          />
        </div>
      </div>

      <div className={panelClass()}>
        <div className="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          WIP by stage
        </div>
        <div className="flex-1 px-3 pb-3 overflow-y-auto">
          {wipRows.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">All queues empty</p>
          ) : (
            <ul className="space-y-2">
              {wipRows.map((r) => (
                <li key={r.key}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-slate-300">{r.label}</span>
                    <span className="tabular-nums text-slate-500">
                      {r.wip} · {r.oldestMin}m
                    </span>
                  </div>
                  <BarRow
                    value={r.wip}
                    max={maxWip}
                    color={
                      r.status === "STALLED"
                        ? "#ef4444"
                        : r.status === "AGING"
                          ? "#f59e0b"
                          : "#3b82f6"
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={panelClass()}>
        <div className="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Pause breakdown · 7 days
        </div>
        <div className="flex-1 flex items-center justify-center p-3">
          {pauseSegments.length === 0 ? (
            <p className="text-sm text-slate-500 text-center">
              No pause data in the last 7 days
            </p>
          ) : (
            <DonutChart segments={pauseSegments} size={130} thickness={22} />
          )}
        </div>
      </div>

      <div className={panelClass()}>
        <div className="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Data coverage · gaps
        </div>
        <DataGapPanel gaps={dataGaps} />
      </div>
    </div>
  );
}
