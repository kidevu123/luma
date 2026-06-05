"use client";

import Link from "next/link";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";

type DataGapRow = FloorManagerSnapshot["dataGaps"][number];

const STATUS_STYLE: Record<
  DataGapRow["status"],
  { text: string; border: string; bg: string; label: string }
> = {
  ok: {
    text: "text-emerald-300",
    border: "border-emerald-500/25",
    bg: "bg-emerald-500/[0.06]",
    label: "OK",
  },
  warn: {
    text: "text-amber-200",
    border: "border-amber-500/35",
    bg: "bg-amber-500/[0.08]",
    label: "Watch",
  },
  crit: {
    text: "text-red-200",
    border: "border-red-500/40",
    bg: "bg-red-500/[0.08]",
    label: "Fix",
  },
  missing: {
    text: "text-slate-300",
    border: "border-slate-500/30",
    bg: "bg-slate-800/50",
    label: "Gap",
  },
};

function DataGapItem({ gap }: { gap: DataGapRow }) {
  const style = STATUS_STYLE[gap.status];
  const inner = (
    <div
      className={`rounded-md border px-2 py-1.5 ${style.border} ${style.bg}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-slate-200">
            {gap.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-500">
            {gap.detail}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-[10px] font-semibold uppercase ${style.text}`}>
            {style.label}
          </p>
          <p className="mt-0.5 max-w-[70px] truncate text-[10px] tabular-nums text-slate-500">
            {gap.value}
          </p>
        </div>
      </div>
    </div>
  );

  if (gap.href) {
    return (
      <Link href={gap.href} className="block hover:brightness-110">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function DataGapPanel({ gaps }: { gaps: DataGapRow[] }) {
  const sorted = [...gaps].sort((a, b) => {
    const rank: Record<DataGapRow["status"], number> = {
      crit: 0,
      warn: 1,
      missing: 2,
      ok: 3,
    };
    return rank[a.status] - rank[b.status];
  });

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-3">
      <div className="space-y-1.5">
        {sorted.map((gap) => (
          <DataGapItem key={gap.id} gap={gap} />
        ))}
      </div>
    </div>
  );
}
