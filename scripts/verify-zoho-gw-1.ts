// ZOHO-GW-1 — in-container verification harness.
//
// Mirrors what runConnectivityCheckAction does from
// app/(admin)/settings/integrations/zoho/actions.ts, minus the
// requireAdmin() wrapper. Probes the gateway via the live
// checkZohoGatewayHealth + fetchZohoOrganizations helpers, persists
// one zoho_sync_runs row with sync_type=CONNECTIVITY_CHECK, then
// reads it back and prints the structured outcome.
//
// Run inside the staging app container:
//   docker compose exec -T app \
//     node --experimental-strip-types /app/scripts/verify-zoho-gw-1.ts
//
// Does NOT run any item / customer / sales-order / PO sync.
// Does NOT call any Zoho write endpoint.
// Does NOT touch the legacy direct-OAuth code path.

import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  checkZohoGatewayHealth,
  fetchZohoOrganizations,
  validateZohoGatewayConfig,
} from "@/lib/integrations/zoho/gateway";

async function main() {
  console.log("[zoho-gw-1] starting verify run");
  const cfg = validateZohoGatewayConfig(process.env);
  console.log("  config.configured=", cfg.configured);
  console.log("  config.hasSecret=", cfg.hasSecret);

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

  const shouldProbeOrgs = health.status === "CONNECTED";
  const orgs = shouldProbeOrgs
    ? await fetchZohoOrganizations()
    : { kind: "SKIPPED" as const };
  console.log("  orgs.kind=", orgs.kind);

  const summary = {
    gateway: {
      configured: cfg.configured,
      hasSecret: cfg.hasSecret,
      status: health.status,
      httpStatus: health.httpStatus,
      probedPath: health.probedPath,
      elapsedMs: health.elapsedMs,
    },
    organizations:
      orgs.kind === "OK" || orgs.kind === "NEEDS_SELECTION"
        ? {
            kind: orgs.kind,
            count: orgs.organizations.length,
            ids: orgs.organizations.map((o) => o.organizationId),
          }
        : { kind: orgs.kind, count: 0 },
    note: "verify-zoho-gw-1 harness — no Zoho writes; no item/customer sync.",
  };

  let runStatus: "SUCCESS" | "PARTIAL" | "FAILED";
  if (health.status === "CONNECTED") {
    if (orgs.kind === "OK" || orgs.kind === "SKIPPED") runStatus = "SUCCESS";
    else if (
      orgs.kind === "NEEDS_SELECTION" ||
      orgs.kind === "GATEWAY_LACKS_ENDPOINT" ||
      orgs.kind === "NONE_RETURNED"
    )
      runStatus = "PARTIAL";
    else runStatus = "FAILED";
  } else {
    runStatus = "FAILED";
  }

  const error =
    health.status !== "CONNECTED"
      ? health.message
      : orgs.kind !== "OK" && orgs.kind !== "SKIPPED"
        ? `orgs outcome: ${orgs.kind}`
        : null;

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

  console.log("[zoho-gw-1] verify OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("[zoho-gw-1] verify FAILED", err);
  process.exit(1);
});
