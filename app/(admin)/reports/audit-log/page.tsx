// AUDIT-LOG-1 — read-only system audit log viewer for supervisors.

import { Suspense } from "react";
import { requireLead } from "@/lib/auth-guards";
import {
  listRecentAuditLogs,
  type AuditLogRow,
} from "@/lib/db/queries/audit-log";
import { buildAuditLogViewRows } from "@/lib/audit/audit-log-view";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ScrollText } from "lucide-react";
import { AuditLogFilters } from "./audit-log-filters";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 100;

type SearchParams = Promise<{
  action?: string;
  targetType?: string;
  actor?: string;
}>;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireLead();
  const sp = await searchParams;
  const actionContains = sp.action?.trim() ?? "";
  const targetType = sp.targetType?.trim() ?? "";
  const actorEmailContains = sp.actor?.trim() ?? "";

  const listParams: Parameters<typeof listRecentAuditLogs>[0] = {
    limit: ROW_LIMIT,
  };
  if (actionContains) listParams.actionContains = actionContains;
  if (targetType) listParams.targetType = targetType;
  if (actorEmailContains) listParams.actorEmailContains = actorEmailContains;
  const rows = await listRecentAuditLogs(listParams);
  const viewRows = buildAuditLogViewRows(rows);
  const rawById = new Map<number, AuditLogRow>(
    rows.map((r) => [r.id, r]),
  );

  const hasFilters = Boolean(actionContains || targetType || actorEmailContains);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        description={`Latest ${ROW_LIMIT} audit entries, newest first. Read-only — every write in Luma is recorded here.`}
      />

      <Suspense fallback={null}>
        <AuditLogFilters
          initial={{
            action: actionContains,
            targetType,
            actor: actorEmailContains,
          }}
        />
      </Suspense>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-text-subtle" aria-hidden />
            Recent activity
            {hasFilters && (
              <span className="text-xs font-normal text-text-muted">(filtered)</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {viewRows.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              {hasFilters
                ? "No audit rows match these filters."
                : "No audit log entries yet."}
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Target</TH>
                  <TH>Summary</TH>
                  <TH className="w-[72px]">Details</TH>
                </TR>
              </THead>
              <tbody>
                {viewRows.map((row) => (
                  <TR key={row.id}>
                    <TD className="text-xs tabular-nums whitespace-nowrap align-top">
                      <time dateTime={row.createdAt.toISOString()}>
                        {row.createdAt.toLocaleString()}
                      </time>
                    </TD>
                    <TD className="text-xs align-top max-w-[140px]">
                      <span className="block truncate" title={row.actorLabel}>
                        {row.actorLabel}
                      </span>
                    </TD>
                    <TD className="text-xs align-top">
                      <div className="font-medium">{row.actionLabel}</div>
                      <div className="font-mono text-[10px] text-text-subtle mt-0.5">
                        {row.action}
                      </div>
                    </TD>
                    <TD className="text-xs align-top font-mono text-text-muted">
                      {row.targetLabel}
                    </TD>
                    <TD className="text-xs align-top max-w-md">
                      <p className="leading-snug line-clamp-2">{row.summaryLine}</p>
                    </TD>
                    <TD className="text-xs align-top">
                      {row.hasRawDetails ? (
                        <details>
                          <summary className="cursor-pointer text-brand-800 hover:underline">
                            View
                          </summary>
                          <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-text-muted min-w-[200px]">
                            {row.detailLines.length > 0 && (
                              <ul className="list-disc pl-4 space-y-0.5">
                                {row.detailLines.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                            )}
                            <AuditJsonBlock label="Before" value={rawById.get(row.id)?.before} />
                            <AuditJsonBlock label="After" value={rawById.get(row.id)?.after} />
                          </div>
                        </details>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
          <p className="text-[11px] text-text-subtle mt-3 leading-relaxed">
            Showing up to {ROW_LIMIT} rows. For bag-specific edit history on a receive,
            open the receive detail page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AuditJsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length > 4000) {
    text = `${text.slice(0, 4000)}\n… (truncated)`;
  }
  return (
    <div>
      <p className="font-semibold text-text mb-0.5">{label}</p>
      <pre className="overflow-x-auto rounded border border-border/60 bg-surface-2/50 p-2 text-[10px] font-mono">
        {text}
      </pre>
    </div>
  );
}
