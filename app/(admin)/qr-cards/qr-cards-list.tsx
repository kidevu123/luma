"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { RetireButton } from "./forms";
import { sortQrRows, matchesQrSearch } from "@/lib/production/qr-sort";

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
    id: string | null;
    internalReceiptNumber: string | null;
    batchId: string | null;
    bagNumber: number | null;
    receiveName: string | null;
    tabletTypeName: string | null;
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

type TabDef = { label: string; value: TabFilter; count: number };

const TYPE_COLORS: Record<QrCardType, string> = {
  RAW_BAG: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  VARIETY_PACK: "bg-purple-50 text-purple-700 border border-purple-200",
  WORKFLOW_TRAVELER: "bg-surface-2 text-text-muted border border-border",
  UNKNOWN: "bg-amber-50 text-amber-800 border border-amber-200",
};

const TYPE_LABEL: Record<QrCardType, string> = {
  RAW_BAG: "Raw bag",
  VARIETY_PACK: "Variety pack",
  WORKFLOW_TRAVELER: "Traveler",
  UNKNOWN: "Unknown",
};

const STATUS_COLORS: Record<string, string> = {
  IDLE: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  ASSIGNED: "bg-blue-50 text-blue-700 border border-blue-200",
  RETIRED: "bg-surface-2 text-text-muted border border-border/70",
};

function TypeBadge({ cardType }: { cardType: QrCardType }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-tight whitespace-nowrap ${TYPE_COLORS[cardType]}`}
    >
      {TYPE_LABEL[cardType]}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    STATUS_COLORS[status] ??
    "bg-surface-2 text-text-muted border border-border/70";
  const label =
    status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-tight whitespace-nowrap ${cls}`}
    >
      {label}
    </span>
  );
}

function AssignmentCell({
  card,
  bag,
  productName,
  intakeBag,
}: {
  card: QrCardRow["card"];
  bag: QrCardRow["bag"];
  productName: string | null;
  intakeBag: QrCardRow["intakeBag"];
}) {
  if (card.status !== "ASSIGNED") {
    return <span className="text-text-subtle/50">—</span>;
  }

  if (bag) {
    return (
      <span className="text-[11px] leading-snug">
        <span className="text-blue-700 font-medium">Active workflow</span>
        {productName && (
          <span className="text-text-muted"> · {productName}</span>
        )}
      </span>
    );
  }

  if (card.cardType === "RAW_BAG" && intakeBag?.id) {
    const parts: string[] = [];
    if (intakeBag.receiveName) parts.push(intakeBag.receiveName);
    if (intakeBag.bagNumber != null) parts.push(`Bag ${intakeBag.bagNumber}`);
    if (intakeBag.internalReceiptNumber)
      parts.push(`Receipt\u202f#\u202f${intakeBag.internalReceiptNumber}`);
    if (intakeBag.tabletTypeName) parts.push(intakeBag.tabletTypeName);
    if (parts.length > 0) {
      return (
        <span className="text-[11px] leading-snug">
          <span className="text-sky-700 font-medium">Reserved at receive</span>
          <span className="text-text-muted"> · {parts.join(" · ")}</span>
        </span>
      );
    }
    return (
      <span className="text-[11px] leading-snug text-amber-700 font-medium">
        Reserved at receive · missing details
      </span>
    );
  }

  return (
    <span className="text-[11px] text-text-muted italic">
      {card.cardType === "RAW_BAG"
        ? "Assigned — missing bag context"
        : "Assigned — no active workflow"}
    </span>
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

export function QrCardsList({ rows }: { rows: QrCardRow[] }) {
  const [q, setQ] = React.useState("");
  const [tabFilter, setTabFilter] = React.useState<TabFilter>("all");

  const sorted = React.useMemo(() => sortQrRows(rows), [rows]);

  const idleCount = rows.filter((r) => r.card.status === "IDLE").length;
  const assignedCount = rows.filter((r) => r.card.status === "ASSIGNED").length;
  const retiredCount = rows.filter((r) => r.card.status === "RETIRED").length;
  const unknownCount = rows.filter(
    (r) => r.card.cardType === "UNKNOWN",
  ).length;

  const rawBagRows = rows.filter((r) => r.card.cardType === "RAW_BAG");
  const rawBagTotal = rawBagRows.length;
  const rawBagIdle = rawBagRows.filter((r) => r.card.status === "IDLE").length;
  const rawBagAssigned = rawBagRows.filter(
    (r) => r.card.status === "ASSIGNED",
  ).length;

  const varietyPackRows = rows.filter(
    (r) => r.card.cardType === "VARIETY_PACK",
  );
  const varietyPackTotal = varietyPackRows.length;
  const varietyPackIdle = varietyPackRows.filter(
    (r) => r.card.status === "IDLE",
  ).length;
  const varietyPackAssigned = varietyPackRows.filter(
    (r) => r.card.status === "ASSIGNED",
  ).length;

  const filtered = sorted.filter((r) => {
    const matchesQ = matchesQrSearch(r, q);
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

  const tabs: TabDef[] = [
    { label: "All", value: "all", count: rows.length },
    { label: "Raw bag", value: "RAW_BAG", count: rawBagTotal },
    { label: "Variety pack", value: "VARIETY_PACK", count: varietyPackTotal },
    { label: "Assigned", value: "ASSIGNED", count: assignedCount },
    { label: "Idle", value: "IDLE", count: idleCount },
    { label: "Retired", value: "RETIRED", count: retiredCount },
    ...(unknownCount > 0
      ? [
          {
            label: "Unknown / legacy",
            value: "UNKNOWN" as TabFilter,
            count: unknownCount,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      {/* Summary tiles — 2-column on mobile, 4-column on sm+ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700">
            Idle
          </div>
          <div className="text-2xl font-bold tabular-nums text-emerald-900">
            {idleCount}
          </div>
          <div className="text-[10px] text-emerald-700/70">ready to assign</div>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-blue-700">
            Assigned
          </div>
          <div className="text-2xl font-bold tabular-nums text-blue-900">
            {assignedCount}
          </div>
          <div className="text-[10px] text-blue-700/70">carrying a bag</div>
        </div>
        {unknownCount > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-700">
              Unknown / legacy
            </div>
            <div className="text-2xl font-bold tabular-nums text-amber-900">
              {unknownCount}
            </div>
            <div className="text-[10px] text-amber-700/70">
              no type assigned
            </div>
          </div>
        )}
      </div>

      {/* Search + filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search label, token, receive name, receipt #, lot…"
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

      {/* Compact table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-text-muted py-8 text-center">
          {q || tabFilter !== "all"
            ? "No cards match your filter."
            : "No QR cards yet. Create one above."}
        </p>
      ) : (
        <div className="rounded-lg border border-border/70 overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2/60 border-b border-border/60">
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                  Label / Token
                </th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-subtle whitespace-nowrap">
                  Type
                </th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-subtle whitespace-nowrap">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
                  Assignment
                </th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-text-subtle whitespace-nowrap">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {filtered.map(({ card, bag, productName, intakeBag }) => (
                <tr
                  key={card.id}
                  className={`hover:bg-surface-2/40 transition-colors ${
                    card.status === "RETIRED" ? "opacity-50" : ""
                  }`}
                >
                  <td className="px-3 py-2 min-w-[140px]">
                    <p className="font-medium text-[13px] text-text-strong leading-tight">
                      {card.label}
                    </p>
                    <p className="text-[10px] font-mono text-text-subtle leading-tight mt-0.5">
                      {card.scanToken}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <TypeBadge cardType={card.cardType} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={card.status} />
                  </td>
                  <td className="px-3 py-2 max-w-xs">
                    <AssignmentCell
                      card={card}
                      bag={bag}
                      productName={productName}
                      intakeBag={intakeBag}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {card.status !== "RETIRED" && (
                      <RetireButton
                        id={card.id}
                        disabled={card.status === "ASSIGNED"}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t border-border/40 bg-surface-2/30 text-[11px] text-text-subtle text-right tabular-nums">
            {filtered.length === rows.length
              ? `${rows.length} card${rows.length === 1 ? "" : "s"}`
              : `${filtered.length} of ${rows.length} cards`}
          </div>
        </div>
      )}
    </div>
  );
}
