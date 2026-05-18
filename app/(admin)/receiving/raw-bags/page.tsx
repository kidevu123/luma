// INTAKE-WORKFLOW-1 → LUMA-UI-REBUILD-1
//
// Single-screen raw-bag intake. Loads PO + PO-line + tablet-type
// options (for the PO picker) and the Zoho gateway readiness (so the
// verification badge shows the honest state). Hands everything to a
// client form that handles the three sections + save flow.
//
// Chrome rebuilt on the new luma-ui primitive library. Data loading
// + form wiring unchanged from INTAKE-WORKFLOW-1.

import { db } from "@/lib/db";
import { asc, eq } from "drizzle-orm";
import {
  poLines,
  purchaseOrders,
  tabletTypes,
} from "@/lib/db/schema";
import { requireLead } from "@/lib/auth-guards";
import {
  ActionPanel,
  CommandShell,
  PageHero,
  type HeroBadge,
} from "@/components/production/luma-ui";
import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
} from "@/lib/integrations/zoho/gateway";
import { ShieldAlert, ShieldCheck } from "lucide-react";
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
  const zohoReady = readiness === "READY_FOR_DRY_RUN";

  const heroBadges: HeroBadge[] = [
    {
      label: `${pos.length} PO${pos.length === 1 ? "" : "s"} loaded`,
      tone: "info",
      mono: true,
    },
    {
      label: `${tablets.length} active tablet type${tablets.length === 1 ? "" : "s"}`,
      tone: "muted",
      mono: true,
    },
    {
      label: zohoReady ? "Zoho: ready" : `Zoho: ${readiness}`,
      tone: zohoReady ? "good" : "warn",
    },
  ];

  return (
    <CommandShell>
      <PageHero
        eyebrow="Inbound · Raw-pill receiving"
        title="Raw bag intake"
        description={
          <>
            Single-screen receiving for raw-pill bags. Pick the PO, capture
            supplier lot + bag count + receipt range, scan each QR. One save
            creates every <code className="font-mono text-text-strong">inventory_bag</code>{" "}
            in a single transaction.
          </>
        }
        badges={heroBadges}
      />

      {!zohoReady ? (
        <ActionPanel
          tone="warn"
          icon={ShieldAlert}
          title="Zoho PO sync not ready — manual fallback in use"
          body={
            <>
              Live Zoho PO data is unavailable right now (readiness:{" "}
              <code className="font-mono text-text-strong">{readiness}</code>).
              The form falls back to the local Luma PO list and a manual PO
              reference path. Receiving is never blocked by Zoho token state.
            </>
          }
        />
      ) : (
        <ActionPanel
          tone="good"
          icon={ShieldCheck}
          title="Zoho PO sync online"
          body="Live PO lookup is available. The picker will surface the freshest PO list. Manual PO entry stays available as a fallback."
        />
      )}

      <RawBagIntakeForm
        purchaseOrders={pos}
        poLines={lines}
        tabletTypes={tablets}
        zohoReadiness={readiness}
      />
    </CommandShell>
  );
}
