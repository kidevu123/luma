import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Activity } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getFinishedLot } from "@/lib/db/queries/finished-lots";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { StatusActions } from "./status-actions";

export const dynamic = "force-dynamic";

const STATUS_KIND: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  PENDING_QC: "warn",
  RELEASED: "ok",
  ON_HOLD: "warn",
  SHIPPED: "info",
  RECALLED: "danger",
};

export default async function FinishedLotDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const lot = await getFinishedLot(id);
  if (!lot) notFound();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/finished-lots"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Finished lots
        </Link>
        <PageHeader
          title={lot.lot.finishedLotNumber}
          description={
            lot.product
              ? `${lot.product.name} (${lot.product.sku})`
              : "Manual lot — no product link"
          }
          actions={
            <StatusPill kind={STATUS_KIND[lot.lot.status] ?? "neutral"}>
              {lot.lot.status.replace("_", " ")}
            </StatusPill>
          }
        />
      </div>

      <div className="grid lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>
                Genealogy
                {lot.inputs.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-text-muted">
                    {lot.inputs.length} input batch{lot.inputs.length !== 1 ? "es" : ""}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lot.inputs.length === 0 ? (
                <div className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-sm text-text-muted">
                  <p className="font-medium text-text mb-1">No input batches recorded</p>
                  <p className="text-xs leading-relaxed">
                    This is a manual lot, or the consumption events have not yet been
                    processed by the projector. Once bags are finalized and linked, their
                    batch inputs appear here.
                  </p>
                </div>
              ) : (
                <>
                  <DataTable>
                    <THead>
                      <TR>
                        <TH>Batch #</TH>
                        <TH>Kind</TH>
                        <TH>Tablet / material</TH>
                        <TH>Vendor lot</TH>
                        <TH className="text-right">Qty consumed</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {lot.inputs.map(({ input, batch, tabletName }) => (
                        <TR key={input.id}>
                          <TD className="font-mono text-xs">
                            <Link
                              href={`/batches?focus=${batch.id}`}
                              className="text-brand-700 hover:underline"
                            >
                              {batch.batchNumber}
                            </Link>
                          </TD>
                          <TD>
                            <StatusPill kind={batch.kind === "TABLET" ? "info" : "neutral"}>
                              {batch.kind}
                            </StatusPill>
                          </TD>
                          <TD className="font-medium">{tabletName ?? "—"}</TD>
                          <TD className="text-text-muted text-xs font-mono">
                            {batch.vendorLotNumber ?? "—"}
                          </TD>
                          <TD className="text-right tabular-nums font-semibold">
                            {input.qtyConsumed.toLocaleString()}
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </DataTable>
                  <p className="text-[11px] text-text-subtle mt-2">
                    Total inputs: {lot.inputs.reduce((s, i) => s + i.input.qtyConsumed, 0).toLocaleString()} units across {lot.inputs.length} batch{lot.inputs.length !== 1 ? "es" : ""}.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {lot.lot.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-text-subtle" /> Notes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap text-text-muted">
                  {lot.lot.notes}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-3 lg:sticky lg:top-6 self-start">
          <Card>
            <CardHeader>
              <CardTitle>Lot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Lot #" value={lot.lot.finishedLotNumber} mono />
              <Row label="Produced" value={lot.lot.producedOn} />
              <Row label="Expires" value={lot.lot.expiryDate} />
              <Row label="Units" value={lot.lot.unitsProduced.toLocaleString()} />
              {lot.lot.displaysProduced != null && (
                <Row label="Displays" value={lot.lot.displaysProduced.toLocaleString()} />
              )}
              {lot.lot.casesProduced != null && (
                <Row label="Cases" value={lot.lot.casesProduced.toLocaleString()} />
              )}
              {lot.lot.workflowBagId && (
                <Row
                  label="Source bag"
                  value={lot.lot.workflowBagId.slice(0, 8)}
                  mono
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-text-subtle" /> Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StatusActions lotId={lot.lot.id} status={lot.lot.status} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className={`font-semibold tabular-nums${mono ? " font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}
