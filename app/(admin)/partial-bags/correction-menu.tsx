"use client";

// P1-PARTIAL-CORRECTIONS — per-row admin correction menu on the
// Partial Bag Workbench. Each action opens a small inline form with a
// required reason; results append correction sessions/events server-
// side (the original ledger is never edited).

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  correctPartialBagRemainingAction,
  markPartialBagDepletedAction,
  setPartialBagHoldAction,
  voidPartialBagRecordAction,
} from "./actions";
import {
  PARTIAL_BAG_RESOLUTION_METHODS,
  PARTIAL_BAG_RESOLUTION_METHOD_LABELS,
  type PartialBagResolutionMethod,
} from "@/lib/production/partial-bag-resolution-constants";

type CorrectionKind =
  | "correct_remaining"
  | "mark_depleted"
  | "hold"
  | "return_to_stock"
  | "void";

const KIND_LABELS: Record<CorrectionKind, string> = {
  correct_remaining: "Correct remaining",
  mark_depleted: "Mark depleted",
  hold: "Put on hold",
  return_to_stock: "Return to stock",
  void: "Void record",
};

export function PartialBagCorrectionMenu({
  inventoryBagId,
  inventoryStatus,
}: {
  inventoryBagId: string;
  inventoryStatus: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<CorrectionKind | null>(null);
  const [reason, setReason] = React.useState("");
  const [newRemaining, setNewRemaining] = React.useState("");
  const [method, setMethod] = React.useState<PartialBagResolutionMethod>(
    "PHYSICAL_COUNT",
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isHeld = inventoryStatus === "QUARANTINED";
  const isVoid = inventoryStatus === "VOID";
  const available: CorrectionKind[] = isVoid
    ? []
    : isHeld
      ? ["return_to_stock", "void"]
      : ["correct_remaining", "mark_depleted", "hold", "void"];

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("inventoryBagId", inventoryBagId);
      fd.set("reason", reason.trim());
      let result;
      switch (open) {
        case "correct_remaining":
          fd.set("newRemaining", newRemaining);
          fd.set("method", method);
          result = await correctPartialBagRemainingAction(fd);
          break;
        case "mark_depleted":
          result = await markPartialBagDepletedAction(fd);
          break;
        case "hold":
          fd.set("hold", "true");
          result = await setPartialBagHoldAction(fd);
          break;
        case "return_to_stock":
          fd.set("hold", "false");
          result = await setPartialBagHoldAction(fd);
          break;
        case "void":
          result = await voidPartialBagRecordAction(fd);
          break;
        default:
          return;
      }
      if (!result.ok) {
        setError(result.error);
      } else {
        setOpen(null);
        setReason("");
        setNewRemaining("");
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  if (available.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {available.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setOpen(open === kind ? null : kind);
              setError(null);
            }}
            className={`inline-flex items-center px-2 py-1 rounded border text-[11px] font-medium transition-colors ${
              open === kind
                ? "border-brand-400 bg-brand-50 text-brand-700"
                : "border-border bg-surface text-text-muted hover:bg-surface-2"
            }`}
          >
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      {open && (
        <div className="rounded-md border border-border bg-surface-2/50 p-2 space-y-1.5 max-w-[20rem]">
          {open === "correct_remaining" && (
            <>
              <input
                type="number"
                min={0}
                placeholder="New remaining count"
                value={newRemaining}
                onChange={(e) => setNewRemaining(e.target.value)}
                className="block w-full h-8 px-2 rounded border border-border bg-surface text-xs tabular-nums"
              />
              <select
                value={method}
                onChange={(e) =>
                  setMethod(e.target.value as PartialBagResolutionMethod)
                }
                className="block w-full h-8 px-2 rounded border border-border bg-surface text-xs"
              >
                {PARTIAL_BAG_RESOLUTION_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PARTIAL_BAG_RESOLUTION_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </>
          )}
          <input
            type="text"
            placeholder="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="block w-full h-8 px-2 rounded border border-border bg-surface text-xs"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={pending || reason.trim().length < 5}
              onClick={submit}
              className="inline-flex items-center px-2.5 py-1 rounded bg-brand-600 text-white text-[11px] font-medium disabled:opacity-50"
            >
              {pending ? "Saving…" : `Confirm ${KIND_LABELS[open].toLowerCase()}`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(null)}
              className="inline-flex items-center px-2 py-1 rounded border border-border bg-surface text-[11px]"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-[10.5px] text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
