// Bottleneck arrow + cost-of-pause callout. A single big card:
//   - left: arrow showing the flow stages with the slow one
//     highlighted in red. The arrow is a row of stage chips with
//     the bottleneck stage drawn in red and a "← slowest" tag.
//   - right: today's paused-seconds total + a $cost calc using a
//     hardcoded labor rate ($25/hr).
//
// Source data: getBottleneckOfHour (page-level) + getPauseCostToday
// (loaders).

import * as React from "react";
import { TrendingDown, DollarSign, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PAUSE_LABOR_RATE_USD_PER_HOUR } from "../_loaders";

const FLOW_STAGES = [
  { key: "BLISTER", label: "Blister" },
  { key: "SEALING", label: "Sealing" },
  { key: "PACKAGING", label: "Packaging" },
  { key: "BOTTLE_HANDPACK", label: "Bottle pack" },
  { key: "BOTTLE_CAP_SEAL", label: "Cap seal" },
  { key: "BOTTLE_STICKER", label: "Sticker" },
] as const;

function bottleneckKeyFromEventType(eventType: string | null): string | null {
  if (!eventType) return null;
  switch (eventType) {
    case "BLISTER_COMPLETE":
      return "BLISTER";
    case "SEALING_COMPLETE":
      return "SEALING";
    case "PACKAGING_COMPLETE":
    case "PACKAGING_SNAPSHOT":
      return "PACKAGING";
    case "BOTTLE_HANDPACK_COMPLETE":
      return "BOTTLE_HANDPACK";
    case "BOTTLE_CAP_SEAL_COMPLETE":
      return "BOTTLE_CAP_SEAL";
    case "BOTTLE_STICKER_COMPLETE":
      return "BOTTLE_STICKER";
    default:
      return null;
  }
}

function fmtSec(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function BottleneckCostCard({
  bottleneck,
  pause,
}: {
  bottleneck: { stage: string | null; avgSeconds: number; events: number };
  pause: { pausedSeconds: number; costUsd: number };
}) {
  const slowKey = bottleneckKeyFromEventType(bottleneck.stage);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="grid lg:grid-cols-[2fr_1fr] gap-4 items-center">
          {/* Left: flow arrow */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-subtle font-semibold">
              <TrendingDown className="h-3.5 w-3.5 text-amber-700" />
              Bottleneck (last 60 min)
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {FLOW_STAGES.map((s, i) => {
                const isSlow = s.key === slowKey;
                return (
                  <React.Fragment key={s.key}>
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold border ${
                        isSlow
                          ? "bg-red-50 text-red-800 border-red-200"
                          : "bg-surface-2/60 text-text-muted border-border/60"
                      }`}
                    >
                      {s.label}
                      {isSlow && (
                        <span className="text-[9px] font-bold ml-0.5">
                          ← slowest
                        </span>
                      )}
                    </span>
                    {i < FLOW_STAGES.length - 1 && (
                      <ArrowRight className="h-3 w-3 text-text-subtle shrink-0" />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            <div className="text-[11px] text-text-muted">
              {bottleneck.stage && bottleneck.events > 0 ? (
                <>
                  ~
                  <span className="font-semibold text-text">
                    {Math.round(bottleneck.avgSeconds / 60)}m
                  </span>{" "}
                  avg between events ·{" "}
                  <span className="tabular-nums">{bottleneck.events}</span>{" "}
                  in last hour
                </>
              ) : (
                <span className="italic">
                  No multi-event stages in the last hour — flow's even.
                </span>
              )}
            </div>
          </div>

          {/* Right: cost-of-pause */}
          <div className="lg:border-l lg:border-border/60 lg:pl-4">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-subtle font-semibold mb-1">
              <DollarSign className="h-3.5 w-3.5 text-red-700" />
              Cost of pauses today
            </div>
            <div className="text-2xl font-semibold tabular-nums tracking-tight">
              ${pause.costUsd.toFixed(2)}
            </div>
            <div className="text-[11px] text-text-muted">
              {fmtSec(pause.pausedSeconds)} paused ·{" "}
              <span className="font-mono">
                @${PAUSE_LABOR_RATE_USD_PER_HOUR}/hr
              </span>
            </div>
            <div className="text-[10px] text-text-subtle italic mt-0.5">
              Closed pauses since local midnight (ET)
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
