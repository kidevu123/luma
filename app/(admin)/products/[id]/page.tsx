import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { getProductWithBom } from "@/lib/db/queries/products";
import { listTabletTypes } from "@/lib/db/queries/tablet-types";
import { listPackagingMaterials } from "@/lib/db/queries/packaging";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BomEditor } from "./bom-editor";
import { ZohoMappingForm } from "./zoho-mapping-form";
import { SpecForm } from "./spec-form";
import { db } from "@/lib/db";
import { productPackagingSpecs } from "@/lib/db/schema";
import { floorReadinessLevel, floorReadinessLabel } from "@/lib/production/product-floor-readiness";
import {
  classifyProductZohoReadiness,
  zohoReadinessShortLabel,
  zohoReadinessReasonLabel,
} from "@/lib/zoho/product-zoho-readiness";
import { evaluateProductSetupReadiness } from "@/lib/production/product-setup-readiness";

export const dynamic = "force-dynamic";

export default async function ProductBomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ from?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const from = (await searchParams)?.from ?? null;
  const cameFromOutputQueue = from === "output-queue";
  const [product, tablets, materials, assignedRows] = await Promise.all([
    getProductWithBom(id),
    listTabletTypes(),
    listPackagingMaterials(),
    db.selectDistinct({ id: productPackagingSpecs.packagingMaterialId })
      .from(productPackagingSpecs),
  ]);
  if (!product) notFound();
  // Material IDs assigned to ANY product — used by BomEditor to hide
  // already-claimed PACKAGING items from the picker dropdown globally.
  const globallyAssignedIds = assignedRows.map((r) => r.id);
  const setupReadiness = evaluateProductSetupReadiness({
    productId: product.id,
    tabletsPerUnit: product.tabletsPerUnit,
    unitsPerDisplay: product.unitsPerDisplay,
    displaysPerCase: product.displaysPerCase,
    defaultShelfLifeDays: product.defaultShelfLifeDays,
    zohoItemIdUnit: product.zohoItemIdUnit ?? null,
    zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
    zohoItemIdCase: product.zohoItemIdCase ?? null,
  });
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <Link
            href="/products"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
          >
            <ArrowLeft className="h-3 w-3" /> All products
          </Link>
          {cameFromOutputQueue ? (
            <Link
              href="/packaging-output#output-queue"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800 underline-offset-2 hover:underline"
            >
              Back to Production output queue <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
        <PageHeader
          title={product.name}
          description={`SKU ${product.sku} · ${product.kind}`}
          actions={
            <StatusPill kind={product.isActive ? "ok" : "neutral"}>
              {product.isActive ? "Active" : "Inactive"}
            </StatusPill>
          }
        />
      </div>

      {cameFromOutputQueue ? (
        <SetupReadinessBanner readiness={setupReadiness} />
      ) : null}

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Spec</CardTitle>
          </CardHeader>
          <CardContent>
            <SpecForm
              productId={product.id}
              tabletsPerUnit={product.tabletsPerUnit ?? null}
              unitsPerDisplay={product.unitsPerDisplay ?? null}
              displaysPerCase={product.displaysPerCase ?? null}
              defaultShelfLifeDays={product.defaultShelfLifeDays ?? null}
            />
            <div className="mt-3 pt-3 border-t border-border/60 text-[11px] text-text-muted">
              Legacy Zoho item id (single column):{" "}
              <span className="font-mono">{product.zohoItemId ?? "—"}</span>{" "}
              · use the Zoho assembly mapping card below to manage the
              per-level IDs.
            </div>
          </CardContent>
        </Card>

        <BomEditor
          productId={product.id}
          productName={product.name}
          globallyAssignedIds={globallyAssignedIds}
          tablets={tablets.map((t) => ({ id: t.id, name: t.name }))}
          materials={materials.map((m) => ({
            id: m.id,
            sku: m.sku,
            name: m.name,
            kind: m.kind,
            uom: m.uom,
            category: m.category,
          }))}
          allowed={product.allowed}
          specs={product.specs}
          {...(product.lotSummary ? { lotSummary: product.lotSummary } : {})}
        />
      </div>

      <FloorReadinessCard
        isActive={product.isActive}
        tabletMappingCount={product.allowed.length}
        tabletNames={product.allowed.map((a) => a.tabletName)}
      />

      <Card>
        <CardHeader>
          <CardTitle>Zoho assembly mapping</CardTitle>
        </CardHeader>
        <CardContent>
          <ZohoReadinessCard
            isActive={product.isActive}
            zohoItemIdUnit={product.zohoItemIdUnit ?? null}
            zohoItemIdDisplay={product.zohoItemIdDisplay ?? null}
            zohoItemIdCase={product.zohoItemIdCase ?? null}
            unitsPerDisplay={product.unitsPerDisplay ?? null}
            displaysPerCase={product.displaysPerCase ?? null}
            tabletMappingCount={product.allowed.length}
          />
          <p className="text-[11px] text-text-muted mb-4 leading-relaxed">
            These IDs map Luma product levels to existing Zoho composite items. Luma will use
            these later for tablet receiving and assembly jobs. They must match the Zoho item IDs
            exactly — Luma does not create or validate Zoho items. Run{" "}
            <code className="font-mono text-[10px]">scripts/audit-product-zoho-readiness.ts</code>{" "}
            for a fleet-wide readiness summary before enabling Zoho operations.
          </p>
          <ZohoMappingForm
            productId={product.id}
            kind={product.kind}
            unitsPerDisplay={product.unitsPerDisplay ?? null}
            displaysPerCase={product.displaysPerCase ?? null}
            zohoItemIdFallback={product.zohoItemId ?? null}
            zohoItemIdUnit={product.zohoItemIdUnit ?? null}
            zohoItemIdDisplay={product.zohoItemIdDisplay ?? null}
            zohoItemIdCase={product.zohoItemIdCase ?? null}
          />
        </CardContent>
      </Card>

      {cameFromOutputQueue ? (
        <div className="flex justify-end">
          <Link
            href="/packaging-output#output-queue"
            className="inline-flex items-center gap-1.5 rounded-md border border-brand-700 bg-brand-700 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-800 transition-colors"
          >
            Back to Production output queue <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// Banner shown only when arrived from the Production Output queue —
// gives the operator a one-glance picture of what's still missing for
// THIS specific product so they don't keep bouncing back and forth.
function SetupReadinessBanner({
  readiness,
}: {
  readiness: ReturnType<typeof evaluateProductSetupReadiness>;
}) {
  if (readiness.unknown) return null;
  if (readiness.missingFields.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 flex items-start gap-2.5">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-emerald-900">
            Product setup complete — auto-issue ready and Zoho push ready.
          </p>
          <p className="text-xs text-emerald-800/80 mt-0.5">
            Returning to the Production output queue will show any bags
            for this product as ready to auto-issue.
          </p>
        </div>
      </div>
    );
  }
  const autoIssueGaps = readiness.autoIssueBlockers.map((b) => b.label);
  const zohoGap = !readiness.zohoReady;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex items-start gap-2.5">
      <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-amber-900">
          Fix the fields below to clear the Production Output queue.
        </p>
        {autoIssueGaps.length > 0 ? (
          <p className="text-xs text-amber-800/85">
            <span className="font-semibold">Blocks auto-issue:</span>{" "}
            {autoIssueGaps.join(" · ")}
          </p>
        ) : null}
        {zohoGap ? (
          <p className="text-xs text-amber-800/85">
            <span className="font-semibold">Blocks Zoho push:</span>{" "}
            Missing Zoho item IDs (single unit, display, or master case).
            Finished lot can still be created — the Zoho push will skip.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── Zoho readiness ───────────────────────────────────────────────────────────

function ZohoReadinessCard({
  isActive,
  zohoItemIdUnit,
  zohoItemIdDisplay,
  zohoItemIdCase,
  unitsPerDisplay,
  displaysPerCase,
  tabletMappingCount,
}: {
  isActive: boolean;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  tabletMappingCount: number;
}) {
  const result = classifyProductZohoReadiness({
    isActive,
    zohoItemIdUnit,
    zohoItemIdDisplay,
    zohoItemIdCase,
    unitsPerDisplay,
    displaysPerCase,
  });

  const styles = {
    ready: {
      container: "border-emerald-200 bg-emerald-50/60",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />,
      title: "text-emerald-900",
      body: "text-emerald-800/80",
    },
    partial: {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    missing: {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    inactive: {
      container: "border-border bg-surface-2/40",
      icon: <XCircle className="h-4 w-4 text-text-muted flex-shrink-0 mt-0.5" />,
      title: "text-text-muted",
      body: "text-text-subtle",
    },
  }[result.level];

  const floorNote =
    isActive && tabletMappingCount === 0
      ? "Floor: Missing tablet mapping — product cannot be selected at a station."
      : null;

  return (
    <div className={`rounded-xl border px-4 py-3 flex gap-3 mb-4 ${styles.container}`}>
      {styles.icon}
      <div className="space-y-1 min-w-0">
        <p className={`text-sm font-semibold ${styles.title}`}>
          {zohoReadinessShortLabel(result.level)}
        </p>
        {result.reasons.length > 0 && (
          <ul className="space-y-0.5">
            {result.reasons.map((r) => (
              <li key={r} className={`text-xs ${styles.body}`}>
                {zohoReadinessReasonLabel(r)}
              </li>
            ))}
          </ul>
        )}
        {floorNote && (
          <p className="text-xs text-text-muted mt-0.5">{floorNote}</p>
        )}
      </div>
    </div>
  );
}

// ── Floor readiness ──────────────────────────────────────────────────────────

function FloorReadinessCard({
  isActive,
  tabletMappingCount,
  tabletNames,
}: {
  isActive: boolean;
  tabletMappingCount: number;
  tabletNames: string[];
}) {
  const level = floorReadinessLevel({ isActive, tabletMappingCount });

  const styles = {
    ready: {
      container: "border-emerald-200 bg-emerald-50/60",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />,
      title: "text-emerald-900",
      body: "text-emerald-800/80",
    },
    "no-tablet-mapping": {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    inactive: {
      container: "border-border bg-surface-2/40",
      icon: <XCircle className="h-4 w-4 text-text-muted flex-shrink-0 mt-0.5" />,
      title: "text-text-muted",
      body: "text-text-subtle",
    },
  }[level];

  const detail =
    level === "ready"
      ? `Tablet types: ${tabletNames.join(", ")}`
      : level === "no-tablet-mapping"
        ? "Open the Bill of Materials section below and check the tablet types this product should use."
        : "Activate this product to allow it to appear in floor station pickers.";

  return (
    <div className={`rounded-xl border px-4 py-3 flex gap-3 ${styles.container}`}>
      {styles.icon}
      <div className="space-y-0.5">
        <p className={`text-sm font-semibold ${styles.title}`}>
          {floorReadinessLabel(level)}
        </p>
        <p className={`text-xs ${styles.body}`}>{detail}</p>
      </div>
    </div>
  );
}
