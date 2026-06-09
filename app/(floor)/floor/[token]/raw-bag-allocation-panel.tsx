// Read-only source-bag allocation status on the active station workflow.

type RawBagAllocationPanelProps = {
  receiptLabel: string | null;
  humanLot: string | null;
  startingBalanceQty: number | null;
  consumedQtyEstimate: number | null;
  endingBalanceEstimate: number | null;
  sessionStatus: "OPEN" | "CLOSED" | "DEPLETED" | "RETURNED_TO_STOCK" | null;
};

export function RawBagAllocationPanel({
  receiptLabel,
  humanLot,
  startingBalanceQty,
  consumedQtyEstimate,
  endingBalanceEstimate,
  sessionStatus,
}: RawBagAllocationPanelProps) {
  if (!sessionStatus) {
    return (
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <div className="font-semibold">Source bag allocation missing</div>
        <p className="mt-1 text-amber-900/80">
          No open allocation session is linked to this run. Contact a lead — production
          cannot issue a finished lot until allocation is opened at start.
        </p>
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
        Source bag is locked for this run. LEAD confirms actual consumption when issuing the
        finished lot.
      </p>
    </div>
  );
}
