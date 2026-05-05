import Link from "next/link";
import { Plus, PackageCheck } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listFinishedLots } from "@/lib/db/queries/finished-lots";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_KIND: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  PENDING_QC: "warn",
  RELEASED: "ok",
  ON_HOLD: "warn",
  SHIPPED: "info",
  RECALLED: "danger",
};

export default async function FinishedLotsPage() {
  await requireSession();
  const rows = await listFinishedLots();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Finished lots"
        description="Each lot is the saleable output of a workflow bag — full genealogy back to source batches."
        actions={
          <Button asChild>
            <Link href="/finished-lots/new">
              <Plus className="h-4 w-4" /> Issue lot
            </Link>
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="No finished lots yet"
          description="Issue your first lot from a finalized workflow bag. Inputs are inferred from the bag's consumption events."
          action={
            <Button asChild>
              <Link href="/finished-lots/new">
                <Plus className="h-4 w-4" /> Issue lot
              </Link>
            </Button>
          }
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>Lot #</TH>
              <TH>Product</TH>
              <TH>Produced</TH>
              <TH>Expires</TH>
              <TH className="text-right">Units</TH>
              <TH className="text-right">Inputs</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map(({ lot, productName, productSku, inputCount }) => (
              <TR key={lot.id}>
                <TD className="font-mono text-xs">
                  <Link href={`/finished-lots/${lot.id}`} className="hover:underline">
                    {lot.finishedLotNumber}
                  </Link>
                </TD>
                <TD>
                  <div className="font-medium">{productName ?? "—"}</div>
                  {productSku && (
                    <div className="text-[11px] text-text-subtle font-mono">{productSku}</div>
                  )}
                </TD>
                <TD className="text-text-muted text-xs tabular-nums">{lot.producedOn}</TD>
                <TD className="text-text-muted text-xs tabular-nums">{lot.expiryDate}</TD>
                <TD className="text-right tabular-nums">
                  {lot.unitsProduced.toLocaleString()}
                </TD>
                <TD className="text-right tabular-nums">{inputCount}</TD>
                <TD>
                  <StatusPill kind={STATUS_KIND[lot.status] ?? "neutral"}>
                    {lot.status.replace("_", " ")}
                  </StatusPill>
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
