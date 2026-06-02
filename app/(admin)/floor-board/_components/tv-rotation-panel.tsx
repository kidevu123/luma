"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActNowItem } from "@/lib/floor-command/act-now";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import type { ThroughputDataPoint } from "@/lib/floor-command/types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import type { MetricBundle, MetricResult } from "@/lib/production/types";

const ROTATE_MS = 15_000;

const QUEUE_LABELS: Array<{ key: string; label: string }> = [
  { key: "BLISTER_QUEUE.wip", label: "Blister" },
  { key: "SEALING_QUEUE.wip", label: "Sealing" },
  { key: "PACKAGING_QUEUE.wip", label: "Packaging" },
  { key: "FINISHED_GOODS_QUEUE.wip", label: "Finished" },
];

function queueVal(queues: MetricBundle, key: string): number {
  const m = queues[key];
  if (!m || m.confidence === "MISSING" || m.value == null) return 0;
  return typeof m.value === "number" ? m.value : Number(m.value) || 0;
}

function formatStage(metric: MetricResult): string {
  if (metric.confidence === "MISSING") return metric.label ?? "—";
  const raw = metric.value;
  if (typeof raw !== "string" || !raw) return String(raw ?? "—");
  return raw.replace(/_/g, " ").toLowerCase();
}

type Slide =
  | { id: "bottleneck"; title: string; body: React.ReactNode }
  | { id: "bags"; title: string; body: React.ReactNode }
  | { id: "queues"; title: string; body: React.ReactNode }
  | { id: "throughput"; title: string; body: React.ReactNode };

export function TvRotationPanel({
  shiftStatus,
  actNowItems,
  intelligence,
  throughputPoints,
}: {
  shiftStatus: ShiftStatusData;
  actNowItems: ActNowItem[];
  intelligence: FloorProductionIntelligence;
  throughputPoints: ThroughputDataPoint[];
}) {
  const [index, setIndex] = useState(0);
  const [motionOk, setMotionOk] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionOk(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const slides = useMemo((): Slide[] => {
    const bn = intelligence.bottleneck;
    const bottleneckSlide: Slide = {
      id: "bottleneck",
      title: "Bottleneck now",
      body: (
        <div className="space-y-3">
          <p className="text-2xl font-semibold capitalize text-cyan-200">
            {formatStage(bn.stageKey)}
          </p>
          <p className="text-lg text-slate-400">
            {bn.oldestAgeMinutes.value != null && (
              <>Oldest {String(bn.oldestAgeMinutes.value)}m · </>
            )}
            {bn.wip.value != null && <>{String(bn.wip.value)} WIP</>}
          </p>
          <div className="grid grid-cols-2 gap-2 text-base">
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2">
              <div className="text-slate-500 text-xs uppercase">Target</div>
              <div className="text-slate-100 font-medium truncate">
                {shiftStatus.target.value}
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2">
              <div className="text-slate-500 text-xs uppercase">Attention</div>
              <div className="text-slate-100 font-medium truncate">
                {shiftStatus.attention.value}
              </div>
            </div>
          </div>
        </div>
      ),
    };

    const topBags = actNowItems.filter((i) => i.id.startsWith("inflight-")).slice(0, 3);
    const bagsSlide: Slide = {
      id: "bags",
      title: "Stuck / in-flight",
      body:
        topBags.length === 0 ? (
          <p className="text-xl text-emerald-400">No critical bags flagged</p>
        ) : (
          <ul className="space-y-3">
            {topBags.map((b) => (
              <li
                key={b.id}
                className={[
                  "rounded-lg border px-3 py-2",
                  b.severity === "crit"
                    ? "border-red-500/50 bg-red-500/10"
                    : "border-amber-500/40 bg-amber-500/10",
                ].join(" ")}
              >
                <div className="text-lg font-mono font-semibold">{b.title}</div>
                <div className="text-base text-slate-400">{b.detail}</div>
              </li>
            ))}
          </ul>
        ),
    };

    const queues = intelligence.queues;
    const maxWip = Math.max(
      1,
      ...QUEUE_LABELS.map((q) => queueVal(queues, q.key)),
    );
    const queuesSlide: Slide = {
      id: "queues",
      title: "Queue depth (WIP)",
      body: (
        <div className="space-y-4">
          {QUEUE_LABELS.map((q) => {
            const wip = queueVal(queues, q.key);
            return (
              <div key={q.key}>
                <div className="flex justify-between text-base mb-1">
                  <span className="text-slate-300">{q.label}</span>
                  <span className="font-semibold tabular-nums">{wip}</span>
                </div>
                <div className="h-3 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${Math.round((wip / maxWip) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ),
    };

    const recent = throughputPoints.slice(-8);
    const maxBph = Math.max(1, ...recent.map((p) => p.bagsPerHour));
    const throughputSlide: Slide = {
      id: "throughput",
      title: "Throughput (bags/hr)",
      body:
        recent.length === 0 ? (
          <p className="text-xl text-slate-500">No throughput data yet today</p>
        ) : (
          <div className="flex items-end gap-2 h-40">
            {recent.map((p) => (
              <div key={p.label} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div
                  className="w-full bg-cyan-500/80 rounded-t min-h-[4px] transition-all"
                  style={{
                    height: `${Math.max(8, Math.round((p.bagsPerHour / maxBph) * 140))}px`,
                  }}
                  title={`${p.bagsPerHour} bags/hr`}
                />
                <span className="text-[10px] text-slate-500 truncate w-full text-center">
                  {p.label}
                </span>
              </div>
            ))}
          </div>
        ),
    };

    return [bottleneckSlide, bagsSlide, queuesSlide, throughputSlide];
  }, [actNowItems, intelligence, shiftStatus, throughputPoints]);

  useEffect(() => {
    if (!motionOk || slides.length <= 1) return;
    const t = window.setInterval(() => {
      setIndex((i) => (i + 1) % slides.length);
    }, ROTATE_MS);
    return () => window.clearInterval(t);
  }, [motionOk, slides.length]);

  const slide = slides[index] ?? slides[0]!;

  return (
    <div
      className="flex flex-col h-full border-l border-white/10 bg-slate-950 p-4"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          {slide.title}
        </h2>
        <div className="flex gap-1">
          {slides.map((s, i) => (
            <span
              key={s.id}
              className={[
                "h-1.5 w-1.5 rounded-full",
                i === index ? "bg-cyan-400" : "bg-slate-600",
              ].join(" ")}
              aria-hidden
            />
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{slide.body}</div>
      <p className="text-[10px] text-slate-600 mt-3 shrink-0">
        {motionOk ? `Rotates every ${ROTATE_MS / 1000}s` : "Rotation paused (reduced motion)"}
      </p>
    </div>
  );
}
