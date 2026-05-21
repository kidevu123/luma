"use client";

// COMMERCIAL-TRACE-5 — client-side review actions for one invoice line.
//
// Renders the per-row Confirm / Reject buttons plus the line-level
// Generate / Regenerate / Clear unconfirmed actions. Server actions
// from ./actions return discriminated results; the panel surfaces
// status + error inline.

import * as React from "react";
import {
  CheckCircle2,
  AlertCircle,
  Trash2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  clearUnconfirmedInvoiceAllocationsAction,
  confirmInvoiceAllocationAction,
  generateInvoiceLineAllocationSuggestionsAction,
  regenerateInvoiceLineAllocationSuggestionsAction,
  rejectInvoiceAllocationAction,
} from "./actions";

type Row = {
  id: string;
  finishedLotNumber: string | null;
  traceCode: string | null;
  shipmentFinishedLotId: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  quantityAllocated: string;
  unit: string | null;
  confidence: string;
  source: string;
  status: string;
  confirmed: boolean;
  confirmedAt: string | null;
  notes: string | null;
};

const CONFIDENCE_TONE: Record<string, string> = {
  HIGH: "text-emerald-700 bg-emerald-500/10",
  MEDIUM: "text-cyan-700 bg-cyan-500/10",
  LOW: "text-amber-700 bg-amber-500/10",
  MISSING: "text-red-700 bg-red-500/10",
};

const STATUS_LABEL: Record<string, string> = {
  SUGGESTED: "Suggested",
  NEEDS_REVIEW: "Needs review",
  CONFIRMED: "Confirmed by operator",
  REJECTED: "Rejected",
};

export function InvoiceAllocationActions({
  invoiceLineId,
  rows,
}: {
  invoiceLineId: string;
  rows: Row[];
}) {
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  function announce(tone: "ok" | "error", text: string) {
    setMessage({ tone, text });
  }

  return (
    <div className="space-y-3">
      {/* Line-level actions */}
      <div className="flex flex-wrap gap-2">
        {rows.length === 0 ? (
          <Button
            size="sm"
            type="button"
            disabled={pending}
            onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const r = await generateInvoiceLineAllocationSuggestionsAction(invoiceLineId);
                if (r.ok) {
                  announce(
                    "ok",
                    `Generated ${r.counts.suggestions} suggestion(s); ${r.unallocatedQuantity} unit(s) still unallocated.`,
                  );
                } else announce("error", r.error);
              });
            }}
          >
            <Sparkles className="h-3.5 w-3.5" /> Generate suggestions
          </Button>
        ) : (
          <Button
            size="sm"
            type="button"
            disabled={pending}
            onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const r = await regenerateInvoiceLineAllocationSuggestionsAction(invoiceLineId);
                if (r.ok) {
                  announce(
                    "ok",
                    `Regenerated. ${r.counts.cleared} unconfirmed cleared, ${r.counts.suggestions} new suggestion(s).`,
                  );
                } else announce("error", r.error);
              });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Regenerate suggestions
          </Button>
        )}
        <Button
          size="sm"
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setMessage(null);
            startTransition(async () => {
              const r = await clearUnconfirmedInvoiceAllocationsAction(invoiceLineId);
              if (r.ok) announce("ok", `Cleared ${r.cleared} unconfirmed suggestion(s).`);
              else announce("error", r.error);
            });
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear unconfirmed
        </Button>
      </div>

      {message ? (
        <div
          className={`text-[12px] inline-flex items-center gap-1.5 ${
            message.tone === "ok" ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {message.tone === "ok" ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {message.text}
        </div>
      ) : null}

      {/* Suggestion / confirmed rows */}
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          No suggestions yet. Click <em>Generate suggestions</em> to score finished-lot candidates against this invoice
          line. The engine never marks anything HIGH or Confirmed — that requires your explicit confirmation below.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`rounded-md border px-3 py-2 ${
                row.confirmed
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : row.status === "REJECTED"
                    ? "border-slate-500/40 bg-slate-500/5"
                    : row.status === "NEEDS_REVIEW"
                      ? "border-amber-500/40 bg-amber-500/5"
                      : "border-border"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono">{row.finishedLotNumber ?? "(no lot number)"}</span>
                    {row.traceCode ? (
                      <span className="text-text-muted font-mono">trace {row.traceCode}</span>
                    ) : null}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        CONFIDENCE_TONE[row.confidence] ?? "text-text-muted bg-surface-2"
                      }`}
                    >
                      {row.confidence}
                    </span>
                    <span className="text-text-muted">{STATUS_LABEL[row.status] ?? row.status}</span>
                  </div>
                  <div className="mt-1 text-[12px] font-mono">
                    {row.quantityAllocated} {row.unit ?? ""}
                    {row.shipmentFinishedLotId ? (
                      <span className="ml-2 text-text-muted">
                        sfl {row.shipmentFinishedLotId.slice(0, 8)}…
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[10px] text-text-muted">
                    packed {fmtIso(row.packedAt)} · shipped {fmtIso(row.shippedAt)} · source{" "}
                    <span className="font-mono">{row.source}</span>
                    {row.confirmed && row.confirmedAt ? (
                      <span> · confirmed {fmtIso(row.confirmedAt)}</span>
                    ) : null}
                  </div>
                  {row.notes ? (
                    <div className="mt-1 text-[11px] text-amber-700">{row.notes}</div>
                  ) : null}
                </div>
                <div className="shrink-0 flex flex-col gap-1.5">
                  {!row.confirmed && row.status !== "REJECTED" ? (
                    <>
                      <Button
                        size="sm"
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setMessage(null);
                          startTransition(async () => {
                            const r = await confirmInvoiceAllocationAction(row.id);
                            if (r.ok)
                              announce(
                                "ok",
                                `Confirmed allocation; ${r.shipmentRowsUpdated} shipment row(s) updated to ALLOCATED.`,
                              );
                            else announce("error", r.error);
                          });
                        }}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        disabled={pending}
                        onClick={() => {
                          setMessage(null);
                          startTransition(async () => {
                            const r = await rejectInvoiceAllocationAction(row.id);
                            if (r.ok) announce("ok", "Rejected suggestion.");
                            else announce("error", r.error);
                          });
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  ) : row.confirmed ? (
                    <span className="text-[11px] text-emerald-700 font-medium">
                      Confirmed
                    </span>
                  ) : (
                    <span className="text-[11px] text-text-subtle font-medium">
                      Rejected
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtIso(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}
