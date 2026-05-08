// PT-3: PackTrack -> Luma packaging-receipt webhook.
//
// PackTrack POSTs a per-box receipt payload here. Luma validates,
// resolves the material via external_item_mappings, and writes one
// packaging_lots row + the matching material_inventory_events rows
// in a single DB transaction.
//
// Auth: shared-secret token in the `x-packtrack-secret` header,
// validated against PACKTRACK_INTEGRATION_SECRET in /etc/luma/.env.
// (HMAC body-signing can be layered on later; for now the secret
// header is sufficient given the LXC firewall.)
//
// Idempotent: re-POSTing the same (packtrack_receipt_id, box_number)
// returns the existing lot id without writing again. The partial
// unique index `packaging_lots_packtrack_box_unique` enforces this
// at the DB level too.
//
// Inventory rule: this route NEVER decrements qty_on_hand. Only
// production consumption decrements. Reorder/shortage corrections
// go through PACKAGING_RECEIPT_ADJUSTED, never silent overwrites.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importPackTrackPackagingReceipt } from "@/lib/integrations/packtrack/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: reason }, { status: 401 });
}

export async function POST(req: Request) {
  // Shared-secret auth.
  const expected = process.env.PACKTRACK_INTEGRATION_SECRET;
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "PACKTRACK_INTEGRATION_SECRET is not configured on Luma. Supervisor must set it before enabling the integration.",
      },
      { status: 503 },
    );
  }
  const got = req.headers.get("x-packtrack-secret");
  if (!got || got !== expected) {
    return unauthorized("Missing or invalid x-packtrack-secret.");
  }

  // Parse body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body must be JSON." },
      { status: 400 },
    );
  }

  const dryRun = req.headers.get("x-packtrack-dry-run") === "true";

  try {
    const result = await db.transaction(async (tx) => {
      const r = await importPackTrackPackagingReceipt(tx, {
        rawPayload: raw,
      });
      if (dryRun) {
        // Force rollback so dry-run never lands a row.
        throw new Error("__DRY_RUN_ROLLBACK__");
      }
      return r;
    });
    if (!result.ok) {
      const status =
        result.code === "MAPPING_MISSING"
          ? 422
          : result.code === "INVALID"
            ? 400
            : 500;
      console.warn(
        "[packtrack.receipts]",
        JSON.stringify({
          outcome:
            result.code === "MAPPING_MISSING"
              ? "MAPPING_MISSING"
              : result.code === "INVALID"
                ? "INVALID"
                : "INSERT_FAILED",
          reason: result.reason,
          dry_run: dryRun,
        }),
      );
      return NextResponse.json(
        { ok: false, error: result.reason, code: result.code },
        { status },
      );
    }
    console.log(
      "[packtrack.receipts]",
      JSON.stringify({
        outcome: result.created ? "IMPORTED" : "DUPLICATE_SKIPPED",
        luma_packaging_lot_id: result.lotId,
        confidence: result.acceptance.confidence,
        events_emitted: result.eventsEmitted,
      }),
    );
    return NextResponse.json({
      ok: true,
      luma_packaging_lot_id: result.lotId,
      created: result.created,
      accepted_quantity: result.acceptance.acceptedQuantity,
      confidence: result.acceptance.confidence,
      events_emitted: result.eventsEmitted,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__DRY_RUN_ROLLBACK__") {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        message: "Validation + mapping passed; no rows written.",
      });
    }
    console.error("[packtrack.receipts] failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Import failed.",
      },
      { status: 500 },
    );
  }
}

// Reject everything except POST.
export function GET() {
  return NextResponse.json(
    { ok: false, error: "POST only." },
    { status: 405 },
  );
}
