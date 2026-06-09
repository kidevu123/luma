import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { listConsolidatedProductionOutputOps } from "@/lib/db/queries/zoho-production-output-consolidated";
import { isConsolidatedProductionOutputEnabled } from "@/lib/zoho/production-output-config";
import { deriveUiOperationStatus } from "@/lib/zoho/production-output-v1206-readiness";
import {
  processNextQueuedProductionOutputAction,
  processProductionOutputOpAction,
  queueProductionOutputOpAction,
} from "./actions";

export const dynamic = "force-dynamic";

function StatusChip({ status, uiStatus }: { status: string; uiStatus: string }) {
  const tone =
    uiStatus === "committed"
      ? "bg-green-50 text-green-800 border-green-200"
      : uiStatus === "blocked" || uiStatus === "preview failed" || uiStatus === "partial failure"
        ? "bg-red-50 text-red-800 border-red-200"
        : uiStatus === "human review required"
          ? "bg-orange-50 text-orange-900 border-orange-200"
          : uiStatus === "commit pending" || status === "QUEUED" || status === "COMMITTING"
            ? "bg-amber-50 text-amber-900 border-amber-200"
            : uiStatus === "ready"
              ? "bg-blue-50 text-blue-900 border-blue-200"
              : "bg-surface-2 text-text-muted border-border";
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {uiStatus}
    </span>
  );
}

export default async function ZohoProductionOperationsPage() {
  await requireSession();
  const enabled = isConsolidatedProductionOutputEnabled();
  const ops = await listConsolidatedProductionOutputOps(100);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho production output"
        description="Consolidated production-output ops sent to the shared Zoho service. Legacy atomic zoho_assembly_ops remain on /zoho-operations for dry-run/history only when consolidated path is active."
        actions={
          <form action={processNextQueuedProductionOutputAction}>
            <button
              type="submit"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium hover:bg-surface-2"
            >
              Process next queued
            </button>
          </form>
        }
      />

      {!enabled ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-900">
          `ZOHO_PRODUCTION_OUTPUT_ENABLED` is false. Ops may be created as READY/NEEDS_MAPPING but live commit is disabled.
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-[12px] w-full">
            <thead>
              <tr className="border-b border-border/60 text-left">
                <th className="px-4 py-2 font-medium text-text-muted">Lot</th>
                <th className="px-4 py-2 font-medium text-text-muted">SKU</th>
                <th className="px-4 py-2 font-medium text-text-muted">UI status</th>
                <th className="px-4 py-2 font-medium text-text-muted">DB status</th>
                <th className="px-4 py-2 font-medium text-text-muted">Units</th>
                <th className="px-4 py-2 font-medium text-text-muted">Attempts</th>
                <th className="px-4 py-2 font-medium text-text-muted">External ref</th>
                <th className="px-4 py-2 font-medium text-text-muted">Last error</th>
                <th className="px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-text-muted">
                    No consolidated production-output ops yet.
                  </td>
                </tr>
              ) : (
                ops.map((op) => {
                  const uiStatus = deriveUiOperationStatus({
                    status: op.status as "READY",
                    previewStatus: op.previewStatus,
                    humanReviewRequired: op.humanReviewRequired,
                    partialFailure: op.partialFailure,
                    voidedAt: op.voidedAt,
                  });
                  return (
                  <tr key={op.id} className="border-b border-border/30 last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/finished-lots/${op.finishedLotId}`}
                        className="font-mono text-[11px] text-brand-700 hover:underline"
                      >
                        {op.finishedLotId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-[10px]">
                      {op.finishedSku ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <StatusChip status={op.status} uiStatus={uiStatus} />
                    </td>
                    <td className="px-4 py-2 text-[10px] text-text-muted">{op.status}</td>
                    <td className="px-4 py-2 tabular-nums">{op.quantityGood}</td>
                    <td className="px-4 py-2 tabular-nums">{op.commitAttemptCount}</td>
                    <td className="px-4 py-2 font-mono text-[10px]">
                      {op.externalReferenceId ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-[11px] text-red-700 max-w-xs truncate">
                      {op.commitError ??
                        (op.mappingBlockers
                          ? JSON.stringify(op.mappingBlockers)
                          : op.previewStatus ?? "—")}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        {op.status === "READY" && uiStatus === "ready" ? (
                          <form action={queueProductionOutputOpAction}>
                            <input type="hidden" name="opId" value={op.id} />
                            <button type="submit" className="text-[11px] underline">
                              Queue
                            </button>
                          </form>
                        ) : null}
                        {(op.status === "QUEUED" || op.status === "FAILED") &&
                        !op.humanReviewRequired &&
                        !op.partialFailure ? (
                          <form action={processProductionOutputOpAction}>
                            <input type="hidden" name="opId" value={op.id} />
                            <button type="submit" className="text-[11px] underline">
                              {op.status === "FAILED" ? "Retry commit" : "Commit now"}
                            </button>
                          </form>
                        ) : null}
                      </div>
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
