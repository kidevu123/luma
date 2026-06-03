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
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ResolvePartialBagForm } from "./resolve-form";

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
              Sealed card count is shown for traceability only — do not use it as
              remaining tablet count.
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
            <span className="font-medium">Blocked reason: </span>
            {context.eligibilityNote}
          </div>
        </CardContent>
      </Card>

      {gate.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>Record remaining tablets</CardTitle>
          </CardHeader>
          <CardContent>
            <ResolvePartialBagForm context={context} />
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
