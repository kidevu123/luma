import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getReceive } from "@/lib/db/queries/receives";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AddBagForm } from "./add-bag-form";

export const dynamic = "force-dynamic";

export default async function AddBagPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id: receiveId } = await params;
  const r = await getReceive(receiveId);
  if (!r) notFound();

  const poLabel = r.po
    ? `PO ${r.po.poNumber}${r.po.vendorName ? ` · ${r.po.vendorName}` : ""}`
    : null;

  if (r.receive.closedAt) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <Link
            href={`/inbound/${receiveId}`}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
          >
            <ArrowLeft className="h-3 w-3" /> Back to {r.receive.receiveName}
          </Link>
          <PageHeader title="Add bag" description={r.receive.receiveName} />
        </div>
        <Card>
          <CardContent className="pt-5 text-sm text-text-muted">
            This receive is closed. Reopen it from{" "}
            <Link href={`/inbound/${receiveId}/edit`} className="text-brand-700 hover:underline">
              Edit receive
            </Link>{" "}
            before adding bags.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (r.boxes.length === 0) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <Link
            href={`/inbound/${receiveId}`}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
          >
            <ArrowLeft className="h-3 w-3" /> Back to {r.receive.receiveName}
          </Link>
          <PageHeader title="Add bag" description={r.receive.receiveName} />
        </div>
        <Card>
          <CardContent className="pt-5 text-sm text-text-muted">
            This receive has no boxes. Add bags only on receives that were created
            with at least one box.
          </CardContent>
        </Card>
      </div>
    );
  }

  const batchIds = r.boxes
    .map(({ box }) => box.defaultBatchId)
    .filter((x): x is string => !!x);
  const batchRows =
    batchIds.length > 0
      ? await db
          .select({ id: batches.id, batchNumber: batches.batchNumber })
          .from(batches)
          .where(inArray(batches.id, batchIds))
      : [];
  const batchById = new Map(batchRows.map((b) => [b.id, b.batchNumber]));

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <Link
          href={`/inbound/${receiveId}`}
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Back to {r.receive.receiveName}
        </Link>
        <PageHeader
          title="Add bag"
          description={`Add another bag to ${r.receive.receiveName}`}
        />
      </div>

      <Card>
        <CardContent className="pt-5">
          <AddBagForm
            receiveId={receiveId}
            receiveName={r.receive.receiveName}
            poLabel={poLabel}
            boxes={r.boxes.map(({ box, tabletName }) => ({
              id: box.id,
              boxNumber: box.boxNumber,
              tabletName: tabletName ?? null,
              batchNumber: box.defaultBatchId
                ? (batchById.get(box.defaultBatchId) ?? null)
                : null,
              totalBags: box.totalBags,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
