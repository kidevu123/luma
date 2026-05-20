// INTAKE-WORKFLOW-1 → LUMA-UI-REBUILD-1
//
// Single-screen raw-bag intake. Loads PO + PO-line + tablet-type
// options (for the PO picker) and the Zoho gateway readiness (so the
// verification badge shows the honest state). Hands everything to a
// client form that handles the three sections + save flow.
//
// Chrome rebuilt on the standard design system. Data loading
// + form wiring unchanged from INTAKE-WORKFLOW-1.

import { db } from "@/lib/db";
import { asc, eq, inArray } from "drizzle-orm";
import {
  poLines,
  purchaseOrders,
  tabletTypes,
} from "@/lib/db/schema";
import { RECEIVABLE_PO_STATUSES } from "@/lib/production/raw-bag-intake";
import { requireLead } from "@/lib/auth-guards";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
} from "@/lib/integrations/zoho/gateway";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { RawBagIntakeForm } from "./raw-bag-intake-form";
import { ReceivingTabs } from "@/components/ui/receiving-tabs";
import { PageHeader } from "@/components/ui/page-header";

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
      .where(inArray(purchaseOrders.status, [...RECEIVABLE_PO_STATUSES]))
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
  const zohoReady = readiness === "READY_FOR_DRY_RUN";

  return (
    <div className="space-y-5">
      <ReceivingTabs />
      <PageHeader
        title="Receive pills"
        description="Single-screen receiving for raw-pill bags. Pick the PO, capture supplier lot + bag count + receipt range. One save creates every inventory_bag in a single transaction."
      />

      {/* Badge strip */}
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center h-6 px-2.5 rounded-md border border-border bg-surface-2/60 text-[11px] font-mono text-text-muted">
          {pos.length} open/receiving PO{pos.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center h-6 px-2.5 rounded-md border border-border bg-surface-2/60 text-[11px] font-mono text-text-muted">
          {tablets.length} active tablet type{tablets.length === 1 ? "" : "s"}
        </span>
        <span
          className={`inline-flex items-center h-6 px-2.5 rounded-md border text-[11px] font-mono ${
            zohoReady
              ? "border-sky-200 bg-sky-50/60 text-sky-800"
              : "border-warn-200 bg-warn-50/60 text-warn-800"
          }`}
        >
          {zohoReady ? "Zoho: ready" : `Zoho: ${readiness}`}
        </span>
      </div>

      {!zohoReady ? (
        <div className="rounded-xl border border-warn-200 bg-warn-50/60 px-4 py-3 text-[12px] text-warn-800 flex items-start gap-2.5">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Zoho PO sync not ready — manual fallback in use</p>
            <p className="mt-0.5">
              Live Zoho PO data is unavailable right now (readiness:{" "}
              <code className="font-mono text-[11px]">{readiness}</code>).
              The form falls back to the local Luma PO list and a manual PO
              reference path. Receiving is never blocked by Zoho token state.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-sky-800 flex items-start gap-2.5">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Zoho PO sync online</p>
            <p className="mt-0.5">
              Live PO lookup is available. The picker will surface the freshest PO list. Manual PO entry stays available as a fallback.
            </p>
          </div>
        </div>
      )}

      <RawBagIntakeForm
        purchaseOrders={pos}
        poLines={lines}
        tabletTypes={tablets}
        zohoReadiness={readiness}
      />
    </div>
  );
}
