import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { listConsolidatedProductionOutputOps } from "@/lib/db/queries/zoho-production-output-consolidated";
import {
  isProductionOutputCommitEnabled,
  isProductionOutputPersistEnabled,
  isProductionOutputPreviewEnabled,
  resolveProductionOutputGateConfig,
} from "@/lib/zoho/production-output-config";
import { deriveUiOperationStatus } from "@/lib/zoho/production-output-v1206-readiness";
import { parsePreviewWritesAllowed } from "@/lib/zoho/luma-operation-snapshot";
import { isChocoDriftSku } from "@/lib/zoho/v1206-choco-drift-pilot-contract";
// PushToZohoGoLiveBanner + approvedSkuLabelForProductId removed in
// v1.1.0 — the 2-SKU live-commit allowlist is gone. Live-commit
// eligibility is now data-driven via products.zoho_live_commit_enabled
// AND product-readiness facets (see lib/zoho/zoho-live-commit-eligibility.ts).
// Operators toggle the flag on the product page; this queue page no
// longer needs a hard-coded SKU badge.
import { retryPreviewProductionOutputOpAction } from "./actions";
import { ProductionOutputStagingButtons } from "./staging-buttons";
// ZOHO-STAGING-BUFFER-v1.1.0 — processNextQueuedProductionOutputAction
// is intentionally NOT imported here. The single operator/cron entry
// path for production-output commit is sharedCommitProductionOutputOp,
// called by approveAndCommitProductionOutputNow (manual UI) and the
// cron sweep. The legacy "Process next queued" header button bypassed
// the shared wrapper and was removed in v1.1.0.

export const dynamic = "force-dynamic";

export const metadata = { title: "Zoho Production Output" };

function StatusChip({ status, uiStatus }: { status: string; uiStatus: string }) {
  const tone =
    uiStatus === "committed"
      ? "bg-green-50 text-green-800 border-green-200"
      : uiStatus.includes("ambiguous") || uiStatus.includes("needs Luma reconcile")
        ? "bg-orange-50 text-orange-900 border-orange-200"
      : uiStatus === "blocked" || uiStatus === "preview failed" || uiStatus === "partial failure" || uiStatus === "commit failed"
        ? "bg-red-50 text-red-800 border-red-200"
        : uiStatus === "human review required"
          ? "bg-orange-50 text-orange-900 border-orange-200"
          : uiStatus === "commit pending" ||
              uiStatus === "commit in progress" ||
              status === "QUEUED" ||
              status === "COMMITTING"
            ? "bg-amber-50 text-amber-900 border-amber-200"
            : uiStatus === "ready" || uiStatus === "ready to commit"
              ? "bg-blue-50 text-blue-900 border-blue-200"
              : "bg-surface-2 text-text-muted border-border";
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {uiStatus}
    </span>
  );
}

function GateChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-medium ${
        on
          ? "bg-emerald-50 text-emerald-900 border-emerald-200"
          : "bg-surface-2 text-text-muted border-border"
      }`}
    >
      {label}: {on ? "on" : "off"}
    </span>
  );
}

export default async function ZohoProductionOperationsPage() {
  await requireSession();
  const gates = resolveProductionOutputGateConfig();
  const persistOn = isProductionOutputPersistEnabled();
  const previewOn = isProductionOutputPreviewEnabled();
  const commitOn = isProductionOutputCommitEnabled();
  const ops = await listConsolidatedProductionOutputOps(100);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho production output"
        description="Current consolidated production-output queue. Persist and preview are independent of live commit. Commit is operator-driven only — Approve for auto-commit (cron) or Approve & commit now (immediate), both via the same shared idempotent path. The legacy atomic-ops history view is at /zoho-operations."
      />

      <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          <GateChip label="Persist" on={persistOn} />
          <GateChip label="Preview" on={previewOn} />
          <GateChip label="Commit" on={commitOn} />
        </div>
        {gates.legacyEnabledFlagSeen ? (
          <p className="text-[11px] text-amber-800">
            Deprecated `ZOHO_PRODUCTION_OUTPUT_ENABLED` detected — mapped to persist+preview
            only. Use split flags for new deployments.
          </p>
        ) : null}
        {gates.invalidCombination ? (
          <p className="text-[11px] text-red-800">{gates.invalidCombination}</p>
        ) : null}
        {!commitOn ? (
          <p className="text-[11px] text-text-muted">
            Live commit is disabled (`ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false`). Commit
            actions are hidden.
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-[12px] w-full">
            <thead>
              <tr className="border-b border-border/60 text-left">
                <th className="px-4 py-2 font-medium text-text-muted">Lot / SKU</th>
                <th className="px-4 py-2 font-medium text-text-muted">Units / tablets</th>
                <th className="px-4 py-2 font-medium text-text-muted">PO / line</th>
                <th className="px-4 py-2 font-medium text-text-muted">Preview</th>
                <th className="px-4 py-2 font-medium text-text-muted">Status</th>
                <th className="px-4 py-2 font-medium text-text-muted">Blockers</th>
                <th className="px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                    No consolidated production-output ops yet.
                  </td>
                </tr>
              ) : (
                ops.map((op) => {
                  const uiStatus = deriveUiOperationStatus({
                    status: op.status as "READY",
                    previewStatus: op.previewStatus,
                    commitStatus: op.commitStatus,
                    commitError: op.commitError,
                    commitResponse: op.commitResponse,
                    zohoBundleIds: op.zohoBundleIds,
                    humanReviewRequired: op.humanReviewRequired,
                    partialFailure: op.partialFailure,
                    voidedAt: op.voidedAt,
                  });
                  const writesAllowed = parsePreviewWritesAllowed(op.previewResponse);
                  const choco = isChocoDriftSku(op.finishedSku ?? "");
                  const expectedTablets = choco ? op.quantityGood * 4 : null;
                  return (
                    <tr key={op.id} className="border-b border-border/30 last:border-0 align-top">
                      <td className="px-4 py-2 space-y-0.5">
                        <Link
                          href={`/finished-lots/${op.finishedLotId}`}
                          className="font-mono text-[11px] text-brand-700 hover:underline block"
                        >
                          {op.finishedLotId.slice(0, 8)}
                        </Link>
                        <span className="font-mono text-[10px] text-text-muted block">
                          {op.finishedSku ?? "—"}
                        </span>
                        {op.productId ? (
                          <Link
                            href={`/products/${op.productId}`}
                            className="text-[10px] text-text-muted hover:text-brand-700 hover:underline block"
                          >
                            Check live-commit settings →
                          </Link>
                        ) : null}
                        {op.workflowBagId ? (
                          <span className="text-[10px] text-text-subtle block">
                            bag {op.workflowBagId.slice(0, 8)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-[11px]">
                        <div>{op.quantityGood} units</div>
                        {choco ? (
                          <div className="text-text-muted">
                            tablets req: {expectedTablets} (4×)
                          </div>
                        ) : null}
                        {choco ? (
                          <div className="text-text-muted">packaging req: {op.quantityGood} (1×)</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 font-mono text-[10px]">
                        <div>{op.zohoPurchaseorderId ?? "—"}</div>
                        <div className="text-text-muted">{op.zohoPurchaseorderLineItemId ?? "—"}</div>
                      </td>
                      <td className="px-4 py-2 text-[10px]">
                        <div>{op.previewStatus ?? "—"}</div>
                        <div className={writesAllowed ? "text-emerald-700" : "text-text-muted"}>
                          writes_allowed: {writesAllowed ? "true" : "false"}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusChip status={op.status} uiStatus={uiStatus} />
                        <div className="text-[10px] text-text-muted mt-0.5">{op.status}</div>
                      </td>
                      <td className="px-4 py-2 text-[11px] text-red-700 max-w-xs truncate">
                        {op.commitError ??
                          (op.mappingBlockers
                            ? JSON.stringify(op.mappingBlockers)
                            : "—")}
                      </td>
                      <td className="px-4 py-2">
                        {/* ZOHO-STAGING-BUFFER-v1.1.0 — two-button approve
                            model + Hold/Unhold/Void. The legacy explicit
                            "Queue" and "Commit now (by id)" buttons are
                            gone; the state machine still goes
                            Approve → Queue → Commit internally. */}
                        <ProductionOutputStagingButtons
                          row={{
                            id: op.id,
                            status: op.status,
                            heldAt: op.heldAt ?? null,
                            voidedAt: op.voidedAt ?? null,
                            autoCommitEligibleAt: op.autoCommitEligibleAt ?? null,
                            mappingBlockers: op.mappingBlockers ?? null,
                          }}
                        />
                        {previewOn &&
                        persistOn &&
                        op.status !== "COMMITTED" &&
                        op.status !== "COMMITTING" &&
                        op.status !== "QUEUED" &&
                        !op.voidedAt ? (
                          <form action={retryPreviewProductionOutputOpAction} className="mt-1">
                            <input type="hidden" name="opId" value={op.id} />
                            <button type="submit" className="text-[10.5px] text-text-muted underline">
                              Retry preview
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-text-muted px-1">
        Contract:{" "}
        <code className="font-mono">docs/ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md</code>
      </p>
    </div>
  );
}
