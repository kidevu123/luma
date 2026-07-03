"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wrench } from "lucide-react";
import { repairQrReservationAction } from "./bag/[bagId]/edit/actions";

/** QR-RESERVE-REPAIR-1 — one-click re-reserve a bag's own IDLE QR (restores a
 *  lost intake reservation) so it becomes floor-ready. Guarded + audited. */
export function RepairQrReservationButton({
  receiveId,
  bagId,
}: {
  receiveId: string;
  bagId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return <span className="text-[10px] font-medium text-green-700">QR re-reserved</span>;
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await repairQrReservationAction(receiveId, bagId);
            if (r.ok) {
              setDone(true);
              router.refresh();
            } else {
              setError(r.error);
            }
          });
        }}
        className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 hover:bg-amber-100 transition-colors disabled:opacity-60"
      >
        <Wrench className="h-3 w-3" aria-hidden />
        {pending ? "Re-reserving…" : "Re-reserve QR"}
      </button>
      {error ? <p className="text-[10px] text-red-700 mt-0.5">{error}</p> : null}
    </div>
  );
}
