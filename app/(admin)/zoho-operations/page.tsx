// Zoho assembly operations list page.
// Operationally useful: NEEDS_MAPPING and FAILED rows stand out;
// PENDING rows are quiet; SUCCEEDED rows are de-emphasized.
// Server component — no "use client".

import Link from "next/link";
import { AlertCircle, ArrowRight, Search, X } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import {
  listZohoAssemblyOpsWithLot,
  type ZohoAssemblyOpStatus,
  type ZohoAssemblyOpWithLot,
} from "@/lib/db/queries/zoho-assembly";
import type { ZohoAssemblyOp } from "@/lib/db/schema";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { ZohoOpStatusChip, ZohoOpKindChip } from "./_status-chip";

export const dynamic = "force-dynamic";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const VALID_STATUSES: ZohoAssemblyOpStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "NEEDS_MAPPING",
  "SKIPPED",
];

function isValidStatus(s: string): s is ZohoAssemblyOpStatus {
  return (VALID_STATUSES as string[]).includes(s);
}

/** Extract a human-readable hint from requestPayload for NEEDS_MAPPING rows. */
function getMissingHint(op: ZohoAssemblyOp): string | null {
  const payload = op.requestPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  // payload is a plain object here — safe to cast for key inspection
  const p = payload as Record<string, unknown>;

  if (op.opKind === "TABLET_RECEIVE") {
    const missing: string[] = [];
    if (p["zohoPoId"] === null || p["zohoPoId"] === undefined) missing.push("Zoho PO ID");
    if (p["zohoLineItemId"] === null || p["zohoLineItemId"] === undefined)
      missing.push("Zoho line item ID");
    if (missing.length > 0) return `Missing: ${missing.join(", ")}`;
  } else {
    // UNIT_ASSEMBLE, DISPLAY_ASSEMBLE, CASE_ASSEMBLE
    const missing: string[] = [];
    if (p["zohoItemId"] === null || p["zohoItemId"] === undefined) missing.push("Zoho item ID");
    if (missing.length > 0) return `Missing: ${missing.join(", ")}`;
  }

  return null;
}

/** Row background/border class based on status. */
function rowClass(status: ZohoAssemblyOp["status"]): string {
  switch (status) {
    case "NEEDS_MAPPING":
      return "border-l-2 border-l-amber-400 bg-amber-50/30";
    case "FAILED":
      return "border-l-2 border-l-red-400 bg-red-50/20";
    case "SUCCEEDED":
      return "opacity-60";
    default:
      return "";
  }
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

type TabDef = { label: string; status: ZohoAssemblyOpStatus | "ALL" };

const TABS: TabDef[] = [
  { label: "All",          status: "ALL"           },
  { label: "Pending",      status: "PENDING"       },
  { label: "Needs Mapping",status: "NEEDS_MAPPING" },
  { label: "Failed",       status: "FAILED"        },
  { label: "In Progress",  status: "IN_PROGRESS"   },
  { label: "Succeeded",    status: "SUCCEEDED"     },
  { label: "Skipped",      status: "SKIPPED"       },
];

function tabHref(
  tabStatus: ZohoAssemblyOpStatus | "ALL",
  currentQ: string | undefined,
  currentLotId: string | undefined,
): string {
  const params = new URLSearchParams();
  if (tabStatus !== "ALL") params.set("status", tabStatus);
  if (currentQ) params.set("q", currentQ);
  if (currentLotId) params.set("lotId", currentLotId);
  const qs = params.toString();
  return qs ? `/zoho-operations?${qs}` : "/zoho-operations";
}

function countForTab(
  rows: ZohoAssemblyOpWithLot[],
  status: ZohoAssemblyOpStatus | "ALL",
): number {
  if (status === "ALL") return rows.length;
  return rows.filter((r) => r.op.status === status).length;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ZohoOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireSession();
  const sp = await searchParams;

  // Extract and validate params
  const rawStatus = typeof sp["status"] === "string" ? sp["status"] : undefined;
  const statusFilter: ZohoAssemblyOpStatus | undefined =
    rawStatus && isValidStatus(rawStatus) ? rawStatus : undefined;
  const lotId = typeof sp["lotId"] === "string" ? sp["lotId"] : undefined;
  const q = typeof sp["q"] === "string" ? sp["q"].trim() : undefined;

  // DB fetch — 500-row cap; UI is for ops intervention, not bulk export
  const queryOpts: {
    finishedLotId?: string;
    status?: ZohoAssemblyOpStatus;
    limit?: number;
  } = { limit: 500 };
  if (lotId) queryOpts.finishedLotId = lotId;
  if (statusFilter) queryOpts.status = statusFilter;
  const allRows = await listZohoAssemblyOpsWithLot(queryOpts);

  // Client-side search applied after DB fetch
  const rows =
    q && q.length > 0
      ? allRows.filter((r) => {
          const needle = q.toLowerCase();
          return (
            r.finishedLotNumber.toLowerCase().includes(needle) ||
            (r.productName?.toLowerCase().includes(needle) ?? false) ||
            (r.productSku?.toLowerCase().includes(needle) ?? false) ||
            (r.op.zohoItemId?.toLowerCase().includes(needle) ?? false) ||
            (r.op.idempotencyKey?.toLowerCase().includes(needle) ?? false) ||
            r.op.id.toLowerCase().includes(needle)
          );
        })
      : allRows;

  // Active tab is determined by statusFilter
  const activeTab: ZohoAssemblyOpStatus | "ALL" = statusFilter ?? "ALL";

  // Build search-preserving "clear" URLs
  const clearStatusHref = (() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (lotId) params.set("lotId", lotId);
    const qs = params.toString();
    return qs ? `/zoho-operations?${qs}` : "/zoho-operations";
  })();

  const clearQHref = (() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (lotId) params.set("lotId", lotId);
    const qs = params.toString();
    return qs ? `/zoho-operations?${qs}` : "/zoho-operations";
  })();

  const clearLotHref = (() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `/zoho-operations?${qs}` : "/zoho-operations";
  })();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho Operations"
        description="Assembly and receive operations queued for Zoho sync. Dry-run validation only — live writes are disabled. NEEDS_MAPPING rows require operator action before the worker can proceed."
      />

      {/* Lot filter strip */}
      {lotId && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            Filtered to lot: <span className="font-mono text-xs">{lotId}</span>
          </span>
          <Link
            href={clearLotHref}
            className="ml-auto inline-flex items-center gap-0.5 text-xs font-medium text-amber-700 hover:text-amber-900"
          >
            <X className="h-3 w-3" /> Clear
          </Link>
        </div>
      )}

      {/* Status tabs */}
      <div className="-mb-px flex flex-wrap gap-0 border-b border-border">
        {TABS.map((tab) => {
          const isActive = tab.status === activeTab;
          const count = countForTab(allRows, tab.status);
          return (
            <Link
              key={tab.status}
              href={tabHref(tab.status, q, lotId)}
              className={[
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border border-b-surface border-border bg-surface text-text -mb-px rounded-t-md"
                  : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              {tab.label}
              <span
                className={[
                  "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold",
                  isActive
                    ? "bg-brand-700 text-white"
                    : "bg-surface-2 text-text-muted",
                ].join(" ")}
              >
                {count}
                {isActive && q ? "*" : ""}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Search form */}
      <form
        action="/zoho-operations"
        method="get"
        className="flex flex-wrap items-end gap-2"
      >
        {statusFilter && (
          <input type="hidden" name="status" value={statusFilter} />
        )}
        {lotId && <input type="hidden" name="lotId" value={lotId} />}
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle mb-1">
            Search
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle" />
            <input
              type="text"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Lot number, SKU, Zoho item ID…"
              className="h-9 w-full pl-8 pr-2.5 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700/20"
            />
          </div>
        </div>
        <button
          type="submit"
          className="h-9 px-3 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium"
        >
          Search
        </button>
        {q && (
          <Link
            href={clearQHref}
            className="inline-flex h-9 items-center gap-1 px-3 rounded-md border border-border text-sm text-text-muted hover:text-text hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </Link>
        )}
      </form>

      {/* Content */}
      {rows.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No operations found"
          description={
            q
              ? `No ops match "${q}". Try a broader search.`
              : statusFilter
                ? `No ${statusFilter.replace("_", " ").toLowerCase()} operations.`
                : "No Zoho assembly operations have been created yet."
          }
          action={
            (q || statusFilter) ? (
              <Link
                href={clearStatusHref}
                className="inline-flex h-8 items-center gap-1 px-3 rounded-md border border-border text-sm text-text-muted hover:text-text hover:bg-surface-2"
              >
                <X className="h-3.5 w-3.5" /> Clear filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataTable>
              <THead>
                <TR>
                  <TH>Op / Lot</TH>
                  <TH>Status</TH>
                  <TH>Details</TH>
                  <TH className="text-right">Qty</TH>
                  <TH className="text-center">Seq</TH>
                  <TH className="text-center">Retries</TH>
                  <TH>Enqueued</TH>
                  <TH>Error / Note</TH>
                  <TH>{""}</TH>
                </TR>
              </THead>
              <tbody>
                {rows.map(({ op, finishedLotNumber, productName }) => {
                  const missingHint =
                    op.status === "NEEDS_MAPPING" && !op.lastError
                      ? getMissingHint(op)
                      : null;
                  return (
                    <TR key={op.id} className={rowClass(op.status)}>
                      {/* Op / Lot */}
                      <TD>
                        <ZohoOpKindChip opKind={op.opKind} />
                        <div className="mt-0.5 flex items-baseline gap-1.5">
                          <Link
                            href={`/finished-lots/${op.finishedLotId}`}
                            className="font-mono text-xs text-brand-700 hover:underline"
                          >
                            {finishedLotNumber}
                          </Link>
                          {productName && (
                            <span className="text-[11px] text-text-subtle truncate max-w-[160px]">
                              {productName}
                            </span>
                          )}
                        </div>
                      </TD>

                      {/* Status */}
                      <TD>
                        <ZohoOpStatusChip status={op.status} />
                        {missingHint && (
                          <div className="mt-0.5 text-[10px] text-amber-700 font-medium">
                            {missingHint}
                          </div>
                        )}
                      </TD>

                      {/* Details */}
                      <TD>
                        {op.zohoItemId ? (
                          <span className="font-mono text-xs text-text truncate max-w-[140px] block">
                            {op.zohoItemId}
                          </span>
                        ) : (
                          <span className="text-text-subtle text-xs">—</span>
                        )}
                        {op.componentRole && (
                          <div className="text-[11px] text-text-muted mt-0.5">
                            {op.componentRole}
                          </div>
                        )}
                      </TD>

                      {/* Qty */}
                      <TD className="text-right tabular-nums text-sm">
                        {op.quantity.toLocaleString()}
                      </TD>

                      {/* Seq */}
                      <TD className="text-center text-xs text-text-muted tabular-nums">
                        {op.opSequence ?? "—"}
                      </TD>

                      {/* Retries */}
                      <TD className="text-center tabular-nums text-xs">
                        {op.retryCount > 0 ? (
                          <span className="text-amber-700 font-semibold">{op.retryCount}</span>
                        ) : (
                          <span className="text-text-subtle">0</span>
                        )}
                      </TD>

                      {/* Enqueued */}
                      <TD className="text-[11px] text-text-muted whitespace-nowrap tabular-nums">
                        {fmtDate(op.enqueuedAt)}
                      </TD>

                      {/* Error / Note */}
                      <TD className="max-w-[220px]">
                        {op.lastError ? (
                          <span
                            className="text-[11px] text-danger-700 line-clamp-2"
                            title={op.lastError}
                          >
                            {op.lastError}
                          </span>
                        ) : op.resolvedNote ? (
                          <span className="text-[11px] text-text-muted italic line-clamp-2">
                            {op.resolvedNote}
                          </span>
                        ) : (
                          <span className="text-text-subtle text-xs">—</span>
                        )}
                      </TD>

                      {/* Actions */}
                      <TD>
                        <Link
                          href={`/zoho-operations/${op.id}`}
                          className="inline-flex items-center gap-0.5 text-xs text-brand-700 hover:underline font-medium whitespace-nowrap"
                        >
                          View <ArrowRight className="h-3 w-3" />
                        </Link>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </DataTable>
          </CardContent>
        </Card>
      )}

      {allRows.length >= 500 && (
        <p className="text-xs text-warn-700 bg-warn-50 border border-warn-300/60 rounded px-3 py-2">
          Results capped at 500 rows. Apply a status filter or lot filter to see specific operations.
        </p>
      )}
    </div>
  );
}
