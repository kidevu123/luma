"use client";

// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — filter bar.
//
// Operator-driven search + status + date + limit. Submits as a GET
// form so the URL is shareable and the page renders server-side with
// the filters applied.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, RotateCcw } from "lucide-react";
import {
  PRODUCTION_OUTPUT_LIMIT_OPTIONS,
  PRODUCTION_OUTPUT_STATUS_VALUES,
  type ProductionOutputStatusFilter,
  type ProductionOutputLimitOption,
} from "@/lib/production/production-output-filters";

const STATUS_LABELS: Record<ProductionOutputStatusFilter, string> = {
  all: "All",
  awaiting_lot: "Awaiting lot",
  ready_to_auto_issue: "Ready to auto-issue",
  missing_allocation: "Missing allocation",
  blocked: "Blocked",
  issued_lot: "Finished lot issued",
  zoho_pending: "Zoho pending / needs review",
  zoho_committed: "Zoho committed",
  packaged_not_finalized: "Packaged — awaiting finalization",
};

type Props = {
  initialQ: string;
  initialFrom: string;
  initialTo: string;
  initialStatus: ProductionOutputStatusFilter;
  initialLimit: ProductionOutputLimitOption;
};

export function ProductionOutputFilterBar({
  initialQ,
  initialFrom,
  initialTo,
  initialStatus,
  initialLimit,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [q, setQ] = React.useState(initialQ);
  const [from, setFrom] = React.useState(initialFrom);
  const [to, setTo] = React.useState(initialTo);
  const [status, setStatus] =
    React.useState<ProductionOutputStatusFilter>(initialStatus);
  const [limit, setLimit] = React.useState<ProductionOutputLimitOption>(
    initialLimit,
  );

  function apply(event?: React.FormEvent) {
    if (event) event.preventDefault();
    const params = new URLSearchParams();
    // Preserve `poId` from the existing URL so the PO selector and
    // workbench filters compose.
    const existingPoId = searchParams?.get("poId");
    if (existingPoId) params.set("poId", existingPoId);
    if (q.trim()) params.set("q", q.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (status !== "all") params.set("status", status);
    if (limit !== 20) params.set("limit", String(limit));
    const qs = params.toString();
    router.push(`/packaging-output${qs ? `?${qs}` : ""}#output-queue`);
  }

  function reset() {
    setQ("");
    setFrom("");
    setTo("");
    setStatus("all");
    setLimit(20);
    const existingPoId = searchParams?.get("poId");
    const qs = existingPoId
      ? `?${new URLSearchParams({ poId: existingPoId }).toString()}`
      : "";
    router.push(`/packaging-output${qs}#output-queue`);
  }

  return (
    <form
      onSubmit={apply}
      className="rounded-xl border border-border bg-surface p-3 flex flex-wrap items-end gap-2"
      aria-label="Production output filters"
    >
      <div className="flex-1 min-w-[16rem] space-y-1">
        <label
          htmlFor="po-search"
          className="text-[10px] uppercase tracking-wider text-text-subtle font-medium"
        >
          Search
        </label>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle" />
          <input
            id="po-search"
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Receipt, product, SKU, lot, workflow…"
            className="h-9 w-full pl-7 pr-2 rounded-lg bg-surface-2 border border-border text-sm"
            maxLength={120}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="po-from"
          className="text-[10px] uppercase tracking-wider text-text-subtle font-medium"
        >
          Finalized from
        </label>
        <input
          id="po-from"
          type="date"
          name="from"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-9 px-2 rounded-lg bg-surface-2 border border-border text-sm"
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="po-to"
          className="text-[10px] uppercase tracking-wider text-text-subtle font-medium"
        >
          To
        </label>
        <input
          id="po-to"
          type="date"
          name="to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-9 px-2 rounded-lg bg-surface-2 border border-border text-sm"
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="po-status"
          className="text-[10px] uppercase tracking-wider text-text-subtle font-medium"
        >
          Status
        </label>
        <select
          id="po-status"
          name="status"
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as ProductionOutputStatusFilter)
          }
          className="h-9 px-2 rounded-lg bg-surface-2 border border-border text-sm min-w-[12rem]"
        >
          {PRODUCTION_OUTPUT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="po-limit"
          className="text-[10px] uppercase tracking-wider text-text-subtle font-medium"
        >
          Limit
        </label>
        <select
          id="po-limit"
          name="limit"
          value={limit}
          onChange={(e) =>
            setLimit(
              Number(e.target.value) as ProductionOutputLimitOption,
            )
          }
          className="h-9 px-2 rounded-lg bg-surface-2 border border-border text-sm"
        >
          {PRODUCTION_OUTPUT_LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="h-9 px-3 rounded-lg bg-brand-700 text-white text-sm font-medium hover:bg-brand-800"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={reset}
          className="h-9 px-3 rounded-lg bg-surface-2 border border-border text-sm font-medium text-text inline-flex items-center gap-1.5 hover:bg-surface"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>
    </form>
  );
}
