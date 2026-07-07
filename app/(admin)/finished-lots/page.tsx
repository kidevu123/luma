import Link from "next/link";
import { Plus, PackageCheck } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { listFinishedLots } from "@/lib/db/queries/finished-lots";
import { listFinishedLotReleaseCandidates } from "@/lib/production/finished-lot-release-eligibility";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { AutoReleaseAllButton } from "./auto-release-all-button";

export const dynamic = "force-dynamic";

export const metadata = { title: "Finished Lots" };

const STATUS_KIND: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  PENDING_QC: "warn",
  RELEASED: "ok",
  ON_HOLD: "warn",
  SHIPPED: "info",
  RECALLED: "danger",
};

const LEAD_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "LEAD"]);

export default async function FinishedLotsPage() {
  const user = await requireSession();
  const canMutate = LEAD_ROLES.has(user.role);
  const [rows, releaseCandidates] = await Promise.all([
    listFinishedLots(),
    listFinishedLotReleaseCandidates(300),
  ]);
  // Per-lot release eligibility (PENDING_QC only) + summary counts.
  const releaseByLot = new Map(releaseCandidates.map((c) => [c.finishedLotId, c.evaluation]));
  const autoReleaseReady = releaseCandidates.filter((c) => c.evaluation.status === "AUTO_RELEASE_READY").length;
  const needsReview = releaseCandidates.filter((c) => c.evaluation.status === "NEEDS_QC_REVIEW").length;
  const blocked = releaseCandidates.filter((c) => c.evaluation.status === "BLOCKED").length;
  const pendingQc = releaseCandidates.length;
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

      {/* AUTO-QC-RELEASE-1 — QC release queue: summary + one-click auto-release */}
      {pendingQc > 0 ? (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border/60">
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">QC release</p>
            <h2 className="text-sm font-semibold text-text-strong">
              {pendingQc} lot{pendingQc === 1 ? "" : "s"} pending QC
            </h2>
            <p className="text-[11px] text-text-muted mt-0.5">
              <span className="font-medium text-text-strong">Pending QC</span> means the lot exists but
              has not been approved for released inventory. Clean lots can be auto-released; lots with
              missing or risky data (holds, rework, corrections, QC events, open allocations) stay pending
              for review. Zoho output is a separate later step — <span className="font-medium">auto-release
              does not send anything to Zoho</span>.
            </p>
          </div>
          <div className="px-4 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
              <div className="rounded-lg border border-green-300/50 bg-green-50/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-green-700 font-medium">Auto-release ready</p>
                <p className="text-xl font-mono tabular-nums text-green-800">{autoReleaseReady}</p>
              </div>
              <div className="rounded-lg border border-amber-300/50 bg-amber-50/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-amber-700 font-medium">Needs QC review</p>
                <p className="text-xl font-mono tabular-nums text-amber-800">{needsReview}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Blocked</p>
                <p className="text-xl font-mono tabular-nums text-text-strong">{blocked}</p>
              </div>
            </div>
            {canMutate ? (
              <AutoReleaseAllButton readyCount={autoReleaseReady} />
            ) : (
              <p className="text-[11px] text-text-subtle">Lead/admin can auto-release clean lots in one click.</p>
            )}
          </div>
        </div>
      ) : null}

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
                  {(() => {
                    const ev = releaseByLot.get(lot.id);
                    if (!ev || lot.status !== "PENDING_QC") return null;
                    if (ev.status === "AUTO_RELEASE_READY") {
                      return (
                        <div className="mt-1 text-[10px] font-medium text-green-700">
                          Ready to auto-release
                        </div>
                      );
                    }
                    return (
                      <div
                        className={`mt-1 text-[10px] ${ev.status === "BLOCKED" ? "text-text-subtle" : "text-amber-700"}`}
                        title={ev.message}
                      >
                        {ev.status === "BLOCKED" ? "Blocked" : "Needs QC review"}: {ev.message}
                      </div>
                    );
                  })()}
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
