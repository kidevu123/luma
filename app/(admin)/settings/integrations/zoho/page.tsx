// ZOHO-1 — Zoho gateway connectivity + status page.
//
// Owner decision: live Zoho sync routes through the LXC integration
// gateway (env: ZOHO_INTEGRATION_URL). Luma never holds Zoho OAuth
// refresh/access tokens; the gateway owns Zoho creds.
//
// This page surfaces:
//   - whether ZOHO_INTEGRATION_URL is configured
//   - whether an optional ZOHO_INTEGRATION_SECRET is set
//   - the most recent zoho_sync_runs row of kind CONNECTIVITY_CHECK
//   - a "Test gateway connection" button (server action) that probes the
//     gateway /health and /organizations endpoints and writes a new
//     CONNECTIVITY_CHECK run row
//   - a notice about the legacy direct-OAuth path (/settings/zoho)
//     existing but not used by the live sync from ZOHO-2 onward
//
// Does NOT show the secret value.
// Does NOT initiate items/customers/sales-orders/POs sync.
// Does NOT call Zoho directly.

import Link from "next/link";
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { zohoSyncRuns, externalSystems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  ProductionAlertCard,
  ProductionIdentityBlock,
  ProductionSection,
  type IdentityRow,
} from "@/components/production/ui";
import {
  validateZohoGatewayConfig,
  ZOHO_GATEWAY_SECRET_ENV,
  ZOHO_GATEWAY_URL_ENV,
} from "@/lib/integrations/zoho/gateway";
import { TestConnectionButton } from "./test-connection-button";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "Never";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function ZohoGatewayPage() {
  await requireAdmin();

  const cfg = validateZohoGatewayConfig(process.env);

  const [lastCheck] = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      startedAt: zohoSyncRuns.startedAt,
      finishedAt: zohoSyncRuns.finishedAt,
      source: zohoSyncRuns.source,
      dryRun: zohoSyncRuns.dryRun,
      summary: zohoSyncRuns.summary,
      error: zohoSyncRuns.error,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "CONNECTIVITY_CHECK"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(1);

  const [zohoSystem] = await db
    .select({ id: externalSystems.id, isActive: externalSystems.isActive })
    .from(externalSystems)
    .where(eq(externalSystems.code, "ZOHO"));

  const summary = (lastCheck?.summary ?? {}) as {
    gateway?: { status?: string; httpStatus?: number | null; probedPath?: string | null; elapsedMs?: number | null };
    organizations?: { kind?: string; count?: number; ids?: string[] };
  };

  const configRows: IdentityRow[] = [
    {
      label: "Gateway URL env",
      value: ZOHO_GATEWAY_URL_ENV,
      mono: true,
    },
    {
      label: "Configured",
      value: cfg.configured ? "yes" : "no",
    },
    {
      label: "URL value",
      // Render the URL itself but NEVER the secret. The URL is non-
      // sensitive (LAN host:port).
      value: cfg.configured ? cfg.url : null,
      mono: true,
    },
    {
      label: "Secret env",
      value: ZOHO_GATEWAY_SECRET_ENV,
      mono: true,
    },
    {
      label: "Secret configured",
      value: cfg.hasSecret ? "yes" : "no (optional)",
    },
    {
      label: "External system row",
      value: zohoSystem ? "registered" : "missing",
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho gateway"
        description="Connectivity + status for the Zoho integration gateway on LXC 9503. Luma never holds Zoho OAuth credentials directly — the gateway owns them. This phase is connectivity-check only; item / customer / sales-order / PO sync land in ZOHO-2 onward."
      />

      <ProductionSection
        title="Gateway configuration"
        subtitle="Environment variables — secret value never shown."
        tone={cfg.configured ? "GOOD" : "WARN"}
      >
        <ProductionIdentityBlock rows={configRows} columns={2} />
        {!cfg.configured && cfg.issues.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {cfg.issues.map((m, i) => (
              <ProductionAlertCard
                key={`cfg-${i}`}
                tone="WARN"
                title="Configuration issue"
                body={m}
              />
            ))}
          </div>
        ) : null}
      </ProductionSection>

      <ProductionSection
        title="Last connectivity check"
        subtitle={lastCheck ? `Run ${lastCheck.id.slice(0, 8)}…` : "Never run on this deployment."}
        tone={
          !lastCheck
            ? "MUTED"
            : lastCheck.status === "SUCCESS"
              ? "GOOD"
              : lastCheck.status === "PARTIAL"
                ? "WARN"
                : "CRITICAL"
        }
      >
        {lastCheck ? (
          <>
            <ProductionIdentityBlock
              columns={2}
              rows={[
                { label: "Run status", value: lastCheck.status },
                { label: "Started", value: fmtDate(lastCheck.startedAt), mono: true },
                { label: "Finished", value: fmtDate(lastCheck.finishedAt), mono: true },
                { label: "Source", value: lastCheck.source },
                { label: "Dry run", value: lastCheck.dryRun ? "yes" : "no" },
                {
                  label: "Gateway status",
                  value: summary.gateway?.status ?? null,
                },
                {
                  label: "Probed path",
                  value: summary.gateway?.probedPath ?? null,
                  mono: true,
                },
                {
                  label: "HTTP status",
                  value: summary.gateway?.httpStatus ?? null,
                  mono: true,
                },
                {
                  label: "Elapsed (ms)",
                  value: summary.gateway?.elapsedMs ?? null,
                  mono: true,
                },
                {
                  label: "Orgs outcome",
                  value: summary.organizations?.kind ?? null,
                },
                {
                  label: "Orgs returned",
                  value: summary.organizations?.count ?? null,
                  mono: true,
                },
              ] satisfies IdentityRow[]}
            />
            {lastCheck.error ? (
              <div className="mt-3">
                <ProductionAlertCard
                  tone={lastCheck.status === "FAILED" ? "CRITICAL" : "WARN"}
                  title="Last check reported"
                  body={lastCheck.error}
                />
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-text-muted">
            Click <em>Test gateway connection</em> below to run the first check.
            Nothing is sent to Zoho — the probe only hits the LXC gateway.
          </p>
        )}
      </ProductionSection>

      <Card>
        <CardHeader>
          <CardTitle>Test gateway connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-text-muted">
          <p>
            Probes the gateway <code>/health</code> + <code>/organizations</code> endpoints,
            then writes a <code>zoho_sync_runs</code> row with{" "}
            <code>sync_type = CONNECTIVITY_CHECK</code>. No items, customers,
            sales orders, or POs are touched. The shared secret (if configured)
            is sent in an <code>x-luma-zoho-secret</code> header — never echoed
            back in logs or UI.
          </p>
          <TestConnectionButton disabled={!cfg.configured} />
          {!cfg.configured ? (
            <p className="text-[11px] text-amber-700">
              Configure {ZOHO_GATEWAY_URL_ENV} on the LXC before the button is active.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Legacy direct-OAuth path</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-text-muted">
          <p>
            <code>lib/zoho/client.ts</code> exists and handles per-company OAuth
            directly against Zoho. It backs the existing{" "}
            <Link href="/settings/zoho" className="underline">
              /settings/zoho
            </Link>{" "}
            credentials page. Per the ZOHO-0 plan, live sync from ZOHO-2 onward
            does NOT use the direct-OAuth path — it goes through the gateway
            documented above. The legacy code stays in place for now; its only
            live use is the read-only "Test connection" button on{" "}
            <code>/settings/zoho</code>.
          </p>
          <p>
            No Zoho refresh / access tokens are stored or refreshed by anything
            inside this Zoho-gateway page. Credentials for the gateway path live
            entirely on the LXC integration service.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
