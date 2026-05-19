import { requireLead } from "@/lib/auth-guards";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { asc, notInArray } from "drizzle-orm";
import { ReceiveWizard } from "./receive-wizard";

export const dynamic = "force-dynamic";

export default async function NewReceivePage() {
  await requireLead();
  const [tabletTypes, pos] = await Promise.all([
    listTabletTypes(),
    // DRAFT is kept visible — a lead may legitimately receive against a PO
    // that hasn't been formally confirmed yet. Revisit if workflow requires
    // confirmation before receiving.
    db
      .select()
      .from(purchaseOrders)
      .where(notInArray(purchaseOrders.status, ["CLOSED", "CANCELLED"]))
      .orderBy(asc(purchaseOrders.poNumber)),
  ]);
  return <ReceiveWizard tabletTypes={tabletTypes} purchaseOrders={pos} />;
}
