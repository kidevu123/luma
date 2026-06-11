// Read-only source-bag allocation status on the active station workflow.

import Link from "next/link";

type RawBagAllocationPanelProps = {
  receiptLabel: string | null;
  humanLot: string | null;
  startingBalanceQty: number | null;
  consumedQtyEstimate: number | null;
  endingBalanceEstimate: number | null;
  sessionStatus: "OPEN" | "CLOSED" | "DEPLETED" | "RETURNED_TO_STOCK" | null;
  workflowBagId?: string | null;
  missingReason?: "legacy_run" | "start_path_gap" | "other_workflow_open" | null;
  isLead?: boolean;
};

export function RawBagAllocationPanel({
  receiptLabel,
  humanLot,
  startingBalanceQty,
  consumedQtyEstimate,
  endingBalanceEstimate,
  sessionStatus,
  workflowBagId,
  missingReason = null,
  isLead = false,
}: RawBagAllocationPanelProps) {
  if (!sessionStatus) {
    const reasonCopy =
      missingReason === "legacy_run"
        ? "This bag predates automatic allocation — a lead can repair the source ledger at lot issue."
        : missingReason === "other_workflow_open"
          ? "The source bag has an open allocation on another run. Close that session first."
          : missingReason === "start_path_gap"
            ? "Allocation did not open at production start — ask a lead to repair before lot issue."
            : "No open allocation session is linked to this run.";
    return (
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <div className="font-semibold">Source bag allocation missing</div>
        <p className="mt-1 text-amber-900/80">{reasonCopy}</p>
        {isLead && workflowBagId ? (
          <Link
            href={`/finished-lots/new?bagId=${encodeURIComponent(workflowBagId)}`}
            className="mt-2 inline-flex text-[11px] font-semibold text-amber-900 underline"
          >
            Repair source allocation
          </Link>
        ) : (
          <p className="mt-1 text-[10px] text-amber-800/90">
            Ask a lead to repair source allocation — do not guess tablet counts on the floor.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 space-y-1">
      <div className="font-semibold">Source raw bag</div>
      <div className="grid gap-0.5 sm:grid-cols-2">
        <span>Receipt: {receiptLabel ?? "—"}</span>
        <span>Lot: {humanLot ?? "—"}</span>
        <span>
          Starting balance:{" "}
          {startingBalanceQty != null ? startingBalanceQty.toLocaleString() : "—"} tablets
        </span>
        <span>Status: {sessionStatus}</span>
        {sessionStatus === "OPEN" ? (
          <>
            <span>
              Est. consumed:{" "}
              {consumedQtyEstimate != null
                ? consumedQtyEstimate.toLocaleString()
                : "recorded at lot issue"}
            </span>
            <span>
              Est. remaining:{" "}
              {endingBalanceEstimate != null
                ? endingBalanceEstimate.toLocaleString()
                : "confirmed at lot issue"}
            </span>
          </>
        ) : null}
      </div>
      <p className="text-[10px] text-slate-600 pt-1 border-t border-slate-200/80">
        Luma calculates tablet consumption from finished units and product setup when the lot
        is issued. Confirm only if this run used a different physical quantity.
      </p>
    </div>
  );
}
