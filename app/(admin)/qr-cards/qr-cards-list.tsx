"use client";

import * as React from "react";
import { QrCode, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/page-header";
import { RetireButton } from "./forms";

type QrCardType = "RAW_BAG" | "VARIETY_PACK" | "WORKFLOW_TRAVELER" | "UNKNOWN";

type QrCardRow = {
  card: {
    id: string;
    label: string;
    scanToken: string;
    status: string;
    cardType: QrCardType;
    retiredAt: Date | null;
    notes: string | null;
  };
  bag: { id: string } | null;
  productName: string | null;
  intakeBag: {
    id: string;
    internalReceiptNumber: string | null;
    batchId: string | null;
  } | null;
  intakeBatchNumber: string | null;
};

type TabFilter =
  | "all"
  | "RAW_BAG"
  | "VARIETY_PACK"
  | "ASSIGNED"
  | "IDLE"
  | "RETIRED"
  | "UNKNOWN";

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

const TYPE_COLORS: Record<QrCardType, string> = {
  RAW_BAG:
    "bg-indigo-50 text-indigo-700 border border-indigo-200",
  VARIETY_PACK:
    "bg-purple-50 text-purple-700 border border-purple-200",
  WORKFLOW_TRAVELER:
    "bg-surface-2 text-text-muted border border-border",
  UNKNOWN:
    "bg-amber-50 text-amber-800 border border-amber-200",
};

const TYPE_LABEL: Record<QrCardType, string> = {
  RAW_BAG: "Raw bag",
  VARIETY_PACK: "Variety pack",
  WORKFLOW_TRAVELER: "Traveler",
  UNKNOWN: "Unknown",
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

function TypeStatTile({
  label,
  total,
  idle,
  assigned,
}: {
  label: string;
  total: number;
  idle: number;
  assigned: number;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface p-3 space-y-1">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{total}</div>
      <div className="flex items-center gap-2 text-[10px] text-text-subtle">
        <span className="text-emerald-700 font-medium">{idle} idle</span>
        <span className="text-border">·</span>
        <span className="text-brand-700 font-medium">{assigned} assigned</span>
      </div>
    </div>
  );
}

function TypeBadge({ cardType }: { cardType: QrCardType }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-tight ${TYPE_COLORS[cardType]}`}
    >
      {TYPE_LABEL[cardType]}
    </span>
  );
}

export function QrCardsList({ rows }: { rows: QrCardRow[] }) {
  const [q, setQ] = React.useState("");
  const [tabFilter, setTabFilter] = React.useState<TabFilter>("all");

  const idleCount = rows.filter((r) => r.card.status === "IDLE").length;
  const assignedCount = rows.filter((r) => r.card.status === "ASSIGNED").length;
  const retiredCount = rows.filter((r) => r.card.status === "RETIRED").length;
  const unknownCount = rows.filter((r) => r.card.cardType === "UNKNOWN").length;

  const rawBagRows = rows.filter((r) => r.card.cardType === "RAW_BAG");
  const rawBagTotal = rawBagRows.length;
  const rawBagIdle = rawBagRows.filter((r) => r.card.status === "IDLE").length;
  const rawBagAssigned = rawBagRows.filter((r) => r.card.status === "ASSIGNED").length;

  const varietyPackRows = rows.filter((r) => r.card.cardType === "VARIETY_PACK");
  const varietyPackTotal = varietyPackRows.length;
  const varietyPackIdle = varietyPackRows.filter((r) => r.card.status === "IDLE").length;
  const varietyPackAssigned = varietyPackRows.filter(
    (r) => r.card.status === "ASSIGNED",
  ).length;

  const idleRawBagCount = rawBagIdle;

  const filtered = rows.filter((r) => {
    const qLower = q.toLowerCase();
    const matchesQ =
      !q ||
      r.card.label.toLowerCase().includes(qLower) ||
      r.card.scanToken.toLowerCase().includes(qLower) ||
      r.card.id.toLowerCase().includes(qLower) ||
      (r.productName?.toLowerCase().includes(qLower) ?? false);

    let matchesTab: boolean;
    switch (tabFilter) {
      case "all":
        matchesTab = true;
        break;
      case "RAW_BAG":
        matchesTab = r.card.cardType === "RAW_BAG";
        break;
      case "VARIETY_PACK":
        matchesTab = r.card.cardType === "VARIETY_PACK";
        break;
      case "ASSIGNED":
        matchesTab = r.card.status === "ASSIGNED";
        break;
      case "IDLE":
        matchesTab = r.card.status === "IDLE";
        break;
      case "RETIRED":
        matchesTab = r.card.status === "RETIRED";
        break;
      case "UNKNOWN":
        matchesTab = r.card.cardType === "UNKNOWN";
        break;
    }

    return matchesQ && matchesTab;
  });

  type TabDef = { label: string; value: TabFilter; count: number };
  const tabs: TabDef[] = [
    { label: "All", value: "all", count: rows.length },
    { label: "Raw bag", value: "RAW_BAG", count: rawBagTotal },
    { label: "Variety pack", value: "VARIETY_PACK", count: varietyPackTotal },
    { label: "Assigned", value: "ASSIGNED", count: assignedCount },
    { label: "Idle", value: "IDLE", count: idleCount },
    { label: "Retired", value: "RETIRED", count: retiredCount },
    ...(unknownCount > 0
      ? [{ label: "Unknown", value: "UNKNOWN" as TabFilter, count: unknownCount }]
      : []),
  ];

  return (
    <div className="space-y-4">
      {/* Per-type summary tiles */}
      <div className="grid grid-cols-2 gap-2">
        <TypeStatTile
          label="Raw bag cards"
          total={rawBagTotal}
          idle={rawBagIdle}
          assigned={rawBagAssigned}
        />
        <TypeStatTile
          label="Variety pack cards"
          total={varietyPackTotal}
          idle={varietyPackIdle}
          assigned={varietyPackAssigned}
        />
        {unknownCount > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-700">
              Unknown / legacy
            </div>
            <div className="text-2xl font-bold tabular-nums text-amber-900">
              {unknownCount}
            </div>
            <div className="text-[10px] text-amber-700 opacity-70">
              no type assigned
            </div>
          </div>
        )}
      </div>

      {/* Status stats strip */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Idle" count={idleCount} hint="ready to assign" tone="ok" />
        <StatTile label="Assigned" count={assignedCount} hint="carrying a bag" tone="info" />
        <StatTile label="Retired" count={retiredCount} hint="decommissioned" tone="neutral" />
      </div>

      {/* Search + tab filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search label, scan token, or UUID…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setTabFilter(tab.value)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                tabFilter === tab.value
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
          {q || tabFilter !== "all"
            ? "No cards match your filter."
            : "No QR cards yet. Create one above."}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map(({ card, bag, productName, intakeBag, intakeBatchNumber }) => (
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
                      {card.scanToken}
                    </p>
                    <p className="text-[11px] font-mono text-text-subtle/60 truncate">
                      {card.id}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <TypeBadge cardType={card.cardType} />
                  <StatusPill kind={STATUS_KIND[card.status] ?? "neutral"}>
                    {card.status}
                  </StatusPill>
                  {card.status === "ASSIGNED" && !bag && intakeBag && (
                    <span className="text-[11px] text-text-muted">
                      Assigned at intake: {intakeBag.internalReceiptNumber ?? intakeBag.id.slice(0, 8)}
                      {intakeBatchNumber ? ` · lot ${intakeBatchNumber}` : ""}
                    </span>
                  )}
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

      {filtered.length > 0 && (q || tabFilter !== "all") && (
        <p className="text-[11px] text-text-subtle text-center">
          Showing {filtered.length} of {rows.length} cards
        </p>
      )}

    </div>
  );
}
