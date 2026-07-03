"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wrench } from "lucide-react";
import { repairLostQrReservationsAction } from "./bag/[bagId]/edit/actions";

/** BATCH-LOST-QR-RESERVATION-REPAIR-1 — admin one-click repair of all safe lost
 *  intake QR reservations. Skips unsafe/conflicting rows. Never touches
 *  workflow allocations. */
export function RepairLostQrReservationsButton({
  receiveId,
  safeCount,
}: {
  receiveId: string;
  safeCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ repaired: number; skipped: number; capped: boolean } | null>(null);

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !confirm(
              `Re-reserve ${safeCount} bag${safeCount === 1 ? "" : "s"} whose QR card drifted to idle? Only AVAILABLE bags that uniquely claim a safe RAW_BAG card are repaired; anything in production, depleted, retired, or conflicting is skipped. No workflow/allocation/Zoho data is touched.`,
            )
          )
            return;
          setError(null);
          setResult(null);
          startTransition(async () => {
            const r = await repairLostQrReservationsAction(receiveId);
            if (r.ok) {
              setResult({ repaired: r.repaired, skipped: r.skipped, capped: r.capped });
              router.refresh();
            } else {
              setError(r.error);
            }
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-900 hover:bg-amber-100 transition-colors disabled:opacity-60"
      >
        <Wrench className="h-3.5 w-3.5" aria-hidden />
        {pending ? "Repairing…" : `Repair lost QR reservations (${safeCount})`}
      </button>
      {error ? <p className="text-[11px] text-red-700">{error}</p> : null}
      {result ? (
        <p className="text-[11px] text-text-muted">
          <span className="font-medium text-green-700">Re-reserved {result.repaired}</span>
          {result.skipped > 0 ? ` · skipped ${result.skipped}` : ""}
          {result.capped ? " · more remain (run again)" : ""}
        </p>
      ) : null}
    </div>
  );
}
