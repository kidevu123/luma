// Bag-finish Zoho purchase receive workflow for a physical inventory bag.

import { notFound } from "next/navigation";
import { requireLead } from "@/lib/auth-guards";
import { loadRawBagZohoReceivePanel } from "@/lib/zoho/raw-bag-receive-panel";
import { PageHeader } from "@/components/ui/page-header";
import { RawBagZohoReceivePanel } from "@/components/admin/raw-bag-zoho-receive-panel";

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

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Bag-finish Zoho receive"
        description="Preview the exact Zoho purchase receive for this physical bag after floor closeout. One Zoho PR per bag — commit requires PM approval."
      />
      <RawBagZohoReceivePanel
        inventoryBagId={inventoryBagId}
        viewerRole={viewerRole}
      />
    </div>
  );
}
