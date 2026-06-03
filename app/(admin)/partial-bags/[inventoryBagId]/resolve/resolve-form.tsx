"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolvePartialBagInventoryAction } from "@/app/(admin)/partial-bags/actions";
import {
  PARTIAL_BAG_RESOLUTION_METHODS,
  PARTIAL_BAG_RESOLUTION_METHOD_LABELS,
} from "@/lib/production/partial-bag-resolution-constants";
import type { PartialBagReviewContext } from "@/lib/production/partial-bag-review-closeout";

export function ResolvePartialBagForm({
  context,
}: {
  context: PartialBagReviewContext;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4 max-w-lg"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await resolvePartialBagInventoryAction(formData);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          router.push("/partial-bags");
          router.refresh();
        });
      }}
    >
      <input type="hidden" name="inventoryBagId" value={context.inventoryBagId} />

      <div>
        <label
          htmlFor="remainingTabletCount"
          className="block text-xs font-medium text-text-strong mb-1"
        >
          Remaining tablet count (physically verified)
        </label>
        <input
          id="remainingTabletCount"
          name="remainingTabletCount"
          type="number"
          min={0}
          step={1}
          required
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          placeholder="Enter count from floor verification"
        />
        <p className="mt-1 text-[10px] text-text-muted">
          Do not use sealed card counts. Count or weigh-back the raw bag on the
          floor first.
        </p>
      </div>

      <div>
        <label
          htmlFor="resolutionMethod"
          className="block text-xs font-medium text-text-strong mb-1"
        >
          Resolution method
        </label>
        <select
          id="resolutionMethod"
          name="resolutionMethod"
          required
          defaultValue="PHYSICAL_COUNT"
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
        >
          {PARTIAL_BAG_RESOLUTION_METHODS.map((method) => (
            <option key={method} value={method}>
              {PARTIAL_BAG_RESOLUTION_METHOD_LABELS[method]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-text-muted">
          Supervisor estimate is recorded as low confidence.
        </p>
      </div>

      <div>
        <label
          htmlFor="consumedQty"
          className="block text-xs font-medium text-text-strong mb-1"
        >
          Consumed quantity (optional)
        </label>
        <input
          id="consumedQty"
          name="consumedQty"
          type="number"
          min={0}
          step={1}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          placeholder={
            context.declaredPillCount != null
              ? `Auto-derived from declared ${context.declaredPillCount.toLocaleString()} − remaining`
              : "Optional"
          }
        />
      </div>

      <div>
        <label htmlFor="note" className="block text-xs font-medium text-text-strong mb-1">
          Reason / note (required)
        </label>
        <textarea
          id="note"
          name="note"
          required
          maxLength={500}
          rows={3}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          placeholder="Who verified, when, and any context for this closeout"
        />
      </div>

      {error ? (
        <p className="text-sm text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center px-4 py-2 rounded border border-brand-300 bg-brand-50 text-brand-700 text-sm font-medium hover:bg-brand-100 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Record remaining & mark ready"}
        </button>
        <a
          href="/partial-bags"
          className="inline-flex items-center px-4 py-2 rounded border border-border bg-surface text-sm font-medium hover:bg-surface-2"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
