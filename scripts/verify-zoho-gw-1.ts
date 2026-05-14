// ZOHO-GW-2 — in-container verification harness.
//
// Mirrors what runConnectivityCheckAction does from
// app/(admin)/settings/integrations/zoho/actions.ts, minus the
// requireAdmin() wrapper. Probes /health + /status via
// checkZohoGatewayHealth + fetchZohoBrandStatus, derives ZohoReadiness,
// persists one zoho_sync_runs row with sync_type=CONNECTIVITY_CHECK
// and source=verify-script, then reads back and prints the outcome.
//
// Run inside the staging app container:
//   docker compose exec -T app npx tsx /app/scripts/verify-zoho-gw-1.ts
//
// Does NOT run any item / customer / SO / PO sync. Does NOT call any
// Zoho write endpoint. Does NOT touch the legacy direct-OAuth path.

import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
  validateZohoGatewayConfig,
} from "@/lib/integrations/zoho/gateway";

async function main() {
  console.log("[zoho-gw-2] starting verify run");
  const cfg = validateZohoGatewayConfig(process.env);
  console.log("  config.configured=", cfg.configured);
  console.log("  config.hasSecret=", cfg.hasSecret);
  console.log("  config.hasBrand=", cfg.hasBrand, "brand=", cfg.brand);

  const health = await checkZohoGatewayHealth();
  console.log(
    "  health.status=",
    health.status,
    "httpStatus=",
    health.httpStatus,
    "probedPath=",
    health.probedPath,
    "elapsedMs=",
    health.elapsedMs,
  );

  const shouldProbeBrand = health.status === "CONNECTED";
  const brand = shouldProbeBrand ? await fetchZohoBrandStatus() : null;
  console.log("  brand.kind=", brand?.kind ?? "SKIPPED");

  const { readiness, message: readinessMessage } = deriveZohoReadiness({
    health,
    brand,
  });
  console.log("  readiness=", readiness);
  console.log("  readinessMessage=", readinessMessage);

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

  if (selectedBrand) {
    console.log(
      "  selected.brandKey=",
      selectedBrand.brandKey,
      "org=",
      selectedBrand.organizationId,
      "region=",
      selectedBrand.region,
    );
    for (const p of selectedBrand.products) {
      console.log(
        `    ${p.product.padEnd(12)} ${p.tokenStatus}${p.expiresAt ? "  expires " + p.expiresAt : ""}`,
      );
    }
  }

  const availableBrands =
    brand &&
    (brand.kind === "OK" ||
      brand.kind === "NEEDS_REAUTH" ||
      brand.kind === "NEEDS_SELECTION" ||
      brand.kind === "BRAND_NOT_FOUND")
      ? brand.brands.map((b) => ({ brandKey: b.brandKey, organizationId: b.organizationId }))
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
    note: "verify-zoho-gw-1 harness — no Zoho writes; no item/customer sync.",
  };

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
  const error = readiness === "READY_FOR_DRY_RUN" ? null : readinessMessage;

  const inserted = await db
    .insert(zohoSyncRuns)
    .values({
      syncType: "CONNECTIVITY_CHECK",
      status: runStatus,
      finishedAt: new Date(),
      source: "verify-script",
      dryRun: true,
      summary,
      error,
      createdByUserId: null,
    })
    .returning({ id: zohoSyncRuns.id });
  const runId = inserted[0]?.id;
  console.log("  persisted run id=", runId, "status=", runStatus);

  const [readBack] = await db
    .select()
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.id, runId!))
    .limit(1);
  if (!readBack) {
    console.error("  read-back failed — row not found");
    process.exit(2);
  }
  console.log("  read-back ok — sync_type=", readBack.syncType, "dry_run=", readBack.dryRun);

  const recent = await db
    .select({ id: zohoSyncRuns.id, status: zohoSyncRuns.status, source: zohoSyncRuns.source })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "CONNECTIVITY_CHECK"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(5);
  console.log("  recent CONNECTIVITY_CHECK rows:");
  for (const r of recent) {
    console.log(`    ${r.id.slice(0, 8)} ${r.status.padEnd(8)} ${r.source}`);
  }

  console.log("[zoho-gw-2] verify OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("[zoho-gw-2] verify FAILED", err);
  process.exit(1);
});
