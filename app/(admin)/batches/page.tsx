// Batches list — the traceability spine. Status filters along the top
// (one click switches the view), inline status transitions on each row,
// "release" is gated to RELEASE-from-QUARANTINE only when a COA is on
// file (next phase).

import Link from "next/link";
import { ShieldCheck, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listBatches, batchStatusCounts } from "@/lib/db/queries/batches";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { CreateBatchDialog } from "./create-batch-dialog";
import { StatusActions } from "./status-actions";

export const dynamic = "force-dynamic";

const STATUSES = [
  ["", "All"],
  ["QUARANTINE", "Quarantine"],
  ["RELEASED", "Released"],
  ["ON_HOLD", "On hold"],
  ["RECALLED", "Recalled"],
  ["EXPIRED", "Expired"],
  ["DEPLETED", "Depleted"],
] as const;

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; kind?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const validStatuses = [
    "QUARANTINE",
    "RELEASED",
    "ON_HOLD",
    "RECALLED",
    "EXPIRED",
    "DEPLETED",
  ] as const;
  const status = (validStatuses as readonly string[]).includes(params.status ?? "")
    ? (params.status as (typeof validStatuses)[number])
    : undefined;
  const kind =
    params.kind === "TABLET" || params.kind === "PACKAGING" ? params.kind : undefined;

  const [rows, counts, tabletTypes, materials] = await Promise.all([
    listBatches({ ...(status ? { status } : {}), ...(kind ? { kind } : {}) }),
    batchStatusCounts(),
    listTabletTypes(),
    listPackagingMaterials(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Batches"
        description="Every tablet shipment and every packaging lot is one batch row. Production refuses to consume any batch that is not RELEASED — quarantine is the default."
        actions={<CreateBatchDialog tabletTypes={tabletTypes} materials={materials} />}
      />

      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map(([value, label]) => {
          const href =
            "/batches" +
            (value || kind
              ? "?" +
                new URLSearchParams({
                  ...(value ? { status: value } : {}),
                  ...(kind ? { kind } : {}),
                }).toString()
              : "");
          const active = (status ?? "") === value;
          const n = value ? counts[value as keyof typeof counts] ?? 0 : Object.values(counts).reduce((a, b) => a + b, 0);
          return (
            <Link
              key={value}
              href={href}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-colors " +
                (active
                  ? "bg-brand-700 text-white border-brand-700"
                  : "bg-surface text-text-muted border-border hover:bg-surface-2 hover:text-text")
              }
            >
              {label}
              <span className={active ? "text-white/80 tabular-nums" : "text-text-subtle tabular-nums"}>
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
            <TH>Batch</TH>
            <TH>Kind</TH>
            <TH>Material</TH>
            <TH>Vendor</TH>
            <TH className="text-right">Qty on hand</TH>
            <TH>Expiry</TH>
            <TH>Status</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <tbody>
          {rows.length === 0 ? (
            <TR>
              <TD colSpan={8} className="text-center py-10 text-text-subtle">
                No batches match this filter.
              </TD>
            </TR>
          ) : (
            rows.map((b) => (
              <TR key={b.id}>
                <TD className="font-mono text-xs">
                  <Link
                    href={`/batches?focus=${b.id}`}
                    className="hover:underline"
                  >
                    {b.batchNumber}
                  </Link>
                </TD>
                <TD>
                  <StatusPill kind={b.kind === "TABLET" ? "info" : "neutral"}>
                    {b.kind}
                  </StatusPill>
                </TD>
                <TD className="text-text-muted">{b.materialName ?? "—"}</TD>
                <TD className="text-text-muted">
                  {b.vendorName ?? "—"}
                  {b.vendorLotNumber ? (
                    <span className="block font-mono text-[10px] text-text-subtle">
                      {b.vendorLotNumber}
                    </span>
                  ) : null}
                </TD>
                <TD className="text-right tabular-nums">{b.qtyOnHand}</TD>
                <TD className="text-text-muted">{b.expiryDate ?? "—"}</TD>
                <TD>
                  <StatusBadge status={b.status} />
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
    QUARANTINE: "info",
    ON_HOLD: "warn",
    RECALLED: "danger",
    EXPIRED: "danger",
    DEPLETED: "neutral",
  };
  return (
    <StatusPill kind={map[status] ?? "neutral"}>
      {status.replace("_", " ")}
    </StatusPill>
  );
}

void ShieldCheck;
void Plus;
