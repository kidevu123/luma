// WORKFLOW-CLEANUP-2 → LUMA-UI-REBUILD-1
//
// Start Production workflow. Guided 4-step flow: scan the raw bag →
// pick the product → pick an IDLE workflow QR card → pick a station →
// click Start. The CARD_ASSIGNED event fires through projectEvent
// inside the action, just like the floor PWA does. This is the admin
// on-ramp; downstream stage events still come from station scans.
//
// Chrome rebuilt on the new luma-ui primitives. Data loading + form
// wiring unchanged.

import { db } from "@/lib/db";
import { asc, eq } from "drizzle-orm";
import {
  productAllowedTablets,
  products,
  qrCards,
  stations,
} from "@/lib/db/schema";
import { requireLead } from "@/lib/auth-guards";
import {
  CommandShell,
  PageHero,
  SectionCard,
  WorkflowStepper,
  type HeroBadge,
  type StepperStep,
} from "@/components/production/luma-ui";
import { StartProductionForm } from "./start-production-form";

export const dynamic = "force-dynamic";

export default async function StartProductionPage() {
  await requireLead();

  const [idleCards, activeStations, allowedRows] = await Promise.all([
    db
      .select({ id: qrCards.id, code: qrCards.label })
      .from(qrCards)
      .where(eq(qrCards.status, "IDLE"))
      .orderBy(asc(qrCards.label))
      .limit(200),
    db
      .select({ id: stations.id, label: stations.label, kind: stations.kind })
      .from(stations)
      .where(eq(stations.isActive, true))
      .orderBy(asc(stations.label)),
    db
      .select({
        tabletTypeId: productAllowedTablets.tabletTypeId,
        productId: products.id,
        productName: products.name,
        productSku: products.sku,
        productKind: products.kind,
      })
      .from(productAllowedTablets)
      .leftJoin(products, eq(products.id, productAllowedTablets.productId))
      .where(eq(products.isActive, true)),
  ]);

  // Server-side workflow telemetry surfaced as hero badges and the
  // active-tone of the stepper — gives the lead an at-a-glance read
  // on whether they CAN start a run right now.
  const idleCardCount = idleCards.length;
  const stationCount = activeStations.length;
  const idleReady = idleCardCount > 0;
  const stationReady = stationCount > 0;

  const heroBadges: HeroBadge[] = [
    {
      label: `${idleCardCount} idle QR card${idleCardCount === 1 ? "" : "s"}`,
      tone: idleReady ? "info" : "crit",
      mono: true,
    },
    {
      label: `${stationCount} active station${stationCount === 1 ? "" : "s"}`,
      tone: stationReady ? "info" : "crit",
      mono: true,
    },
  ];

  // Stepper labels mirror the form sequence so an operator can map
  // the page to their physical actions before they start clicking.
  const steps: StepperStep[] = [
    { label: "Scan raw bag", state: "active" },
    { label: "Pick product", state: "pending" },
    { label: "Assign QR card", state: "pending" },
    { label: "Pick station", state: "pending" },
    { label: "Start run", state: "pending" },
  ];

  return (
    <CommandShell>
      <PageHero
        eyebrow="Floor work · On-ramp"
        title="Start production"
        description={
          <>
            Scan a raw bag, assign a workflow QR card, pick a station, and
            start. Workflow QR cards are reusable floor badges that track this
            bag through every station until packaging. QR card administration
            (add / retire / print labels) lives under{" "}
            <span className="text-text-strong">Advanced → QR card management</span>.
          </>
        }
        badges={heroBadges}
      />

      <SectionCard
        eyebrow="Run sequence"
        title="Five steps to a live workflow card"
        subtitle="Each step gates the next. The CARD_ASSIGNED event fires only after you click Start."
        tone="info"
        pad="tight"
      >
        <WorkflowStepper steps={steps} />
      </SectionCard>

      <StartProductionForm
        idleCards={idleCards.map((c) => ({ id: c.id, code: c.code }))}
        stations={activeStations}
        allowedProductsByTabletType={groupAllowedProductsByTabletType(allowedRows)}
      />
    </CommandShell>
  );
}

function groupAllowedProductsByTabletType(
  rows: Array<{
    tabletTypeId: string;
    productId: string | null;
    productName: string | null;
    productSku: string | null;
    productKind: string | null;
  }>,
): Record<string, Array<{ id: string; name: string; sku: string; kind: string }>> {
  const out: Record<string, Array<{ id: string; name: string; sku: string; kind: string }>> = {};
  for (const r of rows) {
    if (!r.productId) continue;
    const list = out[r.tabletTypeId] ?? [];
    list.push({
      id: r.productId,
      name: r.productName ?? "(unnamed)",
      sku: r.productSku ?? "",
      kind: r.productKind ?? "",
    });
    out[r.tabletTypeId] = list;
  }
  return out;
}
