"use server";

// ZOHO-1 — server actions for the gateway settings page.
//
// Single action today: runConnectivityCheckAction. Probes the gateway
// health endpoint and the organizations endpoint, persists one
// zoho_sync_runs row with sync_type='CONNECTIVITY_CHECK', writes an
// audit row, returns a structured result for the UI to render.
//
// Does NOT call Zoho directly. Does NOT touch zoho_credentials (the
// legacy direct-OAuth row). Does NOT modify any item / customer /
// sales-order / PO data.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { zohoSyncRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import {
  checkZohoGatewayHealth,
  fetchZohoOrganizations,
  validateZohoGatewayConfig,
} from "@/lib/integrations/zoho/gateway";

export type ConnectivityCheckResult =
  | {
      kind: "ok";
      runId: string;
      gatewayStatus: "CONNECTED" | "UNREACHABLE" | "ERROR" | "NOT_CONFIGURED";
      gatewayMessage: string;
      gatewayElapsedMs: number | null;
      orgsKind:
        | "OK"
        | "NEEDS_SELECTION"
        | "NONE_RETURNED"
        | "GATEWAY_LACKS_ENDPOINT"
        | "UNREACHABLE"
        | "ERROR"
        | "NOT_CONFIGURED"
        | "SKIPPED";
      orgsCount: number;
      orgs: Array<{ id: string; name: string; state: string | null }>;
      orgsMessage: string | null;
    }
  | { kind: "error"; message: string };

export async function runConnectivityCheckAction(): Promise<ConnectivityCheckResult> {
  const actor = await requireAdmin();

  const cfg = validateZohoGatewayConfig(process.env);
  const health = await checkZohoGatewayHealth();

  // Organisations probe — skip entirely if the gateway is not reachable.
  // No point hitting /organizations when the connection is refused.
  const shouldProbeOrgs = health.status === "CONNECTED";
  const orgs = shouldProbeOrgs
    ? await fetchZohoOrganizations()
    : { kind: "SKIPPED" as const };

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
  };

  // Decide the run status. CONNECTED + (OK | SKIPPED) → SUCCESS.
  // CONNECTED + multi-org / no endpoint → PARTIAL. Anything else → FAILED
  // (except NOT_CONFIGURED which is an honest "no creds" state, still
  // FAILED for run-status purposes since the run produced no useful
  // outcome).
  let runStatus: "SUCCESS" | "PARTIAL" | "FAILED";
  if (health.status === "CONNECTED") {
    if (orgs.kind === "OK" || orgs.kind === "SKIPPED") runStatus = "SUCCESS";
    else if (orgs.kind === "NEEDS_SELECTION" || orgs.kind === "GATEWAY_LACKS_ENDPOINT" || orgs.kind === "NONE_RETURNED") runStatus = "PARTIAL";
    else runStatus = "FAILED";
  } else {
    runStatus = "FAILED";
  }

  // Persist the run + audit row in a transaction so the operator-visible
  // "last connectivity check" is consistent with the audit log.
  let runId = "";
  let runErrorText: string | null = null;
  if (health.status !== "CONNECTED") runErrorText = health.message;
  else if (
    orgs.kind !== "OK" &&
    orgs.kind !== "NEEDS_SELECTION" &&
    orgs.kind !== "SKIPPED"
  ) {
    runErrorText = orgsKindMessage(orgs);
  }

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
        error: runErrorText,
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
          gatewayStatus: health.status,
          orgsKind: orgs.kind,
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
    orgsKind: orgs.kind,
    orgsCount:
      orgs.kind === "OK" || orgs.kind === "NEEDS_SELECTION"
        ? orgs.organizations.length
        : 0,
    orgs:
      orgs.kind === "OK" || orgs.kind === "NEEDS_SELECTION"
        ? orgs.organizations.map((o) => ({
            id: o.organizationId,
            name: o.organizationName,
            state: o.state,
          }))
        : [],
    orgsMessage: orgs.kind === "OK" || orgs.kind === "SKIPPED" ? null : orgsKindMessage(orgs),
  };
}

function orgsKindMessage(orgs: {
  kind: string;
  organizations?: readonly unknown[];
  probedPaths?: readonly string[];
  message?: string;
}): string {
  switch (orgs.kind) {
    case "OK":
      return `One organization available.`;
    case "NEEDS_SELECTION":
      return `Multiple organizations returned (${(orgs.organizations ?? []).length}). Pick one before live sync.`;
    case "NONE_RETURNED":
      return `Gateway exposes the endpoint but returned zero organizations.`;
    case "GATEWAY_LACKS_ENDPOINT":
      return `Gateway does not expose an organizations endpoint. Tried: ${(orgs.probedPaths ?? []).join(", ")}.`;
    case "UNREACHABLE":
      return orgs.message ?? "Gateway unreachable.";
    case "ERROR":
      return orgs.message ?? "Gateway error.";
    case "NOT_CONFIGURED":
      return orgs.message ?? "Gateway not configured.";
    case "SKIPPED":
      return "Skipped (gateway not reachable).";
    default:
      return `Unknown organizations outcome: ${orgs.kind}`;
  }
}

// Quiet selector to keep the unused-import warning at bay if the audit
// helper grows a different signature later.
const _eq = eq;
void _eq;
