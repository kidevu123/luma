// BATCH-LOST-QR-RESERVATION-REPAIR-1 — bearer-authed ops endpoint to run the
// audited batch repair of lost intake QR reservations on the LXC (which has no
// node/tsx runtime). Same bearer secret as the cron routes.
//
//   GET  http://localhost:3000/api/admin/repair-lost-qr-reservations   (read-only dry-run)
//   POST http://localhost:3000/api/admin/repair-lost-qr-reservations   (execute, audited)
//   Authorization: Bearer <LUMA_CRON_SECRET>
//
// The repair only flips a bag's own IDLE RAW_BAG card to ASSIGNED via the shared
// guard. It never touches workflow bags, allocation sessions, finished lots, or
// Zoho, and never sets assignedWorkflowBagId.

import { type NextRequest, NextResponse } from "next/server";
import { cronAuthHttpStatus, validateCronBearer } from "@/lib/zoho/cron-auth";
import {
  listLostQrReservationCandidates,
  repairLostQrReservationsBatch,
} from "@/lib/db/queries/lost-qr-reservations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authOrReject(req: NextRequest): NextResponse | null {
  const auth = validateCronBearer(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.reason },
      { status: cronAuthHttpStatus(auth.reason) },
    );
  }
  return null;
}

/** Read-only dry-run: detector counts + per-row reasons. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejected = authOrReject(req);
  if (rejected) return rejected;
  const scan = await listLostQrReservationCandidates();
  return NextResponse.json({
    ok: true,
    dryRun: true,
    total: scan.total,
    safeToRepair: scan.safeToRepair,
    unsafe: scan.unsafe,
    reasonCounts: scan.reasonCounts,
    safeExamples: scan.candidates
      .filter((c) => c.safe)
      .slice(0, 50)
      .map((c) => ({
        inventoryBagId: c.inventoryBagId,
        bagNumber: c.bagNumber,
        bagQrCode: c.bagQrCode,
        receipt: c.internalReceiptNumber,
        receive: c.receiveName,
      })),
  });
}

/** Execute the audited batch repair (system actor). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejected = authOrReject(req);
  if (rejected) return rejected;
  const result = await repairLostQrReservationsBatch({ id: null, role: null });
  return NextResponse.json(result);
}
