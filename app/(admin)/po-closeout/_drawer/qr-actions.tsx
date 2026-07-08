"use client";

// CLOSEOUT-DRAWER-1 — QR reservation repair, inline. Calls the EXISTING
// repairQrReservationAction (Receive Detail's action) verbatim.

import * as React from "react";
import Link from "next/link";
import { repairQrReservationAction } from "@/app/(admin)/inbound/[id]/bag/[bagId]/edit/actions";

export function QrActions({
  receiveId,
  inventoryBagId,
  onDone,
}: {
  receiveId: string;
  inventoryBagId: string;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="rounded border border-border bg-surface px-3 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-text-strong">Repair QR reservation</p>
      <p className="text-[10.5px] text-text-muted">
        Re-reserves this bag&apos;s own idle QR card for intake (safe repair — same
        action as Receive Detail).
      </p>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10.5px] text-red-800">{error}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            const r = await repairQrReservationAction(receiveId, inventoryBagId);
            setPending(false);
            if (!r.ok) setError(r.error);
            else onDone();
          }}
          className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Repairing…" : "Re-reserve QR"}
        </button>
        <Link href={`/inbound/${receiveId}`} className="text-[10.5px] font-medium text-brand-700 hover:underline">
          Open receive
        </Link>
      </div>
    </div>
  );
}
