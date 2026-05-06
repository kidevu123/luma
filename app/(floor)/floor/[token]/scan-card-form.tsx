"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { scanCardAction } from "./actions";

export function ScanCardForm({
  token,
  stationId,
  idleCards,
}: {
  token: string;
  stationId: string;
  idleCards: { id: string; label: string; scanToken: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
          Pick an idle card…
        </option>
        {idleCards.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} ({c.scanToken})
          </option>
        ))}
      </select>
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
