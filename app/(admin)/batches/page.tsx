// Input lots — material availability and exception controls for production.

import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { listBatches, batchStatusCounts } from "@/lib/db/queries/batches";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { formatDateTimeEst } from "@/lib/ui/luma-display";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { CreateBatchDialog } from "./create-batch-dialog";
import { StatusActions } from "./status-actions";
import { BulkReleasePanel } from "./bulk-release-panel";

export const dynamic = "force-dynamic";

type FilterKey =
  | ""
  | "AVAILABLE"
  | "BLOCKED"
  | "ON_HOLD"
  | "RECALLED"
  | "EXPIRED"
  | "DEPLETED";

const FILTERS: ReadonlyArray<[FilterKey, string, string | undefined]> = [
  ["", "All", undefined],
  ["AVAILABLE", "Available", "RELEASED"],
  ["BLOCKED", "Blocked / Needs review", "QUARANTINE"],
  ["ON_HOLD", "On hold", "ON_HOLD"],
  ["RECALLED", "Recalled", "RECALLED"],
  ["EXPIRED", "Expired", "EXPIRED"],
  ["DEPLETED", "Depleted", "DEPLETED"],
] as const;

const VALID_FILTER_KEYS = new Set(FILTERS.map(([k]) => k));

function resolveFilter(raw?: string): { key: FilterKey; status?: typeof FILTERS[number][2] } {
  const key = VALID_FILTER_KEYS.has(raw as FilterKey) ? (raw as FilterKey) : "";
  const match = FILTERS.find(([k]) => k === key);
  const status = match?.[2];
  return status ? { key, status } : { key };
}

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; kind?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const { key: filterKey, status } = resolveFilter(params.status);
  const kind =
    params.kind === "TABLET" || params.kind === "PACKAGING" ? params.kind : undefined;

  const [rows, counts, tabletTypes, materials] = await Promise.all([
    listBatches({ ...(status ? { status } : {}), ...(kind ? { kind } : {}) }),
    batchStatusCounts(),
    listTabletTypes(),
    listPackagingMaterials(),
  ]);

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const quarantineCount = counts.QUARANTINE ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Input lots"
        description="Successfully received tablet and packaging lots are available for production automatically. Use hold, quarantine, or recall only when a lot should be blocked."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <BulkReleasePanel quarantineCount={quarantineCount} />
            <CreateBatchDialog tabletTypes={tabletTypes} materials={materials} />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([value, label, statusValue]) => {
          const href =
            "/batches" +
            (value || kind
              ? "?" +
                new URLSearchParams({
                  ...(value ? { status: value } : {}),
                  ...(kind ? { kind } : {}),
                }).toString()
              : "");
          const active = filterKey === value;
          const n = statusValue
            ? counts[statusValue as keyof typeof counts] ?? 0
            : totalCount;
          return (
            <Link
              key={value || "all"}
              href={href}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-colors " +
                (active
                  ? "bg-brand-700 text-white border-brand-700"
                  : "bg-surface text-text-muted border-border hover:bg-surface-2 hover:text-text")
              }
            >
              {label}
              <span
                className={
                  active ? "text-white/80 tabular-nums" : "text-text-subtle tabular-nums"
                }
              >
                {n}
              </span>
            </Link>
          );
        })}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-text-subtle">
          Showing {rows.length}
        </span>
      </div>

      <DataTable>
        <THead>
          <TR>
            <TH>Lot #</TH>
            <TH>Kind</TH>
            <TH>Material</TH>
            <TH>Vendor</TH>
            <TH>Supplier lot</TH>
            <TH className="text-right">Qty received</TH>
            <TH className="text-right">Qty on hand</TH>
            <TH>Expiry</TH>
            <TH>Status</TH>
            <TH>Last change</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <tbody>
          {rows.length === 0 ? (
            <TR>
              <TD colSpan={11} className="text-center py-10 text-text-subtle">
                No lots match this filter.
              </TD>
            </TR>
          ) : (
            rows.map((b) => (
              <TR key={b.id}>
                <TD className="font-mono text-xs">{b.batchNumber}</TD>
                <TD>
                  <StatusPill kind={b.kind === "TABLET" ? "info" : "neutral"}>
                    {b.kind === "TABLET" ? "Tablet" : "Packaging"}
                  </StatusPill>
                </TD>
                <TD className="text-text-muted">{b.materialName ?? "—"}</TD>
                <TD className="text-text-muted">{b.vendorName ?? "—"}</TD>
                <TD className="font-mono text-[10px] text-text-muted">
                  {b.vendorLotNumber ?? "—"}
                </TD>
                <TD className="text-right tabular-nums">{b.qtyReceived}</TD>
                <TD className="text-right tabular-nums">{b.qtyOnHand}</TD>
                <TD className="text-text-muted">{b.expiryDate ?? "—"}</TD>
                <TD>
                  <StatusBadge status={b.status} />
                </TD>
                <TD className="text-text-muted text-xs whitespace-nowrap">
                  {formatDateTimeEst(b.statusChangedAt)}
                </TD>
                <TD className="text-right">
                  <StatusActions batchId={b.id} status={b.status} />
                </TD>
              </TR>
            ))
          )}
        </tbody>
      </DataTable>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
    RELEASED: "ok",
    QUARANTINE: "warn",
    ON_HOLD: "warn",
    RECALLED: "danger",
    EXPIRED: "danger",
    DEPLETED: "neutral",
  };
  const labels: Record<string, string> = {
    RELEASED: "Available",
    QUARANTINE: "Blocked",
    ON_HOLD: "On hold",
    RECALLED: "Recalled",
    EXPIRED: "Expired",
    DEPLETED: "Depleted",
  };
  return (
    <StatusPill kind={map[status] ?? "neutral"}>
      {labels[status] ?? status.replace("_", " ")}
    </StatusPill>
  );
}
