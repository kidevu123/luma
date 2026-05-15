// INTAKE-WORKFLOW-1 — one-screen raw-bag intake.
//
// Loads PO + PO-line + tablet-type options (for the PO picker) and the
// Zoho gateway readiness (so the verification badge shows the honest
// state). Hands everything to a client form that handles the three
// sections + save flow.

import { db } from "@/lib/db";
import { asc, eq } from "drizzle-orm";
import {
  poLines,
  purchaseOrders,
  tabletTypes,
} from "@/lib/db/schema";
import { requireLead } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { ProductionAlertCard } from "@/components/production/ui";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
} from "@/lib/integrations/zoho/gateway";
import { RawBagIntakeForm } from "./raw-bag-intake-form";

export const dynamic = "force-dynamic";

export default async function ReceiveRawBagsPage() {
  await requireLead();

  // Load PO picker data + tablet types in parallel.
  const [pos, lines, tablets] = await Promise.all([
    db
      .select({
        id: purchaseOrders.id,
        poNumber: purchaseOrders.poNumber,
        vendorName: purchaseOrders.vendorName,
        status: purchaseOrders.status,
      })
      .from(purchaseOrders)
      .orderBy(asc(purchaseOrders.poNumber)),
    db
      .select({
        id: poLines.id,
        poId: poLines.poId,
        tabletTypeId: poLines.tabletTypeId,
        qtyOrdered: poLines.qtyOrdered,
        zohoLineItemId: poLines.zohoLineItemId,
      })
      .from(poLines),
    db
      .select({
        id: tabletTypes.id,
        sku: tabletTypes.sku,
        name: tabletTypes.name,
      })
      .from(tabletTypes)
      .where(eq(tabletTypes.isActive, true))
      .orderBy(asc(tabletTypes.name)),
  ]);

  // Probe Zoho readiness — read-only; if NEEDS_REAUTH the form shows
  // the manual-PO fallback as the primary path.
  const health = await checkZohoGatewayHealth();
  const brand =
    health.status === "CONNECTED" ? await fetchZohoBrandStatus() : null;
  const { readiness } = deriveZohoReadiness({ health, brand });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Raw bag intake"
        description="Single-screen receiving for raw-pill bags. Pick the PO, capture supplier lot + bag count + receipt range, scan each QR. One save creates every inventory_bag in a single transaction."
      />

      {readiness !== "READY_FOR_DRY_RUN" ? (
        <ProductionAlertCard
          tone="WARN"
          title="Zoho PO sync not ready"
          body={`Live Zoho PO data is unavailable right now (readiness: ${readiness}). The form falls back to the local Luma PO list + a manual PO reference path; receiving is never blocked by Zoho token state.`}
        />
      ) : null}

      <RawBagIntakeForm
        purchaseOrders={pos}
        poLines={lines}
        tabletTypes={tablets}
        zohoReadiness={readiness}
      />
    </div>
  );
}
