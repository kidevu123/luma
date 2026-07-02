import { formatDateTimeEst } from "@/lib/ui/luma-display";
import Link from "next/link";
import { Truck, Package, Inbox, Boxes } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listReceives } from "@/lib/db/queries/receives";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ReceivingTabs } from "@/components/ui/receiving-tabs";
import {
  groupReceivesByPo,
  formatReceiveGroupSummary,
  type PoReceiveGroup,
} from "@/lib/production/receives-grouping";

export const dynamic = "force-dynamic";

type ReceiveRow = Awaited<ReturnType<typeof listReceives>>[number];

function statusChipClass(label: string): string {
  switch (label) {
    case "Open":
      return "bg-sky-50/80 border-sky-300/50 text-sky-700";
    case "Closed":
      return "bg-surface-2 border-border text-text-muted";
    default: // Mixed
      return "bg-amber-50/80 border-amber-300/50 text-amber-700";
  }
}

export default async function InboundPage() {
  await requireSession();
  const rows = await listReceives();
  return (
    <div className="space-y-5">
      <ReceivingTabs />
      <PageHeader
        title="Receives"
        description="History of all tablet and packaging receives. Each receive links to a PO and contains boxes and bags."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href="/receiving/raw-bags">
                <Inbox className="h-4 w-4" /> Receive pills
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/inbound/packaging-materials">
                <Boxes className="h-4 w-4" /> Receive packaging
              </Link>
            </Button>
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No receives yet"
          description="Start by receiving pills or packaging materials."
          action={
            <div className="flex items-center gap-2">
              <Button asChild>
                <Link href="/receiving/raw-bags">
                  <Inbox className="h-4 w-4" /> Receive pills
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/inbound/packaging-materials">
                  <Boxes className="h-4 w-4" /> Receive packaging
                </Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="space-y-4">
          {groupReceivesByPo(rows).map((group) => (
            <PoReceiveGroupCard key={group.key} group={group} />
          ))}
        </div>
      )}

      <div className="text-[11px] text-text-subtle inline-flex items-center gap-1.5">
        <Package className="h-3 w-3" /> Every bag you receive becomes an auditable batch row. Releasing a batch is a separate gated step.
      </div>
    </div>
  );
}

// RECEIVES-BY-PO-1 — one card per PO. Header carries the shared PO/vendor
// context + rollup (receives, bags, status, latest received); the individual
// receives stay listed and clickable underneath, exactly as before.
function PoReceiveGroupCard({ group }: { group: PoReceiveGroup<ReceiveRow> }) {
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-sm font-semibold text-text-strong">
            {group.poNumber ?? "Unknown PO"}
          </span>
          <span
            className="inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-medium bg-surface-2 border-border text-text-muted tabular-nums"
            title="Receives in this PO"
          >
            {group.totalReceives}
          </span>
          <span className="text-text-muted text-[12.5px] truncate">
            {group.vendor ?? "Unknown vendor"}
          </span>
        </div>
        <div className="flex items-center gap-2.5 text-[11px] text-text-muted">
          <span className="tabular-nums">{formatReceiveGroupSummary(group)}</span>
          <span
            className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${statusChipClass(
              group.status.label,
            )}`}
            title={
              group.status.label === "Mixed"
                ? `${group.status.openCount} open · ${group.status.closedCount} closed`
                : undefined
            }
          >
            {group.status.label}
          </span>
          <span className="hidden sm:inline text-text-subtle">
            latest {formatDateTimeEst(group.latestReceivedAt)}
          </span>
        </div>
      </div>
      <DataTable>
        <THead>
          <TR>
            <TH>Receive</TH>
            <TH>Tablet / Flavor</TH>
            <TH>Received</TH>
            <TH className="text-right">Bags</TH>
            <TH>Status</TH>
          </TR>
        </THead>
        <tbody>
          {group.receives.map(({ receive, tabletTypes, bagCount }) => (
            <TR key={receive.id}>
              <TD className="font-medium">
                <Link href={`/inbound/${receive.id}`} className="hover:underline">
                  {receive.receiveName ?? "Unknown receive"}
                </Link>
              </TD>
              <TD className="text-xs text-text-muted">{formatFlavorSummary(tabletTypes)}</TD>
              <TD className="text-text-muted text-xs">
                {formatDateTimeEst(receive.receivedAt as unknown as string)}
              </TD>
              <TD className="text-right tabular-nums">{bagCount ?? 0}</TD>
              <TD className="text-text-muted text-xs">
                {receive.closedAt ? "Closed" : "Open"}
              </TD>
            </TR>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}

function formatFlavorSummary(tabletTypes: string | null): string {
  if (!tabletTypes) return "Unknown tablet / flavor";
  const parts = tabletTypes.split(", ");
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]!} + ${parts.length - 1} more`;
}
