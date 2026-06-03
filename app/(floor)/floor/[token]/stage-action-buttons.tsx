"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Flag,
  PauseCircle,
  PlayCircle,
  UserCheck,
  PackageCheck,
} from "lucide-react";
import {
  fireStageEventAction,
  saveSealingProductAction,
  finalizeBagAction,
  releaseBagAction,
  releaseSealingHandoffAction,
  pauseBagAction,
  resumeBagAction,
  setOperatorAction,
  packagingCompleteAction,
} from "./actions";
import { changeRollAction } from "./roll-actions";
import {
  STATION_RELEASE_FROM_STAGE,
  STATIONS_THAT_FINALIZE,
} from "@/lib/production/stage-progression";
import {
  SEALING_PARTIAL_CLOSE_REASONS,
  SEALING_PARTIAL_CLOSE_REASON_LABELS,
  type SealingPartialCloseReason,
} from "@/lib/production/sealing-partial-closeout";

// crypto.randomUUID() is only available in secure contexts (HTTPS or
// localhost). Floor PWA runs over plain HTTP on the LAN, so we fall
// back to crypto.getRandomValues() which is universally available.
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
  // RFC 4122 v4 from 16 random bytes.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

/** Numeric badge only — rejects UUID-shaped stale sessionStorage values. */
function operatorBadgeCodeForSubmit(code: string): string | null {
  const trimmed = code.trim();
  return /^\d{1,4}$/.test(trimmed) ? trimmed : null;
}

const STAGE_BY_KIND: Record<string, { label: string; eventType: string }[]> = {
  BLISTER: [{ label: "Blister complete", eventType: "BLISTER_COMPLETE" }],
  HANDPACK_BLISTER: [{ label: "Hand-pack complete", eventType: "HANDPACK_BLISTER_COMPLETE" }],
  SEALING: [],
  PACKAGING: [], // PACKAGING uses the rich complete form below
  BOTTLE_HANDPACK: [{ label: "Hand-pack complete", eventType: "BOTTLE_HANDPACK_COMPLETE" }],
  BOTTLE_CAP_SEAL: [{ label: "Cap-seal complete", eventType: "BOTTLE_CAP_SEAL_COMPLETE" }],
  BOTTLE_STICKER: [{ label: "Sticker complete", eventType: "BOTTLE_STICKER_COMPLETE" }],
  COMBINED: [
    { label: "Sealing complete", eventType: "SEALING_COMPLETE" },
    { label: "Blister complete", eventType: "BLISTER_COMPLETE" },
  ],
};

import { EVENT_STAGE_PREREQ } from "@/lib/production/stage-progression";
import {
  getDefaultPauseReasonForStation,
  getPauseReasonsForStation,
  type PauseReasonValue,
} from "@/lib/production/station-pause-reasons";
import {
  blisterCloseOutCounterHelperText,
  parseNonnegativeIntegerInput,
  pauseCounterSnapshotFieldLabel,
  pauseCounterSnapshotHelperText,
  pauseCounterSnapshotMissingError,
  rollChangeCounterHelperText,
  stationRequiresBlisterCounterSnapshot,
} from "@/lib/production/blister-counter-snapshot";
import {
  SEALING_COUNTER_CONFIG_ERROR,
  computeSealedCountFromCounter,
} from "@/lib/production/sealing-counter";
import { SEALING_STATION_KINDS } from "@/lib/production/sealing-product";

type PackagingSpecLine = {
  materialName: string;
  materialKind: string;
  qtyPerUnit: number;
  perScope: string;
};

type SealingProductOption = {
  id: string;
  sku: string;
  name: string;
};

type HandpackTabletContext =
  | {
      status: "resolved";
      tabletTypeId: string;
      tabletTypeName: string;
      source: "inventory_bag" | "card_assigned";
      receiptNumber: string | null;
      bagNumber: number | null;
    }
  | { status: "missing" };

type SealingSegmentProgress = {
  segmentCount: number;
  stationCount: number;
  cardsTotal: number;
};

export function StageActionButtons({
  token,
  stationId,
  stationKind,
  workflowBagId,
  isPaused = false,
  currentStage = null,
  productKind = null,
  unitsPerDisplay = null,
  displaysPerCase = null,
  packagingSpecs = [],
  sealingCardsPerPress = null,
  hasProductMapped = true,
  sealingProductOptions = [],
  sealingProductFilterHint = null,
  rollChangeRole = null,
  handpackTabletContext = null,
  sealingSegmentProgress = null,
  hasPartialSealingCloseout = false,
}: {
  token: string;
  stationId: string;
  stationKind: string;
  workflowBagId: string | null;
  isPaused?: boolean;
  /** Bag's current stage from read_bag_state (STARTED | BLISTERED |
   *  SEALED | PACKAGED | FINALIZED). Null when read model lags. */
  currentStage?: string | null;
  productKind?: string | null;
  unitsPerDisplay?: number | null;
  displaysPerCase?: number | null;
  packagingSpecs?: PackagingSpecLine[];
  /** Bound machine cards-per-press for SEALING / COMBINED. Null = config missing. */
  sealingCardsPerPress?: number | null;
  /** False when workflow_bags.product_id is still null. */
  hasProductMapped?: boolean;
  /** Finished SKU options for sealing close-out when product is missing. */
  sealingProductOptions?: SealingProductOption[];
  /** Shown when tablet type is unknown and the product list is unfiltered. */
  sealingProductFilterHint?: string | null;
  /** When the bag was paused for a roll swap, drives the inline RollChangeCard. */
  rollChangeRole?: "PVC" | "FOIL" | null;
  /** Received-bag tablet lineage for HANDPACK_BLISTER completion. */
  handpackTabletContext?: HandpackTabletContext | null;
  /** Bag-level sealing segment totals (all stations). */
  sealingSegmentProgress?: SealingSegmentProgress | null;
  /** Durable partial sealing close-out — packaging may complete at BLISTERED. */
  hasPartialSealingCloseout?: boolean;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState("");
  const [operatorCode, setOperatorCode] = React.useState("");
  const pauseReasonOptions = getPauseReasonsForStation(stationKind);
  const [pauseReason, setPauseReason] = React.useState<PauseReasonValue>(() =>
    getDefaultPauseReasonForStation(stationKind),
  );
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [pauseCounterSnapshot, setPauseCounterSnapshot] = React.useState("");
  const pauseRequiresCounterSnapshot = stationRequiresBlisterCounterSnapshot(
    stationKind,
    pauseReason,
  );

  React.useEffect(() => {
    const options = getPauseReasonsForStation(stationKind);
    setPauseReason((current) =>
      options.some((o) => o.value === current)
        ? current
        : getDefaultPauseReasonForStation(stationKind),
    );
  }, [stationKind]);
  const router = useRouter();
  const [packagingOpen, setPackagingOpen] = React.useState(false);
  const [sealingOpen, setSealingOpen] = React.useState(false);
  const [sealingFinalOpen, setSealingFinalOpen] = React.useState(false);
  const [blisterOpen, setBlisterOpen] = React.useState(false);
  const [selectedSealingProductId, setSelectedSealingProductId] =
    React.useState("");

  // Operator code persists per-station for the browser session so an
  // operator only types it once a shift. Cleared with sessionStorage
  // when the tab closes. Only 1–4 digit badge codes are stored — reject
  // stale UUID-shaped values that would hit employee_code lookup.
  const opStorageKey = `luma.op.${stationId}`;
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.sessionStorage.getItem(opStorageKey);
    if (saved && operatorBadgeCodeForSubmit(saved)) {
      setOperatorCode(saved);
    } else if (saved) {
      window.sessionStorage.removeItem(opStorageKey);
    }
  }, [opStorageKey]);
  function updateOperatorCode(v: string) {
    setOperatorCode(v);
    if (typeof window !== "undefined") {
      const badge = operatorBadgeCodeForSubmit(v);
      if (badge) window.sessionStorage.setItem(opStorageKey, badge);
      else window.sessionStorage.removeItem(opStorageKey);
    }
  }

  if (!workflowBagId) return null;
  const allStages = STAGE_BY_KIND[stationKind] ?? [];
  // These events use their own rich close-out forms instead of the
  // shared single-count input + immediate-fire button.
  const RICH_FORM_EVENTS = new Set(["SEALING_COMPLETE", "BLISTER_COMPLETE"]);
  // Timed-only events fire immediately with no count input — the
  // duration is captured by the elapsed timer, not a manual count.
  const TIMED_ONLY_EVENTS = new Set(["HANDPACK_BLISTER_COMPLETE"]);
  // Hide forward-stage buttons whose prereq is not satisfied by the
  // bag's current stage. The server enforces the same rule; this
  // just stops the operator tapping a button that will be rejected.
  const stages = allStages.filter((s) => {
    const prereq = EVENT_STAGE_PREREQ[s.eventType];
    if (!prereq) return true;
    if (currentStage == null) return true; // lag — let server decide
    return prereq.includes(currentStage);
  });
  // Whether any of this station's stage events still use the generic
  // single-count path (bottle stations). Rich-form and timed-only
  // events both suppress the shared count input.
  const hasGenericStages = stages.some(
    s => !RICH_FORM_EVENTS.has(s.eventType) && !TIMED_ONLY_EVENTS.has(s.eventType),
  );
  const isPackaging = stationKind === "PACKAGING" || stationKind === "COMBINED";
  const isSealingStation = stationKind === "SEALING";
  const sealingStageReady =
    !currentStage || currentStage === "BLISTERED";
  const hasSealingSegments = (sealingSegmentProgress?.segmentCount ?? 0) > 0;
  const packagingReady =
    !currentStage ||
    currentStage === "SEALED" ||
    (currentStage === "BLISTERED" && hasPartialSealingCloseout);
  const packagingSealingInProgress =
    isPackaging &&
    currentStage === "BLISTERED" &&
    hasSealingSegments &&
    !hasPartialSealingCloseout;
  const needsSealingProductMapping = !hasProductMapped;
  const showSealingProductPicker =
    needsSealingProductMapping && SEALING_STATION_KINDS.has(stationKind);
  const sealingProductReady = hasProductMapped;
  const isHandpackBlister = stationKind === "HANDPACK_BLISTER";
  const handpackTabletMissing =
    isHandpackBlister && handpackTabletContext?.status !== "resolved";
  const handpackTabletTypeReady =
    !isHandpackBlister || handpackTabletContext?.status === "resolved";
  const packagingBlockedNoProduct =
    isPackaging && packagingReady && !hasProductMapped;

  // Release button shows after this station's stage event has fired
  // and the bag is at the station's "ready to release" stage.
  const releaseAtStage = STATION_RELEASE_FROM_STAGE[stationKind];
  // HANDPACK_BLISTER + SEALING auto-release on complete server-side — no manual step.
  // BLISTER keeps manual release for legacy bags already BLISTERED but not yet released.
  const releaseReady =
    stationKind !== "HANDPACK_BLISTER" &&
    stationKind !== "SEALING" &&
    releaseAtStage != null &&
    currentStage === releaseAtStage;
  const releaseLabel =
    stationKind === "BLISTER" || stationKind === "BOTTLE_HANDPACK"
      ? "Release to sealing queue"
      : stationKind === "SEALING" || stationKind === "BOTTLE_CAP_SEAL"
        ? "Release to packaging queue"
        : stationKind === "BOTTLE_STICKER"
          ? "Release to finishing queue"
          : "Release to next station";

  // Only stations that finalize show the Finalize button — legacy
  // fallback when a bag is PACKAGED but not yet finalized (e.g. Bag
  // Card 117 before auto-finalize shipped). New close-outs auto-finalize.
  const canFinalize =
    STATIONS_THAT_FINALIZE.has(stationKind) &&
    (currentStage == null || currentStage === "PACKAGED");

  function baseFd(opts: { withClientEventId?: boolean } = {}): FormData {
    const fd = new FormData();
    fd.set("token", token);
    if (workflowBagId) fd.set("workflowBagId", workflowBagId);
    fd.set("stationId", stationId);
    // Per-click idempotency key — server's partial unique index
    // turns retries into no-ops. Operator-handoff is exempt (a
    // re-fire with the same operator code is harmless).
    if (opts.withClientEventId !== false) {
      fd.set("clientEventId", newClientEventId());
    }
    return fd;
  }

  async function fire(eventType: string) {
    if (!workflowBagId) return;
    setPending(eventType);
    setError(null);
    try {
      const fd = baseFd();
      fd.set("eventType", eventType);
      if (count) fd.set("countTotal", count);
      const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
      if (badgeCode) {
        // OPERATOR_CHANGE doesn't get an idempotency key — re-firing
        // it with the same code is a no-op already.
        const op = baseFd({ withClientEventId: false });
        op.set("operatorCode", badgeCode);
        await setOperatorAction(op);
      }
      const r = await fireStageEventAction(fd);
      setCount("");
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  async function finalize() {
    if (!workflowBagId) return;
    if (!confirm("Finalize this bag? Closes the production cycle and returns the card to the IDLE pool."))
      return;
    setPending("finalize");
    setError(null);
    try {
      const r = await finalizeBagAction(baseFd());
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  async function release() {
    if (!workflowBagId) return;
    setPending("release");
    setError(null);
    try {
      const r = await releaseBagAction(baseFd());
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  async function sealingHandoff() {
    if (!workflowBagId) return;
    setPending("sealing-handoff");
    setError(null);
    try {
      const r = await releaseSealingHandoffAction(baseFd());
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  async function pause() {
    if (!workflowBagId) return;
    const counterSnapshot = pauseRequiresCounterSnapshot
      ? parseNonnegativeIntegerInput(pauseCounterSnapshot)
      : null;
    if (pauseRequiresCounterSnapshot && counterSnapshot == null) {
      setError(pauseCounterSnapshotMissingError(pauseReason));
      return;
    }
    setPending("pause");
    setError(null);
    try {
      const fd = baseFd();
      fd.set("reason", pauseReason);
      if (counterSnapshot != null) {
        fd.set("counterSnapshotCount", String(counterSnapshot));
      }
      const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
      if (badgeCode) fd.set("operatorCode", badgeCode);
      const r = await pauseBagAction(fd);
      setPauseOpen(false);
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  async function resume() {
    if (!workflowBagId) return;
    setPending("resume");
    setError(null);
    try {
      const fd = baseFd();
      const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
      if (badgeCode) fd.set("operatorCode", badgeCode);
      const r = await resumeBagAction(fd);
      if (r?.error) setError(r.error);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {isPaused && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-amber-900">
          <p className="text-sm font-semibold">Bag is paused</p>
          <p className="text-xs">Resume to continue the cycle timer.</p>
        </div>
      )}

      {isPaused &&
        rollChangeRole != null &&
        (stationKind === "BLISTER" || stationKind === "COMBINED") && (
          <RollChangeCard
            token={token}
            stationId={stationId}
            workflowBagId={workflowBagId}
            operatorCode={operatorCode}
            role={rollChangeRole}
          />
        )}

      <div className={`grid ${hasGenericStages ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{4}"
          value={operatorCode}
          onChange={(e) => updateOperatorCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="Operator code"
          maxLength={4}
          aria-label="Operator code"
          title="4-digit operator badge — saved for this shift on this device"
          className="h-12 px-3 rounded-lg bg-surface border border-border text-base tabular-nums"
        />
        {hasGenericStages && (
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            placeholder="Count"
            className="h-12 px-3 rounded-lg bg-surface border border-border text-base tabular-nums"
          />
        )}
      </div>

      {!isPaused && showSealingProductPicker && !sealingOpen && (
        <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 space-y-2">
          <div className="font-semibold text-sm">Step 1: Save product</div>
          <p className="text-sm text-amber-900/90 leading-relaxed">
            Save the finished product first. This locks product identity for the
            bag. Segment and complete stay blocked until product is saved.
          </p>
          {sealingProductFilterHint ? (
            <p className="text-sm text-amber-800">{sealingProductFilterHint}</p>
          ) : null}
          {sealingProductOptions.length === 0 ? (
            <p className="text-sm text-red-800">
              No active products are configured for this bag&apos;s tablet type.
              Ask a supervisor to set up the product mapping.
            </p>
          ) : (
            <>
              <select
                required
                value={selectedSealingProductId}
                onChange={(e) => setSelectedSealingProductId(e.target.value)}
                className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
              >
                <option value="" disabled>
                  — Select product —
                </option>
                {sealingProductOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={
                  pending !== null ||
                  !selectedSealingProductId.trim()
                }
                onClick={async () => {
                  setPending("save-product");
                  setError(null);
                  try {
                    const fd = new FormData();
                    fd.set("token", token);
                    fd.set("workflowBagId", workflowBagId);
                    fd.set("stationId", stationId);
                    fd.set("productId", selectedSealingProductId);
                    const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
                    if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
                    fd.set("clientEventId", newClientEventId());
                    const r = await saveSealingProductAction(fd);
                    if (r?.error) {
                      setError(r.error);
                    } else {
                      router.refresh();
                    }
                  } finally {
                    setPending(null);
                  }
                }}
                className="w-full h-12 rounded-xl bg-amber-700 text-white text-sm font-semibold disabled:opacity-60"
              >
                {pending === "save-product" ? "Saving…" : "Save product"}
              </button>
            </>
          )}
        </div>
      )}

      {!isPaused &&
        isHandpackBlister &&
        handpackTabletContext?.status === "resolved" && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900 space-y-1">
            <div className="font-semibold text-sm">
              Tablet: {handpackTabletContext.tabletTypeName}
            </div>
            <p className="text-sm text-emerald-900/80">
              Finished product will be chosen at sealing.
            </p>
            {handpackTabletContext.receiptNumber || handpackTabletContext.bagNumber != null ? (
              <p className="text-xs text-emerald-900/70">
                {handpackTabletContext.receiptNumber
                  ? `Receipt ${handpackTabletContext.receiptNumber}`
                  : "Received bag"}
                {handpackTabletContext.bagNumber != null
                  ? ` · Bag ${handpackTabletContext.bagNumber}`
                  : ""}
              </p>
            ) : null}
          </div>
        )}

      {!isPaused && handpackTabletMissing && (
        <div className="rounded-lg border border-red-300 bg-red-50/80 px-3 py-2 text-sm text-red-900 space-y-1">
          <div className="font-semibold">
            Missing received tablet context.
          </div>
          <p>
            This bag must be fixed in receiving/admin before hand-pack can be
            completed.
          </p>
        </div>
      )}

      {!isPaused && isSealingStation && sealingStageReady && (
        <div className="space-y-2">
          <div className="rounded-lg border border-border/80 bg-surface-2/50 px-3 py-2 text-xs text-text-muted space-y-1">
            <p className="font-semibold text-text">Sealing workflow</p>
            <ol className="list-decimal list-inside space-y-0.5 leading-relaxed">
              <li
                className={
                  sealingProductReady
                    ? "text-emerald-800"
                    : "font-medium text-amber-900"
                }
              >
                Save product{sealingProductReady ? " — done" : " — required first"}
              </li>
              <li className={sealingProductReady ? "" : "opacity-60"}>
                Record sealing segment — partial progress at this machine
              </li>
              <li className={sealingProductReady ? "" : "opacity-60"}>
                Complete sealing — only when every machine is done
              </li>
            </ol>
          </div>
          {sealingProductReady ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900">
              <p className="font-semibold text-sm">Product locked for this bag</p>
              <p className="text-sm text-emerald-900/85">
                Contact admin if this is wrong. You can record segments and
                complete sealing.
              </p>
            </div>
          ) : (
            <p className="text-xs text-amber-900 font-medium">
              Save product before recording sealing work.
            </p>
          )}
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="font-medium">Record sealing segment</span> = partial
            progress (pause, hand off, or finish later).{" "}
            <span className="font-medium">Sealing complete</span> = final
            close-out when all sealers are done — not the same as a segment.
          </p>
          {hasSealingSegments && sealingSegmentProgress ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
              Sealing in progress —{" "}
              <span className="font-semibold tabular-nums">
                {sealingSegmentProgress.cardsTotal}
              </span>{" "}
              cards recorded across{" "}
              <span className="font-semibold tabular-nums">
                {sealingSegmentProgress.stationCount}
              </span>{" "}
              station
              {sealingSegmentProgress.stationCount === 1 ? "" : "s"}. Packaging
              close-out unlocks when sealing is marked complete.
            </div>
          ) : null}
          <button
            type="button"
            disabled={pending !== null || !sealingProductReady}
            onClick={() => setSealingOpen(true)}
            className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-sky-700 text-white text-base font-semibold shadow-sm hover:bg-sky-800 disabled:opacity-60 transition-colors"
          >
            <CheckCircle2 className="h-5 w-5" />
            {pending === "SEALING_SEGMENT_COMPLETE"
              ? "Saving…"
              : "Step 2: Record sealing segment"}
          </button>
          <button
            type="button"
            disabled={
              pending !== null ||
              !sealingProductReady ||
              !hasSealingSegments
            }
            onClick={() => setSealingFinalOpen(true)}
            className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl border-2 border-sky-400 bg-surface text-sky-900 text-sm font-semibold disabled:opacity-60 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4" />
            {pending === "SEALING_COMPLETE"
              ? "Saving…"
              : "Step 3: Sealing complete — all machines done"}
          </button>
          {hasSealingSegments ? (
            <button
              type="button"
              disabled={pending !== null}
              onClick={sealingHandoff}
              className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 text-text text-sm font-medium disabled:opacity-60 transition-colors"
            >
              {pending === "sealing-handoff"
                ? "Handing off…"
                : "Done at this machine — hand off to next sealer"}
            </button>
          ) : null}
        </div>
      )}

      {!isPaused && packagingSealingInProgress && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Sealing in progress — packaging unlocks when sealing is marked
          complete.
        </div>
      )}

      {/* Per-stage complete buttons — large, primary action.
       *  SEALING and BLISTER events open a close-out form instead of
       *  firing immediately (counter presses vs blister count). */}
      {!isPaused &&
        stages.map((s) => (
          <button
            key={s.eventType}
            type="button"
            disabled={
              pending !== null ||
              (s.eventType === "SEALING_COMPLETE" && !sealingProductReady) ||
              (s.eventType === "HANDPACK_BLISTER_COMPLETE" && !handpackTabletTypeReady)
            }
            onClick={() => {
              if (s.eventType === "SEALING_COMPLETE") setSealingOpen(true);
              else if (s.eventType === "BLISTER_COMPLETE") setBlisterOpen(true);
              else fire(s.eventType);
            }}
            className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
          >
            <CheckCircle2 className="h-5 w-5" />
            {pending === s.eventType ? "Saving…" : s.label}
          </button>
        ))}

      {/* Packaging gets its own rich form */}
      {!isPaused && isPackaging && packagingReady && !packagingBlockedNoProduct && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => setPackagingOpen(true)}
          className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 text-white text-base font-semibold shadow-sm hover:bg-emerald-800 disabled:opacity-60 transition-colors"
        >
          <PackageCheck className="h-5 w-5" />
          Packaging complete (close out)
        </button>
      )}

      {!isPaused && packagingBlockedNoProduct && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Select finished product at sealing before packaging close-out.
        </div>
      )}

      {/* Release to next station — visible only after this station's
       *  stage event has fired and the bag is ready to hand forward.
       *  The QR card stays attached to the bag; the next station picks
       *  up by scanning the same card. */}
      {!isPaused && releaseReady && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={release}
          className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-sky-700 text-white text-base font-semibold shadow-sm hover:bg-sky-800 disabled:opacity-60 transition-colors"
        >
          <CheckCircle2 className="h-5 w-5" />
          {pending === "release" ? "Releasing…" : releaseLabel}
        </button>
      )}

      {/* Pause / Resume row */}
      {!isPaused ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => setPauseOpen(true)}
          className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-900 text-sm font-semibold disabled:opacity-60"
        >
          <PauseCircle className="h-4 w-4" />
          Pause bag
        </button>
      ) : (
        <button
          type="button"
          disabled={pending !== null}
          onClick={resume}
          className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 text-white text-base font-semibold disabled:opacity-60"
        >
          <PlayCircle className="h-5 w-5" />
          {pending === "resume" ? "Resuming…" : "Resume bag"}
        </button>
      )}

      {canFinalize && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={finalize}
          className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface text-text-muted hover:text-text hover:bg-surface-2 text-sm font-medium transition-colors"
        >
          <Flag className="h-4 w-4" />
          Finalize bag
        </button>
      )}

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Pause reason picker */}
      {pauseOpen && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 space-y-2">
          <p className="text-sm font-semibold text-amber-900">Why pausing?</p>
          <select
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value as typeof pauseReason)}
            className="w-full h-12 px-3 rounded-lg bg-surface border border-border text-base"
          >
            {pauseReasonOptions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {pauseRequiresCounterSnapshot ? (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-amber-950">
                {pauseCounterSnapshotFieldLabel(pauseReason)}
              </span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pauseCounterSnapshot}
                onChange={(e) =>
                  setPauseCounterSnapshot(e.target.value.replace(/\D/g, ""))
                }
                className="w-full h-12 px-3 rounded-lg bg-surface border border-border text-base tabular-nums"
                placeholder="0"
              />
              <span className="block text-xs leading-relaxed text-amber-900">
                {pauseCounterSnapshotHelperText(pauseReason)}
              </span>
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPauseOpen(false)}
              className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={pause}
              className="h-12 rounded-xl bg-amber-600 text-white text-sm font-semibold disabled:opacity-60"
            >
              {pending === "pause" ? "Pausing…" : "Confirm pause"}
            </button>
          </div>
        </div>
      )}

      {/* Packaging-complete rich form */}
      {packagingOpen && (
        <PackagingCompleteForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
          productKind={productKind}
          unitsPerDisplay={unitsPerDisplay}
          displaysPerCase={displaysPerCase}
          packagingSpecs={packagingSpecs}
          onClose={(success) => {
            setPackagingOpen(false);
            if (success && error) setError(null);
          }}
          onError={setError}
        />
      )}

      {/* Sealing segment close-out form (SEALING stations only) */}
      {!isPaused && sealingOpen && isSealingStation && (
        <SealingSegmentForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
          sealingCardsPerPress={sealingCardsPerPress}
          onClose={(success) => {
            setSealingOpen(false);
            if (success && error) setError(null);
          }}
          onError={setError}
        />
      )}

      {/* Sealing lane-close confirm */}
      {!isPaused && sealingFinalOpen && (
        <SealingFinalConfirmForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
          sealedCardsTotal={sealingSegmentProgress?.cardsTotal ?? 0}
          onClose={(success) => {
            setSealingFinalOpen(false);
            if (success && error) setError(null);
          }}
          onError={setError}
        />
      )}

      {/* Legacy COMBINED sealing close-out form */}
      {!isPaused && sealingOpen && stationKind === "COMBINED" && (
        <SealingCompleteForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
          sealingCardsPerPress={sealingCardsPerPress}
          onClose={(success) => {
            setSealingOpen(false);
            if (success && error) setError(null);
          }}
          onError={setError}
        />
      )}

      {/* Blister close-out form */}
      {!isPaused && blisterOpen && (
        <BlisterCompleteForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
          onClose={(success) => {
            setBlisterOpen(false);
            if (success && error) setError(null);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function PackagingCompleteForm({
  token,
  workflowBagId,
  stationId,
  operatorCode,
  productKind,
  unitsPerDisplay,
  displaysPerCase,
  packagingSpecs,
  onClose,
  onError,
}: {
  token: string;
  workflowBagId: string;
  stationId: string;
  operatorCode: string;
  productKind?: string | null;
  unitsPerDisplay?: number | null;
  displaysPerCase?: number | null;
  packagingSpecs?: PackagingSpecLine[];
  onClose: (success: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [masterCases, setMasterCases] = React.useState("");
  const [displaysMade, setDisplaysMade] = React.useState("");
  const [looseCards, setLooseCards] = React.useState("");
  const [damagedPackaging, setDamagedPackaging] = React.useState("");
  const [rippedCards, setRippedCards] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // VARIETY uses "units" instead of "cards" in labels; BOTTLE products
  // don't reach this station (they use BOTTLE_* station kinds).
  const isVariety = productKind === "VARIETY";
  const looseLabel = isVariety ? "Loose units" : "Loose cards";
  const reworkLabel = "Needs rework / return to sealing";
  const rippedLabel = "Ripped / unusable";

  // Live BOM consumption preview — computed from entered counts + product
  // structure. Updates as the operator types.
  const mc = parseInt(masterCases) || 0;
  const dm = parseInt(displaysMade) || 0;
  const lc = parseInt(looseCards) || 0;
  const totalCases = mc;
  const totalDisplays = mc * (displaysPerCase ?? 0) + dm;
  const totalUnits = totalDisplays * (unitsPerDisplay ?? 0) + lc;
  const dp = parseInt(damagedPackaging) || 0;
  const rc = parseInt(rippedCards) || 0;
  const hasPackagingCounts = mc > 0 || dm > 0 || lc > 0 || dp > 0 || rc > 0;
  const hasBomPreview = packagingSpecs && packagingSpecs.length > 0;
  const bomLines =
    hasBomPreview && (mc > 0 || dm > 0 || lc > 0)
      ? packagingSpecs!.map((s) => {
          let qty = 0;
          if (s.perScope === "UNIT") qty = s.qtyPerUnit * totalUnits;
          else if (s.perScope === "DISPLAY") qty = s.qtyPerUnit * totalDisplays;
          else if (s.perScope === "CASE") qty = s.qtyPerUnit * totalCases;
          return { ...s, qty };
        }).filter((s) => s.qty > 0)
      : [];

  return (
    <div ref={containerRef} className="rounded-lg border-2 border-emerald-300 bg-emerald-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-emerald-900">
        Packaging close-out
      </p>
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Master cases" value={masterCases} onChange={setMasterCases} scrollSafe />
        <NumField label="Displays" value={displaysMade} onChange={setDisplaysMade} scrollSafe />
        <NumField label={looseLabel} value={looseCards} onChange={setLooseCards} scrollSafe />
        <NumField
          label={reworkLabel}
          value={damagedPackaging}
          onChange={setDamagedPackaging}
          scrollSafe
        />
        <NumField
          label={rippedLabel}
          value={rippedCards}
          onChange={setRippedCards}
          className="col-span-2"
          scrollSafe
        />
      </div>

      {/* BOM consumption preview — only shown when specs exist and
          the operator has entered at least one count. */}
      {bomLines.length > 0 && (
        <div className="rounded-md border border-emerald-400 bg-emerald-100/60 px-2.5 py-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800">
            Materials this run will consume
          </p>
          {bomLines.map((s, i) => (
            <div key={i} className="flex items-baseline justify-between text-xs text-emerald-900">
              <span className="truncate pr-2">{s.materialName}</span>
              <span className="tabular-nums font-semibold whitespace-nowrap">
                {s.qty.toLocaleString()} <span className="font-normal text-[10px] text-emerald-700">per {s.perScope.toLowerCase()}</span>
              </span>
            </div>
          ))}
          {unitsPerDisplay != null && displaysPerCase != null && (
            <p className="text-[10px] text-emerald-700 pt-0.5">
              {totalUnits.toLocaleString()} units · {totalDisplays.toLocaleString()} displays · {totalCases.toLocaleString()} cases
            </p>
          )}
        </div>
      )}

      {hasBomPreview && hasPackagingCounts && (
        <div className="text-[11px] text-text-subtle space-y-0.5 border-t border-border/40 pt-2 mt-1">
          {packagingSpecs!
            .filter(s => !["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(s.materialKind))
            .map(s => (
              <div key={`${s.materialName}|${s.perScope}`} className="flex items-center justify-between">
                <span className="truncate">{s.materialName}</span>
                <span className="text-text-subtle/70">Pending — deducted on save</span>
              </div>
            ))
          }
          {packagingSpecs!.some(s => ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(s.materialKind)) && (
            <div className="text-text-subtle/50">PVC/foil tracked via roll counter</div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={pending}
          className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              const fd = new FormData();
              fd.set("token", token);
              fd.set("workflowBagId", workflowBagId);
              fd.set("stationId", stationId);
              fd.set("masterCases", masterCases || "0");
              fd.set("displaysMade", displaysMade || "0");
              fd.set("looseCards", looseCards || "0");
              fd.set("damagedPackaging", damagedPackaging || "0");
              fd.set("rippedCards", rippedCards || "0");
              const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
              if (badgeCode) fd.set("operatorCode", badgeCode);
              fd.set("clientEventId", newClientEventId());
              const r = await packagingCompleteAction(fd);
              if (r?.error) {
                onError(r.error);
                onClose(false);
              } else {
                onClose(true);
              }
            } finally {
              setPending(false);
            }
          }}
          className="h-14 rounded-xl bg-emerald-700 text-white text-base font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save & close"}
        </button>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  className,
  scrollSafe = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** Prevent trackpad/mouse wheel from changing value while focused. */
  scrollSafe?: boolean;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="block text-xs font-medium text-text-muted mb-1">
        {label}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onWheel={
          scrollSafe
            ? (e) => {
                e.currentTarget.blur();
              }
            : undefined
        }
        className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base tabular-nums"
      />
    </label>
  );
}

function SealingSegmentForm({
  token,
  workflowBagId,
  stationId,
  operatorCode,
  sealingCardsPerPress,
  onClose,
  onError,
}: {
  token: string;
  workflowBagId: string;
  stationId: string;
  operatorCode: string;
  sealingCardsPerPress: number | null;
  onClose: (success: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [counterPresses, setCounterPresses] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const configReady =
    sealingCardsPerPress != null && Number.isFinite(sealingCardsPerPress);
  const previewCount =
    configReady && counterPresses.trim() !== ""
      ? computeSealedCountFromCounter(
          Number(counterPresses),
          sealingCardsPerPress,
        )
      : null;

  return (
    <div
      ref={containerRef}
      className="rounded-lg border-2 border-sky-300 bg-sky-50/40 p-3 space-y-3"
    >
      <p className="text-sm font-semibold text-sky-900">
        Step 2: Record sealing segment
      </p>
      <p className="text-xs text-sky-900/90 leading-relaxed">
        Partial progress at this machine — not final close-out. Use when pausing,
        handing off to another sealer, or stopping before the bag is fully sealed.
      </p>
      {!configReady ? (
        <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {SEALING_COUNTER_CONFIG_ERROR}
        </p>
      ) : (
        <>
          <p className="text-xs text-sky-900">
            Cards per press (from machine setup):{" "}
            <span className="font-semibold tabular-nums">{sealingCardsPerPress}</span>
          </p>
          <div className="space-y-2">
            <NumField
              label="Presses completed (machine counter)"
              value={counterPresses}
              onChange={setCounterPresses}
              scrollSafe
            />
            {previewCount != null && Number.isFinite(previewCount) ? (
              <p className="text-xs text-sky-800">
                Sealed cards = counter × {sealingCardsPerPress} ={" "}
                <span className="font-semibold tabular-nums">{previewCount}</span>
              </p>
            ) : null}
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={pending}
          className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending || !configReady}
          onClick={async () => {
            setPending(true);
            try {
              const fd = new FormData();
              fd.set("token", token);
              fd.set("workflowBagId", workflowBagId);
              fd.set("stationId", stationId);
              fd.set("eventType", "SEALING_SEGMENT_COMPLETE");
              fd.set("counterPresses", counterPresses || "0");
              const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
              if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
              fd.set("clientEventId", newClientEventId());
              const r = await fireStageEventAction(fd);
              if (r?.error) {
                onError(r.error);
                onClose(false);
              } else {
                onClose(true);
              }
            } finally {
              setPending(false);
            }
          }}
          className="h-14 rounded-xl bg-sky-700 text-white text-base font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save segment"}
        </button>
      </div>
    </div>
  );
}

function SealingFinalConfirmForm({
  token,
  workflowBagId,
  stationId,
  operatorCode,
  sealedCardsTotal,
  onClose,
  onError,
}: {
  token: string;
  workflowBagId: string;
  stationId: string;
  operatorCode: string;
  sealedCardsTotal: number;
  onClose: (success: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [pending, setPending] = React.useState<"whole" | "partial" | null>(null);
  const [partialReason, setPartialReason] = React.useState<
    SealingPartialCloseReason | ""
  >("");
  const [partialNote, setPartialNote] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const submitClose = async (mode: "whole" | "partial") => {
    if (mode === "partial") {
      if (!partialReason) {
        onError("Select a partial close-out reason.");
        return;
      }
      if (partialReason === "OTHER" && partialNote.trim().length < 3) {
        onError("Add a short note when the reason is Other.");
        return;
      }
    }
    setPending(mode);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("workflowBagId", workflowBagId);
      fd.set("stationId", stationId);
      fd.set("eventType", "SEALING_COMPLETE");
      fd.set("sealingCloseMode", mode);
      if (mode === "partial") {
        fd.set("partialCloseReason", partialReason);
        if (partialReason === "OTHER") {
          fd.set("partialCloseReasonNote", partialNote.trim());
        }
      }
      const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
      if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
      fd.set("clientEventId", newClientEventId());
      const r = await fireStageEventAction(fd);
      if (r?.error) {
        onError(r.error);
        onClose(false);
      } else {
        onClose(true);
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      ref={containerRef}
      className="rounded-lg border-2 border-sky-400 bg-sky-50/60 p-3 space-y-3"
    >
      <p className="text-sm font-semibold text-sky-900">
        Step 3: Close sealing for this bag
      </p>
      <p className="text-xs text-sky-900/90 leading-relaxed">
        <span className="font-medium">Submit whole bag</span> when every machine
        is done sealing this bag.{" "}
        <span className="font-medium">Submit partial bag</span> sends the sealed
        quantity forward to packaging. Use only when this bag will not be fully
        sealed now.
      </p>
      <p className="text-xs text-sky-800 bg-sky-100/80 border border-sky-200 rounded-lg px-3 py-2">
        Sealed quantity from segments:{" "}
        <span className="font-semibold tabular-nums">{sealedCardsTotal}</span>{" "}
        cards (system total — not re-entered on partial submit).
      </p>
      <label className="block text-xs font-medium text-sky-900">
        Partial close-out reason (required only for partial submit)
        <select
          value={partialReason}
          onChange={(e) =>
            setPartialReason(e.target.value as SealingPartialCloseReason | "")
          }
          disabled={pending !== null}
          className="mt-1 w-full h-11 rounded-lg border border-sky-300 bg-white px-3 text-sm text-text"
        >
          <option value="">Select reason…</option>
          {SEALING_PARTIAL_CLOSE_REASONS.map((code) => (
            <option key={code} value={code}>
              {SEALING_PARTIAL_CLOSE_REASON_LABELS[code]}
            </option>
          ))}
        </select>
      </label>
      {partialReason === "OTHER" ? (
        <label className="block text-xs font-medium text-sky-900">
          Short note (required for Other)
          <input
            type="text"
            maxLength={200}
            value={partialNote}
            onChange={(e) => setPartialNote(e.target.value)}
            disabled={pending !== null}
            className="mt-1 w-full h-11 rounded-lg border border-sky-300 bg-white px-3 text-sm text-text"
            placeholder="Brief explanation"
          />
        </label>
      ) : null}
      <div className="grid grid-cols-1 gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={pending !== null}
          className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => submitClose("whole")}
          className="h-14 rounded-xl bg-sky-800 text-white text-base font-semibold disabled:opacity-60"
        >
          {pending === "whole" ? "Saving…" : "Submit whole bag"}
        </button>
        <button
          type="button"
          disabled={pending !== null || !partialReason}
          onClick={() => submitClose("partial")}
          className="h-14 rounded-xl border-2 border-sky-600 bg-white text-sky-900 text-base font-semibold disabled:opacity-60"
        >
          {pending === "partial" ? "Saving…" : "Submit partial bag"}
        </button>
      </div>
    </div>
  );
}

function SealingCompleteForm({
  token,
  workflowBagId,
  stationId,
  operatorCode,
  sealingCardsPerPress,
  onClose,
  onError,
}: {
  token: string;
  workflowBagId: string;
  stationId: string;
  operatorCode: string;
  sealingCardsPerPress: number | null;
  onClose: (success: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [counterPresses, setCounterPresses] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const configReady =
    sealingCardsPerPress != null && sealingCardsPerPress >= 1;
  const previewCount =
    configReady && counterPresses !== ""
      ? Number(counterPresses) * sealingCardsPerPress
      : null;
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={containerRef} className="rounded-lg border-2 border-sky-300 bg-sky-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-sky-900">Sealing close-out</p>
      {!configReady ? (
        <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {SEALING_COUNTER_CONFIG_ERROR}
        </p>
      ) : (
        <>
          <p className="text-xs text-sky-900">
            Cards per press:{" "}
            <span className="font-semibold tabular-nums">{sealingCardsPerPress}</span>
          </p>
          <div className="space-y-2">
            <NumField
              label="Counter presses"
              value={counterPresses}
              onChange={setCounterPresses}
              scrollSafe
            />
            {previewCount != null && Number.isFinite(previewCount) ? (
              <p className="text-xs text-sky-800">
                Sealed cards = counter × {sealingCardsPerPress} ={" "}
                <span className="font-semibold tabular-nums">{previewCount}</span>
              </p>
            ) : null}
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={pending}
          className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending || !configReady}
          onClick={async () => {
            setPending(true);
            try {
              const fd = new FormData();
              fd.set("token", token);
              fd.set("workflowBagId", workflowBagId);
              fd.set("stationId", stationId);
              fd.set("eventType", "SEALING_COMPLETE");
              fd.set("counterPresses", counterPresses || "0");
              const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
              if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
              fd.set("clientEventId", newClientEventId());
              const r = await fireStageEventAction(fd);
              if (r?.error) {
                onError(r.error);
                onClose(false);
              } else {
                onClose(true);
              }
            } finally {
              setPending(false);
            }
          }}
          className="h-14 rounded-xl bg-sky-700 text-white text-base font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Complete sealing"}
        </button>
      </div>
    </div>
  );
}

function BlisterCompleteForm({
  token,
  workflowBagId,
  stationId,
  operatorCode,
  onClose,
  onError,
}: {
  token: string;
  workflowBagId: string;
  stationId: string;
  operatorCode: string;
  onClose: (success: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [machineCounter, setMachineCounter] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={containerRef} className="rounded-lg border-2 border-violet-300 bg-violet-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-violet-900">Blister close-out</p>
      <NumField
        label="Counter snapshot at blister close-out"
        value={machineCounter}
        onChange={setMachineCounter}
        scrollSafe
      />
      <p className="text-xs leading-relaxed text-violet-900">
        {blisterCloseOutCounterHelperText()}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={pending}
          className="h-12 rounded-xl border border-border bg-surface text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              const fd = new FormData();
              fd.set("token", token);
              fd.set("workflowBagId", workflowBagId);
              fd.set("stationId", stationId);
              fd.set("eventType", "BLISTER_COMPLETE");
              fd.set("countTotal", machineCounter || "0");
              const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
              if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
              fd.set("clientEventId", newClientEventId());
              const r = await fireStageEventAction(fd);
              if (r?.error) {
                onError(r.error);
                onClose(false);
              } else {
                onClose(true);
              }
            } finally {
              setPending(false);
            }
          }}
          className="h-14 rounded-xl bg-violet-700 text-white text-base font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save & close"}
        </button>
      </div>
    </div>
  );
}

function RollChangeCard({
  token,
  stationId,
  workflowBagId,
  operatorCode,
  role,
}: {
  token: string;
  stationId: string;
  workflowBagId: string;
  operatorCode: string;
  role: "PVC" | "FOIL";
}) {
  const [counterSegment, setCounterSegment] = React.useState("");
  const [newRollNumber, setNewRollNumber] = React.useState("");
  const [newStartingWeight, setNewStartingWeight] = React.useState("");
  const [oldRollEndState, setOldRollEndState] = React.useState<
    "depleted" | "removed_partial" | ""
  >("");
  const [done, setDone] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const label = role === "PVC" ? "PVC" : "Foil";

  if (done) {
    return (
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-3 text-emerald-900 text-sm">
        <p className="font-semibold">{label} roll change recorded</p>
        <p className="text-xs">Resume the bag to continue.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3 space-y-3">
      <div>
        <p className="text-sm font-semibold text-orange-900">
          {label} roll change required
        </p>
        <p className="text-xs text-orange-800/80 leading-relaxed">
          {rollChangeCounterHelperText(role)}
        </p>
      </div>

      <NumField
        label={`Counter snapshot when ${label} roll stopped`}
        value={counterSegment}
        onChange={setCounterSegment}
        scrollSafe
      />

      <fieldset className="space-y-2">
        <legend className="block text-xs font-medium text-text-muted">
          Old {label} roll status
        </legend>
        <label className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <input
            type="radio"
            name="oldRollEndState"
            value="depleted"
            checked={oldRollEndState === "depleted"}
            onChange={() => setOldRollEndState("depleted")}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Finished / depleted</span>
            <span className="block text-xs text-text-muted">
              Mark the old roll depleted after assigning this count.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <input
            type="radio"
            name="oldRollEndState"
            value="removed_partial"
            checked={oldRollEndState === "removed_partial"}
            onChange={() => setOldRollEndState("removed_partial")}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">
              Removed with material remaining
            </span>
            <span className="block text-xs text-text-muted">
              The old roll will be removed and can be mounted again later. It
              will not be marked depleted.
            </span>
          </span>
        </label>
      </fieldset>

      <label className="block text-sm">
        <span className="block text-xs font-medium text-text-muted mb-1">
          New {label} roll number
        </span>
        <input
          type="text"
          value={newRollNumber}
          onChange={(e) => setNewRollNumber(e.target.value)}
          placeholder="Roll number or scan token"
          className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base"
        />
      </label>

      <NumField
        label="New roll starting weight (g, optional)"
        value={newStartingWeight}
        onChange={setNewStartingWeight}
        scrollSafe
      />

      {localError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          <p className="font-semibold">Roll change failed</p>
          <p className="text-xs">{localError}</p>
        </div>
      )}

      <button
        type="button"
        disabled={pending || !counterSegment || !oldRollEndState || !newRollNumber}
        onClick={async () => {
          setPending(true);
          setLocalError(null);
          try {
            const fd = new FormData();
            fd.set("token", token);
            fd.set("stationId", stationId);
            fd.set("workflowBagId", workflowBagId);
            fd.set("role", role);
            fd.set("counterSegmentCount", counterSegment);
            fd.set("oldRollEndState", oldRollEndState);
            fd.set("newRollNumber", newRollNumber);
            if (newStartingWeight)
              fd.set("newStartingWeightGrams", newStartingWeight);
            const badgeCode = operatorBadgeCodeForSubmit(operatorCode);
            if (badgeCode) fd.set("overrideEmployeeCode", badgeCode);
            fd.set("clientEventId", newClientEventId());
            const r = await changeRollAction(fd);
            if (r && "error" in r && r.error) {
              setLocalError(r.error);
            } else {
              setDone(true);
            }
          } catch (err) {
            setLocalError(
              err instanceof Error ? err.message : "Unexpected error.",
            );
          } finally {
            setPending(false);
          }
        }}
        className="w-full rounded-lg bg-orange-600 hover:bg-orange-700 active:bg-orange-800 text-white text-sm font-semibold px-4 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "Recording…" : `Record ${label} roll change`}
      </button>
    </div>
  );
}
