// BAG-PRODUCTION-SUMMARY-1 — shared read-only rendering for the per-bag
// production breakdown. Two variants:
//   "row"   — compact stacked cell for table rows (Receive Detail, PO Closeout)
//   "panel" — bordered panel with expected-vs-recorded remaining detail
//             (Production Output, Partial Bag Workbench, Finished Lot, Recall)
// Copy leads with Received / Produced / Remaining / Complete / Source /
// Next action; allocation jargon is secondary detail only. Missing data
// renders as "Missing"/"Unknown", never zero; negative remaining renders
// negative (over-consumed).

import type { BagProductionSummary } from "@/lib/production/bag-production-summary";

function n(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString();
}

export function bagWorkflowStateLabel(s: BagProductionSummary): string {
  const wf = s.workflow;
  if (wf?.excludedFromOutput || wf?.recoveryStatus) return "Recovered — output excluded";
  if (!wf) return s.bagStatus === "AVAILABLE" ? "Not started" : "No production run";
  if (!wf.finalized) return "On floor";
  if (!s.finishedLot) return "Finalized — awaiting lot";
  switch (s.finishedLot.status) {
    case "PENDING_QC":
      return "Lot issued — pending QC";
    case "ON_HOLD":
      return "Lot on hold";
    case "RELEASED":
      switch (s.zoho.status) {
        case "COMMITTED":
          return "Zoho committed";
        case "QUEUED":
          return "Zoho queued";
        case "READY_TO_QUEUE":
        case "NONE":
          return "Released — Zoho ready to queue";
        case "NEEDS_MAPPING":
          return "Released — Zoho needs mapping";
        case "FAILED":
          return "Released — Zoho failed";
        case "NOT_REQUIRED":
          return "Released (Zoho not required)";
        default:
          return "Released";
      }
    case "SHIPPED":
      return "Shipped";
    case "RECALLED":
      return "Recalled";
    default:
      return `Lot ${s.finishedLot.status}`;
  }
}

function warningChips(s: BagProductionSummary): string[] {
  const chips: string[] = [];
  if (s.flags.overConsumed) chips.push("Over-consumed: produced output exceeds received quantity");
  if (s.flags.remainingMismatch && s.remainingDifference != null) {
    chips.push(`Remaining differs from recorded closeout by ${n(Math.abs(s.remainingDifference))}`);
  }
  if (s.allocation?.isOpen && (s.producedTablets ?? 0) > 0) {
    chips.push("Production output exists but allocation is still open");
  }
  if (s.flags.multipleWorkflows) chips.push(`Multiple workflows used this bag (${s.workflowCount})`);
  if (s.flags.splitBag && !s.flags.multipleWorkflows) chips.push("Split across allocation sessions");
  if (s.workflow?.recoveryStatus) chips.push("Wrong-route recovery — output excluded");
  if (s.flags.consumptionUnknown) chips.push("Needs review — production/remaining unknown");
  return chips;
}

export function BagProductionSummaryInline({
  summary,
  variant = "row",
}: {
  summary: BagProductionSummary;
  variant?: "row" | "panel";
}) {
  const s = summary;
  const state = bagWorkflowStateLabel(s);
  const warnings = warningChips(s);

  const metricsLine = (
    <p className="text-xs tabular-nums text-text-strong">
      <span className="text-text-muted">Received</span> {n(s.receivedTablets)}
      <span className="text-text-subtle"> · </span>
      <span className="text-text-muted">Produced</span> {n(s.producedTablets)}
      <span className="text-text-subtle"> · </span>
      <span className="text-text-muted">Remaining</span>{" "}
      <span className={s.remainingDisplay != null && s.remainingDisplay < 0 ? "font-semibold text-crit-700" : ""}>
        {n(s.remainingDisplay)}
      </span>
      {s.percentComplete != null ? (
        <>
          <span className="text-text-subtle"> · </span>
          <span className="text-text-muted">Complete</span> {s.percentComplete}%
        </>
      ) : null}
    </p>
  );

  const sourceLine = (
    <p className="text-[10px] text-text-muted">
      Source: {s.producedSource}
      {s.outputCounts
        ? ` · ${n(s.outputCounts.cases)} cases · ${n(s.outputCounts.displays)} displays · ${n(s.outputCounts.loose)} loose`
        : ""}
    </p>
  );

  if (variant === "row") {
    return (
      <div className="space-y-0.5 min-w-[210px]">
        {metricsLine}
        {sourceLine}
        <p className="text-[10px]">
          <span className="text-text-subtle">{state}</span>
          <span className="text-text-subtle"> · </span>
          <span className="font-medium text-brand-800">{s.nextAction}</span>
        </p>
        {warnings.length > 0 ? (
          <p className="text-[10px] text-warn-700">{warnings.join(" · ")}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-surface-2/50 px-3 py-2 space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
        Source bag production
        {s.receiptNumber ? (
          <span className="ml-1 font-mono normal-case tracking-normal text-text-muted">
            {s.receiptNumber}
          </span>
        ) : null}
      </p>
      {metricsLine}
      {sourceLine}
      <div className="text-[10px] text-text-muted space-y-0.5">
        <p>
          Received: {n(s.receivedTablets)}{" "}
          <span className="text-text-subtle">({s.receivedSource})</span>
        </p>
        {s.expectedRemainingTablets != null ? (
          <p>Expected remaining from production counts: {n(s.expectedRemainingTablets)}</p>
        ) : null}
        {s.recordedRemainingTablets != null ? (
          <p>
            Recorded remaining: {n(s.recordedRemainingTablets)}
            {s.remainingSource ? (
              <span className="text-text-subtle"> — {s.remainingSource}</span>
            ) : null}
          </p>
        ) : s.allocation?.isOpen ? (
          <p>Recorded remaining: not recorded yet (allocation still open)</p>
        ) : null}
        {s.remainingDifference != null && s.remainingDifference !== 0 ? (
          <p className="text-warn-700">
            Difference: {n(s.remainingDifference)} (recorded − expected)
          </p>
        ) : null}
        <p>
          {state}
          <span className="text-text-subtle"> · Next action: </span>
          <span className="font-medium text-brand-800">{s.nextAction}</span>
        </p>
        {s.blockerReason ? <p className="text-warn-700">{s.blockerReason}</p> : null}
        {warnings.length > 0 ? (
          <p className="text-warn-700">{warnings.join(" · ")}</p>
        ) : null}
      </div>
    </div>
  );
}
