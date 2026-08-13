"use client";

// P4b Task 3 — THE operator screen.
//
// One component, one render case per NextAction variant, plus the two
// pieces of persistent chrome the spec names: the station label with
// ? Help, and the ⋮ More sheet. Layout and copy follow
// docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md
// ("The operator screen", "Partial bags", "More", "? Help").
//
// PRESENTATIONAL. Every decision lives in the engine: what to show next
// (StationView.nextAction), which fields to ask for (CompletionInput[]),
// why the operator is stuck (Blocker / evaluateChecks), and what the
// screen may submit on its own (autoProductSubmission). The pure helpers
// this file leans on are in lib/production/engine/operator-screen-model.ts
// with their own tests; nothing here decides anything a test would need a
// DOM to observe.
//
// NOT MOUNTED. page.tsx is untouched until the Task 5 cutover — the old
// and new screens must not coexist.
//
// Imports from lib/production go through the engine barrel ONLY (the
// app/(floor) boundary rule); anything else the screen needs is wrapped
// in operator-screen-model.ts and re-exported there.

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  HelpCircle,
  Keyboard,
  Layers,
  LogOut,
  MoreVertical,
  PauseCircle,
  PlayCircle,
  ScanLine,
  X,
  XCircle,
} from "lucide-react";
import {
  assembleCompletionInputs,
  autoProductSubmission,
  completionFieldLabel,
  helpChecklistForView,
  helpIdleNote,
  helpNotifyDetail,
  operatorMaterialLinks,
  operatorPauseModel,
  partialScreenFor,
  pauseCounterSnapshotCopy,
  pauseNeedsCounterSnapshot,
  primaryBlockerSentence,
  progressPercent,
  shouldSubmitAutoProduct,
  upNextSummary,
  type CompletionInput,
  type StationView,
} from "@/lib/production/engine";
import { CameraScanner } from "./camera-scanner";
import { OperatorSessionPanel } from "./operator-session-form";
import { pauseBagAction, resumeBagAction, saveSealingProductAction } from "./actions";
import { endOperatorSessionAction } from "./operator-session-actions";
import {
  advanceBagAction,
  claimScannedBagAction,
  raiseProductionExceptionAction,
} from "./operator-actions";

// crypto.randomUUID() is only available in secure contexts. Floor PWA
// runs over plain HTTP on the LAN — mirror the fallback that
// stage-action-buttons.tsx and qc-panel.tsx use.
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

type EmployeeOption = { id: string; fullName: string; employeeCode: string | null };

type ActionResult = { ok?: true; error?: string } | void;

const PRIMARY_BUTTON =
  "w-full min-h-[72px] inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-700 px-6 text-xl font-semibold text-white shadow-sm transition-colors hover:bg-brand-800 disabled:opacity-60";
const SECONDARY_BUTTON =
  "w-full min-h-[60px] inline-flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-6 text-lg font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-60";
const NUMERIC_INPUT =
  "h-14 w-full rounded-xl border border-border bg-surface px-4 text-2xl tabular-nums text-text";
const SHEET_ITEM =
  "flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-4 text-left text-base text-text hover:bg-surface-2 disabled:opacity-50";

export function OperatorScreen({
  view,
  token,
  employeeOptions,
  reportProblem,
}: {
  view: StationView;
  token: string;
  /** For the OPEN_SHIFT picker — the same list the existing session
   *  panel takes, loaded by the page. */
  employeeOptions: EmployeeOption[];
  /** Task 4's Report problem flow. A ReactNode slot rather than a
   *  callback so the page (a server component) can pass it down. */
  reportProblem?: React.ReactNode;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<
    "none" | "more" | "help" | "pause" | "code"
  >("none");
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [partialQty, setPartialQty] = React.useState("");
  const [keepWorkingBag, setKeepWorkingBag] = React.useState(false);

  const { station, current, nextAction } = view;
  const stationId = station.id;
  const operatorSessionId = view.operator?.sessionId ?? null;
  const currentBagId = current?.workflowBagId ?? null;

  // Typed counts belong to ONE bag. A live refresh (SSE, revalidate,
  // another station releasing work here) can swap the bag under the
  // operator mid-entry, and carrying "52" over to the next bag would
  // submit a count nobody made. Every per-bag entry resets with the id.
  React.useEffect(() => {
    setValues({});
    setPartialQty("");
    setKeepWorkingBag(false);
    setError(null);
  }, [currentBagId]);

  /** One place where an action is called, so pending/error handling
   *  cannot drift between the fifteen buttons on this screen. */
  const run = React.useCallback(
    async (fn: () => Promise<ActionResult>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const result = await fn();
        if (result && "error" in result && result.error) {
          setError(result.error);
          return false;
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  const baseForm = React.useCallback(() => {
    const fd = new FormData();
    fd.set("token", token);
    fd.set("stationId", stationId);
    fd.set("clientEventId", newClientEventId());
    return fd;
  }, [token, stationId]);

  const submitProduct = React.useCallback(
    async (productId: string) => {
      if (!current) return;
      await run(async () => {
        const fd = baseForm();
        fd.set("workflowBagId", current.workflowBagId);
        fd.set("productId", productId);
        const r = await saveSealingProductAction(fd);
        if (r && "openAllocationBlock" in r && r.openAllocationBlock) {
          return { error: r.openAllocationBlock.message };
        }
        return r;
      });
    },
    [baseForm, current, run],
  );

  // ── the AUTO rule ───────────────────────────────────────────────────
  // Exactly one compatible product is master data's answer, not an
  // operator question: the screen sends it and no button is ever drawn.
  // The ref is the loop guard — a rejected submission leaves the view
  // looking identical, so retrying on it would spin forever. A different
  // bag (or product) produces a different key and gets its own attempt.
  const autoAttemptedRef = React.useRef<string | null>(null);
  const auto = React.useMemo(() => autoProductSubmission(view), [view]);
  React.useEffect(() => {
    if (!shouldSubmitAutoProduct(auto, autoAttemptedRef.current)) return;
    if (!auto) return;
    autoAttemptedRef.current = auto.key;
    void submitProduct(auto.productId);
  }, [auto, submitProduct]);

  const advance = React.useCallback(
    async (
      intent: "COMPLETE" | "CONFIRM_BAG_EMPTY" | "RESOLVE_PARTIAL",
      extra: Record<string, string> = {},
    ) => {
      if (!current || !operatorSessionId) {
        setError("Open a shift before recording work.");
        return;
      }
      const ok = await run(async () => {
        const fd = baseForm();
        fd.set("workflowBagId", current.workflowBagId);
        fd.set("operatorSessionId", operatorSessionId);
        fd.set("intent", intent);
        for (const [k, v] of Object.entries(extra)) fd.set(k, v);
        return advanceBagAction(fd);
      });
      if (ok) {
        setValues({});
        setPartialQty("");
        setKeepWorkingBag(false);
      }
    },
    [baseForm, current, operatorSessionId, run],
  );

  const claim = React.useCallback(
    async (args: { scanToken?: string; workflowBagId?: string }): Promise<boolean> => {
      return run(async () => {
        const fd = baseForm();
        if (args.scanToken) fd.set("scanToken", args.scanToken);
        if (args.workflowBagId) fd.set("workflowBagId", args.workflowBagId);
        return claimScannedBagAction(fd);
      });
    },
    [baseForm, run],
  );

  return (
    <div className="flex min-h-screen flex-col bg-surface-2 text-text">
      <StationHeader
        label={station.label}
        machineName={station.machineName}
        operatorName={view.operator?.name ?? null}
        onHelp={() => setSheet("help")}
      />

      <main className="flex-1 space-y-5 px-4 pb-28 pt-4">
        <ErrorAlert message={error} />

        {nextAction.kind === "OPEN_SHIFT" ? (
          <OperatorSessionPanel
            token={token}
            stationId={stationId}
            stationKind={station.kind}
            activeSession={null}
            employeeOptions={employeeOptions}
          />
        ) : null}

        {nextAction.kind === "SCAN_TO_CLAIM" ? (
          <section className="space-y-5">
            {nextAction.expected ? (
              <div className="rounded-2xl border border-border bg-surface px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                  Up next
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {upNextSummary(nextAction.expected)}
                </p>
              </div>
            ) : (
              <p className="rounded-2xl border border-border bg-surface px-4 py-6 text-center text-base text-text-muted">
                Nothing is waiting for this station. Scan a bag to pick it up.
              </p>
            )}
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={pending}
              onClick={() => {
                setError(null);
                setScannerOpen(true);
              }}
            >
              <ScanLine className="h-6 w-6" />
              Scan to confirm
            </button>
          </section>
        ) : null}

        {current ? (
          <BagIdentity
            bagLabel={current.bagLabel}
            bagSubLabel={current.bagSubLabel}
            productName={current.productName}
            statusLine={current.statusLine}
          />
        ) : null}

        {nextAction.kind === "START" ? (
          // Rendered for completeness: no AdvanceIntent corresponds to
          // START and buildNextAction never returns it today, so there is
          // no gesture to offer. Announcing the step without a live
          // button is the honest shape until the engine can serve one.
          <section className="space-y-3">
            <p className="text-center text-2xl font-semibold">{nextAction.label}</p>
            <p className="text-center text-base text-text-muted">
              Luma opens this step for you — nothing to do here yet.
            </p>
          </section>
        ) : null}

        {nextAction.kind === "COMPLETE" && current ? (
          <section className="space-y-5">
            {current.progress ? (
              <Progress
                done={current.progress.done}
                expected={current.progress.expected}
                unit={current.progress.unit}
              />
            ) : null}
            {nextAction.inputs.map((input: CompletionInput) => (
              <label key={input.key} className="block space-y-1.5">
                <span className="text-sm font-medium text-text-muted">
                  {completionFieldLabel(input)}
                  {input.required ? "" : " · optional"}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={values[input.key] ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [input.key]: e.target.value.replace(/\D/g, ""),
                    }))
                  }
                  className={NUMERIC_INPUT}
                  placeholder="0"
                />
              </label>
            ))}
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={pending}
              onClick={() => {
                const assembled = assembleCompletionInputs(nextAction.inputs, values);
                if (!assembled.ok) {
                  setError(assembled.message);
                  return;
                }
                const extra: Record<string, string> = {};
                for (const [k, v] of Object.entries(assembled.inputs)) {
                  if (v != null) extra[k] = String(v);
                }
                void advance("COMPLETE", extra);
              }}
            >
              <CheckCircle2 className="h-6 w-6" />
              {nextAction.label}
            </button>
            {/* The mock's "Scan next bag" line: a hint about what happens
                after DONE, not a second camera. The claim screen (with
                the real scanner) is what this station shows next. */}
            <p className="text-center text-base text-text-muted">
              Scan next bag when this one is done.
            </p>
          </section>
        ) : null}

        {nextAction.kind === "CONFIRM_BAG_EMPTY" ? (
          <section className="space-y-3">
            <p className="text-center text-xl font-semibold">Is this bag empty?</p>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={pending}
              onClick={() => void advance("CONFIRM_BAG_EMPTY")}
            >
              Yes, bag empty
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={pending}
              onClick={() => {
                // Declining records nothing: "more to work" is the
                // absence of a close, not an event of its own.
                setError(null);
                setKeepWorkingBag(true);
              }}
            >
              No, more to work
            </button>
            {keepWorkingBag ? (
              <p className="text-center text-base text-text-muted">
                Keep working this bag. Come back when it is empty.
              </p>
            ) : null}
          </section>
        ) : null}

        {nextAction.kind === "RESOLVE_PARTIAL" ? (
          <PartialBag
            action={nextAction}
            pending={pending}
            quantity={partialQty}
            onQuantityChange={setPartialQty}
            onUseEstimate={(estimate) =>
              void advance("RESOLVE_PARTIAL", {
                partialRemainingEstimate: String(estimate),
              })
            }
            onContinue={(qty) =>
              void advance("RESOLVE_PARTIAL", { physicalQty: qty })
            }
            onInvalid={setError}
          />
        ) : null}

        {nextAction.kind === "PICK_PRODUCT" && auto ? (
          // The AUTO case: one compatible product is not a question, so
          // the screen shows what it is doing instead of a chooser with
          // a single button the operator would have to press.
          <p className="text-center text-lg text-text-muted">Setting product…</p>
        ) : null}

        {nextAction.kind === "PICK_PRODUCT" && !auto ? (
          <section className="space-y-3">
            <p className="text-center text-xl font-semibold">
              Which product is this bag making?
            </p>
            {nextAction.options.map((option) => (
              <button
                key={option.productId}
                type="button"
                className={SECONDARY_BUTTON}
                disabled={pending}
                onClick={() => void submitProduct(option.productId)}
              >
                <span className="flex-1 text-left">
                  <span className="block font-semibold">{option.name}</span>
                  <span className="block text-sm text-text-muted">{option.sku}</span>
                </span>
                <ChevronRight className="h-5 w-5 text-text-muted" />
              </button>
            ))}
          </section>
        ) : null}

        {nextAction.kind === "BLOCKED" ? (
          <section className="space-y-4">
            <p className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-5 text-center text-xl font-semibold text-amber-950">
              {primaryBlockerSentence(nextAction) ?? "Luma cannot continue here."}
            </p>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => setSheet("help")}
            >
              <HelpCircle className="h-5 w-5" />
              Why?
            </button>
            {reportProblem}
          </section>
        ) : null}
      </main>

      <footer className="fixed inset-x-0 bottom-0 border-t border-border bg-surface px-4 py-3">
        <button
          type="button"
          onClick={() => setSheet("more")}
          className="ml-auto flex items-center gap-2 rounded-xl px-4 py-2.5 text-base font-medium text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <MoreVertical className="h-5 w-5" />
          More
        </button>
      </footer>

      {scannerOpen ? (
        <CameraScanner
          onResult={(scanToken) => {
            setScannerOpen(false);
            void claim({ scanToken });
          }}
          onClose={() => setScannerOpen(false)}
        />
      ) : null}

      {sheet === "more" ? (
        <MoreSheet
          view={view}
          token={token}
          pending={pending}
          error={error}
          reportProblem={reportProblem}
          onClose={() => setSheet("none")}
          onPause={() => setSheet("pause")}
          onEnterCode={() => setSheet("code")}
          onResume={() =>
            void run(async () => {
              // Silence here would look like a successful resume. The bag
              // can vanish between the sheet opening and the press (a
              // live refresh, another station taking it).
              if (!current) {
                return { error: "There is no bag at this station to resume." };
              }
              const fd = baseForm();
              fd.set("workflowBagId", current.workflowBagId);
              return resumeBagAction(fd);
            })
          }
          onEndShift={() =>
            void run(async () => {
              const fd = new FormData();
              fd.set("token", token);
              fd.set("stationId", stationId);
              return endOperatorSessionAction(fd);
            })
          }
        />
      ) : null}

      {sheet === "pause" && current ? (
        <PauseSheet
          stationKind={station.kind}
          pending={pending}
          error={error}
          onClose={() => setSheet("none")}
          onSubmit={async (reason, counterSnapshot) => {
            const ok = await run(async () => {
              const fd = baseForm();
              fd.set("workflowBagId", current.workflowBagId);
              fd.set("reason", reason);
              if (counterSnapshot) fd.set("counterSnapshotCount", counterSnapshot);
              return pauseBagAction(fd);
            });
            if (ok) setSheet("none");
          }}
        />
      ) : null}

      {sheet === "code" ? (
        <TypedCodeSheet
          pending={pending}
          error={error}
          onClose={() => setSheet("none")}
          onSubmit={async (code) => {
            // Stay open on a refusal — the sheet is where the operator
            // can fix the code they typed.
            if (await claim({ scanToken: code })) setSheet("none");
          }}
        />
      ) : null}

      {sheet === "help" ? (
        <HelpSheet
          view={view}
          pending={pending}
          error={error}
          onClose={() => setSheet("none")}
          onNotify={async (detail) => {
            const ok = await run(async () => {
              const fd = baseForm();
              if (current) fd.set("workflowBagId", current.workflowBagId);
              fd.set("category", "OTHER");
              fd.set("detail", detail);
              return raiseProductionExceptionAction(fd);
            });
            if (ok) setSheet("none");
          }}
        />
      ) : null}
    </div>
  );
}

// ── chrome ────────────────────────────────────────────────────────────

function StationHeader({
  label,
  machineName,
  operatorName,
  onHelp,
}: {
  label: string;
  machineName: string | null;
  operatorName: string | null;
  onHelp: () => void;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div>
        <h1 className="text-2xl font-bold uppercase tracking-tight">{label}</h1>
        <p className="text-sm text-text-muted">
          {[machineName, operatorName].filter(Boolean).join(" · ") || " "}
        </p>
      </div>
      <button
        type="button"
        onClick={onHelp}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-base text-text-muted hover:bg-surface-2 hover:text-text"
      >
        <HelpCircle className="h-5 w-5" />
        Help
      </button>
    </header>
  );
}

function BagIdentity({
  bagLabel,
  bagSubLabel,
  productName,
  statusLine,
}: {
  bagLabel: string;
  bagSubLabel: string | null;
  productName: string | null;
  statusLine: string;
}) {
  return (
    <section className="space-y-1">
      <p className="text-2xl font-bold tracking-tight">{bagLabel}</p>
      {bagSubLabel ? <p className="text-sm text-text-muted">{bagSubLabel}</p> : null}
      {productName ? <p className="text-lg text-text">{productName}</p> : null}
      <p className="text-sm text-text-muted">{statusLine}</p>
    </section>
  );
}

function Progress({
  done,
  expected,
  unit,
}: {
  done: number;
  expected: number;
  unit: string;
}) {
  const pct = progressPercent({ done, expected, unit });
  return (
    <div className="space-y-2">
      <p className="text-3xl font-bold tabular-nums">
        {done} / {expected}{" "}
        <span className="text-base font-normal text-text-muted">{unit}</span>
      </p>
      {pct != null ? (
        <div
          className="h-4 w-full overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full bg-brand-700" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** The only error surface on this screen. Rendered in main AND inside
 *  every sheet: a sheet covers main, so an error raised by a button the
 *  operator pressed IN a sheet would otherwise land behind it and read
 *  as "nothing happened". */
function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-base text-rose-900"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <span>{message}</span>
    </p>
  );
}

function Sheet({
  title,
  error,
  onClose,
  children,
}: {
  title: string;
  error: string | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50">
      <div className="max-h-[85vh] w-full space-y-3 overflow-y-auto rounded-t-3xl bg-surface-2 p-4">
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <ErrorAlert message={error} />
        {children}
      </div>
    </div>
  );
}

function MoreSheet({
  view,
  token,
  pending,
  error,
  reportProblem,
  onClose,
  onPause,
  onResume,
  onEnterCode,
  onEndShift,
}: {
  view: StationView;
  token: string;
  pending: boolean;
  error: string | null;
  reportProblem?: React.ReactNode;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnterCode: () => void;
  onEndShift: () => void;
}) {
  const isPaused =
    view.nextAction.kind === "BLOCKED" &&
    view.nextAction.blockers.some((b) => b.code === "BAG_PAUSED");
  const materialLinks = operatorMaterialLinks(token, view.station.kind);

  return (
    <Sheet title="More" error={error} onClose={onClose}>
      {view.capabilities.canPause ? (
        isPaused ? (
          <button type="button" className={SHEET_ITEM} disabled={pending} onClick={onResume}>
            <span className="flex items-center gap-3">
              <PlayCircle className="h-5 w-5 text-text-muted" />
              Resume bag
            </span>
          </button>
        ) : (
          <button type="button" className={SHEET_ITEM} disabled={pending} onClick={onPause}>
            <span className="flex items-center gap-3">
              <PauseCircle className="h-5 w-5 text-text-muted" />
              Pause
            </span>
            <ChevronRight className="h-5 w-5 text-text-muted" />
          </button>
        )
      ) : null}

      {materialLinks.map((link) => (
        <a key={link.id} href={link.href} className={SHEET_ITEM}>
          <span className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-text-muted" />
            Change material
          </span>
          <ChevronRight className="h-5 w-5 text-text-muted" />
        </a>
      ))}

      {reportProblem}

      <button type="button" className={SHEET_ITEM} onClick={onEnterCode}>
        <span className="flex items-center gap-3">
          <Keyboard className="h-5 w-5 text-text-muted" />
          Enter code manually
        </span>
        <ChevronRight className="h-5 w-5 text-text-muted" />
      </button>

      {view.operator ? (
        <button type="button" className={SHEET_ITEM} disabled={pending} onClick={onEndShift}>
          <span className="flex items-center gap-3">
            <LogOut className="h-5 w-5 text-text-muted" />
            End shift
          </span>
        </button>
      ) : null}
    </Sheet>
  );
}

function PauseSheet({
  stationKind,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  stationKind: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (reason: string, counterSnapshot: string | null) => void;
}) {
  const model = React.useMemo(() => operatorPauseModel(stationKind), [stationKind]);
  const [reason, setReason] = React.useState(model.defaultReason);
  const [counter, setCounter] = React.useState("");
  const needsCounter = pauseNeedsCounterSnapshot(stationKind, reason);
  const copy = pauseCounterSnapshotCopy(reason);

  return (
    <Sheet title="Pause" error={error} onClose={onClose}>
      <div className="space-y-2">
        {model.reasons.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => setReason(r.value)}
            className={`${SHEET_ITEM} ${
              reason === r.value ? "border-brand-700 ring-2 ring-brand-700/30" : ""
            }`}
          >
            <span>{r.label}</span>
            {reason === r.value ? (
              <CheckCircle2 className="h-5 w-5 text-brand-700" />
            ) : null}
          </button>
        ))}
      </div>
      {needsCounter ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text-muted">{copy.label}</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={counter}
            disabled={pending}
            onChange={(e) => setCounter(e.target.value.replace(/\D/g, ""))}
            className={NUMERIC_INPUT}
            placeholder="0"
          />
          <span className="block text-xs leading-relaxed text-text-muted">
            {copy.helper}
          </span>
        </label>
      ) : null}
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={pending}
        onClick={() => onSubmit(reason, needsCounter ? counter : null)}
      >
        <PauseCircle className="h-6 w-6" />
        Pause bag
      </button>
    </Sheet>
  );
}

function TypedCodeSheet({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = React.useState("");
  return (
    <Sheet title="Enter code manually" error={error} onClose={onClose}>
      <p className="text-sm text-text-muted">
        Type the code printed under the bag QR.
      </p>
      <input
        type="text"
        value={code}
        disabled={pending}
        onChange={(e) => setCode(e.target.value.trim())}
        className="h-14 w-full rounded-xl border border-border bg-surface px-4 text-xl text-text"
        placeholder="bag-card-000"
      />
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={pending || code === ""}
        onClick={() => onSubmit(code)}
      >
        Use this code
      </button>
    </Sheet>
  );
}

function HelpSheet({
  view,
  pending,
  error,
  onClose,
  onNotify,
}: {
  view: StationView;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onNotify: (detail: string) => void;
}) {
  // The SAME evaluateChecks() that produced the view's blockers — the
  // checklist cannot disagree with why the button is disabled. On an
  // idle station the bag-in-hand rows are dropped and the note below
  // says why, rather than showing three crosses for a bag nobody has
  // scanned yet.
  const checks = helpChecklistForView(view);
  const idleNote = helpIdleNote(view);
  const failed = checks.filter((c) => !c.passed);
  const detail = helpNotifyDetail(checks);

  return (
    <Sheet title="Why can't I continue?" error={error} onClose={onClose}>
      {idleNote ? (
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-text-muted">
          {idleNote}
        </p>
      ) : null}
      <ul className="space-y-2">
        {checks.map((check) => (
          <li
            key={check.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-base"
          >
            {check.passed ? (
              <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-600" />
            ) : (
              <XCircle className="h-5 w-5 flex-shrink-0 text-rose-600" />
            )}
            <span className={check.passed ? "text-text-muted" : "font-medium text-text"}>
              {check.label}
            </span>
          </li>
        ))}
      </ul>
      {failed.length > 0 ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-base text-amber-950">
          {failed[0]?.blocker?.operatorSentence}
        </p>
      ) : null}
      <button
        type="button"
        className={SECONDARY_BUTTON}
        disabled={pending}
        onClick={() => onNotify(detail)}
      >
        Notify supervisor
      </button>
    </Sheet>
  );
}

function PartialBag({
  action,
  pending,
  quantity,
  onQuantityChange,
  onUseEstimate,
  onContinue,
  onInvalid,
}: {
  action: Extract<StationView["nextAction"], { kind: "RESOLVE_PARTIAL" }>;
  pending: boolean;
  quantity: string;
  onQuantityChange: (value: string) => void;
  onUseEstimate: (estimate: number) => void;
  onContinue: (quantity: string) => void;
  onInvalid: (message: string) => void;
}) {
  const screen = partialScreenFor(action);
  if (!screen) return null;

  if (screen.mode === "USE_ESTIMATE") {
    return (
      <section className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface px-4 py-4 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            Partial bag detected
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            Estimated remaining: {screen.estimate.toLocaleString()} units
          </p>
        </div>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={pending}
          onClick={() => onUseEstimate(screen.estimate)}
        >
          Use bag
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-900">
          Check bag
        </p>
        <p className="mt-1 text-base text-amber-950">
          System cannot confidently determine remaining quantity.
        </p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-text-muted">
          Enter physical quantity
        </span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={quantity}
          disabled={pending}
          onChange={(e) => onQuantityChange(e.target.value.replace(/\D/g, ""))}
          className={NUMERIC_INPUT}
          placeholder="0"
        />
      </label>
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={pending}
        onClick={() => {
          if (quantity.trim() === "") {
            onInvalid("Enter the physical quantity before continuing.");
            return;
          }
          onContinue(quantity.trim());
        }}
      >
        Continue
      </button>
    </section>
  );
}
