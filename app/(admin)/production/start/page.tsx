// WORKFLOW-CLEANUP-2 → LUMA-UI-REBUILD-1
//
// Start Production workflow. Guided 4-step flow: scan the raw bag →
// pick the product → pick an IDLE workflow QR card → pick a station →
// click Start. The CARD_ASSIGNED event fires through projectEvent
// inside the action, just like the floor PWA does. This is the admin
// on-ramp; downstream stage events still come from station scans.
//
// Chrome rebuilt on the standard design system. Data loading + form
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

  const idleCardCount = idleCards.length;
  const stationCount = activeStations.length;
  const idleReady = idleCardCount > 0;
  const stationReady = stationCount > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Start production"
        description="Scan a raw bag, assign a workflow QR card, pick a station, and start. QR card administration (add / retire / print labels) lives under Advanced → QR card management."
      />

      {/* Readiness badges */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center h-6 px-2.5 rounded-md border text-[11px] font-mono ${
            idleReady
              ? "border-sky-200 bg-sky-50 text-sky-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {idleCardCount} idle QR card{idleCardCount === 1 ? "" : "s"}
        </span>
        <span
          className={`inline-flex items-center h-6 px-2.5 rounded-md border text-[11px] font-mono ${
            stationReady
              ? "border-sky-200 bg-sky-50 text-sky-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {stationCount} active station{stationCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Workflow steps */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Run sequence</p>
          <p className="text-sm font-semibold text-text-strong mt-0.5">
            Five steps to a live workflow card
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            Each step gates the next. The CARD_ASSIGNED event fires only after you click Start.
          </p>
        </div>
        <ol className="px-4 py-4 flex flex-col gap-2">
          {[
            "Scan raw bag",
            "Pick product",
            "Assign QR card",
            "Pick station",
            "Start run",
          ].map((stepLabel, i) => (
            <li key={stepLabel} className="flex items-center gap-3">
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold shrink-0 ${
                  i === 0
                    ? "border-brand-300 bg-brand-50 text-brand-800"
                    : "border-border bg-surface-2 text-text-subtle"
                }`}
              >
                {i + 1}
              </span>
              <span
                className={`text-[13px] ${i === 0 ? "font-medium text-text-strong" : "text-text-muted"}`}
              >
                {stepLabel}
              </span>
            </li>
          ))}
        </ol>
      </div>

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
