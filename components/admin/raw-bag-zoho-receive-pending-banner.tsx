"use client";

import * as React from "react";
import Link from "next/link";
import { Clock } from "lucide-react";

/** Intake-time banner: pending Zoho receive until bag finish — no preview/commit here. */
export function RawBagZohoReceivePendingBanner({
  inventoryBagId,
  lumaReceipt,
}: {
  inventoryBagId: string;
  lumaReceipt?: string | null;
}) {
  return (
    <div className="rounded-lg border border-amber-200/80 bg-amber-50/40 px-3 py-2 text-xs text-amber-950 space-y-1">
      <div className="flex items-start gap-2">
        <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Pending Zoho receive</p>
          <p>
            Luma receipt {lumaReceipt ?? "—"} is tracked. Zoho purchase receive
            happens when this physical bag is finished or depleted on the floor —
            not at intake.
          </p>
          <p className="text-[10px] text-amber-900/80 mt-1">
            One Zoho purchase receive per physical bag only.
          </p>
          <Link
            href={`/partial-bags/${inventoryBagId}/zoho-receive`}
            className="inline-block mt-1 font-medium underline underline-offset-2"
          >
            Open bag-finish Zoho receive
          </Link>
        </div>
      </div>
    </div>
  );
}
