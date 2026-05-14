"use server";

// ZOHO-GW-2 — server action backing the "Test gateway connection"
// button on /settings/integrations/zoho.
//
// Probes /health + /status, derives ZohoReadiness, persists one
// zoho_sync_runs row + one audit row, returns a structured result.
//
// Does NOT call Zoho directly. Does NOT touch zoho_credentials (legacy
// direct-OAuth row). Does NOT sync items / customers / sales-orders /
// purchase-orders. Does NOT write to Zoho.

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
