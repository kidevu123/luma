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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  poLines,
  purchaseOrders,
  tabletTypes,
} from "@/lib/db/schema";
import { RECEIVABLE_PO_STATUSES } from "@/lib/production/raw-bag-intake";
import { requireLead } from "@/lib/auth-guards";
import { listAvailableRawBagQrCards } from "@/lib/db/queries/qr-cards";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
} from "@/lib/integrations/zoho/gateway";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { RawBagIntakeForm } from "./raw-bag-intake-form";
import { ReceivingTabs } from "@/components/ui/receiving-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { SyncPoButton } from "./sync-po-button";

export const dynamic = "force-dynamic";

export default async function ReceiveRawBagsPage() {
  await requireLead();

  // Load PO picker data + tablet types + available QR cards in parallel.
  const [pos, lines, tablets, availableQrCards] = await Promise.all([
    db
      .select({
        id: purchaseOrders.id,
        poNumber: purchaseOrders.poNumber,
        vendorName: purchaseOrders.vendorName,
        status: purchaseOrders.status,
      })
      .from(purchaseOrders)
      .where(
        and(
          inArray(purchaseOrders.status, [...RECEIVABLE_PO_STATUSES]),
          eq(purchaseOrders.isTabletPo, true),
        ),
      )
      .orderBy(desc(purchaseOrders.openedAt)),
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
    listAvailableRawBagQrCards(),
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
          {pos.length} tablet PO{pos.length === 1 ? "" : "s"}
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
        <SyncPoButton />
      </div>

      {/* Zoho readiness banner — three-tier */}
      {zohoReady ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-sky-800 flex items-start gap-2.5">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Zoho PO sync online</p>
            <p className="mt-0.5">
              Live PO lookup is available. The picker will surface the freshest PO list. Manual PO entry stays available as a fallback.
            </p>
          </div>
        </div>
      ) : pos.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface/60 px-4 py-3 text-[12px] text-text-muted flex items-start gap-2.5">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-text">Using synced PO data from Luma</p>
            <p className="mt-0.5">
              Live Zoho sync is offline ({readiness}), but {pos.length} PO{pos.length === 1 ? "" : "s"} and
              their line items are available locally. Use the &ldquo;Sync POs from Zoho&rdquo; button to
              refresh when Zoho is available.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-800 flex items-start gap-2.5">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">No local PO data — use manual PO reference</p>
            <p className="mt-0.5">
              Live Zoho sync is offline ({readiness}) and no POs have been synced yet.
              Use the manual PO reference tab in the form below, or sync POs from Zoho when available.
            </p>
          </div>
        </div>
      )}

      <RawBagIntakeForm
        purchaseOrders={pos}
        poLines={lines}
        tabletTypes={tablets}
        zohoReadiness={readiness}
        availableQrCards={availableQrCards.map((c) => ({ scanToken: c.scanToken }))}
      />
    </div>
  );
}
