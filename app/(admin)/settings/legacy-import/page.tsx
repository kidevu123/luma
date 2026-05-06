// Legacy-import settings. Owner-only. Holds the PythonAnywhere API
// token + a list of remote files to pull on a schedule. Each row
// shows last-fetch metadata so the operator can spot a 404 / auth
// failure without digging into logs.

import { eq, desc } from "drizzle-orm";
import {
  CloudDownload,
  ExternalLink,
  Clock,
  CircleCheck,
  CircleAlert,
  HardDriveDownload,
} from "lucide-react";
import { requireOwner } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  companies,
  legacyImportConfig,
  legacyImportPaths,
  legacyImportRuns,
} from "@/lib/db/schema";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import {
  AddPathForm,
  CredentialsForm,
  FetchNowButton,
  PathRowActions,
  RunImportButton,
  PostImportMaintenance,
  SynthesizeSubmissionsButton,
} from "./forms";

export const dynamic = "force-dynamic";

export default async function LegacyImportSettingsPage() {
  await requireOwner();
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .limit(1);
  if (!company) {
    return (
      <p className="text-sm text-text-muted">No company configured.</p>
    );
  }

  const [cfg] = await db
    .select()
    .from(legacyImportConfig)
    .where(eq(legacyImportConfig.companyId, company.id));

  const paths = cfg
    ? await db
        .select()
        .from(legacyImportPaths)
        .where(eq(legacyImportPaths.configId, cfg.id))
        .orderBy(desc(legacyImportPaths.createdAt))
    : [];

  const recentRuns = cfg
    ? await db
        .select()
        .from(legacyImportRuns)
        .where(eq(legacyImportRuns.configId, cfg.id))
        .orderBy(desc(legacyImportRuns.startedAt))
        .limit(10)
    : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Legacy import"
        description="Pulls files from a PythonAnywhere account so we can study the legacy DB and migrate Zoho config without manual downloads."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudDownload className="h-4 w-4 text-text-subtle" />
            PythonAnywhere credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-text-muted">
            Generate a token at{" "}
            <a
              href="https://www.pythonanywhere.com/account/#api_token"
              target="_blank"
              rel="noreferrer"
              className="underline inline-flex items-center gap-1"
            >
              pythonanywhere.com/account
              <ExternalLink className="h-3 w-3" />
            </a>
            . The token grants read access to your PA filesystem — keep
            it scoped to one PA account dedicated to legacy reads.
          </p>
          <CredentialsForm
            paUsername={cfg?.paUsername ?? ""}
            hasToken={!!cfg?.paApiToken}
            isActive={cfg?.isActive ?? true}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 text-text-subtle" />
            Files to fetch
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!cfg ? (
            <p className="text-sm text-text-muted">
              Save credentials before adding paths.
            </p>
          ) : (
            <>
              <AddPathForm />
              {paths.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No paths configured yet. Add one above.
                </p>
              ) : (
                <DataTable>
                  <THead>
                    <TR>
                      <TH>Label</TH>
                      <TH>Kind</TH>
                      <TH>Remote path</TH>
                      <TH>Last fetched</TH>
                      <TH className="text-right">Size</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {paths.map((p) => (
                      <TR key={p.id}>
                        <TD className="font-medium">{p.label}</TD>
                        <TD>
                          <StatusPill kind="neutral">
                            {p.kind.replace("_", " ")}
                          </StatusPill>
                        </TD>
                        <TD className="font-mono text-[11px] text-text-muted">
                          {p.remotePath}
                        </TD>
                        <TD className="text-xs text-text-muted">
                          {p.lastFetchedAt ? (
                            <span className="inline-flex items-center gap-1">
                              {p.lastError ? (
                                <CircleAlert className="h-3 w-3 text-red-700" />
                              ) : (
                                <CircleCheck className="h-3 w-3 text-emerald-700" />
                              )}
                              {new Date(p.lastFetchedAt).toLocaleString()}
                              {p.lastError && (
                                <span
                                  className="text-red-700 truncate max-w-[200px]"
                                  title={p.lastError}
                                >
                                  · {p.lastError.slice(0, 40)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-text-subtle">never</span>
                          )}
                        </TD>
                        <TD className="text-right tabular-nums text-xs">
                          {p.lastBytes != null ? formatBytes(p.lastBytes) : "—"}
                        </TD>
                        <TD className="text-right">
                          <PathRowActions
                            pathId={p.id}
                            enabled={p.enabled}
                          />
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </DataTable>
              )}
              <div className="pt-2 border-t border-border/60 space-y-4">
                <FetchNowButton />
                <RunImportButton />
                <SynthesizeSubmissionsButton />
                <PostImportMaintenance />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {recentRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-text-subtle" />
              Recent runs
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable>
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Trigger</TH>
                  <TH>Result</TH>
                  <TH>Files</TH>
                  <TH>Summary</TH>
                </TR>
              </THead>
              <tbody>
                {recentRuns.map((r) => (
                  <TR key={r.id}>
                    <TD className="text-xs tabular-nums">
                      {new Date(r.startedAt).toLocaleString()}
                    </TD>
                    <TD>
                      <StatusPill kind="neutral">
                        {r.triggeredBy.toLowerCase()}
                      </StatusPill>
                    </TD>
                    <TD>
                      {r.ok === null ? (
                        <StatusPill kind="warn">running</StatusPill>
                      ) : r.ok ? (
                        <StatusPill kind="ok">ok</StatusPill>
                      ) : (
                        <StatusPill kind="danger">failed</StatusPill>
                      )}
                    </TD>
                    <TD className="text-xs tabular-nums">
                      {r.filesSucceeded}/{r.filesAttempted}
                    </TD>
                    <TD className="text-xs text-text-muted">
                      {r.summary ?? "—"}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
