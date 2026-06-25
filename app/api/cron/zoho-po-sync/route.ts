// PO-SYNC-CRON — daily Zoho purchase-order pull endpoint.
//
// Triggered by the systemd timer on LXC 122 at 03:59 (server local time):
//
//   POST http://localhost:3000/api/cron/zoho-po-sync
//   Authorization: Bearer <LUMA_CRON_SECRET>
//
// Read-only toward Zoho; upserts local purchase_orders + po_lines.

import { type NextRequest, NextResponse } from "next/server";
import { cronAuthHttpStatus, validateCronBearer } from "@/lib/zoho/cron-auth";
import { runPoSyncSweep } from "@/lib/zoho/po-sync-sweep";
import { writeAudit } from "@/lib/db/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = validateCronBearer(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.reason },
      { status: cronAuthHttpStatus(auth.reason) },
    );
  }

  try {
    const summary = await runPoSyncSweep();

    await writeAudit({
      actorId: null,
      actorRole: null,
      action: "zoho_po_sync.sweep_ran",
      targetType: "ZohoPoSyncSweep",
      targetId: summary.startedAt,
      after: {
        enabled: summary.enabled,
        status: summary.status,
        skippedReason: summary.skippedReason ?? null,
        syncRunId: summary.syncRunId ?? null,
        fetched: summary.result?.fetched ?? 0,
        poUpserted: summary.result?.poUpserted ?? 0,
        lineUpserted: summary.result?.lineUpserted ?? 0,
        errorCount: summary.result?.errors.length ?? 0,
      },
    });

    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "PO sync sweep failed.", message },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: "Use POST." },
    { status: 405 },
  );
}
