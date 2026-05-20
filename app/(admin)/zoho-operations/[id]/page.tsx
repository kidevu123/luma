// Zoho assembly operation detail page.
// Server component — no "use client".

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { finishedLots } from "@/lib/db/schema";
import { getZohoAssemblyOp } from "@/lib/db/queries/zoho-assembly";
import { isZohoAssemblyDryRunEnabled } from "@/lib/zoho/assembly-service-client";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ZohoOpStatusChip, ZohoOpKindChip } from "../_status-chip";
import { OpActionsPanel } from "./op-actions";

export const dynamic = "force-dynamic";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isDryRunResponse(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>)["dry_run"] === true
  );
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle mb-0.5">
        {label}
      </dt>
      <dd className="text-sm text-text">{children}</dd>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ZohoOpDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;

  const op = await getZohoAssemblyOp(id);
  if (!op) notFound();

  const dryRunEnabled = isZohoAssemblyDryRunEnabled();

  // Fetch lot number via a direct db query (one extra call is fine per spec).
  const [lotRow] = await db
    .select({ finishedLotNumber: finishedLots.finishedLotNumber })
    .from(finishedLots)
    .where(eq(finishedLots.id, op.finishedLotId))
    .limit(1);
  const finishedLotNumber = lotRow?.finishedLotNumber ?? "(lot not found)";

  // Determine the completion timestamp (whichever is set).
  const completionDate = op.succeededAt ?? op.failedAt ?? null;

  return (
    <div className="space-y-5">
      {/* Back link */}
      <Link
        href={`/zoho-operations?lotId=${op.finishedLotId}`}
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to lot ops
      </Link>

      <PageHeader
        title="Zoho Operation"
        description={`${op.opKind.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())} — Lot ${finishedLotNumber}`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* ── Main column ────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-5">
          {/* Operation Details */}
          <Card>
            <CardHeader>
              <CardTitle>Operation Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <FieldRow label="ID">
                  <span className="font-mono text-xs break-all">{op.id}</span>
                </FieldRow>

                <FieldRow label="Op Kind">
                  <ZohoOpKindChip opKind={op.opKind} />
                </FieldRow>

                <FieldRow label="Status">
                  <ZohoOpStatusChip status={op.status} />
                </FieldRow>

                <FieldRow label="Lot">
                  <Link
                    href={`/finished-lots/${op.finishedLotId}`}
                    className="font-mono text-xs text-brand-700 hover:underline"
                  >
                    {finishedLotNumber}
                  </Link>
                </FieldRow>

                <FieldRow label="Quantity">
                  <span className="tabular-nums">{op.quantity.toLocaleString()}</span>
                </FieldRow>

                <FieldRow label="Sequence">
                  {op.opSequence != null ? (
                    <span className="tabular-nums">{op.opSequence}</span>
                  ) : (
                    <span className="text-text-subtle">—</span>
                  )}
                </FieldRow>

                <FieldRow label="Retry Count">
                  <span className={op.retryCount > 0 ? "tabular-nums text-amber-700 font-semibold" : "tabular-nums"}>
                    {op.retryCount}
                  </span>
                </FieldRow>

                <FieldRow label="Idempotency Key">
                  <span className="font-mono text-xs break-all">{op.idempotencyKey}</span>
                </FieldRow>

                <FieldRow label="Enqueued">
                  <span className="tabular-nums text-xs">{fmtDate(op.enqueuedAt)}</span>
                </FieldRow>

                <FieldRow label="Started">
                  <span className="tabular-nums text-xs">{fmtDate(op.startedAt)}</span>
                </FieldRow>

                <FieldRow label={op.failedAt ? "Failed" : op.succeededAt ? "Succeeded" : "Completed"}>
                  <span className="tabular-nums text-xs">{fmtDate(completionDate)}</span>
                </FieldRow>

                <FieldRow label="Component Role">
                  {op.componentRole ? (
                    <span>{op.componentRole}</span>
                  ) : (
                    <span className="text-text-subtle">—</span>
                  )}
                </FieldRow>
              </dl>
            </CardContent>
          </Card>

          {/* Zoho Identifiers */}
          <Card>
            <CardHeader>
              <CardTitle>Zoho Identifiers</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <FieldRow label="Zoho Item ID">
                  {op.zohoItemId ? (
                    <span className="font-mono text-xs">{op.zohoItemId}</span>
                  ) : (
                    <span className="text-text-subtle">—</span>
                  )}
                </FieldRow>

                <FieldRow label="Zoho Reference ID">
                  {op.zohoReferenceId ? (
                    <span className="font-mono text-xs">{op.zohoReferenceId}</span>
                  ) : (
                    <span className="text-text-subtle">—</span>
                  )}
                </FieldRow>
              </dl>
            </CardContent>
          </Card>

          {/* Request Payload */}
          {op.requestPayload != null && (
            <Card>
              <CardHeader>
                <CardTitle>Request Payload</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="overflow-x-auto max-h-64 text-xs bg-surface-2 rounded p-3 text-text-muted">
                  {JSON.stringify(op.requestPayload, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* Response Payload */}
          {op.responsePayload != null && (
            <Card>
              <CardHeader>
                <CardTitle>
                  Response Payload
                  {isDryRunResponse(op.responsePayload) && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                      DRY RUN
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="overflow-x-auto max-h-64 text-xs bg-surface-2 rounded p-3 text-text-muted">
                  {JSON.stringify(op.responsePayload, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* Last Error */}
          {op.lastError && (
            <Card className="border-l-2 border-l-danger-500">
              <CardHeader>
                <CardTitle>Last Error</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-danger-700 whitespace-pre-wrap break-words">
                  {op.lastError}
                </p>
                {op.failedAt && (
                  <p className="mt-2 text-xs text-text-muted tabular-nums">
                    Failed at: {fmtDate(op.failedAt)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Resolution */}
          {op.resolvedNote && (
            <Card className="border-l-2 border-l-good-500">
              <CardHeader>
                <CardTitle>Resolution</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text whitespace-pre-wrap break-words">
                  {op.resolvedNote}
                </p>
                <div className="mt-2 space-y-0.5">
                  {op.resolvedByUserId && (
                    <p className="text-xs text-text-muted">
                      By user ID:{" "}
                      <span className="font-mono">{op.resolvedByUserId}</span>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <OpActionsPanel id={op.id} status={op.status} dryRunEnabled={dryRunEnabled} />

          {/* Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                <TimelineItem label="Enqueued" date={op.enqueuedAt} />
                <TimelineItem label="Started" date={op.startedAt} />
                <TimelineItem label="Succeeded" date={op.succeededAt} />
                <TimelineItem label="Failed" date={op.failedAt} />
                {op.resolvedNote && (
                  <TimelineItem label="Resolved (manual)" date={null} note="See resolution note" />
                )}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TimelineItem({
  label,
  date,
  note,
}: {
  label: string;
  date: Date | null | undefined;
  note?: string;
}) {
  const hasValue = date != null || note;
  return (
    <li className={`flex items-start gap-2 ${hasValue ? "" : "opacity-40"}`}>
      <span
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
          hasValue ? "bg-brand-700" : "bg-border"
        }`}
      />
      <div>
        <p className="text-xs font-medium text-text">{label}</p>
        <p className="text-[11px] text-text-muted tabular-nums">
          {note ?? fmtDate(date)}
        </p>
      </div>
    </li>
  );
}
