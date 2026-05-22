import Link from "next/link";
import { Truck, Package, Inbox, Boxes } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listReceives } from "@/lib/db/queries/receives";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ReceivingTabs } from "@/components/ui/receiving-tabs";

export const dynamic = "force-dynamic";

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
        <DataTable>
          <THead>
            <TR>
              <TH>Receive</TH>
              <TH>PO</TH>
              <TH>Vendor</TH>
              <TH>Tablet / Flavor</TH>
              <TH>Received</TH>
              <TH className="text-right">Bags</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map(({ receive, poNumber, vendor, bagCount, tabletTypes }) => (
              <TR key={receive.id}>
                <TD className="font-medium">
                  <Link href={`/inbound/${receive.id}`} className="hover:underline">
                    {receive.receiveName}
                  </Link>
                </TD>
                <TD className="font-mono text-xs">{poNumber ?? "—"}</TD>
                <TD className="text-text-muted">{vendor ?? "—"}</TD>
                <TD className="text-xs text-text-muted">{formatFlavorSummary(tabletTypes)}</TD>
                <TD className="text-text-muted text-xs">
                  {new Date(receive.receivedAt as unknown as string).toLocaleString()}
                </TD>
                <TD className="text-right tabular-nums">{bagCount}</TD>
                <TD className="text-text-muted text-xs">
                  {receive.closedAt ? "Closed" : "Open"}
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}

      <div className="text-[11px] text-text-subtle inline-flex items-center gap-1.5">
        <Package className="h-3 w-3" /> Every bag you receive becomes an auditable batch row. Releasing a batch is a separate gated step.
      </div>
    </div>
  );
}

function formatFlavorSummary(tabletTypes: string | null): string {
  if (!tabletTypes) return "—";
  const parts = tabletTypes.split(", ");
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]!} + ${parts.length - 1} more`;
}
