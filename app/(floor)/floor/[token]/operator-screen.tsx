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
// MOUNTED as of the Task 5 cutover: page.tsx's main render path is now
// resolve station -> getStationView -> <FloorLiveRefresh> + this
// component. The legacy panels are gone from that path; the old and new
// screens do not coexist.
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
  MoreVertical,
  PauseCircle,
  PlayCircle,
  ScanLine,
  Shield,
  SkipForward,
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
  helpNotifyDisabled,
  helpNotifyRequiresBagCopy,
  operatorMaterialLinks,
  operatorPauseModel,
  SEALING_PARTIAL_CLOSE_REASONS,
  SEALING_PARTIAL_CLOSE_REASON_LABELS,
  partialScreenFor,
  pauseCounterSnapshotCopy,
  pauseNeedsCounterSnapshot,
  primaryBlockerSentence,
  progressPercent,
  shouldSubmitAutoProduct,
  upNextSummary,
  type CompletionInput,
  type SealingPartialCloseReason,
  type StationView,
} from "@/lib/production/engine/client";
import { BottleSealingRecoveryPanel } from "./bottle-sealing-recovery-panel";
import { CameraScanner } from "./camera-scanner";
import { OperatorSessionPanel, type ActiveSession } from "./operator-session-form";
import { pauseBagAction, resumeBagAction, saveSealingProductAction } from "./actions";
import {
  advanceBagAction,
  claimScannedBagAction,
  raiseProductionExceptionAction,
} from "./operator-actions";
import { SupervisorBanner, SupervisorSheet } from "./supervisor-sheet";

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
  activeSession,
  reportProblem,
  qcPanel,
}: {
  view: StationView;
  token: string;
  /** For the OPEN_SHIFT picker — the same list the existing session
   *  panel takes, loaded by the page. */
  employeeOptions: EmployeeOption[];
  /** The open station_operator_sessions row, or null. StationView's
   *  `operator` carries only an id and a name; the End-shift flow needs
   *  the row itself, because BLISTER-PAUSE-COUNT-SNAPSHOT-1 refuses to
   *  end a shift on a running counting station without a counter
   *  reading, and that guard lives in OperatorSessionPanel. */
  activeSession: ActiveSession | null;
  /** Task 4's Report problem flow. A ReactNode slot rather than a
   *  callback so the page (a server component) can pass it down.
   *
   *  REQUIRED as of the Task 5 cutover: an optional slot is a silently
   *  forgettable one, and `Report problem` is the ONLY exception path
   *  the operator screen offers. A station that mounted this component
   *  without it would strand every operator whose problem is not a
   *  blocker Luma already knows about. */
  reportProblem: React.ReactNode;
  /** QC-3's panel, rendered under More for the station kinds that get
   *  it (shouldRenderQcPanel) and only while a bag is in hand. Also
   *  hosts [ Release hold ], the only escape from a QA hold — P5 moves
   *  the whole panel behind supervisor unlock. */
  qcPanel?: React.ReactNode;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<
    "none" | "more" | "help" | "pause" | "code" | "sealingPartial" | "supervisor"
  >("none");
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [partialQty, setPartialQty] = React.useState("");
  const [leadCode, setLeadCode] = React.useState("");
  const [keepWorkingBag, setKeepWorkingBag] = React.useState(false);
  // SCAN-FIRST-1 — a scan can come back asking for one more answer
  // before the bag can start: which product (BOTTLE_HANDPACK) or "yes,
  // this partial is the bag I mean". Both are re-submissions of the SAME
  // scan, so the token is held alongside them.
  const [startScan, setStartScan] = React.useState<{
    scanToken: string;
    needsProduct?: { options: { productId: string; name: string; sku: string }[] };
    partialReuse?: {
      estimate: number | null;
      confidence: string | null;
      previousProductName: string | null;
    };
  } | null>(null);

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
    setLeadCode("");
    setKeepWorkingBag(false);
    setStartScan(null);
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

  /** Returns whether the write landed. Callers that opened a SHEET need
   *  the answer: a refusal must leave the sheet open on top of the error,
   *  because the sheet is where the inputs that caused it still are. */
  const advance = React.useCallback(
    async (
      intent: "COMPLETE" | "CONFIRM_BAG_EMPTY" | "RESOLVE_PARTIAL",
      extra: Record<string, string> = {},
    ): Promise<boolean> => {
      if (!current || !operatorSessionId) {
        setError("Open a shift before recording work.");
        return false;
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
      return ok;
    },
    [baseForm, current, operatorSessionId, run],
  );

  /** The DONE gesture, shared by COMPLETE and by "No, more to work"
   *  (which records another sealing segment on the same bag). Only the
   *  keys the ENGINE asked for are read — assembleCompletionInputs
   *  drops anything else, which is load-bearing: the presence of
   *  cases/displays/loose is what routes a COMBINED station's write to
   *  packaging. */
  const submitWork = React.useCallback(
    (inputs: readonly CompletionInput[]) => {
      const assembled = assembleCompletionInputs(inputs, values);
      if (!assembled.ok) {
        setError(assembled.message);
        return;
      }
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(assembled.inputs)) {
        if (v != null) extra[k] = String(v);
      }
      void advance("COMPLETE", extra);
    },
    [advance, values],
  );

  const claim = React.useCallback(
    async (args: {
      scanToken?: string;
      workflowBagId?: string;
      productId?: string;
      confirmPartialReuse?: boolean;
      partialReuseSupervisorCode?: string;
    }): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const fd = baseForm();
        if (args.scanToken) fd.set("scanToken", args.scanToken);
        if (args.workflowBagId) fd.set("workflowBagId", args.workflowBagId);
        if (args.productId) fd.set("productId", args.productId);
        if (args.confirmPartialReuse) fd.set("confirmPartialReuse", "true");
        if (args.partialReuseSupervisorCode) {
          fd.set("partialReuseSupervisorCode", args.partialReuseSupervisorCode);
        }
        const result = await claimScannedBagAction(fd);
        if ("needsProduct" in result || "partialReuse" in result) {
          // Not an error and not a success: the scan is mid-flight and
          // the operator owes one answer. Keeping the token is what
          // makes the follow-up a re-submission rather than a re-scan.
          setStartScan({
            scanToken: args.scanToken ?? "",
            ...("needsProduct" in result
              ? { needsProduct: result.needsProduct }
              : {}),
            ...("partialReuse" in result
              ? { partialReuse: result.partialReuse }
              : {}),
          });
          return false;
        }
        setStartScan(null);
        if ("error" in result && result.error) {
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
    [baseForm],
  );

  return (
    <div className="flex min-h-screen flex-col bg-surface-2 text-text">
      <StationHeader
        label={station.label}
        machineName={station.machineName}
        operatorName={view.operator?.name ?? null}
        onHelp={() => setSheet("help")}
      />

      {view.supervisor ? (
        <SupervisorBanner
          supervisor={view.supervisor}
          token={token}
          stationId={stationId}
        />
      ) : null}

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

        {nextAction.kind === "SCAN_TO_CLAIM" && startScan?.needsProduct ? (
          <section className="space-y-3">
            <p className="text-center text-xl font-semibold">
              Which product is this bag making?
            </p>
            {startScan.needsProduct.options.map((option) => (
              <button
                key={option.productId}
                type="button"
                className={SECONDARY_BUTTON}
                disabled={pending}
                onClick={() =>
                  void claim({
                    scanToken: startScan.scanToken,
                    productId: option.productId,
                  })
                }
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

        {nextAction.kind === "SCAN_TO_CLAIM" && startScan?.partialReuse ? (
          <PartialReuseStart
            reuse={startScan.partialReuse}
            pending={pending}
            leadCode={leadCode}
            onLeadCodeChange={setLeadCode}
            onConfirm={(supervisorCode) =>
              void claim({
                scanToken: startScan.scanToken,
                confirmPartialReuse: true,
                ...(supervisorCode ? { partialReuseSupervisorCode: supervisorCode } : {}),
              })
            }
            onInvalid={setError}
          />
        ) : null}

        {nextAction.kind === "SCAN_TO_CLAIM" && !startScan ? (
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
          // Claimed early — the overlap scan. There is no gesture to
          // offer because no workflow event marks "operator started";
          // buildNextAction flips this to COMPLETE on its own the moment
          // the upstream station's completion lands, which is exactly
          // what this copy promises.
          <section className="space-y-3">
            <p className="text-center text-2xl font-semibold">{nextAction.label}</p>
            <p className="text-center text-base text-text-muted">
              This bag is still being worked on at the step before this one.
              Luma opens {nextAction.label.toLowerCase()} here as soon as that
              finishes — nothing to tap.
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
            <CompletionFields
              inputs={nextAction.inputs}
              values={values}
              pending={pending}
              onChange={setValues}
            />
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={pending}
              onClick={() => submitWork(nextAction.inputs)}
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
                // Declining records no CLOSE — but it is not "nothing
                // happens" either: the operator keeps sealing the same
                // bag, and that work is another segment. Revealing the
                // same completion form the COMPLETE case would have
                // shown (nextAction.moreWork, the engine's own
                // CompletionInput[]) is what stops the second answer
                // from being a dead end.
                setError(null);
                setKeepWorkingBag(true);
              }}
            >
              No, more to work
            </button>
            {keepWorkingBag ? (
              <div className="space-y-4 rounded-2xl border border-border bg-surface px-4 py-4">
                <p className="text-base text-text-muted">
                  Keep working this bag, then record what you just did.
                </p>
                <CompletionFields
                  inputs={nextAction.moreWork.inputs}
                  values={values}
                  pending={pending}
                  onChange={setValues}
                />
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  disabled={pending}
                  onClick={() => submitWork(nextAction.moreWork.inputs)}
                >
                  <CheckCircle2 className="h-6 w-6" />
                  {nextAction.moreWork.label}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {nextAction.kind === "RESOLVE_PARTIAL" ? (
          <PartialBag
            action={nextAction}
            pending={pending}
            quantity={partialQty}
            onQuantityChange={setPartialQty}
            leadCode={leadCode}
            onLeadCodeChange={setLeadCode}
            onUseEstimate={(estimate) =>
              void advance("RESOLVE_PARTIAL", {
                partialRemainingEstimate: String(estimate),
                overrideEmployeeCode: leadCode.trim(),
              })
            }
            onContinue={(qty) =>
              void advance("RESOLVE_PARTIAL", {
                physicalQty: qty,
                overrideEmployeeCode: leadCode.trim(),
              })
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
          qcPanel={qcPanel}
          activeSession={activeSession}
          employeeOptions={employeeOptions}
          currentWorkflowBagId={currentBagId}
          currentBagIsPaused={
            view.nextAction.kind === "BLOCKED" &&
            view.nextAction.blockers.some((b) => b.code === "BAG_PAUSED")
          }
          onClose={() => setSheet("none")}
          onPause={() => setSheet("pause")}
          onEnterCode={() => setSheet("code")}
          onCloseSealingEarly={() => setSheet("sealingPartial")}
          onOpenSupervisor={() => setSheet("supervisor")}
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

      {sheet === "sealingPartial" ? (
        <CloseSealingEarlySheet
          pending={pending}
          error={error}
          onClose={() => setSheet("none")}
          onSubmit={async (reason, note) => {
            const ok = await advance("CONFIRM_BAG_EMPTY", {
              sealingCloseMode: "partial",
              partialCloseReason: reason,
              ...(note.trim() ? { partialCloseReasonNote: note.trim() } : {}),
            });
            // Stay open on a refusal, like TypedCodeSheet does. The
            // sheet is where the reason and note the operator picked
            // still are, and validateSealingPartialCloseInput refuses
            // for reasons they can act on ("record at least one sealing
            // segment", "add a short note"). Closing it would drop the
            // selection and show the error over a screen with no way to
            // retry.
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

      {sheet === "supervisor" && !view.supervisor ? (
        <SupervisorSheet
          token={token}
          stationId={stationId}
          onClose={() => setSheet("none")}
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

/** The engine's CompletionInput[] as numeric fields. Rendered by the
 *  COMPLETE case and again inside CONFIRM_BAG_EMPTY's "more to work"
 *  branch, which records another segment on the same bag — one field
 *  renderer so the two can never ask for different things. */
function CompletionFields({
  inputs,
  values,
  pending,
  onChange,
}: {
  inputs: readonly CompletionInput[];
  values: Record<string, string>;
  pending: boolean;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  return (
    <>
      {inputs.map((input) => (
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
              onChange((prev) => ({
                ...prev,
                [input.key]: e.target.value.replace(/\D/g, ""),
              }))
            }
            className={NUMERIC_INPUT}
            placeholder="0"
          />
        </label>
      ))}
    </>
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
  qcPanel,
  activeSession,
  employeeOptions,
  currentWorkflowBagId,
  currentBagIsPaused,
  onClose,
  onPause,
  onResume,
  onEnterCode,
  onCloseSealingEarly,
  onOpenSupervisor,
}: {
  view: StationView;
  token: string;
  pending: boolean;
  error: string | null;
  reportProblem: React.ReactNode;
  qcPanel?: React.ReactNode;
  activeSession: ActiveSession | null;
  employeeOptions: EmployeeOption[];
  currentWorkflowBagId: string | null;
  currentBagIsPaused: boolean;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnterCode: () => void;
  onCloseSealingEarly: () => void;
  onOpenSupervisor: () => void;
}) {
  const isPaused =
    view.nextAction.kind === "BLOCKED" &&
    view.nextAction.blockers.some((b) => b.code === "BAG_PAUSED");
  const materialLinks = operatorMaterialLinks(token, view.station.kind);
  // BOTTLE-SEALING-RECOVERY-1 kept reachable after the cutover. The
  // condition the legacy page computed inline (bottle product, stage
  // BLISTERED, at packaging) is not on StationView, so the offer is
  // widened to "a bag is here and this station cannot move it forward
  // yet" — which is exactly the dead end the recovery exists for. The
  // action itself re-checks product kind, stage, finalization and the
  // lead badge server-side and refuses everything else by name, so a
  // wider offer cannot become a wider effect.
  const offerBottleRecovery =
    currentWorkflowBagId != null && view.nextAction.kind === "START";
  // SEALING-PARTIAL-CLOSEOUT-1. Spec conformance note: the operator
  // screen splits Normal from Exception, and closing a bag that is NOT
  // empty is an exception — so it lives under More, deliberately, and
  // never as a second button beside "Yes, bag empty" on the main screen.
  //
  // The gate is exactly the precondition
  // validateSealingPartialCloseInput enforces server-side:
  // CONFIRM_BAG_EMPTY is emitted only when the bag has sealing segments
  // and no partial close-out yet (needsSealingLaneClose), and the
  // partial path itself is refused off a pure SEALING station
  // (recordStageEvent's isPureSealingStation). Offering it anywhere
  // else would be offering a refusal.
  const offerCloseSealingEarly =
    view.station.kind === "SEALING" &&
    view.nextAction.kind === "CONFIRM_BAG_EMPTY";

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

      {view.supervisor ? (
        // Session is open: the banner above the screen shows name +
        // countdown + Exit. The entry here acknowledges the state and
        // closes More so the banner is visible.
        <button
          type="button"
          className={SHEET_ITEM}
          onClick={onClose}
        >
          <span className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-amber-600" />
            <span>
              Supervisor active
              <span className="block text-xs text-text-muted">
                {view.supervisor.employeeName}
              </span>
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          className={SHEET_ITEM}
          onClick={onOpenSupervisor}
        >
          <span className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-text-muted" />
            Supervisor
          </span>
          <ChevronRight className="h-5 w-5 text-text-muted" />
        </button>
      )}

      {offerCloseSealingEarly ? (
        <button
          type="button"
          className={SHEET_ITEM}
          disabled={pending}
          onClick={onCloseSealingEarly}
        >
          <span className="flex items-center gap-3">
            <SkipForward className="h-5 w-5 text-text-muted" />
            Close sealing early
          </span>
          <ChevronRight className="h-5 w-5 text-text-muted" />
        </button>
      ) : null}

      {offerBottleRecovery && currentWorkflowBagId ? (
        <BottleSealingRecoveryPanel
          token={token}
          stationId={view.station.id}
          workflowBagId={currentWorkflowBagId}
        />
      ) : null}

      {qcPanel}

      {/* P5-SUPERVISOR Task 4 — supervisor-only tools inside More.
          Rendered ONLY when a session is open (cosmetic); the real
          gates are server-side in claimScannedBagAction and the QC /
          roll / bag-allocation / variety action families. Manual bag
          pick reuses claimScannedBagAction via the sanctioned P4b
          path (resolveFreshBagStart / startFreshBag) — no bespoke
          claim logic here. Corrections is a plain deep-link to the
          admin correction wizard: the floor does not build voiding. */}
      {view.supervisor ? (
        <ManualBagPickPanel
          token={token}
          stationId={view.station.id}
          upNext={view.upNext}
          pending={pending}
        />
      ) : null}

      {view.supervisor ? (
        <a
          href="/workflow-submissions"
          className={SHEET_ITEM}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-text-muted" />
            Corrections
          </span>
          <ChevronRight className="h-5 w-5 text-text-muted" />
        </a>
      ) : null}

      {/* End shift is the PANEL, not a bare button. BLISTER-PAUSE-COUNT-
          SNAPSHOT-1 refuses to close a shift on a counting station whose
          bag is still running until the operator records the machine
          counter, and that guard lives inside ActiveSessionView. A
          plain endOperatorSessionAction button here would let an
          operator walk away from a running blister machine with no
          reading — the exact hole the guard exists to close. */}
      {activeSession ? (
        <div className="rounded-xl border border-border bg-surface p-3">
          <OperatorSessionPanel
            token={token}
            stationId={view.station.id}
            stationKind={view.station.kind}
            activeSession={activeSession}
            employeeOptions={employeeOptions}
            currentWorkflowBagId={currentWorkflowBagId}
            currentBagIsPaused={currentBagIsPaused}
          />
        </div>
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

/** SEALING-PARTIAL-CLOSEOUT-1 — "Close sealing early".
 *
 *  The bag is not empty, but this lane is done with it: end of shift, a
 *  handoff, a material problem. The engine records the segments sealed
 *  so far as the bag's sealed count and lets packaging pick it up at
 *  BLISTERED (allowsPackagingCompleteAtBlistered), instead of stranding
 *  it waiting for a lane close that is not coming.
 *
 *  SPEC CONFORMANCE: this is the EXCEPTION half of the spec's
 *  Normal/Exception split, so it lives under More rather than beside
 *  "Yes, bag empty" on the main screen — the normal answer to "is this
 *  bag empty?" must stay two buttons, not three.
 *
 *  The reason list is the engine's own SEALING_PARTIAL_CLOSE_REASONS,
 *  never a local copy: validateSealingPartialCloseInput refuses anything
 *  outside it, and OTHER additionally demands a note of at least three
 *  characters. Both rules are enforced server-side; the note field is
 *  required here only when the reason is OTHER so the operator is not
 *  bounced by a refusal they could have been told about first. */
function CloseSealingEarlySheet({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (reason: SealingPartialCloseReason, note: string) => void;
}) {
  const [reason, setReason] = React.useState<SealingPartialCloseReason | null>(
    null,
  );
  const [note, setNote] = React.useState("");
  const needsNote = reason === "OTHER";

  return (
    <Sheet title="Close sealing early" error={error} onClose={onClose}>
      <p className="text-sm text-text-muted">
        The bag still has cards in it, but this machine is done with it.
        Packaging can take what has been sealed so far.
      </p>
      <div className="space-y-2">
        {SEALING_PARTIAL_CLOSE_REASONS.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setReason(code)}
            className={`${SHEET_ITEM} ${
              reason === code ? "border-brand-700 ring-2 ring-brand-700/30" : ""
            }`}
          >
            <span>{SEALING_PARTIAL_CLOSE_REASON_LABELS[code]}</span>
            {reason === code ? (
              <CheckCircle2 className="h-5 w-5 text-brand-700" />
            ) : null}
          </button>
        ))}
      </div>
      {needsNote ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text-muted">
            What happened?
          </span>
          <textarea
            value={note}
            disabled={pending}
            maxLength={500}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base text-text"
            placeholder="Short note — a supervisor sees this."
          />
        </label>
      ) : null}
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={
          pending || reason == null || (needsNote && note.trim().length < 3)
        }
        onClick={() => {
          if (!reason) return;
          onSubmit(reason, note);
        }}
      >
        <SkipForward className="h-6 w-6" />
        Close sealing early
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
  const notifyDisabled = helpNotifyDisabled(view);

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
        disabled={pending || notifyDisabled}
        onClick={() => onNotify(detail)}
      >
        Notify supervisor
      </button>
      {notifyDisabled ? (
        // Fix round 2 (MED 2): the button used to be enabled on the idle
        // SCAN_TO_CLAIM screen, and clicking it there fired
        // raiseProductionExceptionAction with no workflowBagId — which
        // the action refuses as PRODUCTION_EXCEPTION_NO_BAG. Same shape
        // as Report Problem's category grid: helper text explains the
        // gate in the same sheet, on the same touchscreen.
        <p className="text-center text-sm text-text-muted">
          {helpNotifyRequiresBagCopy}
        </p>
      ) : null}
    </Sheet>
  );
}

/** The lead badge both partial screens collect.
 *
 *  Closing a raw-bag allocation ledger has asked for a badge since
 *  SPLIT-BAG-1 (resolveScannedBagAllocationAction resolves the code
 *  through resolveStationAccountability with SUPERVISOR_OVERRIDE), and
 *  resolvePartialAllocation reproduces that exactly.
 *
 *  BE HONEST ABOUT WHAT IT IS: not a refusal. An unrecognized code falls
 *  back to the station's open operator session, so with a shift running
 *  the write proceeds and is attributed to that operator — same as the
 *  legacy floor panel. It records WHO is answering for the number; it
 *  does not stop anyone. A real gate is a supervisor session, which is
 *  P5's station_supervisor_sessions. */
function LeadCodeField({
  value,
  pending,
  onChange,
}: {
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text-muted">Lead badge code</span>
      <input
        type="text"
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        className="h-14 w-full rounded-xl border border-border bg-surface px-4 text-xl text-text"
        placeholder="Badge code"
      />
    </label>
  );
}

/** P1-PARTIAL at scan time — the spec's partial screens for a bag that
 *  is being STARTED from an earlier run's leftovers, rather than for a
 *  bag already at the station (that is PartialBag below, the
 *  RESOLVE_PARTIAL case).
 *
 *  Same two shapes, same rule: HIGH/MEDIUM shows the conclusion and one
 *  button; LOW requires a supervisor badge, which is the rule
 *  lib/production/partial-bag-lifecycle.test.ts pins and scanCardAction
 *  enforces. The estimate is shown as an estimate — it is the previous
 *  run's closing balance, never a physical count (luma-data-honesty). */
function PartialReuseStart({
  reuse,
  pending,
  leadCode,
  onLeadCodeChange,
  onConfirm,
  onInvalid,
}: {
  reuse: {
    estimate: number | null;
    confidence: string | null;
    previousProductName: string | null;
  };
  pending: boolean;
  leadCode: string;
  onLeadCodeChange: (value: string) => void;
  onConfirm: (supervisorCode: string | null) => void;
  onInvalid: (message: string) => void;
}) {
  const needsSupervisor = reuse.confidence === "LOW" || reuse.estimate == null;
  return (
    <section className="space-y-4">
      <div
        className={
          needsSupervisor
            ? "rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4"
            : "rounded-2xl border border-border bg-surface px-4 py-4 text-center"
        }
      >
        <p
          className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${
            needsSupervisor ? "text-amber-900" : "text-text-muted"
          }`}
        >
          {needsSupervisor ? "Check bag" : "Partial bag detected"}
        </p>
        {reuse.estimate != null ? (
          <p className="mt-1 text-2xl font-bold tabular-nums">
            Estimated remaining: {reuse.estimate.toLocaleString()} units
          </p>
        ) : (
          <p className="mt-1 text-base text-amber-950">
            System cannot confidently determine remaining quantity.
          </p>
        )}
      </div>
      {needsSupervisor ? (
        <LeadCodeField
          value={leadCode}
          pending={pending}
          onChange={onLeadCodeChange}
        />
      ) : null}
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={pending}
        onClick={() => {
          if (needsSupervisor && leadCode.trim() === "") {
            onInvalid("A supervisor badge code is needed to use this bag.");
            return;
          }
          onConfirm(needsSupervisor ? leadCode.trim() : null);
        }}
      >
        Use bag
      </button>
    </section>
  );
}

function PartialBag({
  action,
  pending,
  quantity,
  onQuantityChange,
  leadCode,
  onLeadCodeChange,
  onUseEstimate,
  onContinue,
  onInvalid,
}: {
  action: Extract<StationView["nextAction"], { kind: "RESOLVE_PARTIAL" }>;
  pending: boolean;
  quantity: string;
  onQuantityChange: (value: string) => void;
  leadCode: string;
  onLeadCodeChange: (value: string) => void;
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
        <LeadCodeField
          value={leadCode}
          pending={pending}
          onChange={onLeadCodeChange}
        />
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={pending}
          onClick={() => {
            if (leadCode.trim() === "") {
              onInvalid("Enter the lead badge code to use this bag.");
              return;
            }
            onUseEstimate(screen.estimate);
          }}
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
      <LeadCodeField
        value={leadCode}
        pending={pending}
        onChange={onLeadCodeChange}
      />
      <button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={pending}
        onClick={() => {
          if (quantity.trim() === "") {
            onInvalid("Enter the physical quantity before continuing.");
            return;
          }
          if (leadCode.trim() === "") {
            onInvalid("Enter the lead badge code to save this count.");
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

// ── ManualBagPickPanel (P5-SUPERVISOR Task 4) ────────────────────────
//
// The "old dropdown reborn". Renders the queue of bags that can start
// or resume at THIS station (view.upNext, which loadStationViewRows
// already scopes to eligibleStationKinds and drops rows held by a
// non-eligible station). Each row submits claimScannedBagAction with
// workflowBagId — the SANCTIONED P4b path (resolveFreshBagStart /
// startFreshBag inside operator-actions.ts). NO bespoke claim logic
// here; if the P4b path refuses (bag not ready, held elsewhere, on
// hold), the operator sees the same blocker sentence they would from
// a scan.
//
// Server-side, claimScannedBagAction is NOT gated (an operator picks
// up bags on the sanctioned scan path with no supervisor unlock); the
// gating in Task 4 is only for QC / rolls / bag-allocation / variety /
// hold-release. Rendering this section from view.supervisor is
// cosmetic: it puts the affordance behind supervisor unlock in the
// tablet UI because the intent of the tool is manual override, but a
// hand-crafted request against claimScannedBagAction is not refused
// (that would refuse a normal scan too).
function ManualBagPickPanel({
  token,
  stationId,
  upNext,
  pending: outerPending,
}: {
  token: string;
  stationId: string;
  upNext: StationView["upNext"];
  pending: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleClaim = React.useCallback(
    async (workflowBagId: string) => {
      if (pending || outerPending) return;
      setPending(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("stationId", stationId);
        fd.set("workflowBagId", workflowBagId);
        fd.set("clientEventId", newClientEventId());
        const r = await claimScannedBagAction(fd);
        if (r && "error" in r && r.error) {
          setError(r.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not pick up this bag.");
      } finally {
        setPending(false);
      }
    },
    [pending, outerPending, token, stationId],
  );

  if (upNext.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
          Manual bag pick
        </p>
        <p className="text-sm text-text-muted">
          No bags waiting for this station.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-3 space-y-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
          Manual bag pick
        </p>
        <p className="text-xs text-text-muted">
          Supervisor override — claim uses the same scan path.
        </p>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
        >
          {error}
        </p>
      ) : null}
      <ul className="space-y-1">
        {upNext.slice(0, 8).map((bag) => (
          <li key={bag.workflowBagId}>
            <button
              type="button"
              disabled={pending || outerPending}
              onClick={() => void handleClaim(bag.workflowBagId)}
              className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-60"
            >
              <span className="truncate">
                <span className="font-medium">{bag.bagLabel}</span>
                {bag.productName ? (
                  <span className="text-text-muted"> · {bag.productName}</span>
                ) : null}
              </span>
              <span className="ml-2 whitespace-nowrap text-xs text-text-muted">
                {bag.readyState === "READY"
                  ? "ready"
                  : bag.etaMinutes != null
                    ? `~${bag.etaMinutes}m`
                    : "upstream"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
