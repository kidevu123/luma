import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  FLOOR_METRICS_QUICK_LINKS,
  metricsUrl,
  type MetricsLane,
} from "@/lib/floor-command/metrics-links";

export function MetricsQuickLinks({
  compact = false,
  lane,
}: {
  compact?: boolean;
  lane?: MetricsLane | null;
}) {
  return (
    <div
      className={[
        "flex items-center gap-2 flex-wrap border-t border-white/10 bg-slate-950/90 shrink-0",
        compact ? "px-2 py-1" : "px-3 py-1.5",
      ].join(" ")}
      aria-label="Deep dive metrics"
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500 shrink-0">
        Metrics
      </span>
      {lane && (
        <Link
          href={`/metrics/${lane}?days=7`}
          className="text-[10px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
        >
          {lane} lane →
        </Link>
      )}
      {FLOOR_METRICS_QUICK_LINKS.map((link) => (
        <Link
          key={link.section}
          href={metricsUrl(link.section, 7)}
          className="text-[10px] px-2 py-0.5 rounded border border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20"
        >
          {compact ? (link.short ?? link.label) : link.label}
        </Link>
      ))}
      <Link
        href="/metrics/forecast"
        className="ml-auto flex items-center gap-0.5 text-[10px] text-sky-400 hover:text-sky-300"
      >
        Forecast
        <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}
