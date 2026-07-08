"use client";

// CLOSEOUT-DRAWER-1 — partial-bag resolution, inline. Calls the EXISTING
// Partial Bag Workbench server actions verbatim: use system-calculated
// remaining, correct remaining (manual count), or mark depleted. The full
// workbench remains one click away for edge cases.

import * as React from "react";
import Link from "next/link";
import {
  correctPartialBagRemainingAction,
  markPartialBagDepletedAction,
  useCalculatedRemainingAction,
} from "@/app/(admin)/partial-bags/actions";

type Tab = "CALCULATED" | "MANUAL" | "DEPLETED";

export function PartialActions({
  inventoryBagId,
  onDone,
}: {
  inventoryBagId: string;
  onDone: () => void;
}) {
  const [tab, setTab] = React.useState<Tab>("CALCULATED");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (fn: () => Promise<{ ok: boolean } & { error?: string }>) => {
    setPending(true);
    setError(null);
    const r = await fn();
    setPending(false);
    if (!r.ok) setError(("error" in r && r.error) || "Action failed.");
    else onDone();
  };

  return (
    <div className="rounded border border-border bg-surface px-3 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-text-strong">Resolve remaining</p>
      <div className="flex gap-1">
        {(
          [
            ["CALCULATED", "Use calculated"],
            ["MANUAL", "Correct remaining"],
            ["DEPLETED", "Mark depleted"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
              tab === key
                ? "border-brand-500 bg-brand-50 text-brand-800"
                : "border-border text-text-muted hover:bg-surface-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10.5px] text-red-800">{error}</p>
      ) : null}

      {tab === "CALCULATED" ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("inventoryBagId", inventoryBagId);
            void submit(() => useCalculatedRemainingAction(fd));
          }}
        >
          <p className="text-[10.5px] text-text-muted">
            Closes the open allocation using the system-derived remaining from
            production output (fails closed if it cannot be derived safely).
          </p>
          <input
            name="note"
            placeholder="Note (optional)…"
            className="w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Closing…" : "Use calculated remaining"}
          </button>
        </form>
      ) : null}

      {tab === "MANUAL" ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("inventoryBagId", inventoryBagId);
            fd.set("method", "PHYSICAL_RECOUNT");
            void submit(() => correctPartialBagRemainingAction(fd));
          }}
        >
          <p className="text-[10.5px] text-text-muted">
            Records a physically counted remaining balance (admin correction,
            audited).
          </p>
          <input
            name="newRemaining"
            type="number"
            min={0}
            required
            placeholder="Counted remaining (tablets)"
            className="w-full rounded border border-border bg-white px-2 py-1 text-[11px] tabular-nums"
          />
          <input
            name="reason"
            required
            minLength={10}
            placeholder="Reason (min 10 chars, audited)…"
            className="w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Record counted remaining"}
          </button>
        </form>
      ) : null}

      {tab === "DEPLETED" ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("inventoryBagId", inventoryBagId);
            void submit(() => markPartialBagDepletedAction(fd));
          }}
        >
          <p className="text-[10.5px] text-text-muted">
            Marks the bag fully used (remaining 0). Audited admin correction.
          </p>
          <input
            name="reason"
            required
            minLength={10}
            placeholder="Reason (min 10 chars, audited)…"
            className="w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-red-800 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Mark depleted"}
          </button>
        </form>
      ) : null}

      <Link
        href={`/partial-bags/${inventoryBagId}/resolve`}
        className="inline-block text-[10.5px] font-medium text-brand-700 hover:underline"
      >
        Open full workbench
      </Link>
    </div>
  );
}
