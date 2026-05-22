import { requireLead } from "@/lib/auth-guards";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { RECEIVABLE_PO_STATUSES } from "@/lib/production/raw-bag-intake";
import { ReceiveWizard } from "./receive-wizard";

export const dynamic = "force-dynamic";

export default async function NewReceivePage() {
  await requireLead();
  const [tabletTypes, pos] = await Promise.all([
    listTabletTypes(),
    db
      .select()
      .from(purchaseOrders)
      .where(
        and(
          inArray(purchaseOrders.status, [...RECEIVABLE_PO_STATUSES]),
          eq(purchaseOrders.isTabletPo, true),
        ),
      )
      .orderBy(asc(purchaseOrders.poNumber)),
  ]);
  return <ReceiveWizard tabletTypes={tabletTypes} purchaseOrders={pos} />;
}
