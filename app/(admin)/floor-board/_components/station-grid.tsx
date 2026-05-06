// Station status grid — a row of small chips, one per active
// station. Each chip:
//   - kind icon (different shape per station kind)
//   - label
//   - status dot:
//       green  = scanned in last 5 min
//       amber  = 5–30 min
//       red    = > 30 min AND seen in 24h
//       gray   = quiet (>24h or never)
//   - current bag receipt + product (compact)
//   - last event type + time
//
// Sorted by status worst-first within each lane so an operator can
// scan left-to-right and see what needs attention.

import * as React from "react";
import {
  Pill,
  FlaskConical,
  PackageCheck,
  Sparkles,
  Layers,
  Tag,
  Beaker,
  CircleSlash,
} from "lucide-react";
import type { StationStatusRow } from "../_loaders";

const ONE_MIN = 60_000;

type Status = "running" | "idle" | "down" | "quiet";

function classifyStatus(lastEventAt: Date | null): Status {
  if (!lastEventAt) return "quiet";
  const ms = Date.now() - lastEventAt.getTime();
  if (ms <= 5 * ONE_MIN) return "running";
  if (ms <= 30 * ONE_MIN) return "idle";
  if (ms <= 24 * 60 * ONE_MIN) return "down";
  return "quiet";
}

const STATUS_DOT: Record<Status, string> = {
  running: "bg-emerald-500",
  idle: "bg-amber-400",
  down: "bg-red-500",
  quiet: "bg-text-subtle/40",
};

const STATUS_RING: Record<Status, string> = {
  running: "border-emerald-200",
  idle: "border-amber-200",
  down: "border-red-200",
  quiet: "border-border/60",
};

const STATUS_RANK: Record<Status, number> = {
  down: 0,
  idle: 1,
  running: 2,
  quiet: 3,
};

function fmtTimeAgo(d: Date | null): string {
  if (!d) return "never";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "now";
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * ONE_MIN) return `${Math.floor(ms / ONE_MIN)}m`;
  if (ms < 24 * 60 * ONE_MIN)
    return `${Math.floor(ms / (60 * ONE_MIN))}h`;
  return `${Math.floor(ms / (24 * 60 * ONE_MIN))}d`;
}

function iconForKind(kind: string): React.ComponentType<{ className?: string }> {
  switch (kind) {
    case "BLISTER":
      return Pill;
    case "SEALING":
      return Sparkles;
    case "PACKAGING":
      return PackageCheck;
    case "BOTTLE_HANDPACK":
      return FlaskConical;
    case "BOTTLE_CAP_SEAL":
      return Beaker;
    case "BOTTLE_STICKER":
      return Tag;
    default:
      return Layers;
  }
}

export function StationGrid({ stations }: { stations: StationStatusRow[] }) {
  if (stations.length === 0) {
    return (
      <p className="text-sm text-text-muted py-3 flex items-center gap-2">
        <CircleSlash className="h-4 w-4 text-text-subtle" />
        No active stations. Configure under /admin/stations.
      </p>
    );
  }
  // Sort: worst status first, then alphabetical.
  const sorted = [...stations].sort((a, b) => {
    const sa = classifyStatus(a.lastEventAt);
    const sb = classifyStatus(b.lastEventAt);
    if (STATUS_RANK[sa] !== STATUS_RANK[sb])
      return STATUS_RANK[sa] - STATUS_RANK[sb];
    return a.label.localeCompare(b.label);
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5">
      {sorted.map((s) => (
        <StationChip key={s.stationId} s={s} />
      ))}
    </div>
  );
}

function StationChip({ s }: { s: StationStatusRow }) {
  const status = classifyStatus(s.lastEventAt);
  const Icon = iconForKind(s.kind);
  return (
    <div
      className={`rounded-md border bg-surface px-2 py-1.5 flex items-start gap-2 ${STATUS_RING[status]}`}
    >
      <span className="relative flex items-center justify-center h-5 w-5 rounded bg-surface-2 shrink-0 mt-0.5">
        <Icon className="h-3 w-3 text-text-muted" />
        <span
          className={`absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]} ${
            status === "running" ? "animate-pulse" : ""
          }`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-[11px] font-semibold leading-tight truncate">
            {s.label}
          </span>
          <span className="text-[9px] text-text-subtle font-mono tabular-nums shrink-0">
            {fmtTimeAgo(s.lastEventAt)}
          </span>
        </div>
        {s.currentReceiptNumber || s.currentProductName ? (
          <p className="text-[10px] text-text-muted truncate leading-tight">
            {s.currentProductName ?? "—"}
            {s.currentReceiptNumber && (
              <span className="text-text-subtle">
                {" · "}
                {s.currentReceiptNumber}
              </span>
            )}
          </p>
        ) : (
          <p className="text-[10px] text-text-subtle italic leading-tight">
            no active bag
          </p>
        )}
        {s.lastEventType && (
          <p className="text-[9px] text-text-subtle truncate leading-tight font-mono">
            {s.lastEventType.replace(/_/g, " ").toLowerCase()}
          </p>
        )}
      </div>
    </div>
  );
}
