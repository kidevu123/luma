"use client";

import * as React from "react";
import { sealHandpackBagAction } from "./actions";

export function SealHandpackForm({
  token,
  stationId,
  workflowBagId,
}: {
  token: string;
  stationId: string;
  workflowBagId: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const r = await sealHandpackBagAction(fd);
    setPending(false);
    if (r?.error) setError(r.error);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="stationId" value={stationId} />
      <input type="hidden" name="workflowBagId" value={workflowBagId} />
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-3">
        <p className="text-sm font-semibold text-amber-800">
          Hand-packed bag — enter plastic blister count
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            name="plasticBlisterCount"
            min={1}
            required
            placeholder="0"
            className="w-28 rounded-lg border border-border bg-surface px-3 py-2 text-sm tabular-nums text-center"
          />
          <span className="text-sm text-text-muted">blisters sealed</span>
        </div>
        {error && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium py-2.5 transition-colors disabled:opacity-60"
        >
          {pending ? "Saving…" : "Complete sealing"}
        </button>
      </div>
    </form>
  );
}
