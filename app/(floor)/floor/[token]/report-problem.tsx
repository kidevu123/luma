"use client";

// P4b Task 4 — the single exception workflow. Six category buttons,
// ONE follow-up question, recorded automatically
// (docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md,
// "Exceptions"):
//
//   Something wrong?
//   [ Material ] [ Machine ] [ Product ]
//   [ Bag ]      [ Quality ] [ Other ]
//
// Routing per raise-production-exception.ts's own header (the mapping
// table), made checkable without a DOM via reportProblemRouteFor
// (operator-screen-model.ts):
//   MACHINE                  -> pauseBagAction (best-effort) + raiseDowntimeAction
//   QUALITY                  -> raiseQaHoldAction
//   BAG                      -> pauseBagAction
//   MATERIAL / PRODUCT / OTHER -> raiseProductionExceptionAction
//
// PRESENTATIONAL, same discipline as operator-screen.tsx: the only
// decisions this file makes for itself are which sheet is open and
// what the operator typed. Which write(s) a category becomes is
// reportProblemRouteFor's answer, not a switch re-derived here.
//
// Rendered from OperatorScreen's `reportProblem` slot — the SAME
// instance appears in both the More sheet and the BLOCKED screen
// (operator-screen.tsx), so this is a fully self-contained trigger +
// sheet with its own pending/error/open state: neither caller can
// reach into OperatorScreen's.

import * as React from "react";
import { ChevronLeft, Flag, Send, X } from "lucide-react";
import {
  EXCEPTION_DETAIL_MAX_LENGTH,
  REPORT_PROBLEM_CATEGORY_LAYOUT,
  reportProblemCategoryDisabled,
  reportProblemRouteFor,
  type ProductionExceptionCategory,
} from "@/lib/production/engine";
import { pauseBagAction } from "./actions";
import {
  raiseDowntimeAction,
  raiseProductionExceptionAction,
  raiseQaHoldAction,
  type OperatorActionResult,
} from "./operator-actions";

const CATEGORY_LABEL: Record<ProductionExceptionCategory, string> = {
  MATERIAL: "Material",
  MACHINE: "Machine",
  PRODUCT: "Product",
  BAG: "Bag",
  QUALITY: "Quality",
  OTHER: "Other",
};

// The tighter of the two caps the follow-up detail can land in:
// pauseBagAction's `notes` column (400, MACHINE/BAG) and
// raiseProductionException's `detail` column (EXCEPTION_DETAIL_MAX_LENGTH,
// 500, MATERIAL/PRODUCT/OTHER/QUALITY/MACHINE's DOWNTIME_STARTED write).
// One field, one limit, so the same textarea never risks a validation
// error depending on which category the operator picked.
const DETAIL_MAX_LENGTH = Math.min(400, EXCEPTION_DETAIL_MAX_LENGTH);

const TRIGGER =
  "flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-6 py-4 text-lg font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-60";
const CATEGORY_BUTTON =
  "flex min-h-[64px] items-center justify-center rounded-2xl border border-border bg-surface px-3 text-center text-base font-semibold text-text transition-colors hover:bg-surface-2 disabled:opacity-40";
const PRIMARY_BUTTON =
  "w-full min-h-[60px] inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-700 px-6 text-lg font-semibold text-white shadow-sm transition-colors hover:bg-brand-800 disabled:opacity-60";

// crypto.randomUUID() is only available in secure contexts. Floor PWA
// runs over plain HTTP on the LAN — same fallback as operator-screen.tsx.
function newClientEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
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

type PauseActionResult = Awaited<ReturnType<typeof pauseBagAction>>;

export function ReportProblem({
  token,
  stationId,
  workflowBagId,
}: {
  token: string;
  stationId: string;
  /** The bag currently pinned at this station (view.current?.workflowBagId),
   *  or null. Bagless MATERIAL/PRODUCT/OTHER/BAG reports are disabled —
   *  see reportProblemCategoryDisabled's own comment for why MACHINE and
   *  QUALITY stay enabled: a bagless report is P5 scope. */
  workflowBagId: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [category, setCategory] = React.useState<ProductionExceptionCategory | null>(
    null,
  );
  const [detail, setDetail] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  const close = React.useCallback(() => {
    setOpen(false);
    setCategory(null);
    setDetail("");
    setError(null);
    setSent(false);
  }, []);

  const baseForm = React.useCallback(() => {
    const fd = new FormData();
    fd.set("token", token);
    fd.set("stationId", stationId);
    fd.set("clientEventId", newClientEventId());
    return fd;
  }, [token, stationId]);

  const submit = React.useCallback(async () => {
    if (!category) return;
    const trimmed = detail.trim();
    if (!trimmed) {
      setError("Add a short note about what's wrong before sending.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const route = reportProblemRouteFor(category);
      let result: OperatorActionResult | PauseActionResult;
      if (route === "PAUSE_AND_DOWNTIME") {
        // Best-effort: a bag already paused for another reason (shift
        // break, an earlier report) must not block the downtime
        // record itself, so this call's own outcome is not checked.
        // "other" (not "machine_jam") deliberately — machine_jam
        // demands a blister counter reading at counting stations,
        // which would break the spec's ONE follow-up question.
        if (workflowBagId) {
          const pauseFd = baseForm();
          pauseFd.set("workflowBagId", workflowBagId);
          pauseFd.set("reason", "other");
          pauseFd.set("notes", trimmed);
          void pauseBagAction(pauseFd);
        }
        const fd = baseForm();
        if (workflowBagId) fd.set("workflowBagId", workflowBagId);
        fd.set("detail", trimmed);
        result = await raiseDowntimeAction(fd);
      } else if (route === "QA_HOLD") {
        const fd = baseForm();
        if (workflowBagId) fd.set("workflowBagId", workflowBagId);
        fd.set("detail", trimmed);
        result = await raiseQaHoldAction(fd);
      } else if (route === "PAUSE") {
        if (!workflowBagId) {
          setError("Scan the bag this is about first.");
          return;
        }
        const fd = baseForm();
        fd.set("workflowBagId", workflowBagId);
        fd.set("reason", "other");
        fd.set("notes", trimmed);
        result = await pauseBagAction(fd);
      } else {
        const fd = baseForm();
        if (workflowBagId) fd.set("workflowBagId", workflowBagId);
        fd.set("category", category);
        fd.set("detail", trimmed);
        result = await raiseProductionExceptionAction(fd);
      }
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send this.");
    } finally {
      setPending(false);
    }
  }, [baseForm, category, detail, workflowBagId]);

  return (
    <>
      <button type="button" className={TRIGGER} onClick={() => setOpen(true)}>
        <Flag className="h-5 w-5 text-text-muted" />
        Report problem
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50">
          <div className="max-h-[85vh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-surface-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-lg font-semibold">
                {sent
                  ? "Sent"
                  : category
                    ? CATEGORY_LABEL[category]
                    : "Something wrong?"}
              </p>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-base text-rose-900"
              >
                {error}
              </p>
            ) : null}

            {sent ? (
              <p className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-base text-text-muted">
                Recorded. A supervisor can see this on the floor board.
              </p>
            ) : category == null ? (
              <div className="grid grid-cols-3 gap-3">
                {REPORT_PROBLEM_CATEGORY_LAYOUT.map((c) => {
                  const disabled = reportProblemCategoryDisabled(
                    reportProblemRouteFor(c),
                    workflowBagId != null,
                  );
                  return (
                    <button
                      key={c}
                      type="button"
                      className={CATEGORY_BUTTON}
                      disabled={disabled}
                      title={disabled ? "Scan the bag this is about first." : undefined}
                      onClick={() => setCategory(c)}
                    >
                      {CATEGORY_LABEL[c]}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-text-muted">
                    What&apos;s wrong?
                  </span>
                  <textarea
                    value={detail}
                    disabled={pending}
                    maxLength={DETAIL_MAX_LENGTH}
                    onChange={(e) => setDetail(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base text-text"
                    placeholder="Short note — a supervisor sees this."
                  />
                </label>
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  disabled={pending || detail.trim() === ""}
                  onClick={() => void submit()}
                >
                  <Send className="h-5 w-5" />
                  Send
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1.5 py-2 text-base text-text-muted hover:text-text"
                  disabled={pending}
                  onClick={() => setCategory(null)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
