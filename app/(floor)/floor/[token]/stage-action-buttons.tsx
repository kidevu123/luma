"use client";

import * as React from "react";
import { CheckCircle2, Flag } from "lucide-react";
import { fireStageEventAction, finalizeBagAction } from "./actions";

const STAGE_BY_KIND: Record<string, { label: string; eventType: string }[]> = {
  BLISTER: [{ label: "Blister complete", eventType: "BLISTER_COMPLETE" }],
  SEALING: [{ label: "Sealing complete", eventType: "SEALING_COMPLETE" }],
  PACKAGING: [{ label: "Packaging snapshot", eventType: "PACKAGING_SNAPSHOT" }],
  BOTTLE_HANDPACK: [{ label: "Hand-pack complete", eventType: "BOTTLE_HANDPACK_COMPLETE" }],
  BOTTLE_CAP_SEAL: [{ label: "Cap-seal complete", eventType: "BOTTLE_CAP_SEAL_COMPLETE" }],
  BOTTLE_STICKER: [{ label: "Sticker complete", eventType: "BOTTLE_STICKER_COMPLETE" }],
  COMBINED: [
    { label: "Sealing complete", eventType: "SEALING_COMPLETE" },
    { label: "Blister complete", eventType: "BLISTER_COMPLETE" },
    { label: "Packaging snapshot", eventType: "PACKAGING_SNAPSHOT" },
  ],
};

export function StageActionButtons({
  stationId,
  stationKind,
  workflowBagId,
}: {
  stationId: string;
  stationKind: string;
  workflowBagId: string | null;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState("");

  if (!workflowBagId) return null;
  const stages = STAGE_BY_KIND[stationKind] ?? [];

  async function fire(eventType: string) {
    if (!workflowBagId) return;
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("workflowBagId", workflowBagId);
    fd.set("stationId", stationId);
    fd.set("eventType", eventType);
    if (count) fd.set("countTotal", count);
    const r = await fireStageEventAction(fd);
    setPending(false);
    setCount("");
    if (r?.error) setError(r.error);
  }

  async function finalize() {
    if (!workflowBagId) return;
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("workflowBagId", workflowBagId);
    const r = await finalizeBagAction(fd);
    setPending(false);
    if (r?.error) setError(r.error);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-muted">
          Count (optional)
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="how many this turn"
          className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base"
        />
      </div>

      {stages.map((s) => (
        <button
          key={s.eventType}
          type="button"
          disabled={pending}
          onClick={() => fire(s.eventType)}
          className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
        >
          <CheckCircle2 className="h-5 w-5" />
          {s.label}
        </button>
      ))}

      <button
        type="button"
        disabled={pending}
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
    </div>
  );
}
