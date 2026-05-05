import { requireLead } from "@/lib/auth-guards";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { ReceiveWizard } from "./receive-wizard";

export const dynamic = "force-dynamic";

export default async function NewReceivePage() {
  await requireLead();
  const [tabletTypes, pos] = await Promise.all([
    listTabletTypes(),
    db.select().from(purchaseOrders).orderBy(asc(purchaseOrders.poNumber)),
  ]);
  return <ReceiveWizard tabletTypes={tabletTypes} purchaseOrders={pos} />;
}
