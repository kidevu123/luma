// Recall lookup. Search by batch number / vendor lot / partial match;
// see every finished lot that pulled from each matched batch. Built
// on the finished_lot_inputs genealogy table — single join, no scan.
//
// Workflow: regulatory letter says "vendor recalled lot #X". You type
// X here, immediately see every internal batch tied to it, and every
// finished lot you've shipped from those batches. Click through to
// the lot to ON_HOLD / RECALL it.

import Link from "next/link";
import { Search, AlertTriangle, ArrowRight } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { lookupByBatchSearch } from "@/lib/db/queries/recall";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function RecallPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSession();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const results = q ? await lookupByBatchSearch(q) : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recall lookup"
        description="Search by batch number or vendor lot. Returns every finished lot that consumed it."
      />

      <Card>
        <CardContent className="pt-5">
          <form className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[240px] space-y-1">
              <Label htmlFor="q">Batch / vendor lot</Label>
              <Input
                id="q"
                name="q"
                defaultValue={q}
                placeholder="e.g. 25-A312 or HN-LOT-12345"
                autoFocus
              />
            </div>
            <Button type="submit">
              <Search className="h-4 w-4" /> Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {q === "" ? (
        <EmptyState
          icon={Search}
          title="Type a batch or vendor lot number"
          description="Partial matches OK. The lookup walks finished_lot_inputs to find every shipped lot."
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="No matches"
          description={`Nothing matches "${q}". Try a partial match (e.g. just the year prefix).`}
        />
      ) : (
        <div className="space-y-4">
          {results.map(({ batch, lots }) => (
            <Card key={batch.id}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono text-sm font-medium">
                        {batch.batchNumber}
                      </p>
                      <StatusPill kind={batch.kind === "TABLET" ? "info" : "neutral"}>
                        {batch.kind}
                      </StatusPill>
                      <BatchStatusPill status={batch.status} />
                    </div>
                    <p className="text-xs text-text-muted">
                      {batch.tabletName ?? "—"}
                      {batch.vendorLotNumber
                        ? ` · vendor lot ${batch.vendorLotNumber}`
                        : ""}
                      {" · "}
                      <span className="tabular-nums">
                        {batch.qtyOnHand.toLocaleString()} on hand
                      </span>
                    </p>
                  </div>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={`/batches?focus=${batch.id}`}>
                      Open batch <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
                {lots.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    No finished lots have consumed this batch yet.
                  </p>
                ) : (
                  <DataTable>
                    <THead>
                      <TR>
                        <TH>Finished lot</TH>
                        <TH>Product</TH>
                        <TH>Produced</TH>
                        <TH>Status</TH>
                        <TH className="text-right">Qty consumed</TH>
                        <TH className="text-right">Units shipped</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {lots.map(({ input, lot, product }) => (
                        <TR key={input.id}>
                          <TD className="font-mono text-xs">
                            <Link
                              href={`/finished-lots/${lot.id}`}
                              className="hover:underline"
                            >
                              {lot.finishedLotNumber}
                            </Link>
                          </TD>
                          <TD>{product?.name ?? "—"}</TD>
                          <TD className="text-text-muted text-xs tabular-nums">
                            {lot.producedOn}
                          </TD>
                          <TD>
                            <FinishedLotStatusPill status={lot.status} />
                          </TD>
                          <TD className="text-right tabular-nums">
                            {input.qtyConsumed.toLocaleString()}
                          </TD>
                          <TD className="text-right tabular-nums">
                            {lot.unitsProduced.toLocaleString()}
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchStatusPill({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
    QUARANTINE: "warn",
    RELEASED: "ok",
    ON_HOLD: "warn",
    RECALLED: "danger",
    EXPIRED: "danger",
    DEPLETED: "neutral",
  };
  return <StatusPill kind={map[status] ?? "neutral"}>{status}</StatusPill>;
}

function FinishedLotStatusPill({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
    PENDING_QC: "warn",
    RELEASED: "ok",
    ON_HOLD: "warn",
    SHIPPED: "info",
    RECALLED: "danger",
  };
  return (
    <StatusPill kind={map[status] ?? "neutral"}>
      {status.replace("_", " ")}
    </StatusPill>
  );
}
