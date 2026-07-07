"use client";

// ADMIN-CORRECTION-WIZARD-1 — guided admin correction / recovery wizard.
// Four explicit correction types with per-type copy, a real wrong-product
// remap flow (candidate selector → downstream-impact preview → audited
// apply), and quarantine-based flows for wrong route / wrong QR. Every
// apply requires a detailed reason and an explicit confirmation checkbox.

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, RouteOff, Wrench } from "lucide-react";
import {
  applyWrongProductCorrectionAction,
  loadWrongProductCorrectionOptionsAction,
  previewWrongProductCorrectionAction,
  workflowRecoveryAction,
  type WrongProductCorrectionOptions,
  type WrongProductCorrectionPreviewResult,
} from "./actions";

type CorrectionType =
  | "WRONG_PRODUCT_CORRECTION"
  | "WRONG_ROUTE_CORRECTION"
  | "WRONG_QR_OR_RECEIPT_CORRECTION"
  | "QUARANTINE_ONLY";

const CORRECTION_TYPE_COPY: Record<
  CorrectionType,
  { title: string; changes: string; keeps: string; downstream: string }
> = {
  WRONG_PRODUCT_CORRECTION: {
    title: "Wrong product selected",
    changes:
      "Remaps this run's output to the correct product (same route only) and recalculates units, tablet consumption, and allocation.",
    keeps:
      "Keeps all station history and counts. Does not touch committed Zoho output or the QR card.",
    downstream:
      "An existing finished lot is rebuilt under the corrected product and placed ON_HOLD for re-review. Uncommitted Zoho ops are voided and must be re-queued. Output continues automatically after re-release.",
  },
  WRONG_ROUTE_CORRECTION: {
    title: "Wrong route / wrong production type",
    changes:
      "Marks this run's output as invalid for normal output (quarantine) and records which product SHOULD have been run.",
    keeps:
      "Keeps all station history. Card output is never converted into bottle output (or vice versa) — no route conversion exists.",
    downstream:
      "Finished lot (if any) goes ON_HOLD; uncommitted Zoho ops are voided; the QR may be released when safe. You then start the correct workflow separately — nothing is auto-created.",
  },
  WRONG_QR_OR_RECEIPT_CORRECTION: {
    title: "Wrong QR / card / receipt assigned",
    changes:
      "Quarantines this run so the wrong linkage cannot reach finished lots or Zoho. Relinking to another bag/receipt is a manual review step for now.",
    keeps:
      "Keeps all station history and both bags' data. Does not modify the other bag or receipt.",
    downstream:
      "Finished lot (if any) goes ON_HOLD; uncommitted Zoho ops are voided; QR released when safe. Re-run the workflow with the correct QR/receipt.",
  },
  QUARANTINE_ONLY: {
    title: "Quarantine only — flag for review",
    changes:
      "Marks this run for review and excludes it from normal output. No product or route change is recorded.",
    keeps: "Keeps everything else untouched.",
    downstream:
      "Finished lot (if any) goes ON_HOLD; uncommitted Zoho ops are voided; QR released when safe.",
  },
};

export function WorkflowRecoveryForm({
  workflowBagId,
  bagFinalized,
  hasFinishedLot,
  heldPartialBottle = false,
}: {
  workflowBagId: string;
  bagFinalized: boolean;
  hasFinishedLot: boolean;
  heldPartialBottle?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [correctionType, setCorrectionType] =
    React.useState<CorrectionType>("WRONG_PRODUCT_CORRECTION");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-800 hover:bg-red-100"
      >
        <Wrench className="h-3 w-3" />
        Admin correction / recovery
      </button>
    );
  }

  const copy = CORRECTION_TYPE_COPY[correctionType];

  return (
    <div className="mt-3 space-y-2 rounded border border-red-200 bg-red-50/40 p-3">
      <p className="text-[11px] font-semibold text-red-900">
        Admin correction / recovery
      </p>
      {heldPartialBottle ? (
        <div className="rounded border border-red-400 bg-red-100 px-2 py-1.5 text-[10px] leading-snug text-red-950">
          <p className="flex items-center gap-1 font-bold uppercase tracking-wide">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            QR held for a partial bottle bag
          </p>
          <p className="mt-0.5">
            This QR is currently kept with a <strong>partial bottle bag</strong>{" "}
            (it still has product and is held for the next run). Recovering this
            bag will remove the QR from that physical bag. Only continue if the
            bag is actually being <strong>abandoned, relabeled, or corrected</strong>.
          </p>
        </div>
      ) : null}
      <label className="block text-[10px]">
        <span className="font-medium">What went wrong?</span>
        <select
          value={correctionType}
          onChange={(e) => setCorrectionType(e.target.value as CorrectionType)}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        >
          <option value="WRONG_PRODUCT_CORRECTION">
            Wrong product selected (route/process was correct)
          </option>
          <option value="WRONG_ROUTE_CORRECTION">
            Wrong route / wrong production type (e.g. cards instead of bottles)
          </option>
          <option value="WRONG_QR_OR_RECEIPT_CORRECTION">
            Wrong QR / card / receipt assigned
          </option>
          <option value="QUARANTINE_ONLY">Quarantine only — flag for review</option>
        </select>
      </label>
      <div className="rounded border border-border bg-white px-2 py-1.5 text-[10px] leading-snug text-text-muted space-y-0.5">
        <p>
          <span className="font-semibold text-text-strong">Changes:</span> {copy.changes}
        </p>
        <p>
          <span className="font-semibold text-text-strong">Preserves:</span> {copy.keeps}
        </p>
        <p>
          <span className="font-semibold text-text-strong">Downstream:</span> {copy.downstream}
        </p>
      </div>

      {correctionType === "WRONG_PRODUCT_CORRECTION" ? (
        <WrongProductCorrectionFlow workflowBagId={workflowBagId} />
      ) : (
        <QuarantineRecoveryFlow
          workflowBagId={workflowBagId}
          correctionType={correctionType}
          bagFinalized={bagFinalized}
          hasFinishedLot={hasFinishedLot}
        />
      )}

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded border border-border bg-surface px-3 py-1.5 text-[10px] text-text-muted"
      >
        Close
      </button>
    </div>
  );
}

// ── Wrong product correction (preview → apply) ────────────────────────────

function WrongProductCorrectionFlow({ workflowBagId }: { workflowBagId: string }) {
  const [options, setOptions] =
    React.useState<WrongProductCorrectionOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = React.useState(false);
  const [selectedProductId, setSelectedProductId] = React.useState("");
  const [preview, setPreview] =
    React.useState<WrongProductCorrectionPreviewResult | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  const [state, formAction, pending] = useActionState(
    applyWrongProductCorrectionAction,
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    setLoadingOptions(true);
    loadWrongProductCorrectionOptionsAction(workflowBagId)
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowBagId]);

  React.useEffect(() => {
    // Any change to the selected product invalidates the previous preview.
    setPreview(null);
    setConfirmed(false);
  }, [selectedProductId]);

  if (state?.ok) {
    return (
      <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
        Product corrected. Station history is preserved; metrics, allocation and
        output were recalculated under the corrected product. Review the held
        finished lot (if any) and re-queue Zoho output when ready.
      </p>
    );
  }

  if (loadingOptions) {
    return <p className="text-[10px] text-text-muted">Loading correction options…</p>;
  }
  if (!options || options.error) {
    return (
      <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] text-red-900">
        {options?.error ?? "Failed to load correction options."}
      </p>
    );
  }

  const selected = options.candidates.find((c) => c.id === selectedProductId);

  const runPreview = async () => {
    if (!selectedProductId) return;
    setPreviewing(true);
    try {
      setPreview(
        await previewWrongProductCorrectionAction(workflowBagId, selectedProductId),
      );
    } finally {
      setPreviewing(false);
    }
  };

  const allowed = Boolean(preview?.verdict?.allowed);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="workflowBagId" value={workflowBagId} />
      <input type="hidden" name="newProductId" value={selectedProductId} />
      <input type="hidden" name="confirm" value={confirmed ? "true" : ""} />

      <div className="rounded border border-border bg-white px-2 py-1.5 text-[10px]">
        <p>
          <span className="text-text-muted">Current product:</span>{" "}
          <span className="font-medium text-text-strong">
            {options.currentProduct
              ? `${options.currentProduct.name} (${options.currentProduct.kind})`
              : "Unknown"}
          </span>
        </p>
      </div>

      <label className="block text-[10px]">
        <span className="font-medium">
          Correct product <span className="text-red-700">(required)</span>
        </span>
        <select
          required
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        >
          <option value="">Select the product staff should have used…</option>
          {options.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.sku} ({c.kind})
            </option>
          ))}
        </select>
        <span className="mt-0.5 block text-[9.5px] text-text-muted">
          Only active products on the same route that allow this bag&apos;s tablet
          type are listed. If the right product is not here, the run was on the
          wrong route — use the wrong-route correction instead.
        </span>
      </label>

      {options.candidates.length === 0 ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
          No same-route candidate products exist for this bag&apos;s tablet type.
          Direct product correction is not possible — use the wrong-route
          correction (quarantine + start correct workflow).
        </p>
      ) : null}

      {selected && options.currentProduct ? (
        <div className="flex items-center gap-1.5 rounded border border-border bg-white px-2 py-1.5 text-[10px]">
          <span className="font-medium">{options.currentProduct.name}</span>
          <span className="rounded border border-border bg-surface-2 px-1 text-[9px] uppercase">
            {options.currentProduct.kind}
          </span>
          <ArrowRight className="h-3 w-3 text-text-muted" aria-hidden />
          <span className="font-medium">{selected.name}</span>
          <span className="rounded border border-border bg-surface-2 px-1 text-[9px] uppercase">
            {selected.kind}
          </span>
          <span className="ml-auto rounded border border-emerald-200 bg-emerald-50 px-1 text-[9px] font-medium text-emerald-800">
            Same route
          </span>
        </div>
      ) : null}

      <button
        type="button"
        disabled={!selectedProductId || previewing}
        onClick={() => void runPreview()}
        className="rounded border border-brand-600 bg-white px-3 py-1.5 text-[10px] font-semibold text-brand-700 disabled:opacity-50"
      >
        {previewing ? "Previewing…" : "Preview downstream impact"}
      </button>

      {preview?.error ? (
        <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] text-red-900">
          {preview.error}
        </p>
      ) : null}

      {preview?.verdict && preview.preview ? (
        <CorrectionPreviewPanel
          verdict={preview.verdict}
          preview={preview.preview}
        />
      ) : null}

      {preview?.verdict && allowed ? (
        <>
          <label className="block text-[10px]">
            <span className="font-medium">Detailed reason</span>
            <textarea
              name="reason"
              required
              minLength={10}
              maxLength={500}
              rows={3}
              className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
              placeholder="Example: Staff selected Choco Drift but this bag ran FIX Beyond - Cocoa Calm cards."
            />
          </label>
          <label className="block text-[10px]">
            <span className="font-medium">Notes (optional)</span>
            <input
              name="notes"
              maxLength={2000}
              className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
            />
          </label>
          <label className="flex items-start gap-2 text-[10px] text-red-950">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I confirm this correction is intentional. Luma will append events
              and recalculate derived output — it will not delete station history.
            </span>
          </label>
          {state?.error ? (
            <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] text-red-900">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending || !confirmed}
            className="rounded bg-red-800 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Applying…" : "Apply product correction"}
          </button>
        </>
      ) : null}
    </form>
  );
}

function CorrectionPreviewPanel({
  verdict,
  preview,
}: {
  verdict: NonNullable<WrongProductCorrectionPreviewResult["verdict"]>;
  preview: NonNullable<WrongProductCorrectionPreviewResult["preview"]>;
}) {
  const fmt = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString();
  return (
    <div className="space-y-1.5">
      {verdict.blockers.length > 0 ? (
        <div className="rounded border border-red-300 bg-red-100 px-2 py-1.5 text-[10px] text-red-950 space-y-1">
          <p className="font-bold uppercase tracking-wide">Correction blocked</p>
          {verdict.blockers.map((b) => (
            <p key={b.code}>
              <span className="font-semibold">{b.message}</span> {b.recommendation}
            </p>
          ))}
        </div>
      ) : null}
      {verdict.warnings.length > 0 ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-950 space-y-0.5">
          {verdict.warnings.map((w) => (
            <p key={w.code}>{w.message}</p>
          ))}
        </div>
      ) : null}
      <div className="rounded border border-border bg-white px-2 py-1.5 text-[10px]">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[9px] uppercase tracking-wide text-text-subtle">
              <th className="py-0.5 pr-2 font-medium">Impact</th>
              <th className="py-0.5 pr-2 font-medium">Current</th>
              <th className="py-0.5 font-medium">After correction</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            <tr>
              <td className="py-0.5 pr-2 font-sans text-text-muted">Product</td>
              <td className="py-0.5 pr-2">{preview.oldProductName ?? "—"}</td>
              <td className="py-0.5">{preview.newProductName ?? "—"}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-2 font-sans text-text-muted">Route</td>
              <td className="py-0.5 pr-2">{preview.oldRoute ?? "—"}</td>
              <td className="py-0.5">{preview.newRoute ?? "—"}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-2 font-sans text-text-muted">
                Units (from submitted counts)
              </td>
              <td className="py-0.5 pr-2">{fmt(preview.oldUnits)}</td>
              <td className="py-0.5">{fmt(preview.newUnits)}</td>
            </tr>
            <tr>
              <td className="py-0.5 pr-2 font-sans text-text-muted">
                Expected tablet consumption
              </td>
              <td className="py-0.5 pr-2">{fmt(preview.oldExpectedConsumption)}</td>
              <td className="py-0.5">{fmt(preview.newExpectedConsumption)}</td>
            </tr>
            {preview.allocationImpact ? (
              <tr>
                <td className="py-0.5 pr-2 font-sans text-text-muted">
                  Bag balance ({fmt(preview.allocationImpact.startingBalanceQty)} start)
                </td>
                <td className="py-0.5 pr-2">{fmt(preview.allocationImpact.oldEnding)}</td>
                <td className="py-0.5">{fmt(preview.allocationImpact.newEnding)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {preview.counts ? (
          <p className="mt-1 text-[9.5px] text-text-muted">
            Submitted counts stay as-is: {preview.counts.masterCases} cases ·{" "}
            {preview.counts.displaysMade} displays · {preview.counts.looseCards} loose.
          </p>
        ) : (
          <p className="mt-1 text-[9.5px] text-text-muted">
            No packaging counts submitted yet — only the product mapping changes.
          </p>
        )}
        <div className="mt-1 space-y-0.5 text-[9.5px] text-text-muted">
          <p>
            <span className="font-semibold text-text-strong">Finished lot:</span>{" "}
            {preview.finishedLotImpact === "NONE"
              ? "No lot exists yet — a future auto-issue uses the corrected product."
              : preview.finishedLotImpact === "UPDATE_AND_HOLD"
                ? "Existing lot is rebuilt under the corrected product and placed ON_HOLD for re-review."
                : "Blocked — committed/shipped output cannot be corrected here."}
          </p>
          <p>
            <span className="font-semibold text-text-strong">Zoho:</span>{" "}
            {preview.zohoImpact === "NONE"
              ? "No Zoho op exists — nothing to void."
              : preview.zohoImpact === "VOID_UNCOMMITTED_REBUILD"
                ? "Uncommitted Zoho op is voided — re-preview and queue after correction. Nothing is committed automatically."
                : "Blocked — Zoho output already committed."}
          </p>
          <p>
            <span className="font-semibold text-text-strong">PO Closeout:</span>{" "}
            {preview.poCloseoutImpact}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Quarantine-based flows (wrong route / wrong QR / quarantine only) ─────

function QuarantineRecoveryFlow({
  workflowBagId,
  correctionType,
  bagFinalized,
  hasFinishedLot,
}: {
  workflowBagId: string;
  correctionType: Exclude<CorrectionType, "WRONG_PRODUCT_CORRECTION">;
  bagFinalized: boolean;
  hasFinishedLot: boolean;
}) {
  const [state, formAction, pending] = useActionState(workflowRecoveryAction, null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [options, setOptions] =
    React.useState<WrongProductCorrectionOptions | null>(null);

  const isWrongRoute = correctionType === "WRONG_ROUTE_CORRECTION";
  const recoveryKind =
    correctionType === "WRONG_QR_OR_RECEIPT_CORRECTION"
      ? "WRONG_QR_ASSIGNMENT"
      : "WRONG_ROUTE";
  const correctionMode = isWrongRoute ? "QUARANTINE_AND_RESTART" : "QUARANTINE_ONLY";

  React.useEffect(() => {
    if (!isWrongRoute) return;
    let cancelled = false;
    loadWrongProductCorrectionOptionsAction(workflowBagId).then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowBagId, isWrongRoute]);

  if (state?.ok) {
    return (
      <div className="space-y-1.5">
        <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
          Recovery recorded. History is preserved and this run is excluded from
          normal output.
        </p>
        {isWrongRoute ? (
          <Link
            href="/production/start"
            className="inline-flex items-center gap-1 rounded border border-brand-600 bg-white px-2 py-1 text-[10px] font-semibold text-brand-700 hover:bg-brand-50"
          >
            <RouteOff className="h-3 w-3" aria-hidden />
            Start the correct workflow
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="workflowBagId" value={workflowBagId} />
      <input type="hidden" name="recoveryKind" value={recoveryKind} />
      <input type="hidden" name="correctionMode" value={correctionMode} />
      <input type="hidden" name="confirm" value={confirmed ? "true" : ""} />

      <p className="text-[10px] text-red-900/90 leading-snug">
        This does not erase history. It appends recovery events and may release
        the QR card so the correct workflow can be started.
        {bagFinalized || hasFinishedLot
          ? " This bag is finalized or has a finished lot — simple reset is blocked; output will be voided from sync and marked for review."
          : null}
      </p>

      {isWrongRoute ? (
        <>
          <p className="rounded border border-border bg-white px-2 py-1.5 text-[10px] leading-snug text-text-muted">
            This will mark the wrong workflow output as invalid for normal
            output. It will preserve history and allow the correct workflow to
            be started. Direct conversion between routes (e.g. treating card
            output as bottle output) is not allowed.
          </p>
          <label className="block text-[10px]">
            <span className="font-medium">Intended product (recommended)</span>
            <select
              name="intendedProductId"
              defaultValue=""
              className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
            >
              <option value="">Not sure / record later</option>
              {(options?.allActiveProducts ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.sku} ({p.kind})
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[9.5px] text-text-muted">
              Recorded as intent only — the correct workflow still has to be
              started and run on the floor.
            </span>
          </label>
        </>
      ) : null}

      {correctionType === "WRONG_QR_OR_RECEIPT_CORRECTION" ? (
        <p className="rounded border border-border bg-white px-2 py-1.5 text-[10px] leading-snug text-text-muted">
          Relinking this run to a different bag/receipt/QR is not automated —
          this quarantines the wrong linkage so it cannot reach finished lots or
          Zoho, and the run must be redone with the correct QR/receipt.
        </p>
      ) : null}

      <label className="block text-[10px]">
        <span className="font-medium">Detailed reason</span>
        <textarea
          name="reason"
          required
          minLength={10}
          rows={3}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
          placeholder="Example: Bag was run on cards but should have been bottles for SKU X."
        />
      </label>
      <label className="block text-[10px]">
        <span className="font-medium">Notes (optional)</span>
        <input
          name="notes"
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        />
      </label>
      <label className="flex items-start gap-2 text-[10px] text-red-950">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I confirm this recovery is intentional. Luma will append events only —
          not delete station history.
        </span>
      </label>
      {state?.error ? (
        <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] text-red-900">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || !confirmed}
        className="rounded bg-red-800 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Recording…" : "Record recovery"}
      </button>
    </form>
  );
}
