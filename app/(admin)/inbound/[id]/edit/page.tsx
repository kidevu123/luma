// RECEIVE-EDIT-2B-1 — supervisor receive metadata edit (notes + open/closed only).

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireLead } from "@/lib/auth-guards";
import { getReceive } from "@/lib/db/queries/receives";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReceiveEditForm } from "./receive-edit-form";

export const dynamic = "force-dynamic";

export default async function ReceiveEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireLead();
  const { id } = await params;
  const r = await getReceive(id);
  if (!r) notFound();

  const poContext = r.po
    ? `PO ${r.po.poNumber}${r.po.vendorName ? ` · ${r.po.vendorName}` : ""}`
    : null;

  return (
    <div className="space-y-5 max-w-2xl">
      <Link
        href={`/inbound/${id}`}
        className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-3 w-3" /> Back to receive
      </Link>

      <PageHeader
        title="Edit receive"
        description="Supervisor correction — notes and open/closed status only. Bags, batches, and PO links are unchanged."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Editable fields</CardTitle>
        </CardHeader>
        <CardContent>
          <ReceiveEditForm
            receiveId={id}
            receiveName={r.receive.receiveName}
            poContext={poContext}
            initialNotes={r.receive.notes ?? null}
            initialIsClosed={r.receive.closedAt != null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
