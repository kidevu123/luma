"use client";

import * as React from "react";
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
  finalizeBagAction,
  releaseBagAction,
  pauseBagAction,
  resumeBagAction,
  setOperatorAction,
  packagingCompleteAction,
} from "./actions";
import {
  STATION_RELEASE_FROM_STAGE,
  STATIONS_THAT_FINALIZE,
} from "@/lib/production/stage-progression";

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

const STAGE_BY_KIND: Record<string, { label: string; eventType: string }[]> = {
  BLISTER: [{ label: "Blister complete", eventType: "BLISTER_COMPLETE" }],
  SEALING: [{ label: "Sealing complete", eventType: "SEALING_COMPLETE" }],
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

type PackagingSpecLine = {
  materialName: string;
  materialKind: string;
  qtyPerUnit: number;
  perScope: string;
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
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState("");
  const [operatorCode, setOperatorCode] = React.useState("");
  const [pauseReason, setPauseReason] = React.useState<
    "pvc_swap" | "shift_end" | "machine_jam" | "qa_check" | "other"
  >("pvc_swap");
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [packagingOpen, setPackagingOpen] = React.useState(false);
  const [sealingOpen, setSealingOpen] = React.useState(false);
  const [blisterOpen, setBlisterOpen] = React.useState(false);

  // Operator code persists per-station for the browser session so an
  // operator only types it once a shift. Cleared with sessionStorage
  // when the tab closes.
  const opStorageKey = `luma.op.${stationId}`;
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.sessionStorage.getItem(opStorageKey);
    if (saved) setOperatorCode(saved);
  }, [opStorageKey]);
  function updateOperatorCode(v: string) {
    setOperatorCode(v);
    if (typeof window !== "undefined") {
      if (v) window.sessionStorage.setItem(opStorageKey, v);
      else window.sessionStorage.removeItem(opStorageKey);
    }
  }

  if (!workflowBagId) return null;
  const allStages = STAGE_BY_KIND[stationKind] ?? [];
  // These events use their own rich close-out forms instead of the
  // shared single-count input + immediate-fire button.
  const RICH_FORM_EVENTS = new Set(["SEALING_COMPLETE", "BLISTER_COMPLETE"]);
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
  // single-count path (bottle stations). If all events are rich-form
  // events, hide the shared count input.
  const hasGenericStages = stages.some(s => !RICH_FORM_EVENTS.has(s.eventType));
  const isPackaging = stationKind === "PACKAGING" || stationKind === "COMBINED";
  const packagingReady = !currentStage || currentStage === "SEALED";

  // Release button shows after this station's stage event has fired
  // and the bag is at the station's "ready to release" stage.
  const releaseAtStage = STATION_RELEASE_FROM_STAGE[stationKind];
  const releaseReady =
    releaseAtStage != null && currentStage === releaseAtStage;
  const releaseLabel =
    stationKind === "BLISTER" || stationKind === "BOTTLE_HANDPACK"
      ? "Release to sealing queue"
      : stationKind === "SEALING" || stationKind === "BOTTLE_CAP_SEAL"
        ? "Release to packaging queue"
        : stationKind === "BOTTLE_STICKER"
          ? "Release to finishing queue"
          : "Release to next station";

  // Only stations that finalize show the Finalize button — and only
  // when the bag is at PACKAGED. Everywhere else, finalize is hidden.
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
      if (operatorCode) {
        // OPERATOR_CHANGE doesn't get an idempotency key — re-firing
        // it with the same code is a no-op already.
        const op = baseFd({ withClientEventId: false });
        op.set("operatorCode", operatorCode);
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

  async function pause() {
    if (!workflowBagId) return;
    setPending("pause");
    setError(null);
    try {
      const fd = baseFd();
      fd.set("reason", pauseReason);
      if (operatorCode) fd.set("operatorCode", operatorCode);
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
      if (operatorCode) fd.set("operatorCode", operatorCode);
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

      <div className={`grid ${hasGenericStages ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{4}"
          value={operatorCode}
          onChange={(e) => updateOperatorCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="Op # (4 digits)"
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

      {/* Per-stage complete buttons — large, primary action.
       *  SEALING and BLISTER events open a rich close-out form instead
       *  of firing immediately, so operators can record packs_remaining
       *  and cards_reopened alongside the main count. */}
      {!isPaused &&
        stages.map((s) => (
          <button
            key={s.eventType}
            type="button"
            disabled={pending !== null}
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
      {!isPaused && isPackaging && packagingReady && (
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
            <option value="pvc_swap">PVC roll swap</option>
            <option value="shift_end">Shift ending</option>
            <option value="machine_jam">Machine jam</option>
            <option value="qa_check">QA check</option>
            <option value="other">Other</option>
          </select>
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

      {/* Sealing close-out form */}
      {!isPaused && sealingOpen && (
        <SealingCompleteForm
          token={token}
          workflowBagId={workflowBagId}
          stationId={stationId}
          operatorCode={operatorCode}
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
  const rippedLabel = isVariety ? "Damaged (scrap)" : "Ripped (scrap)";

  // Live BOM consumption preview — computed from entered counts + product
  // structure. Updates as the operator types.
  const mc = parseInt(masterCases) || 0;
  const dm = parseInt(displaysMade) || 0;
  const lc = parseInt(looseCards) || 0;
  const totalCases = mc;
  const totalDisplays = mc * (displaysPerCase ?? 0) + dm;
  const totalUnits = totalDisplays * (unitsPerDisplay ?? 0) + lc;
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
        <NumField label="Master cases" value={masterCases} onChange={setMasterCases} />
        <NumField label="Displays" value={displaysMade} onChange={setDisplaysMade} />
        <NumField label={looseLabel} value={looseCards} onChange={setLooseCards} />
        <NumField
          label="Damaged (return to sealing)"
          value={damagedPackaging}
          onChange={setDamagedPackaging}
        />
        <NumField
          label={rippedLabel}
          value={rippedCards}
          onChange={setRippedCards}
          className="col-span-2"
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
              if (operatorCode) fd.set("operatorCode", operatorCode);
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
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
        className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base"
      />
    </label>
  );
}

function SealingCompleteForm({
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
  const [sealedCount, setSealedCount] = React.useState("");
  const [packsRemaining, setPacksRemaining] = React.useState("");
  const [cardsReopened, setCardsReopened] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={containerRef} className="rounded-lg border-2 border-sky-300 bg-sky-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-sky-900">Sealing close-out</p>
      <div className="grid grid-cols-2 gap-2">
        <NumField
          label="Sealed count"
          value={sealedCount}
          onChange={setSealedCount}
          className="col-span-2"
        />
        <NumField
          label="Packs remaining"
          value={packsRemaining}
          onChange={setPacksRemaining}
        />
        <NumField
          label="Cards reopened (scrap)"
          value={cardsReopened}
          onChange={setCardsReopened}
        />
      </div>
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
              fd.set("eventType", "SEALING_COMPLETE");
              fd.set("countTotal", sealedCount || "0");
              fd.set("packsRemaining", packsRemaining || "0");
              fd.set("cardsReopened", cardsReopened || "0");
              if (operatorCode) fd.set("overrideEmployeeCode", operatorCode);
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
          {pending ? "Saving…" : "Save & close"}
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
  const [blisterCount, setBlisterCount] = React.useState("");
  const [packsRemaining, setPacksRemaining] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={containerRef} className="rounded-lg border-2 border-violet-300 bg-violet-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-violet-900">Blister close-out</p>
      <div className="grid grid-cols-2 gap-2">
        <NumField
          label="Blister count"
          value={blisterCount}
          onChange={setBlisterCount}
        />
        <NumField
          label="Packs remaining"
          value={packsRemaining}
          onChange={setPacksRemaining}
        />
      </div>
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
              fd.set("countTotal", blisterCount || "0");
              fd.set("packsRemaining", packsRemaining || "0");
              if (operatorCode) fd.set("overrideEmployeeCode", operatorCode);
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
