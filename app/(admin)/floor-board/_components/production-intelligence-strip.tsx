"use client";

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, Gauge, Layers, Timer } from "lucide-react";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { MetricBundle, MetricResult } from "@/lib/production/types";
import {
  FloorHeroMetric,
  FloorLiveIndicator,
  FloorPanel,
  floorTokens,
} from "./floor-board-ui";

const FALLBACK: MetricResult = {
  value: null,
  unit: null,
  confidence: "MISSING",
  missingInputs: ["metric_api"],
  label: "No data",
};

function pick(bundle: MetricBundle, key: string): MetricResult {
  return bundle[key] ?? FALLBACK;
}

function num(m: MetricResult): number | null {
  if (m.confidence === "MISSING" || m.value == null) return null;
  return typeof m.value === "number" ? m.value : Number(m.value);
}

function display(m: MetricResult): string {
  if (m.confidence === "MISSING") return m.label ?? "—";
  if (m.value == null) return "—";
  if (typeof m.value === "string") return m.value.replace(/_/g, " ");
  if (Number.isInteger(m.value)) return m.value.toLocaleString();
  return Number(m.value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatStageKey(metric: MetricResult): string {
  if (metric.confidence === "MISSING") return metric.label ?? "—";
  const raw = metric.value;
  if (typeof raw !== "string" || !raw) return String(raw ?? "—");
  return raw.replace(/_/g, " ").toLowerCase();
}

const QUEUE_META = [
  { label: "Blister", key: "BLISTER_QUEUE.wip", fill: "#6366f1" },
  { label: "Sealing", key: "SEALING_QUEUE.wip", fill: "#2ee8a5" },
  { label: "Packaging", key: "PACKAGING_QUEUE.wip", fill: "#f59e0b" },
  { label: "Finished", key: "FINISHED_GOODS_QUEUE.wip", fill: "#94a3b8" },
] as const;

export function ProductionIntelligenceStrip({
  data,
}: {
  data: FloorProductionIntelligence;
}) {
  const { dashboard, bottleneck, queues } = data;

  const bagsInFlow = pick(dashboard, "bagsInFlow");
  const finalized = pick(dashboard, "bagsFinalizedToday");
  const units = pick(dashboard, "goodUnitsToday");
  const oldestQ = pick(dashboard, "oldestQueueAgeMinutes");
  const paused = pick(dashboard, "pausedBagsOverThreshold");

  const oldestMin = num(oldestQ);
  const heroOldestTone =
    oldestMin != null && oldestMin > 120
      ? "danger"
      : oldestMin != null && oldestMin > 60
        ? "warn"
        : "neutral";

  const queueChart = QUEUE_META.map(({ label, key, fill }) => ({
    name: label,
    wip: num(queues[key] ?? FALLBACK) ?? 0,
    fill,
  }));

  const secondary = [
    { label: "Displays", metric: pick(dashboard, "displaysToday") },
    { label: "Cases", metric: pick(dashboard, "casesToday") },
    { label: "Paused >30m", metric: paused },
    { label: "Schedule gap", metric: pick(dashboard, "scheduleGap") },
  ];

  const bottleneckLabel = formatStageKey(bottleneck.stageKey);

  return (
    <section
      aria-label="Production intelligence metrics"
      className="flex-shrink-0 border-t border-amber-500/20 bg-[#0a0f1a]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <Gauge className="h-4 w-4 text-amber-400 shrink-0" strokeWidth={1.75} aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-slate-100 tracking-tight">
              Shift pulse
            </h2>
            <p className={floorTokens.panelSub}>
              Canonical metrics · updates on floor events
            </p>
          </div>
        </div>
        <FloorLiveIndicator />
      </div>

      <div className="px-3 py-3 space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <FloorHeroMetric
            label="Bags in flow"
            value={display(bagsInFlow)}
            {...(bagsInFlow.unit ? { sub: bagsInFlow.unit } : {})}
            tone="accent"
          />
          <FloorHeroMetric
            label="Finalized today"
            value={display(finalized)}
            tone="success"
          />
          <FloorHeroMetric
            label="Units today"
            value={display(units)}
          />
          <FloorHeroMetric
            label="Oldest queue"
            value={oldestMin != null ? `${oldestMin}m` : display(oldestQ)}
            {...(bottleneck.oldestAgeMinutes.value != null
              ? { sub: `bottleneck ${bottleneckLabel}` }
              : {})}
            tone={heroOldestTone}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
          <div className="lg:col-span-5 grid grid-cols-2 gap-2">
            {secondary.map(({ label, metric }) => (
              <div
                key={label}
                className="rounded-lg border border-white/[0.06] bg-slate-900/40 px-2.5 py-2"
              >
                <div className={floorTokens.label}>{label}</div>
                <div className="text-lg font-semibold tabular-nums text-slate-100 mt-0.5">
                  {display(metric)}
                </div>
              </div>
            ))}
            <div className="col-span-2 rounded-lg border border-indigo-500/25 bg-indigo-500/10 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-indigo-300" aria-hidden />
                <span className={floorTokens.label}>Bottleneck</span>
              </div>
              <div className="text-base font-semibold text-indigo-100 mt-1 capitalize">
                {bottleneckLabel}
              </div>
              <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                {bottleneck.reason.value != null
                  ? String(bottleneck.reason.value)
                  : "Highest WIP or oldest wait in lane"}
                {bottleneck.wip.value != null && (
                  <> · {String(bottleneck.wip.value)} WIP</>
                )}
              </p>
            </div>
          </div>

          <FloorPanel
            title="Queue depth"
            subtitle="WIP by production lane"
            className="lg:col-span-7"
            bodyClassName="p-2 h-[120px]"
          >
            {queueChart.every((q) => q.wip === 0) ? (
              <div className="flex items-center justify-center h-full gap-2 text-slate-500 text-sm">
                <Layers className="h-4 w-4" aria-hidden />
                No queue buildup right now
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={queueChart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "#64748b", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    contentStyle={{
                      background: "#0f172a",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v) => [`${v} bags`, "WIP"]}
                  />
                  <Bar dataKey="wip" radius={[6, 6, 0, 0]} maxBarSize={48}>
                    {queueChart.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </FloorPanel>
        </div>

        <div className="flex items-center gap-2 px-1 text-[11px] text-slate-500">
          <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Cycle vs standard:{" "}
            {bottleneck.cycleVsStandardPct.confidence === "MISSING"
              ? (bottleneck.cycleVsStandardPct.label ?? "not configured")
              : display(bottleneck.cycleVsStandardPct)}
          </span>
        </div>
      </div>
    </section>
  );
}
