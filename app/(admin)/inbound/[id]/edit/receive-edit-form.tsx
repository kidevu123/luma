"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { editReceiveAction } from "./actions";

export function ReceiveEditForm({
  receiveId,
  receiveName,
  poContext,
  initialNotes,
  initialIsClosed,
}: {
  receiveId: string;
  receiveName: string;
  poContext: string | null;
  initialNotes: string | null;
  initialIsClosed: boolean;
}) {
  const router = useRouter();
  const [notes, setNotes] = React.useState(initialNotes ?? "");
  const [isClosed, setIsClosed] = React.useState(initialIsClosed);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await editReceiveAction(receiveId, { notes, isClosed });
      if (result.ok) {
        router.push(`/inbound/${receiveId}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      <div className="rounded-md border border-border/70 bg-surface-2/40 px-4 py-3 text-sm space-y-1">
        <p className="font-semibold text-text">{receiveName}</p>
        {poContext && <p className="text-xs text-text-muted">{poContext}</p>}
        <p className="text-[11px] text-text-subtle pt-1 border-t border-border/50">
          Receive name, PO, shipment, and bags are not editable here. Use{" "}
          <span className="font-medium">Edit bag</span> on the receive detail page
          for per-bag corrections.
        </p>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-text" htmlFor="receive-notes">
          Receive notes
        </label>
        <textarea
          id="receive-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Clerical notes about this receive (optional)"
        />
      </div>

      <fieldset className="space-y-2 rounded-md border border-border/70 px-4 py-3">
        <legend className="text-xs font-medium text-text px-1">Receive status</legend>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="receive-open"
            checked={!isClosed}
            onChange={() => setIsClosed(false)}
            className="h-4 w-4"
          />
          Open — intake corrections may still be needed
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="receive-open"
            checked={isClosed}
            onChange={() => setIsClosed(true)}
            className="h-4 w-4"
          />
          Closed — mark this receive complete for supervisors
        </label>
        <p className="text-[11px] text-text-subtle">
          Closing records the current time the first time you close an open receive.
          Reopening clears the close timestamp.
        </p>
      </fieldset>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => router.push(`/inbound/${receiveId}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
