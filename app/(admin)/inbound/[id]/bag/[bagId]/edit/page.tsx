import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getBagForEdit } from "@/lib/db/queries/bag-edits";
import { getReceive } from "@/lib/db/queries/receives";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { BagEditForm } from "./bag-edit-form";

export const dynamic = "force-dynamic";

export default async function BagEditPage({
  params,
}: {
  params: Promise<{ id: string; bagId: string }>;
}) {
  await requireSession();
  const { id: receiveId, bagId } = await params;

  const [receive, loaded] = await Promise.all([
    getReceive(receiveId),
    getBagForEdit(bagId),
  ]);
  if (!receive || !loaded) notFound();

  const { bag, batchNumber, isInProduction } = loaded;

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <Link
          href={`/inbound/${receiveId}`}
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Back to {receive.receive.receiveName}
        </Link>
        <PageHeader
          title={`Edit bag ${bag.internalReceiptNumber ?? bag.id.slice(0, 8)}`}
          description={`Receive: ${receive.receive.receiveName}`}
        />
      </div>

      <Card>
        <CardContent className="pt-5">
          <BagEditForm
            receiveId={receiveId}
            bag={{
              id: bag.id,
              weightGrams: bag.weightGrams ?? null,
              declaredPillCount: bag.declaredPillCount ?? null,
              notes: bag.notes ?? null,
              internalReceiptNumber: bag.internalReceiptNumber ?? null,
              bagQrCode: bag.bagQrCode ?? null,
              batchNumber: batchNumber ?? null,
              isInProduction,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
