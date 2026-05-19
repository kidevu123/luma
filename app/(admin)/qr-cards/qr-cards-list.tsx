"use client";

import * as React from "react";
import { QrCode, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/page-header";
import { RetireButton } from "./forms";

type QrCardRow = {
  card: {
    id: string;
    label: string;
    status: string;
    retiredAt: Date | null;
    notes: string | null;
  };
  bag: { id: string } | null;
  productName: string | null;
};

type StatusFilter = "all" | "IDLE" | "ASSIGNED" | "RETIRED";

const STATUS_KIND: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  IDLE: "ok",
  ASSIGNED: "info",
  RETIRED: "neutral",
};

const STAT_COLORS: Record<"ok" | "info" | "neutral", string> = {
  ok: "bg-emerald-50 border-emerald-200 text-emerald-800",
  info: "bg-blue-50 border-blue-200 text-blue-800",
  neutral: "bg-surface border-border/70 text-text-muted",
};

function StatTile({
  label,
  count,
  hint,
  tone,
}: {
  label: string;
  count: number;
  hint: string;
  tone: "ok" | "info" | "neutral";
}) {
  return (
    <div className={`rounded-lg border p-3 ${STAT_COLORS[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{count}</div>
      <div className="text-[10px] opacity-60 mt-0.5">{hint}</div>
    </div>
  );
}

export function QrCardsList({ rows }: { rows: QrCardRow[] }) {
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  const idleCount = rows.filter((r) => r.card.status === "IDLE").length;
  const assignedCount = rows.filter((r) => r.card.status === "ASSIGNED").length;
  const retiredCount = rows.filter((r) => r.card.status === "RETIRED").length;

  const filtered = rows.filter((r) => {
    const qLower = q.toLowerCase();
    const matchesQ =
      !q ||
      r.card.label.toLowerCase().includes(qLower) ||
      r.card.id.toLowerCase().includes(qLower) ||
      (r.productName?.toLowerCase().includes(qLower) ?? false);
    const matchesStatus = statusFilter === "all" || r.card.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const tabs: { label: string; value: StatusFilter; count: number }[] = [
    { label: "All", value: "all", count: rows.length },
    { label: "Idle", value: "IDLE", count: idleCount },
    { label: "Assigned", value: "ASSIGNED", count: assignedCount },
    { label: "Retired", value: "RETIRED", count: retiredCount },
  ];

  return (
    <div className="space-y-4">
      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Idle" count={idleCount} hint="ready to assign" tone="ok" />
        <StatTile label="Assigned" count={assignedCount} hint="carrying a bag" tone="info" />
        <StatTile label="Retired" count={retiredCount} hint="decommissioned" tone="neutral" />
      </div>

      {/* Search + status filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search label or UUID…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                statusFilter === tab.value
                  ? "bg-brand-700 text-white font-semibold"
                  : "text-text-muted hover:bg-surface-2"
              }`}
            >
              {tab.label}{" "}
              <span className="opacity-70">({tab.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Card list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-text-muted py-6 text-center">
          {q || statusFilter !== "all"
            ? "No cards match your filter."
            : "No QR cards yet. Create one above."}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map(({ card, bag, productName }) => (
            <li
              key={card.id}
              className="rounded-lg border border-border/70 bg-surface p-3"
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 ring-1 ring-inset ring-brand-100 shrink-0">
                    <QrCode className="h-4 w-4 text-brand-700" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{card.label}</p>
                    <p className="text-[11px] font-mono text-text-subtle truncate">
                      {card.id}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusPill kind={STATUS_KIND[card.status] ?? "neutral"}>
                    {card.status}
                  </StatusPill>
                  {card.status === "ASSIGNED" && bag && (
                    <span className="text-[11px] text-text-muted">
                      bag {bag.id.slice(0, 8)}
                      {productName ? ` · ${productName}` : ""}
                    </span>
                  )}
                  {card.status !== "RETIRED" && (
                    <RetireButton
                      id={card.id}
                      disabled={card.status === "ASSIGNED"}
                    />
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {filtered.length > 0 && (q || statusFilter !== "all") && (
        <p className="text-[11px] text-text-subtle text-center">
          Showing {filtered.length} of {rows.length} cards
        </p>
      )}
    </div>
  );
}
