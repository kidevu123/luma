// ZOHO-GW-2 — Zoho gateway connectivity + readiness page.
//
// Owner decision: live Zoho sync routes through the LXC integration
// gateway (env: ZOHO_INTEGRATION_URL, default http://192.168.1.205:8000).
// Luma never holds Zoho OAuth credentials directly; the gateway owns
// them. Multi-brand gateway — Luma selects via ZOHO_BRAND.
//
// Surfaces:
//   - URL configured · secret configured · brand configured
//   - selected brand · Zoho org id · per-product token status (valid /
//     expired / missing) with expiry timestamps
//   - latest zoho_sync_runs CONNECTIVITY_CHECK row
//   - "Test gateway connection" button (server action) that probes
//     /health + /status and writes a fresh CONNECTIVITY_CHECK row
//   - overall readiness:
//       NOT_CONFIGURED · UNREACHABLE · ERROR · CONNECTED_HEALTH_ONLY ·
//       NEEDS_SELECTION · NEEDS_REAUTH · READY_FOR_DRY_RUN
//   - legacy direct-OAuth notice
//
// Does NOT show secret values. Does NOT sync items / customers / SO /
// PO. Does NOT call Zoho writes.

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
  type Tone,
} from "@/components/production/ui";
import {
  validateZohoGatewayConfig,
  ZOHO_GATEWAY_BRAND_ENV,
  ZOHO_GATEWAY_SECRET_ENV,
  ZOHO_GATEWAY_URL_ENV,
} from "@/lib/integrations/zoho/gateway";
import { TestConnectionButton } from "./test-connection-button";
import { DryRunButton } from "./dry-run-button";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "Never";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const READINESS_TONE: Record<string, Tone> = {
  READY_FOR_DRY_RUN: "GOOD",
  CONNECTED_HEALTH_ONLY: "INFO",
  NEEDS_REAUTH: "WARN",
  NEEDS_SELECTION: "WARN",
  UNREACHABLE: "CRITICAL",
  ERROR: "CRITICAL",
  NOT_CONFIGURED: "MUTED",
};

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

  const [lastItemsDryRun] = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      startedAt: zohoSyncRuns.startedAt,
      finishedAt: zohoSyncRuns.finishedAt,
      source: zohoSyncRuns.source,
      summary: zohoSyncRuns.summary,
      error: zohoSyncRuns.error,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "ITEMS"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(1);

  const [lastCustomersDryRun] = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      startedAt: zohoSyncRuns.startedAt,
      finishedAt: zohoSyncRuns.finishedAt,
      source: zohoSyncRuns.source,
      summary: zohoSyncRuns.summary,
      error: zohoSyncRuns.error,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "CUSTOMERS"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(1);

  const [zohoSystem] = await db
    .select({ id: externalSystems.id, isActive: externalSystems.isActive })
    .from(externalSystems)
    .where(eq(externalSystems.code, "ZOHO"));

  const summary = (lastCheck?.summary ?? {}) as {
    gateway?: {
      status?: string;
      httpStatus?: number | null;
      probedPath?: string | null;
      elapsedMs?: number | null;
      brand?: string | null;
    };
    brand?: {
      kind?: string;
      selectedBrandKey?: string | null;
      selectedOrganizationId?: string | null;
      availableBrandKeys?: string[];
      tokenStatuses?: Array<{ product: string; tokenStatus: string }>;
    };
    readiness?: string;
  };

  const configRows: IdentityRow[] = [
    { label: "Gateway URL env", value: ZOHO_GATEWAY_URL_ENV, mono: true },
    { label: "Configured", value: cfg.configured ? "yes" : "no" },
    { label: "URL value", value: cfg.configured ? cfg.url : null, mono: true },
    { label: "Secret env", value: ZOHO_GATEWAY_SECRET_ENV, mono: true },
    { label: "Secret configured", value: cfg.hasSecret ? "yes" : "no" },
    { label: "Brand env", value: ZOHO_GATEWAY_BRAND_ENV, mono: true },
    { label: "Brand configured", value: cfg.hasBrand ? cfg.brand : "no" },
    { label: "External system row", value: zohoSystem ? "registered" : "missing" },
  ];

  const readiness = summary.readiness ?? "NOT_CONFIGURED";
  const readinessTone: Tone = READINESS_TONE[readiness] ?? "MUTED";

  const tokenStatuses = summary.brand?.tokenStatuses ?? [];
  const tokenRows: IdentityRow[] = tokenStatuses.map((t) => ({
    label: t.product,
    value: t.tokenStatus,
    mono: true,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho gateway"
        description={`Connectivity + brand readiness for the Zoho integration gateway. Luma never holds Zoho OAuth credentials directly — the gateway on LXC ${cfg.configured ? cfg.url : "9503"} owns them. This phase is connectivity-only; item / customer / sales-order / PO sync land in ZOHO-2 onward.`}
      />

      <ProductionSection
        title="Gateway configuration"
        subtitle="Environment variables — secret value never shown."
        tone={cfg.configured ? (cfg.hasSecret && cfg.hasBrand ? "GOOD" : "WARN") : "WARN"}
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
        {cfg.configured && !cfg.hasBrand ? (
          <div className="mt-3">
            <ProductionAlertCard
              tone="WARN"
              title={`${ZOHO_GATEWAY_BRAND_ENV} not set`}
              body="Required for protected gateway calls. Without it, the gateway returns NEEDS_SELECTION when multiple brands exist."
            />
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
                { label: "Readiness", value: readiness },
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
                  label: "Brand outcome",
                  value: summary.brand?.kind ?? null,
                },
                {
                  label: "Selected brand",
                  value: summary.brand?.selectedBrandKey ?? null,
                  mono: true,
                },
                {
                  label: "Zoho org id",
                  value: summary.brand?.selectedOrganizationId ?? null,
                  mono: true,
                },
                {
                  label: "Available brands",
                  value: summary.brand?.availableBrandKeys?.join(", ") ?? null,
                  mono: true,
                },
              ] satisfies IdentityRow[]}
            />
            <div className="mt-4">
              <ProductionAlertCard
                tone={readinessTone}
                title={`Overall readiness: ${readiness}`}
                body={
                  readiness === "READY_FOR_DRY_RUN"
                    ? "Gateway reachable, brand selected, all relevant Zoho tokens valid. ZOHO-2 dry-run can proceed."
                    : readiness === "NEEDS_REAUTH"
                      ? "Gateway reachable + brand selected, but one or more Zoho refresh tokens are expired on the gateway. ZOHO-2 cannot proceed until an operator re-authorizes them on the gateway side."
                      : readiness === "NEEDS_SELECTION"
                        ? "Gateway reachable, but multiple brands available and ZOHO_BRAND is not set (or does not match)."
                        : readiness === "CONNECTED_HEALTH_ONLY"
                          ? "Gateway /health reachable; /status did not return a brands list."
                          : readiness === "UNREACHABLE"
                            ? "Gateway connection refused / DNS failure / timeout."
                            : readiness === "ERROR"
                              ? "Gateway returned an error. See the run row above."
                              : "Gateway not configured. Set ZOHO_INTEGRATION_URL on the LXC."
                }
              />
            </div>
            {tokenRows.length > 0 ? (
              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-[0.10em] text-text-muted font-semibold mb-1">
                  Per-product Zoho token status
                </p>
                <ProductionIdentityBlock rows={tokenRows} columns={4} />
              </div>
            ) : null}
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
            Nothing is sent to Zoho — the probe only hits the LXC gateway at{" "}
            <code>{cfg.configured ? cfg.url : "(not configured)"}</code>.
          </p>
        )}
      </ProductionSection>

      <Card>
        <CardHeader>
          <CardTitle>Test gateway connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-text-muted">
          <p>
            Probes the gateway <code>/health</code> + <code>/status</code> endpoints
            with <code>X-Internal-Token</code> + <code>X-Brand</code> headers, then
            writes a fresh <code>zoho_sync_runs</code> row with{" "}
            <code>sync_type = CONNECTIVITY_CHECK</code>. No items, customers,
            sales orders, or POs are touched. The shared secret (if configured)
            is sent as <code>X-Internal-Token</code> — never echoed in logs or UI.
          </p>
          <TestConnectionButton disabled={!cfg.configured} />
          {!cfg.configured ? (
            <p className="text-[11px] text-amber-700">
              Configure {ZOHO_GATEWAY_URL_ENV} on the LXC before the button is active.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <ProductionSection
        title="Dry-run item / customer sync (ZOHO-2A)"
        subtitle="Read-only diff against Luma master tables. Never writes products / customers / materials."
        tone={
          readiness === "READY_FOR_DRY_RUN"
            ? "GOOD"
            : readiness === "NEEDS_REAUTH" || readiness === "NEEDS_SELECTION"
              ? "WARN"
              : "MUTED"
        }
      >
        {readiness === "NEEDS_REAUTH" ? (
          <div className="mb-3">
            <ProductionAlertCard
              tone="WARN"
              title="Dry-run blocked — Zoho tokens expired"
              body="Zoho gateway is reachable, but haute_brands tokens must be re-authorized before live dry-run can fetch items / customers. The button below is enabled so an operator can still capture a blocked-state audit row; clicking it does NOT call /items or /contacts_inv."
            />
          </div>
        ) : null}
        <ProductionIdentityBlock
          columns={2}
          rows={[
            { label: "Readiness", value: readiness },
            { label: "Selected brand", value: cfg.brand ?? null, mono: true },
            {
              label: "Last items dry-run",
              value: lastItemsDryRun
                ? `${lastItemsDryRun.status} · ${fmtDate(lastItemsDryRun.startedAt)}`
                : "Never run",
            },
            {
              label: "Last customers dry-run",
              value: lastCustomersDryRun
                ? `${lastCustomersDryRun.status} · ${fmtDate(lastCustomersDryRun.startedAt)}`
                : "Never run",
            },
            {
              label: "Items scanned (last run)",
              value:
                (lastItemsDryRun?.summary as { counts?: { scanned?: number } } | null)?.counts
                  ?.scanned ?? null,
              mono: true,
            },
            {
              label: "Customers scanned (last run)",
              value:
                (lastCustomersDryRun?.summary as { counts?: { scanned?: number } } | null)?.counts
                  ?.scanned ?? null,
              mono: true,
            },
            {
              label: "Items conflicts",
              value:
                (lastItemsDryRun?.summary as { counts?: { conflicts?: number } } | null)?.counts
                  ?.conflicts ?? null,
              mono: true,
            },
            {
              label: "Customers conflicts",
              value:
                (lastCustomersDryRun?.summary as { counts?: { conflicts?: number } } | null)
                  ?.counts?.conflicts ?? null,
              mono: true,
            },
          ] satisfies IdentityRow[]}
        />
        <div className="mt-4 space-y-2 text-sm text-text-muted">
          <p>
            Click the button to probe Zoho readiness, fetch items + customers via the
            gateway, normalize, and diff against the current Luma master snapshot.
            Writes two <code>zoho_sync_runs</code> rows (one ITEMS, one CUSTOMERS)
            with <code>dry_run=true</code>. If readiness is <em>not</em>{" "}
            <code>READY_FOR_DRY_RUN</code>, a single PARTIAL ITEMS row is written and
            no item / customer endpoint is called.
          </p>
          <DryRunButton disabled={!cfg.configured} />
        </div>
      </ProductionSection>

      <Card>
        <CardHeader>
          <CardTitle>Legacy direct-OAuth path</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-text-muted">
          <p>
            <code>lib/zoho/client.ts</code> handles per-company OAuth directly
            against Zoho. It backs the existing{" "}
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
