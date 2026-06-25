// PO-SYNC-CRON — daily scheduled pull of tablet POs from Zoho.
//
// Called by `app/api/cron/zoho-po-sync/route.ts` (and tests). Wraps the
// existing `syncPurchaseOrdersFromZoho` apply path, persists one
// `zoho_sync_runs` row per pass, and returns a structured summary.

import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import {
  syncPurchaseOrdersFromZoho,
  type PoSyncResult,
} from "@/lib/zoho/po-sync";

export const ZOHO_PO_SYNC_ENABLED_ENV = "ZOHO_PO_SYNC_ENABLED";

export type PoSyncSweepStatus = "skipped" | "success" | "partial" | "failed";

export type PoSyncSweepResult = {
  startedAt: string;
  finishedAt: string;
  enabled: boolean;
  skippedReason?: string;
  syncRunId?: string;
  result?: PoSyncResult;
  status: PoSyncSweepStatus;
};

function isPoSyncEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ZOHO_PO_SYNC_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

function deriveRunStatus(result: PoSyncResult): Exclude<PoSyncSweepStatus, "skipped"> {
  const fetchFailed = result.errors.some((e) => e.startsWith("Zoho fetch failed:"));
  if (fetchFailed && result.poUpserted === 0) return "failed";
  if (result.errors.length > 0) return "partial";
  return "success";
}

export async function runPoSyncSweep(opts?: {
  env?: Record<string, string | undefined>;
  syncFn?: typeof syncPurchaseOrdersFromZoho;
  persistRun?: (input: {
    status: "SUCCESS" | "PARTIAL" | "FAILED";
    summary: Record<string, unknown>;
    error: string | null;
  }) => Promise<string>;
}): Promise<PoSyncSweepResult> {
  const startedAt = new Date();
  const env = opts?.env ?? process.env;

  if (!isPoSyncEnabled(env)) {
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      enabled: false,
      skippedReason: `${ZOHO_PO_SYNC_ENABLED_ENV} is not 'true'.`,
      status: "skipped",
    };
  }

  const syncFn = opts?.syncFn ?? syncPurchaseOrdersFromZoho;
  const result = await syncFn(
    opts?.env !== undefined ? { env: opts.env } : undefined,
  );
  const runStatus = deriveRunStatus(result);
  const finishedAt = new Date();

  const persist =
    opts?.persistRun ??
    (async (input) => {
      const [row] = await db
        .insert(zohoSyncRuns)
        .values({
          syncType: "PURCHASE_ORDERS",
          status: input.status,
          finishedAt,
          source: "cron",
          dryRun: false,
          summary: input.summary,
          error: input.error,
          createdByUserId: null,
        })
        .returning({ id: zohoSyncRuns.id });
      return row?.id ?? "";
    });

  const syncRunId = await persist({
    status:
      runStatus === "failed"
        ? "FAILED"
        : runStatus === "partial"
          ? "PARTIAL"
          : "SUCCESS",
    summary: {
      fetched: result.fetched,
      poUpserted: result.poUpserted,
      lineUpserted: result.lineUpserted,
      lineSkipped: result.lineSkipped,
      detailsFetched: result.detailsFetched,
      nonTabletFlagged: result.nonTabletFlagged,
      errorCount: result.errors.length,
    },
    error:
      result.errors.length > 0 ? result.errors.slice(0, 20).join(" | ") : null,
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    enabled: true,
    syncRunId,
    result,
    status: runStatus,
  };
}
