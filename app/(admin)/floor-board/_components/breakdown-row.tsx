// Two side-by-side breakdowns:
//   - Flavor breakdown today: top 8 flavors by units finalized + a
//     "rest of pack" bar.
//   - Pause-reason donut last 7d: total minutes paused per reason.
//
// Both fail-soft to "no data yet" empty states.

import * as React from "react";
import { Pill, PauseCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DonutChart, BarRow } from "@/components/charts/inline-charts";
import type { FlavorRow, PauseReasonRow } from "../_loaders";

const FLAVOR_PALETTE = [
  "#2563eb",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#64748b",
];

function fmtSec(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function FlavorBreakdownCard({ rows }: { rows: FlavorRow[] }) {
  // Strip rows with 0 units (zero-bag flavors clutter the chart).
  const nonzero = rows.filter((r) => r.units > 0);
  const top = nonzero.slice(0, 8);
  const rest = nonzero.slice(8);
  const restUnits = rest.reduce((s, r) => s + r.units, 0);
  const restBags = rest.reduce((s, r) => s + r.bags, 0);
  const total = nonzero.reduce((s, r) => s + r.units, 0);
  const max = Math.max(1, ...top.map((r) => r.units), restUnits);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Pill className="h-4 w-4 text-brand-700" />
          Flavor mix · today
          <span className="ml-auto text-[11px] font-normal text-text-muted tabular-nums">
            {total.toLocaleString()} units · {nonzero.length} flavors
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-text-muted py-3">
            Nothing finalized yet today. Bars light up as bags close out.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {top.map((r, i) => {
              const color =
                FLAVOR_PALETTE[i % FLAVOR_PALETTE.length] ?? "#2563eb";
              return (
                <li
                  key={r.productId ?? `flv-${i}`}
                  className="grid grid-cols-[1fr_auto_60px] items-center gap-2 text-xs"
                >
                  <span
                    className="truncate"
                    title={`${r.productName} · ${r.bags} bag${r.bags === 1 ? "" : "s"}`}
                  >
                    {r.productName}
                  </span>
                  <span className="font-semibold tabular-nums text-text">
                    {r.units.toLocaleString()}
                  </span>
                  <BarRow value={r.units} max={max} color={color} />
                </li>
              );
            })}
            {rest.length > 0 && (
              <li
                className="grid grid-cols-[1fr_auto_60px] items-center gap-2 text-xs pt-1 border-t border-border/40"
                title={`${rest.length} smaller flavors · ${restBags} bags`}
              >
                <span className="text-text-muted italic">
                  rest of pack ({rest.length})
                </span>
                <span className="font-semibold tabular-nums text-text-muted">
                  {restUnits.toLocaleString()}
                </span>
                <BarRow value={restUnits} max={max} color="#94a3b8" />
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const PAUSE_REASON_LABEL: Record<string, string> = {
  pvc_swap: "PVC swap",
  shift_end: "Shift end",
  machine_jam: "Machine jam",
  qa_check: "QA check",
  material_change: "Material change",
  end_of_day: "End of day",
  paused_end_of_day: "End of day",
  out_of_packaging_hold: "Out of packaging",
  handoff: "Handoff",
  operator_change: "Operator change",
  taken_for_delivery: "Taken for delivery",
  other: "Other",
};

function labelFor(reason: string): string {
  if (PAUSE_REASON_LABEL[reason]) return PAUSE_REASON_LABEL[reason];
  // Free-text reasons (synthesized from legacy 'admin_notes' or
  // legacy pause reason strings) come through as snake or kebab.
  return reason.replace(/[_-]/g, " ");
}

export function PauseReasonDonut({ rows }: { rows: PauseReasonRow[] }) {
  // Show top 6 reasons + roll the rest into "other" so the donut
  // doesn't shatter into 15 slivers.
  const sorted = [...rows].sort((a, b) => b.totalSeconds - a.totalSeconds);
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const restSeconds = rest.reduce((s, r) => s + r.totalSeconds, 0);
  const restOcc = rest.reduce((s, r) => s + r.occurrences, 0);
  const segments = [
    ...top.map((r) => ({
      label: `${labelFor(r.reason)} · ${r.occurrences}× · ${fmtSec(r.totalSeconds)}`,
      value: Math.round(r.totalSeconds / 60), // minutes for donut total
    })),
    ...(rest.length > 0
      ? [
          {
            label: `Other · ${restOcc}× · ${fmtSec(restSeconds)}`,
            value: Math.round(restSeconds / 60),
          },
        ]
      : []),
  ];
  const totalSec = sorted.reduce((s, r) => s + r.totalSeconds, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PauseCircle className="h-4 w-4 text-amber-700" />
          Pause reasons · last 7d
          <span className="ml-auto text-[11px] font-normal text-text-muted tabular-nums">
            {fmtSec(totalSec)} total
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {segments.length === 0 ? (
          <p className="text-sm text-text-muted py-3">
            No paused-then-resumed bags in the last 7 days.
          </p>
        ) : (
          <DonutChart segments={segments} size={120} thickness={20} />
        )}
      </CardContent>
    </Card>
  );
}
