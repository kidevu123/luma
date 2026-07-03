// PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1 — admin resolve page.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireLead } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { rawBagAllocationSessions } from "@/lib/db/schema";
import {
  canAdminResolvePartialBagInventory,
  loadPartialBagReviewContext,
} from "@/lib/production/partial-bag-review-closeout";
import {
  computeSystemDerivedResolutionForBag,
  type SystemDerivedResolution,
} from "@/lib/production/system-derived-allocation-resolution";
import { labelSystemDerivedStage } from "@/lib/production/system-derived-allocation";
import {
  computeOpenSessionRebaseEligibility,
  type OpenSessionRebaseEligibility,
} from "@/lib/production/open-session-rebase";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ResolvePartialBagForm } from "./resolve-form";
import { UseCalculatedRemainingButton } from "../../use-calculated-remaining-button";
import { PartialBagCorrectionMenu } from "../../correction-menu";
import { RebaseOpenSessionButton } from "../../rebase-open-session-button";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-CA", { timeZone: "UTC", hour12: false }) + " UTC";
}

export default async function ResolvePartialBagPage({
  params,
}: {
  params: Promise<{ inventoryBagId: string }>;
}) {
  await requireLead();
  const { inventoryBagId } = await params;
  const context = await loadPartialBagReviewContext(inventoryBagId);
  if (!context) notFound();

  const sessionRows = await db
    .select({ allocationStatus: rawBagAllocationSessions.allocationStatus })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId));
  const hasOpenSession = sessionRows.some((s) => s.allocationStatus === "OPEN");
  const gate = canAdminResolvePartialBagInventory({
    eligibility: context.eligibility,
    inventoryStatus: context.inventoryStatus,
    hasOpenSession,
    hasPartialPackagingWorkflow: true,
  });

  if (!gate.ok && context.eligibility === "ready") {
    redirect("/partial-bags");
  }

  // RESOLVE-CLOSEOUT-ACTIONS-1 — when an OPEN session exists, this page must
  // expose the SAME closeout actions as the workbench row (no dead-end). Compute
  // the system-derived eligibility here (defensive: a failure degrades to
  // "unavailable", never crashes the page — cf. v1.14.1).
  let systemDerived: SystemDerivedResolution | null = null;
  if (hasOpenSession) {
    try {
      systemDerived = await computeSystemDerivedResolutionForBag(inventoryBagId);
    } catch {
      systemDerived = {
        available: false,
        sessionId: null,
        workflowBagId: null,
        previousProductName: null,
        reason: "COMPUTE_FAILED",
        message: "Calculation unavailable for this bag.",
      };
    }
  }

  // REBASE-OPEN-SESSION-1 — if the OPEN session was opened from the wrong
  // starting balance (pre-v1.16.0 bug) and has no production output yet, offer
  // an in-place correction that KEEPS the session open. Defensive compute.
  let rebase: OpenSessionRebaseEligibility | null = null;
  if (hasOpenSession) {
    try {
      rebase = await computeOpenSessionRebaseEligibility(inventoryBagId);
    } catch {
      rebase = {
        available: false,
        reason: "COMPUTE_FAILED",
        message: "Rebase check unavailable for this bag.",
      };
    }
  }

  const receiptLabel =
    context.internalReceiptNumber ??
    (context.receiveId ? context.receiveId.slice(0, 8) : "—");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Resolve partial bag inventory"
        description="Record remaining tablets so this bag can restart production. Use physical count or weigh-back when possible. For historical partials where verification is no longer possible, use supervisor estimate with a documented reason."
      />

      <Card>
        <CardHeader>
          <CardTitle>Bag context</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <dt className="text-text-muted">QR token</dt>
              <dd className="font-mono text-text-strong">{context.bagQrCode ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Receipt</dt>
              <dd>
                {context.receiveId ? (
                  <Link
                    href={`/inbound/${context.receiveId}`}
                    className="underline underline-offset-2 hover:text-brand-700"
                  >
                    {receiptLabel}
                  </Link>
                ) : (
                  receiptLabel
                )}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Tablet type</dt>
              <dd>{context.tabletTypeName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Supplier lot</dt>
              <dd className="font-mono">{context.supplierLot ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Declared starting count</dt>
              <dd className="tabular-nums">
                {context.declaredPillCount != null
                  ? context.declaredPillCount.toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Inventory status</dt>
              <dd>{context.inventoryStatus}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Last product</dt>
              <dd>{context.lastUsedProductName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Workflow finalized</dt>
              <dd>{context.workflowFinalized ? "Yes (legacy)" : "No"}</dd>
            </div>
          </dl>

          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs font-medium text-text-strong">Partial sealing evidence</p>
            <p className="text-xs text-text-muted">
              {context.partialSealingAt
                ? `${fmtDate(context.partialSealingAt)} — ${context.partialSealedCount?.toLocaleString() ?? "?"} cards sealed (partial close${context.partialCloseReason ? `: ${context.partialCloseReason}` : ""})`
                : "No partial sealing close recorded."}
            </p>
            <p className="text-xs text-text-muted italic">
              Sealed card count is shown for traceability only — it may belong to
              an earlier run on this physical bag and is not a tablet consumption
              or remaining figure for the open session.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-text-strong">Packaging evidence</p>
            <p className="text-xs text-text-muted">
              {context.partialPackagingAt
                ? `${fmtDate(context.partialPackagingAt)}${context.partialPackagingFlag ? " (partial_packaging flag)" : " (legacy path — no partial_packaging flag)"}`
                : "No packaging complete recorded."}
            </p>
          </div>

          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">Next step: </span>
            {context.eligibilityNote}
          </div>
        </CardContent>
      </Card>

      {hasOpenSession ? (
        <Card>
          <CardHeader>
            <CardTitle>Resolve the open allocation session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-xs text-text-muted leading-snug">
              This bag has an open allocation session. If the run is still in
              progress and just opened from the wrong count, correct its starting
              balance and leave it open. Otherwise close it out — calculated
              remaining, a manual count / weigh-back / supervisor estimate, or
              mark depleted (only if the physical bag is empty — that releases the
              QR).
            </p>

            {/* REBASE-OPEN-SESSION-1 — correct the open session's starting
             *  balance IN PLACE (keeps the run open for later production). Shown
             *  only when it opened from the wrong count and has no output yet. */}
            {rebase?.available ? (
              <div className="rounded-lg border-2 border-brand-400 bg-brand-50/70 px-3 py-3 space-y-2">
                <p className="text-sm font-semibold text-brand-800">
                  Correct open session starting balance
                </p>
                <p className="text-[12px] text-text-strong leading-snug">
                  This session appears to have opened from the original declared
                  count instead of the prior{" "}
                  {rebase.priorStatus.replace(/_/g, " ").toLowerCase()} returned
                  balance.
                </p>
                <p className="text-[13px] text-text-strong tabular-nums">
                  Current start:{" "}
                  {rebase.currentStartingBalance != null
                    ? rebase.currentStartingBalance.toLocaleString()
                    : "unknown"}{" "}
                  → Corrected start:{" "}
                  <span className="font-semibold">
                    {rebase.newStartingBalance.toLocaleString()}
                  </span>
                </p>
                <p className="text-[11px] text-text-muted leading-snug">
                  Keeps the session OPEN so production numbers can be entered
                  later. The QR stays assigned. No production output or finished
                  lot will be created.
                </p>
                <RebaseOpenSessionButton
                  inventoryBagId={context.inventoryBagId}
                  currentStarting={rebase.currentStartingBalance}
                  newStarting={rebase.newStartingBalance}
                />
              </div>
            ) : rebase && !rebase.available ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] leading-snug text-amber-800">
                <span className="font-medium">
                  Starting-balance correction unavailable:
                </span>{" "}
                {rebase.message}
              </p>
            ) : null}

            {/* Calculated remaining (system-derived) — reuses the workbench
             *  button + shared resolution service; shown only when eligible. */}
            {systemDerived?.available ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 space-y-1.5">
                <p className="text-xs font-semibold text-emerald-900">
                  Calculated remaining available
                </p>
                <p className="text-[12px] text-emerald-900 tabular-nums">
                  {systemDerived.startingTabletCount.toLocaleString()} start −{" "}
                  {systemDerived.derivedConsumedTablets.toLocaleString()} consumed
                  ={" "}
                  <span className="font-semibold">
                    {systemDerived.derivedRemainingTablets.toLocaleString()}{" "}
                    remaining
                  </span>
                </p>
                <p className="text-[11px] text-emerald-700/80">
                  System-derived from {labelSystemDerivedStage(systemDerived.outputStage)} — not a physical count.
                </p>
                <UseCalculatedRemainingButton
                  inventoryBagId={context.inventoryBagId}
                  remaining={systemDerived.derivedRemainingTablets}
                />
              </div>
            ) : (
              <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] leading-snug text-amber-800">
                <span className="font-medium">Calculated remaining unavailable:</span>{" "}
                This open session has no production output counts yet. Any sealed-card
                evidence shown above belongs to an earlier run and is for traceability
                only — it is not consumption for this open session. Use the
                starting-balance correction above if offered, or record a manual count
                / weigh-back / supervisor estimate below.
              </p>
            )}

            {/* Manual closeout — reuses the same admin correction actions as the
             *  workbench row: Correct remaining, Mark depleted, hold, void. */}
            <div className="border-t border-border pt-3">
              <p className="text-xs font-medium text-text-strong mb-1.5">
                Manual closeout
              </p>
              <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
                <span className="font-semibold">Heads up:</span> “Correct
                remaining” <span className="font-semibold">closes</span> this open
                session — don’t use it if you need to keep this run open for later
                production (use the starting-balance correction above instead).
                “Mark depleted” releases the QR and is only for a physically empty
                bag; “Void record” discards the bag. Each opens an inline form when
                clicked.
              </p>
              <PartialBagCorrectionMenu
                inventoryBagId={context.inventoryBagId}
                inventoryStatus={context.inventoryStatus}
              />
            </div>

            <Link
              href="/partial-bags"
              className="inline-block text-xs underline underline-offset-2 text-text-muted"
            >
              Back to partial bags
            </Link>
          </CardContent>
        </Card>
      ) : gate.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>Record remaining tablets</CardTitle>
          </CardHeader>
          <CardContent>
            <ResolvePartialBagForm
              context={{
                inventoryBagId: context.inventoryBagId,
                declaredPillCount: context.declaredPillCount,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-text-muted">{gate.reason}</p>
            <Link
              href="/partial-bags"
              className="inline-block mt-4 text-sm underline underline-offset-2"
            >
              Back to partial bags
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
