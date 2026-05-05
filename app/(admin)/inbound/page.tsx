import Link from "next/link";
import { Plus, Truck, Package } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listReceives } from "@/lib/db/queries/receives";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function InboundPage() {
  await requireSession();
  const rows = await listReceives();
  return (
    <div className="space-y-5">
      <PageHeader
        title="POs & receiving"
        description="Every truckload becomes a Receive row with N boxes and bags inside. Each box auto-creates (or reuses) the right Quarantine batch."
        actions={
          <Button asChild>
            <Link href="/inbound/new">
              <Plus className="h-4 w-4" /> New receive
            </Link>
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No receives yet"
          description="Log your first inbound shipment. The wizard creates the boxes, bags, and batches in one go."
          action={
            <Button asChild>
              <Link href="/inbound/new">
                <Plus className="h-4 w-4" /> Start a receive
              </Link>
            </Button>
          }
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>Receive</TH>
              <TH>PO</TH>
              <TH>Vendor</TH>
              <TH>Received</TH>
              <TH className="text-right">Bags</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map(({ receive, poNumber, vendor, bagCount }) => (
              <TR key={receive.id}>
                <TD className="font-medium">
                  <Link href={`/inbound/${receive.id}`} className="hover:underline">
                    {receive.receiveName}
                  </Link>
                </TD>
                <TD className="font-mono text-xs">{poNumber ?? "—"}</TD>
                <TD className="text-text-muted">{vendor ?? "—"}</TD>
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
        <Package className="h-3 w-3" /> Tip: every box you log becomes an
        auditable batch row. Releasing a batch is a separate gated step.
      </div>
    </div>
  );
}
