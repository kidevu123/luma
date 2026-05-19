"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { runZohoItemsSyncAction } from "./actions";

export function SyncButton() {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<
    | { ok: true; scanned: number; created: number; updated: number; materialsCreated: number }
    | { error: string }
    | null
  >(null);

  async function run() {
    setPending(true);
    setResult(null);
    try {
      const r = await runZohoItemsSyncAction();
      setResult(r);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={run} disabled={pending} size="sm">
        {pending ? "Syncing…" : "Sync Zoho items"}
      </Button>
      {result && "error" in result && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {result.error}
        </p>
      )}
      {result && "ok" in result && (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
          Sync complete — {result.scanned} scanned, {result.created} new mappings, {result.updated} updated
          {result.materialsCreated > 0 && `, ${result.materialsCreated} packaging material${result.materialsCreated !== 1 ? "s" : ""} created`}
        </p>
      )}
    </div>
  );
}
