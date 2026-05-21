"use client";

// QC-4 — admin actions on a pending damage row.
//
// Two collapsibles (one form expanded at a time):
//   - Send to rework   → adminReworkSentFromDamageAction
//   - Record scrap     → scrapRecordedAction (linked path; supervisor
//                        is entered_by; accountable employee preserved
//                        from the linked damage event)
//
// Both honor the workflow_events_linked_event_resolution_unique
// partial-unique: a second resolution against the same damage event
// returns { conflict: true } and is surfaced as a clear error.

import * as React from "react";
import { Send, Trash2 } from "lucide-react";
import {
  adminReworkSentFromDamageAction,
  scrapRecordedAction,
} from "./actions";

function newClientEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

type Mode = "idle" | "rework" | "scrap";
type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; what: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string };

export function DamageActionsRow({
  eventId,
  workflowBagId,
  quantity,
  unit,
  reasonCode,
}: {
  eventId: string;
  workflowBagId: string;
  quantity: number;
  unit: string;
  reasonCode: string;
}) {
  const [mode, setMode] = React.useState<Mode>("idle");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [notes, setNotes] = React.useState("");
  const [scrapQty, setScrapQty] = React.useState(quantity || 1);
  const [affectsRaw, setAffectsRaw] = React.useState(false);
  const [affectsPkg, setAffectsPkg] = React.useState(true);

  async function submitRework() {
    setStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("clientEventId", newClientEventId());
    fd.set("workflowBagId", workflowBagId);
    fd.set("linkedEventId", eventId);
    fd.set("quantity", String(quantity));
    fd.set("unit", unit);
    fd.set("reasonCode", reasonCode);
    if (notes.trim()) fd.set("notes", notes.trim());
    const r = await adminReworkSentFromDamageAction(fd);
    if (r.conflict) {
      setStatus({ kind: "conflict", message: r.error ?? "Conflict." });
      return;
    }
    if (r.error) {
      setStatus({ kind: "error", message: r.error });
      return;
    }
    setStatus({ kind: "ok", what: "Rework sent" });
  }

  async function submitScrap() {
    if (!affectsRaw && !affectsPkg) {
      setStatus({
        kind: "error",
        message: "Pick at least one affected scope (raw product or packaging material).",
      });
      return;
    }
    setStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("clientEventId", newClientEventId());
    fd.set("workflowBagId", workflowBagId);
    fd.set("linkedEventId", eventId);
    fd.set("quantity", String(scrapQty));
    fd.set("unit", unit);
    fd.set("reasonCode", reasonCode);
    fd.set("scrapQuantity", String(scrapQty));
    fd.set("scrapUnit", unit);
    fd.set("affectsRawProduct", affectsRaw ? "true" : "false");
    fd.set("affectsPackagingMaterial", affectsPkg ? "true" : "false");
    if (notes.trim()) fd.set("notes", notes.trim());
    const r = await scrapRecordedAction(fd);
    if (r.conflict) {
      setStatus({ kind: "conflict", message: r.error ?? "Conflict." });
      return;
    }
    if (r.error) {
      setStatus({ kind: "error", message: r.error });
      return;
    }
    setStatus({ kind: "ok", what: "Scrap recorded" });
  }

  if (status.kind === "ok") {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
        {status.what}. Refresh to remove from pending.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {mode === "idle" ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("rework")}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100"
          >
            <Send className="h-3 w-3" />
            Send to rework
          </button>
          <button
            type="button"
            onClick={() => setMode("scrap")}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-100"
          >
            <Trash2 className="h-3 w-3" />
            Record scrap
          </button>
        </div>
      ) : null}

      {mode === "rework" ? (
        <div className="w-72 space-y-2 rounded-lg border border-sky-200 bg-white p-3 text-xs">
          <p className="font-semibold text-sky-900">Send to rework</p>
          <p className="text-text-muted">
            Returns {quantity} {unit} to sealing for rework. Preserves accountable employee.
          </p>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
            className="w-full rounded border border-border bg-page px-2 py-1.5 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={status.kind === "pending"}
              onClick={() => void submitRework()}
              className="rounded border border-sky-400 bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-200 disabled:opacity-50"
            >
              {status.kind === "pending" ? "Submitting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setStatus({ kind: "idle" });
              }}
              className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-text-muted hover:bg-page"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === "scrap" ? (
        <div className="w-80 space-y-2 rounded-lg border border-rose-200 bg-white p-3 text-xs">
          <p className="font-semibold text-rose-900">Record scrap</p>
          <p className="text-text-muted">
            Confirmed loss. Accountable employee preserved from the damage event.
          </p>
          <label className="block">
            <span className="text-[11px] font-semibold text-text-muted">Scrap quantity</span>
            <input
              type="number"
              min={1}
              value={scrapQty}
              onChange={(e) => setScrapQty(Number(e.target.value) || 1)}
              className="mt-0.5 w-full rounded border border-border bg-page px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={affectsPkg}
                onChange={(e) => setAffectsPkg(e.target.checked)}
              />
              Packaging material
            </label>
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={affectsRaw}
                onChange={(e) => setAffectsRaw(e.target.checked)}
              />
              Raw product
            </label>
          </div>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
            className="w-full rounded border border-border bg-page px-2 py-1.5 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={status.kind === "pending"}
              onClick={() => void submitScrap()}
              className="rounded border border-rose-400 bg-rose-100 px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-200 disabled:opacity-50"
            >
              {status.kind === "pending" ? "Submitting…" : "Confirm scrap"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setStatus({ kind: "idle" });
              }}
              className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-text-muted hover:bg-page"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {status.kind === "error" ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs text-rose-900">
          {status.message}
        </p>
      ) : null}
      {status.kind === "conflict" ? (
        <p className="rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          {status.message} (someone else may have already converted this row — refresh)
        </p>
      ) : null}
    </div>
  );
}
