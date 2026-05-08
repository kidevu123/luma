"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { scanCardAction } from "./actions";

export type EligibleCard = { id: string; label: string; scanToken: string };

export type EligiblePickup = {
  id: string;
  label: string;
  scanToken: string;
  bagId: string;
  bagStage: string;
};

export function ScanCardForm({
  token,
  stationId,
  idleCards,
  eligiblePickups = [],
}: {
  token: string;
  stationId: string;
  idleCards: EligibleCard[];
  /** ASSIGNED cards whose bag is at a stage this station can pick up
   *  (e.g. SEALING station accepts BLISTERED bags). Surfaced so the
   *  operator can claim a released bag with the same QR. */
  eligiblePickups?: EligiblePickup[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const hasIdle = idleCards.length > 0;
  const hasPickups = eligiblePickups.length > 0;

  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        try {
          const r = await scanCardAction(form);
          if (r?.error) setError(r.error);
          else router.refresh();
        } finally {
          setPending(false);
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="stationId" value={stationId} />
      <select
        name="cardId"
        required
        className="block w-full h-12 px-3 rounded-lg bg-surface border border-border text-base text-text"
        defaultValue=""
      >
        <option value="" disabled>
          {hasPickups
            ? "Pick a card to scan…"
            : "Pick an idle card…"}
        </option>
        {hasPickups && (
          <optgroup label="Pick up released bag (same QR continues)">
            {eligiblePickups.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — bag {c.bagId.slice(0, 8)} · {c.bagStage}
              </option>
            ))}
          </optgroup>
        )}
        {hasIdle && (
          <optgroup label={hasPickups ? "Start a new bag" : "Idle cards"}>
            {idleCards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {hasPickups && (
        <p className="text-[11px] text-text-muted">
          A "Pick up" option claims a bag released from the previous
          station. The same QR card stays attached to the bag.
        </p>
      )}
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full h-14 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 text-white text-base font-semibold shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
      >
        <ScanLine className="h-5 w-5" />
        {pending ? "Scanning…" : "Scan card"}
      </button>
    </form>
  );
}
