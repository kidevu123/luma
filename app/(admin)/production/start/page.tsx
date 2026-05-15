// WORKFLOW-CLEANUP-2 — Start Production workflow.
//
// Guided 4-step workflow: scan the raw bag → pick the product → pick
// an IDLE workflow QR card → pick a station → click Start. The
// CARD_ASSIGNED event fires through projectEvent inside the action,
// just like the floor PWA does. This is the admin on-ramp; downstream
// stage events still come from station scans.

import { db } from "@/lib/db";
import { and, asc, eq } from "drizzle-orm";
import {
  productAllowedTablets,
  products,
  qrCards,
  stations,
} from "@/lib/db/schema";
import { requireLead } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Start production"
        description="Scan a raw bag, assign a workflow QR card, pick a station, and start. Workflow QR cards are reusable floor badges that track this bag through every station until packaging. QR card administration (add/retire/print labels) lives under Advanced."
      />
      <StartProductionForm
        idleCards={idleCards.map((c) => ({ id: c.id, code: c.code }))}
        stations={activeStations}
        allowedProductsByTabletType={groupAllowedProductsByTabletType(allowedRows)}
      />
    </div>
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
