"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ActNowItem, ActNowSeverity } from "@/lib/floor-command/act-now";

const SEV: Record<
  ActNowSeverity,
  { border: string; bg: string; text: string; icon: typeof AlertCircle }
> = {
  crit: {
    border: "border-red-500/50",
    bg: "bg-red-500/10",
    text: "text-red-200",
    icon: AlertCircle,
  },
  warn: {
    border: "border-amber-500/45",
    bg: "bg-amber-500/10",
    text: "text-amber-100",
    icon: AlertCircle,
  },
  info: {
    border: "border-white/10",
    bg: "bg-slate-900/60",
    text: "text-slate-300",
    icon: AlertCircle,
  },
};

function ActNowRow({ item }: { item: ActNowItem }) {
  const s = SEV[item.severity];
  const Icon = s.icon;
  const inner = (
    <div
      className={`rounded-lg border px-2.5 py-2 ${s.border} ${s.bg} hover:brightness-110 transition-colors`}
    >
      <div className="flex gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${s.text}`} aria-hidden />
        <div className="min-w-0">
          <div className={`text-[12px] font-medium leading-snug ${s.text}`}>
            {item.title}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
            {item.detail}
          </div>
        </div>
      </div>
    </div>
  );

  if (item.href) {
    return (
      <Link href={item.href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function ActNowPanel({
  items,
  compact = false,
  hideHeader = false,
}: {
  items: ActNowItem[];
  compact?: boolean;
  hideHeader?: boolean;
}) {
  return (
    <aside
      className={[
        "flex flex-col border-l border-white/10 bg-slate-950/90 shrink-0",
        compact ? "w-full border-l-0 h-full" : "w-[min(100%,280px)]",
      ].join(" ")}
      aria-label="Act now"
    >
      {!hideHeader && (
        <header className="px-3 py-2 border-b border-white/10 shrink-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Act now
          </h2>
          <p className="text-[10px] text-slate-600 mt-0.5">
            Exceptions needing attention this shift
          </p>
        </header>
      )}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center px-2">
            <CheckCircle2
              className="h-8 w-8 text-emerald-500/80"
              strokeWidth={1.5}
              aria-hidden
            />
            <p className="text-sm text-slate-400">Nothing flagged</p>
            <p className="text-[11px] text-slate-600">Floor looks clear for now</p>
          </div>
        ) : (
          items.map((item) => <ActNowRow key={item.id} item={item} />)
        )}
      </div>
    </aside>
  );
}
