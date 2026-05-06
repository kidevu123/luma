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
  pauseBagAction,
  resumeBagAction,
  setOperatorAction,
  packagingCompleteAction,
} from "./actions";

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

export function StageActionButtons({
  token,
  stationId,
  stationKind,
  workflowBagId,
  isPaused = false,
}: {
  token: string;
  stationId: string;
  stationKind: string;
  workflowBagId: string | null;
  isPaused?: boolean;
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

  if (!workflowBagId) return null;
  const stages = STAGE_BY_KIND[stationKind] ?? [];
  const isPackaging = stationKind === "PACKAGING" || stationKind === "COMBINED";

  function baseFd(): FormData {
    const fd = new FormData();
    fd.set("token", token);
    if (workflowBagId) fd.set("workflowBagId", workflowBagId);
    fd.set("stationId", stationId);
    return fd;
  }

  async function fire(eventType: string) {
    if (!workflowBagId) return;
    setPending(eventType);
    setError(null);
    const fd = baseFd();
    fd.set("eventType", eventType);
    if (count) fd.set("countTotal", count);
    if (operatorCode) {
      const op = baseFd();
      op.set("operatorCode", operatorCode);
      await setOperatorAction(op);
    }
    const r = await fireStageEventAction(fd);
    setPending(null);
    setCount("");
    if (r?.error) setError(r.error);
  }

  async function finalize() {
    if (!workflowBagId) return;
    if (!confirm("Finalize this bag? The card returns to the IDLE pool."))
      return;
    setPending("finalize");
    setError(null);
    const r = await finalizeBagAction(baseFd());
    setPending(null);
    if (r?.error) setError(r.error);
  }

  async function pause() {
    if (!workflowBagId) return;
    setPending("pause");
    setError(null);
    const fd = baseFd();
    fd.set("reason", pauseReason);
    if (operatorCode) fd.set("operatorCode", operatorCode);
    const r = await pauseBagAction(fd);
    setPending(null);
    setPauseOpen(false);
    if (r?.error) setError(r.error);
  }

  async function resume() {
    if (!workflowBagId) return;
    setPending("resume");
    setError(null);
    const fd = baseFd();
    if (operatorCode) fd.set("operatorCode", operatorCode);
    const r = await resumeBagAction(fd);
    setPending(null);
    if (r?.error) setError(r.error);
  }

  return (
    <div className="space-y-3">
      {isPaused && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-amber-900">
          <p className="text-sm font-semibold">Bag is paused</p>
          <p className="text-xs">Resume to continue the cycle timer.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={operatorCode}
          onChange={(e) => setOperatorCode(e.target.value)}
          placeholder="Operator code"
          maxLength={20}
          className="h-12 px-3 rounded-lg bg-surface border border-border text-base"
        />
        <input
          type="number"
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="Count"
          className="h-12 px-3 rounded-lg bg-surface border border-border text-base"
        />
      </div>

      {/* Per-stage complete buttons — large, primary action */}
      {!isPaused &&
        stages.map((s) => (
          <button
            key={s.eventType}
            type="button"
            disabled={pending !== null}
            onClick={() => fire(s.eventType)}
            className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
          >
            <CheckCircle2 className="h-5 w-5" />
            {pending === s.eventType ? "Saving…" : s.label}
          </button>
        ))}

      {/* Packaging gets its own rich form */}
      {!isPaused && isPackaging && (
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

      <button
        type="button"
        disabled={pending !== null}
        onClick={finalize}
        className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface text-text-muted hover:text-text hover:bg-surface-2 text-sm font-medium transition-colors"
      >
        <Flag className="h-4 w-4" />
        Finalize bag
      </button>

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
          onClose={(success) => {
            setPackagingOpen(false);
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
  const [masterCases, setMasterCases] = React.useState("");
  const [displaysMade, setDisplaysMade] = React.useState("");
  const [looseCards, setLooseCards] = React.useState("");
  const [damagedPackaging, setDamagedPackaging] = React.useState("");
  const [rippedCards, setRippedCards] = React.useState("");

  return (
    <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50/40 p-3 space-y-3">
      <p className="text-sm font-semibold text-emerald-900">
        Packaging close-out
      </p>
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Master cases" value={masterCases} onChange={setMasterCases} />
        <NumField label="Displays" value={displaysMade} onChange={setDisplaysMade} />
        <NumField label="Loose cards" value={looseCards} onChange={setLooseCards} />
        <NumField
          label="Damaged (return to sealing)"
          value={damagedPackaging}
          onChange={setDamagedPackaging}
        />
        <NumField
          label="Ripped (scrap)"
          value={rippedCards}
          onChange={setRippedCards}
          className="col-span-2"
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
            const r = await packagingCompleteAction(fd);
            setPending(false);
            if (r?.error) {
              onError(r.error);
              onClose(false);
            } else {
              onClose(true);
            }
          }}
          className="h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold disabled:opacity-60"
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
