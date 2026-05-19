"use client";

// QC-3 — floor QC quick-action panel.
//
// Collapsible "Report QC issue" panel that operators tap on the
// packaging / sealing / combined station overlays. Wires to the
// QC-2 server actions:
//
//   - Damage quick actions      → reportPackagingDamageAction
//     (DAMAGED_PACKAGING, RIPPED_CARD, BAD_SEAL, LABEL_ISSUE,
//      COUNT_VARIANCE, OTHER)
//
//   - Send to rework            → reworkSentAction
//     (defaults reason to BAD_SEAL; can be linked to a damage event
//      if the operator picked BAD_SEAL first — that path runs the
//      damage submit, captures the returned event id, and fires
//      rework_sent with linked_event_id. QC-2 already returns
//      { ok: true } on success without surfacing the event id, so
//      QC-3 sends rework with linked_event_id=null — the QC-0 model
//      allows that for "direct rework with no preceding damage row"
//      and operator metrics still credit the originator via the
//      station session. The two-event chain is QC-4 supervisor
//      territory.)
//
//   - Receive rework            → reworkReceivedAction
//     (lists pending REWORK_SENT events for the current bag; each
//      row fires received-quantity=sent-quantity, partial=false
//      against the linked_event_id.)
//
// Photos: deferred. The QC-2 actions accept `photo_keys` as a
// JSON-array string, but no upload helper is wired on the floor
// PWA yet. QC-3 ships text-notes-only; QC-3.5 (or QC-5) can layer
// photo capture without changing the action contracts.

import * as React from "react";
import {
  ChevronDown,
  AlertTriangle,
  PackageX,
  Scissors,
  ShieldAlert,
  Tag,
  Calculator,
  HelpCircle,
  Send,
  Inbox,
} from "lucide-react";
import {
  reportPackagingDamageAction,
  reworkSentAction,
  reworkReceivedAction,
} from "./qc-actions";
import {
  QUICK_DAMAGE_ENTRIES,
  damageHasReworkShortcut,
  type QuickDamageType,
} from "@/lib/production/qc-panel-helpers";

// crypto.randomUUID() is only available in secure contexts. Floor
// PWA runs over plain HTTP on the LAN — mirror the fallback that
// stage-action-buttons.tsx uses.
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

const ICON_BY_TYPE: Record<QuickDamageType, React.ComponentType<{ className?: string }>> = {
  DAMAGED_PACKAGING: PackageX,
  RIPPED_CARD: Scissors,
  BAD_SEAL: ShieldAlert,
  LABEL_ISSUE: Tag,
  COUNT_VARIANCE: Calculator,
};

export type PendingReworkRow = {
  /** workflow_events.id of the REWORK_SENT row. */
  id: string;
  occurredAt: string;
  quantity: number;
  unit: string;
  reasonCode: string;
  fromStationLabel: string | null;
  accountableEmployeeName: string | null;
};

export type QcPanelProps = {
  token: string;
  stationId: string;
  stationKind: string;
  workflowBagId: string;
  /** Operator name from the active station session, if any. When null
   *  the panel renders a clear "No operator on shift" notice and the
   *  submit buttons are disabled. */
  currentOperatorName: string | null;
  /** Source label from the active session — surfaced for confidence. */
  accountabilitySource: string | null;
  /** Pending rework events to receive at this station. Empty when none. */
  pendingRework: PendingReworkRow[];
};

type Status =
  | { kind: "idle" }
  | { kind: "pending"; what: string }
  | { kind: "ok"; what: string }
  | { kind: "error"; message: string };

export function QcPanel(props: QcPanelProps) {
  const {
    token,
    stationId,
    stationKind,
    workflowBagId,
    currentOperatorName,
    accountabilitySource,
    pendingRework,
  } = props;

  const hasOperator = currentOperatorName != null;
  const [quantity, setQuantity] = React.useState(1);
  const [notes, setNotes] = React.useState("");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  const submitDamage = React.useCallback(
    async (
      reasonCode: string,
      args?: { alsoSendToRework?: boolean; otherNotes?: string },
    ) => {
      if (!hasOperator) {
        setStatus({
          kind: "error",
          message: "No operator on shift. Open a shift before reporting QC.",
        });
        return;
      }
      const effectiveNotes =
        (args?.otherNotes ?? (notes.trim() || null)) || null;
      if (reasonCode === "OTHER" && !effectiveNotes) {
        setStatus({
          kind: "error",
          message: "Notes are required when reason is Other.",
        });
        return;
      }
      setStatus({ kind: "pending", what: reasonCode });
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("clientEventId", newClientEventId());
        fd.set("bagId", workflowBagId);
        fd.set("quantity", String(Math.max(1, Math.floor(quantity))));
        fd.set("unit", "cards");
        fd.set("reasonCode", reasonCode);
        if (effectiveNotes) fd.set("notes", effectiveNotes);
        const r = await reportPackagingDamageAction(fd);
        if (r.error) {
          setStatus({ kind: "error", message: r.error });
          return;
        }
        if (args?.alsoSendToRework) {
          const reworkFd = new FormData();
          reworkFd.set("token", token);
          reworkFd.set("stationId", stationId);
          reworkFd.set("clientEventId", newClientEventId());
          reworkFd.set("bagId", workflowBagId);
          reworkFd.set("quantity", String(Math.max(1, Math.floor(quantity))));
          reworkFd.set("unit", "cards");
          reworkFd.set("reasonCode", reasonCode);
          if (effectiveNotes) reworkFd.set("notes", effectiveNotes);
          const rr = await reworkSentAction(reworkFd);
          if (rr.error) {
            setStatus({
              kind: "error",
              message: `Damage logged but rework failed: ${rr.error}`,
            });
            return;
          }
        }
        setStatus({
          kind: "ok",
          what: args?.alsoSendToRework ? "Damage + rework logged" : "Damage logged",
        });
        setNotes("");
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Server error.",
        });
      }
    },
    [hasOperator, notes, quantity, stationId, token, workflowBagId],
  );

  const submitSendToRework = React.useCallback(async () => {
    if (!hasOperator) {
      setStatus({
        kind: "error",
        message: "No operator on shift. Open a shift before sending rework.",
      });
      return;
    }
    setStatus({ kind: "pending", what: "REWORK_SENT" });
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      fd.set("clientEventId", newClientEventId());
      fd.set("bagId", workflowBagId);
      fd.set("quantity", String(Math.max(1, Math.floor(quantity))));
      fd.set("unit", "cards");
      fd.set("reasonCode", "BAD_SEAL");
      if (notes.trim()) fd.set("notes", notes.trim());
      const r = await reworkSentAction(fd);
      if (r.error) {
        setStatus({ kind: "error", message: r.error });
        return;
      }
      setStatus({ kind: "ok", what: "Rework sent" });
      setNotes("");
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Server error.",
      });
    }
  }, [hasOperator, notes, quantity, stationId, token, workflowBagId]);

  const submitReceive = React.useCallback(
    async (row: PendingReworkRow) => {
      if (!hasOperator) {
        setStatus({
          kind: "error",
          message: "No operator on shift. Open a shift before receiving rework.",
        });
        return;
      }
      setStatus({ kind: "pending", what: `RECEIVE:${row.id}` });
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("clientEventId", newClientEventId());
        fd.set("bagId", workflowBagId);
        fd.set("quantity", String(row.quantity));
        fd.set("unit", row.unit);
        fd.set("reasonCode", row.reasonCode);
        fd.set("linkedEventId", row.id);
        fd.set("receivedQuantity", String(row.quantity));
        fd.set("partial", "false");
        const r = await reworkReceivedAction(fd);
        if (r.error) {
          setStatus({ kind: "error", message: r.error });
          return;
        }
        setStatus({ kind: "ok", what: "Rework received" });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Server error.",
        });
      }
    },
    [hasOperator, stationId, token, workflowBagId],
  );

  return (
    <details className="group rounded-2xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-2xl px-5 py-3 hover:bg-page">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold">Report QC issue</span>
          {pendingRework.length > 0 ? (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              {pendingRework.length} pending rework
            </span>
          ) : null}
        </div>
        <ChevronDown className="h-4 w-4 text-text-subtle transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-border/70 px-5 py-4">
        {/* Operator + bag context */}
        <div className="rounded-lg border border-border/70 bg-surface-2/40 px-3 py-2 text-xs">
          {hasOperator ? (
            <p className="text-text-muted">
              Operator: <span className="font-semibold text-text">{currentOperatorName}</span>
              {accountabilitySource ? (
                <span className="text-text-subtle"> · {accountabilitySource}</span>
              ) : null}
              <span className="text-text-subtle"> · station {stationKind.toLowerCase()}</span>
            </p>
          ) : (
            <p className="text-amber-800">
              No operator on shift. Open a shift on this station to enable QC reporting.
            </p>
          )}
          <p className="mt-1 font-mono text-[10px] text-text-subtle">
            Bag {workflowBagId.slice(0, 8)}
          </p>
        </div>

        {/* Status banner */}
        <StatusBanner status={status} />

        {/* Shared inputs — stacked single-column on mobile so both
         *  fields get full width and are easy to tap. */}
        <div className="flex flex-col gap-3">
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-text-muted">Quantity (cards)</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value) || 1)}
              className="w-full h-12 rounded-md border border-border bg-page px-3 text-base"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-text-muted">Notes (optional)</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Short note"
              className="w-full h-12 rounded-md border border-border bg-page px-3 text-base"
            />
          </label>
        </div>

        {/* Damage quick actions */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            Damage / count
          </p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_DAMAGE_ENTRIES.map((e) => {
              const Icon = ICON_BY_TYPE[e.type];
              const isPending = status.kind === "pending" && status.what === e.reasonCode;
              return (
                <button
                  key={e.type}
                  type="button"
                  disabled={!hasOperator || status.kind === "pending"}
                  onClick={() => submitDamage(e.reasonCode)}
                  className="flex items-start gap-2 rounded-lg border border-border/80 bg-surface px-3 py-3 text-left hover:bg-page disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <span className="flex-1 leading-tight">
                    <span className="block text-sm font-semibold">{e.label}</span>
                    {e.hint ? (
                      <span className="block text-[11px] text-text-muted">{e.hint}</span>
                    ) : null}
                    {damageHasReworkShortcut(e.type) ? (
                      <button
                        type="button"
                        disabled={!hasOperator || status.kind === "pending"}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void submitDamage(e.reasonCode, { alsoSendToRework: true });
                        }}
                        className="mt-1 inline-block rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        + send to rework
                      </button>
                    ) : null}
                    {isPending ? (
                      <span className="mt-1 block text-[10px] text-text-subtle">
                        submitting…
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          <OtherDamageForm
            disabled={!hasOperator || status.kind === "pending"}
            onSubmit={(otherNotes) => submitDamage("OTHER", { otherNotes })}
            isPending={status.kind === "pending" && status.what === "OTHER"}
          />
        </div>

        {/* Send to rework (standalone, no damage chain) */}
        <div className="rounded-lg border border-border/70 bg-surface-2/30 px-3 py-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            Send to rework
          </p>
          <p className="mb-2 text-xs text-text-muted">
            Move {Math.max(1, Math.floor(quantity))} card(s) back to sealing. Default reason: bad seal.
          </p>
          <button
            type="button"
            disabled={!hasOperator || status.kind === "pending"}
            onClick={() => void submitSendToRework()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400 bg-amber-50 px-4 h-12 text-base font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4 shrink-0" />
            Send to rework
          </button>
        </div>

        {/* Receive rework (only meaningful at SEALING / COMBINED) */}
        {pendingRework.length > 0 ? (
          <div className="rounded-lg border border-sky-300 bg-sky-50/60 px-3 py-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sky-800">
              Receive rework ({pendingRework.length})
            </p>
            <ul className="space-y-2">
              {pendingRework.map((row) => {
                const isPending =
                  status.kind === "pending" && status.what === `RECEIVE:${row.id}`;
                return (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-sky-200 bg-white px-3 py-2"
                  >
                    <div className="text-xs">
                      <p className="font-semibold text-sky-900">
                        {row.quantity} {row.unit} · {row.reasonCode}
                      </p>
                      <p className="text-text-muted">
                        sent
                        {row.fromStationLabel ? ` from ${row.fromStationLabel}` : ""}
                        {row.accountableEmployeeName ? ` by ${row.accountableEmployeeName}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!hasOperator || status.kind === "pending"}
                      onClick={() => void submitReceive(row)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400 bg-sky-100 px-3 min-h-[44px] text-sm font-semibold text-sky-900 hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
                    >
                      <Inbox className="h-4 w-4" />
                      {isPending ? "Receiving…" : "Mark received"}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[10px] text-text-subtle">
              Mark received logs receipt at this station for the full sent quantity.
              Partial receive lands in QC-4.
            </p>
          </div>
        ) : null}

        <p className="text-[10px] text-text-subtle">
          Photo capture not yet wired on the floor — text notes only. Capturing
          damage / rework here only writes the event; supervisor converts to
          scrap from /qc-review (QC-4).
        </p>
      </div>
    </details>
  );
}

function StatusBanner({ status }: { status: Status }) {
  if (status.kind === "idle") return null;
  if (status.kind === "pending") {
    return (
      <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        Submitting {status.what}…
      </div>
    );
  }
  if (status.kind === "ok") {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
        {status.what}.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900">
      {status.message}
    </div>
  );
}

function OtherDamageForm({
  disabled,
  isPending,
  onSubmit,
}: {
  disabled: boolean;
  isPending: boolean;
  onSubmit: (notes: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 min-h-[44px] px-2 text-sm font-semibold text-text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        <HelpCircle className="h-4 w-4" />
        Other…
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-3 space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        Other reason (notes required)
      </p>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe the issue"
        className="w-full h-12 rounded-md border border-amber-300 bg-white px-3 text-base"
      />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || text.trim().length === 0}
          onClick={() => {
            onSubmit(text.trim());
            setText("");
            setOpen(false);
          }}
          className="h-12 rounded-lg border border-amber-400 bg-amber-100 px-3 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Submitting…" : "Submit"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setText("");
          }}
          className="h-12 rounded-lg border border-border bg-surface px-3 text-sm text-text-muted hover:bg-page"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
