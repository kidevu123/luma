// Bag-finish Zoho purchase receive workflow for a physical inventory bag.

import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireLead } from "@/lib/auth-guards";
import { loadRawBagZohoReceivePanel } from "@/lib/zoho/raw-bag-receive-panel";
import { PageHeader } from "@/components/ui/page-header";
import { RawBagZohoReceivePanel } from "@/components/admin/raw-bag-zoho-receive-panel";
import { db } from "@/lib/db";
import { zohoRawBagReceives } from "@/lib/db/schema";
import { RawBagStagingButtons } from "./staging-buttons";

export const dynamic = "force-dynamic";

export default async function BagFinishZohoReceivePage({
  params,
}: {
  params: Promise<{ inventoryBagId: string }>;
}) {
  const session = await requireLead();
  const { inventoryBagId } = await params;
  const panel = await loadRawBagZohoReceivePanel(inventoryBagId);
  if (!panel) notFound();

  const viewerRole = session.role as
    | "OWNER"
    | "ADMIN"
    | "MANAGER"
    | "LEAD"
    | "STAFF";

  // ZOHO-STAGING-BUFFER-v1.1.0 — load the staged op so the staging
  // buttons can read held/voided/auto_commit_eligible_at + blockers.
  // Returns null when the bag has no staged op yet (Path A intake).
  const [stagedOp] = await db
    .select({
      id: zohoRawBagReceives.id,
      status: zohoRawBagReceives.zohoReceiveStatus,
      heldAt: zohoRawBagReceives.heldAt,
      voidedAt: zohoRawBagReceives.voidedAt,
      autoCommitEligibleAt: zohoRawBagReceives.autoCommitEligibleAt,
      mappingBlockers: zohoRawBagReceives.mappingBlockers,
      // OVERS-RESOLUTION-v1.2.0 — fields the resolution panel needs.
      receivedQuantity: zohoRawBagReceives.zohoReceivedQuantity,
      adjustedReceivedQuantity: zohoRawBagReceives.adjustedReceivedQuantity,
      oversDecision: zohoRawBagReceives.oversDecision,
      oversDecisionNote: zohoRawBagReceives.oversDecisionNote,
    })
    .from(zohoRawBagReceives)
    .where(eq(zohoRawBagReceives.inventoryBagId, inventoryBagId))
    .limit(1);

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Bag-finish Zoho receive"
        description="Preview the exact Zoho purchase receive for this physical bag after floor closeout. One Zoho PR per bag — commit requires PM approval."
      />
      {stagedOp ? (
        <RawBagStagingButtons
          row={{
            opId: stagedOp.id,
            status: stagedOp.status,
            heldAt: stagedOp.heldAt,
            voidedAt: stagedOp.voidedAt,
            autoCommitEligibleAt: stagedOp.autoCommitEligibleAt,
            mappingBlockers: stagedOp.mappingBlockers ?? null,
            receivedQuantity: stagedOp.receivedQuantity ?? 0,
            adjustedReceivedQuantity: stagedOp.adjustedReceivedQuantity,
            oversDecision: stagedOp.oversDecision,
            oversDecisionNote: stagedOp.oversDecisionNote,
          }}
        />
      ) : null}
      <RawBagZohoReceivePanel
        inventoryBagId={inventoryBagId}
        viewerRole={viewerRole}
      />
    </div>
  );
}
