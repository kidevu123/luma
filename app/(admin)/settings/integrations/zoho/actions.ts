"use server";

// ZOHO-2A — server actions for the gateway settings page.
//
// runConnectivityCheckAction (ZOHO-GW-2) probes /health + /status,
// derives ZohoReadiness, persists one zoho_sync_runs row + one audit
// row. Does NOT call Zoho directly.
//
// runItemCustomerDryRunAction (NEW, ZOHO-2A) probes readiness; if
// READY_FOR_DRY_RUN it fetches items + customers via the gateway,
// normalizes, diffs against the current Luma master snapshot, and
// writes one zoho_sync_runs row per kind (ITEMS + CUSTOMERS,
// dry_run=true). If NEEDS_REAUTH (or any other non-READY readiness)
// it writes ONE PARTIAL ITEMS row explaining the block and never
// calls the item / customer endpoints.
//
// Neither action mutates products, tablet_types, packaging_materials,
// or customers. ZOHO-3 replaces these with apply paths.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
  validateZohoGatewayConfig,
  type ZohoBrandProductTokenStatus,
  type ZohoReadiness,
} from "@/lib/integrations/zoho/gateway";
import {
  runZohoDryRunSync,
  type DryRunResult,
  type PersistRunInput,
} from "@/lib/integrations/zoho/sync-dry-run";

export type ConnectivityCheckResult =
  | {
      kind: "ok";
      runId: string;
      gatewayStatus: "CONNECTED" | "UNREACHABLE" | "ERROR" | "NOT_CONFIGURED";
      gatewayMessage: string;
      gatewayElapsedMs: number | null;
      brandKind:
        | "OK"
        | "NEEDS_REAUTH"
        | "NEEDS_SELECTION"
        | "BRAND_NOT_FOUND"
        | "NONE_RETURNED"
        | "GATEWAY_LACKS_ENDPOINT"
        | "UNAUTHORIZED"
        | "UNREACHABLE"
        | "ERROR"
        | "NOT_CONFIGURED"
        | "SKIPPED";
      brandMessage: string | null;
      selectedBrand: {
        brandKey: string;
        organizationId: string | null;
        region: string | null;
        products: Array<{ product: string; tokenStatus: ZohoBrandProductTokenStatus; expiresAt: string | null }>;
      } | null;
      availableBrands: Array<{ brandKey: string; organizationId: string | null }>;
      readiness: ZohoReadiness;
      readinessMessage: string;
    }
  | { kind: "error"; message: string };

export async function runConnectivityCheckAction(): Promise<ConnectivityCheckResult> {
  const actor = await requireAdmin();

  const cfg = validateZohoGatewayConfig(process.env);
  const health = await checkZohoGatewayHealth();

  // Brand probe — skip entirely if the gateway is not reachable. No
  // point hitting /status when the connection is refused.
  const shouldProbeBrand = health.status === "CONNECTED";
  const brand = shouldProbeBrand ? await fetchZohoBrandStatus() : null;
  const { readiness, message: readinessMessage } = deriveZohoReadiness({
    health,
    brand,
  });

  const selectedBrand =
    brand && (brand.kind === "OK" || brand.kind === "NEEDS_REAUTH")
      ? {
          brandKey: brand.brand.brandKey,
          organizationId: brand.brand.organizationId,
          region: brand.brand.region,
          products: brand.brand.products.map((p) => ({
            product: p.product,
            tokenStatus: p.tokenStatus,
            expiresAt: p.expiresAt,
          })),
        }
      : null;

  const availableBrands =
    brand &&
    (brand.kind === "OK" ||
      brand.kind === "NEEDS_REAUTH" ||
      brand.kind === "NEEDS_SELECTION" ||
      brand.kind === "BRAND_NOT_FOUND")
      ? brand.brands.map((b) => ({
          brandKey: b.brandKey,
          organizationId: b.organizationId,
        }))
      : [];

  const summary = {
    gateway: {
      configured: cfg.configured,
      hasSecret: cfg.hasSecret,
      hasBrand: cfg.hasBrand,
      brand: cfg.brand,
      status: health.status,
      httpStatus: health.httpStatus,
      probedPath: health.probedPath,
      elapsedMs: health.elapsedMs,
    },
    brand: brand
      ? {
          kind: brand.kind,
          selectedBrandKey: selectedBrand?.brandKey ?? null,
          selectedOrganizationId: selectedBrand?.organizationId ?? null,
          availableBrandKeys: availableBrands.map((b) => b.brandKey),
          tokenStatuses:
            selectedBrand?.products.map((p) => ({
              product: p.product,
              tokenStatus: p.tokenStatus,
            })) ?? [],
        }
      : { kind: "SKIPPED", reason: "gateway not reachable" },
    readiness,
  };

  // Run status: READY_FOR_DRY_RUN → SUCCESS; CONNECTED_HEALTH_ONLY
  // or NEEDS_REAUTH or NEEDS_SELECTION → PARTIAL; everything else
  // → FAILED. NEEDS_REAUTH is the honest "gateway healthy, but Zoho
  // creds expired" state the operator must resolve before ZOHO-2.
  let runStatus: "SUCCESS" | "PARTIAL" | "FAILED";
  switch (readiness) {
    case "READY_FOR_DRY_RUN":
      runStatus = "SUCCESS";
      break;
    case "CONNECTED_HEALTH_ONLY":
    case "NEEDS_REAUTH":
    case "NEEDS_SELECTION":
      runStatus = "PARTIAL";
      break;
    default:
      runStatus = "FAILED";
  }

  const error =
    readiness === "READY_FOR_DRY_RUN" ? null : readinessMessage;

  let runId = "";
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(zohoSyncRuns)
      .values({
        syncType: "CONNECTIVITY_CHECK",
        status: runStatus,
        finishedAt: new Date(),
        source: "manual",
        dryRun: true,
        summary,
        error,
        createdByUserId: actor.id,
      })
      .returning({ id: zohoSyncRuns.id });
    runId = inserted[0]?.id ?? "";
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "zoho.gateway.connectivity_check",
        targetType: "ZohoSyncRun",
        targetId: runId,
        after: {
          status: runStatus,
          readiness,
          gatewayStatus: health.status,
          brandKind: brand?.kind ?? "SKIPPED",
          selectedBrand: selectedBrand?.brandKey ?? null,
        },
      },
      tx,
    );
  });

  revalidatePath("/settings/integrations/zoho");

  return {
    kind: "ok",
    runId,
    gatewayStatus: health.status,
    gatewayMessage: health.message,
    gatewayElapsedMs: health.elapsedMs,
    brandKind: brand?.kind ?? "SKIPPED",
    brandMessage: brand?.message ?? null,
    selectedBrand,
    availableBrands,
    readiness,
    readinessMessage,
  };
}

// ─── ZOHO-2A — item / customer dry-run action ─────────────────────────────

export type ItemCustomerDryRunResult =
  | {
      kind: "blocked";
      readiness: ZohoReadiness;
      reason: string;
      itemRunId: string | null;
    }
  | {
      kind: "ok";
      readiness: ZohoReadiness;
      itemRunId: string;
      customerRunId: string;
      counts: {
        items: {
          scanned: number;
          createCandidates: number;
          updateCandidates: number;
          noChange: number;
          needsReview: number;
          conflicts: number;
        };
        customers: {
          scanned: number;
          createCandidates: number;
          updateCandidates: number;
          noChange: number;
          needsReview: number;
          conflicts: number;
        };
      };
      warnings: { items: string[]; customers: string[] };
      preview: {
        items: Array<{
          action: string;
          zohoItemId: string;
          zohoName: string;
          sku: string | null;
          suggestedTarget: string;
          reasons: string[];
        }>;
        customers: Array<{
          action: string;
          zohoCustomerId: string;
          zohoName: string;
          customerCodeSuggestion: string | null;
          reasons: string[];
        }>;
      };
    }
  | { kind: "error"; message: string };

export async function runItemCustomerDryRunAction(): Promise<ItemCustomerDryRunResult> {
  const actor = await requireAdmin();

  // Audit + persistence wrapper: writes the zoho_sync_runs row + audit
  // entry, both in a single transaction. The orchestrator passes us
  // each row's content; we just persist it. Never writes any other
  // table.
  const persistRun = async (input: PersistRunInput): Promise<string> => {
    let id = "";
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(zohoSyncRuns)
        .values({
          syncType: input.syncType,
          status: input.status,
          finishedAt: new Date(),
          source: input.source,
          dryRun: true,
          summary: input.summary,
          error: input.error,
          createdByUserId: input.actorUserId,
        })
        .returning({ id: zohoSyncRuns.id });
      id = inserted[0]?.id ?? "";
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "zoho.sync.dry_run",
          targetType: "ZohoSyncRun",
          targetId: id,
          after: {
            syncType: input.syncType,
            status: input.status,
            error: input.error,
          },
        },
        tx,
      );
    });
    return id;
  };

  const result: DryRunResult = await runZohoDryRunSync({
    persistRun,
    actorUserId: actor.id,
    source: "manual",
  });

  revalidatePath("/settings/integrations/zoho");

  if (result.kind === "BLOCKED") {
    return {
      kind: "blocked",
      readiness: result.readiness,
      reason: result.reason,
      itemRunId: result.itemRunId,
    };
  }
  if (result.kind === "ERROR") {
    return { kind: "error", message: result.message };
  }
  // OK — strip the full preview down to a UI-friendly snapshot. Keep
  // the first 25 rows of each kind. The full rows live in summary
  // jsonb in zoho_sync_runs for forensic / future-export use.
  return {
    kind: "ok",
    readiness: result.readiness,
    itemRunId: result.itemRunId,
    customerRunId: result.customerRunId,
    counts: {
      items: { ...result.items.counts },
      customers: { ...result.customers.counts },
    },
    warnings: {
      items: [...result.items.warnings],
      customers: [...result.customers.warnings],
    },
    preview: {
      items: result.items.rows.slice(0, 25).map((r) => ({
        action: r.action,
        zohoItemId: r.zohoItemId,
        zohoName: r.zohoName,
        sku: r.sku,
        suggestedTarget: r.suggestedTarget,
        reasons: [...r.reasons],
      })),
      customers: result.customers.rows.slice(0, 25).map((r) => ({
        action: r.action,
        zohoCustomerId: r.zohoCustomerId,
        zohoName: r.zohoName,
        customerCodeSuggestion: r.customerCodeSuggestion,
        reasons: [...r.reasons],
      })),
    },
  };
}
