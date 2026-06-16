// ZOHO-STAGING-BUFFER-v1.1.0 — auto-commit cron endpoint.
//
// Triggered by the systemd timer on LXC 122 every 5 minutes:
//
//   POST http://localhost:3000/api/cron/zoho-auto-commit
//   Authorization: Bearer <LUMA_CRON_SECRET>
//
// The route is the orchestrator only — all real work happens in
// `lib/zoho/auto-commit-sweep.ts` so the same code is callable from
// tests with mocked dependencies. The route is thin on purpose: auth,
// invoke, audit-log, JSON-respond.
//
// Status codes:
//   200 — sweep ran (the body details what happened; "no rows" is 200)
//   401 — bad / missing bearer token
//   503 — LUMA_CRON_SECRET is not configured on this deployment
//   500 — unexpected exception during the sweep

import { type NextRequest, NextResponse } from "next/server";
import { cronAuthHttpStatus, validateCronBearer } from "@/lib/zoho/cron-auth";
import { runAutoCommitSweep } from "@/lib/zoho/auto-commit-sweep";
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
    const summary = await runAutoCommitSweep();

    // One audit row per pass — searchable. The per-row outcomes also
    // go into the audit log via the shared commit fns' own audit
    // writes; this is the umbrella row.
    // actorId/actorRole both null: this isn't an operator action. The
    // umbrella row's targetId is the sweep timestamp, and the per-row
    // audit writes inside the shared commit fns carry the detail.
    await writeAudit({
      actorId: null,
      actorRole: null,
      action: "zoho_auto_commit.sweep_ran",
      targetType: "ZohoAutoCommitSweep",
      targetId: summary.startedAt,
      after: {
        rawBagConsidered: summary.rawBagEligibleConsidered,
        productionOutputConsidered: summary.productionOutputEligibleConsidered,
        totals: summary.totals,
        gates: {
          autoCommitEnabled: summary.gates.autoCommitEnabled,
          rawBagWritesAllowed: summary.gates.rawBagWritesAllowed,
          productionOutputWritesAllowed: summary.gates.productionOutputWritesAllowed,
        },
      },
    });

    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "Sweep failed.", message },
      { status: 500 },
    );
  }
}

// GET intentionally unimplemented — the cron is action-only.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: "Use POST." },
    { status: 405 },
  );
}
