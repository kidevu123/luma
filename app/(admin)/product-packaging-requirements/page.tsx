// Phase H.x7 — Product packaging requirements panel.
// Upgraded to hierarchical BOM view grouped by scope (UNIT / DISPLAY / CASE).
// Product structure (tabs/unit, units/display, displays/case) loaded alongside
// the BOM panel and shown inline.

import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { loadProductPackagingRequirementsPanel } from "@/lib/production/material-panels";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import type { ProductPackagingRequirementLine } from "@/lib/production/material-panels";

export const dynamic = "force-dynamic";

// ─── helpers ──────────────────────────────────────────────────────────────────

const SCOPE_ORDER = ["UNIT", "DISPLAY", "CASE"] as const;
type Scope = (typeof SCOPE_ORDER)[number];

function ScopeLabel({
  scope,
  note,
}: {
  scope: string;
  note?: string | undefined;
}) {
  return (
    <div className="flex items-baseline gap-3 mb-2 mt-4 first:mt-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
        {scope === "UNIT"
          ? "Unit packaging"
          : scope === "DISPLAY"
            ? "Display packaging"
            : scope === "CASE"
              ? "Case packaging"
              : scope}
      </span>
      {note ? (
        <span className="text-[11px] text-text-muted">{note}</span>
      ) : null}
    </div>
  );
}

function BomTable({ lines }: { lines: ProductPackagingRequirementLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="text-[11.5px] text-text-subtle italic py-1 pl-1">
        None configured
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-border/50">
            <th className="text-left py-1 pr-5 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              Material
            </th>
            <th className="text-left py-1 pr-5 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              Kind
            </th>
            <th className="text-right py-1 pr-5 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              Qty
            </th>
            <th className="text-left py-1 pr-5 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              UoM
            </th>
            <th className="text-right py-1 pr-5 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              Waste %
            </th>
            <th className="text-left py-1 font-medium text-text-muted text-[10.5px] uppercase tracking-wide whitespace-nowrap">
              Conf.
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr
              key={`${line.materialId ?? "null"}-${line.perScope ?? "null"}-${i}`}
              className="border-b border-border/25 last:border-0"
            >
              <td className="py-1.5 pr-5">
                <div className="text-text-strong">
                  {line.materialName ?? (
                    <span className="italic text-text-subtle">Missing material</span>
                  )}
                </div>
                {line.materialSku ? (
                  <div className="font-mono text-[10px] text-text-muted">
                    {line.materialSku}
                  </div>
                ) : null}
              </td>
              <td className="py-1.5 pr-5 text-text">
                {line.materialKind ?? (
                  <span className="italic text-text-subtle">—</span>
                )}
              </td>
              <td className="py-1.5 pr-5 text-right tabular-nums text-text-strong">
                {line.qtyNeeded != null ? line.qtyNeeded : (
                  <span className="italic text-text-subtle">—</span>
                )}
              </td>
              <td className="py-1.5 pr-5 text-text-muted">
                {line.unit ?? "—"}
              </td>
              <td className="py-1.5 pr-5 text-right tabular-nums text-text">
                {line.wasteAllowancePct != null ? `${line.wasteAllowancePct}%` : "0%"}
              </td>
              <td className="py-1.5">
                <ConfidenceBadge confidence={line.confidence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function ProductPackagingRequirementsPage() {
  await requireAdmin();

  const [panel, productStructures] = await Promise.all([
    loadProductPackagingRequirementsPanel(),
    db
      .select({
        id: products.id,
        tabletsPerUnit: products.tabletsPerUnit,
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
        kind: products.kind,
      })
      .from(products)
      .where(eq(products.isActive, true)),
  ]);

  const structByProduct = new Map(productStructures.map((p) => [p.id, p]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product packaging requirements"
        description="BOM view by product, grouped by packaging scope. Missing product structure or packaging BOM stays explicit; no requirements are inferred."
      />

      {panel.products.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              Product packaging requirements missing. No active products are configured.
            </p>
          </CardContent>
        </Card>
      ) : (
        panel.products.map((product) => {
          const struct = structByProduct.get(product.productId);

          // Group BOM lines by scope.
          const byScope = new Map<string, ProductPackagingRequirementLine[]>();
          for (const scope of SCOPE_ORDER) {
            byScope.set(scope, []);
          }
          for (const line of product.lines) {
            const scope = line.perScope ?? "UNIT";
            const existing = byScope.get(scope);
            if (existing !== undefined) {
              existing.push(line);
            } else {
              byScope.set(scope, [line]);
            }
          }

          // Structure note shown inline with DISPLAY and CASE headings.
          const displayNote =
            struct?.unitsPerDisplay != null
              ? `1 display = ${struct.unitsPerDisplay} unit${struct.unitsPerDisplay === 1 ? "" : "s"}`
              : undefined;
          const caseNote =
            struct?.displaysPerCase != null
              ? `1 case = ${struct.displaysPerCase} display${struct.displaysPerCase === 1 ? "" : "s"}`
              : undefined;

          return (
            <Card key={product.productId}>
              <CardHeader>
                <CardTitle className="flex items-baseline gap-2 flex-wrap">
                  <Link
                    href={`/products/${product.productId}`}
                    className="hover:underline text-text-strong"
                  >
                    {product.productName}
                  </Link>
                  <span className="font-mono text-xs text-text-muted">
                    {product.productSku}
                  </span>
                  {struct?.kind ? (
                    <span className="text-[11px] text-text-subtle font-normal">
                      {struct.kind}
                    </span>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Product structure summary */}
                {struct != null && (
                  struct.tabletsPerUnit != null ||
                  struct.unitsPerDisplay != null ||
                  struct.displaysPerCase != null
                ) ? (
                  <div className="mb-4 text-[12px] text-text-muted space-x-3">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mr-2">
                      Structure
                    </span>
                    {struct.tabletsPerUnit != null ? (
                      <span>{struct.tabletsPerUnit} tabs/unit</span>
                    ) : null}
                    {struct.unitsPerDisplay != null ? (
                      <span>{struct.unitsPerDisplay} units/display</span>
                    ) : null}
                    {struct.displaysPerCase != null ? (
                      <span>{struct.displaysPerCase} displays/case</span>
                    ) : null}
                  </div>
                ) : null}

                {product.lines.length === 0 ? (
                  <div className="rounded border border-dashed border-border/70 bg-page p-4 text-sm text-text-muted">
                    <div className="font-medium text-text">
                      Product packaging requirements missing
                    </div>
                    {product.missingInputs.length > 0 ? (
                      <div className="mt-1 text-[11px]">
                        missing inputs: {product.missingInputs.join(", ")}
                      </div>
                    ) : null}
                    <div className="mt-2 flex items-center gap-3">
                      <ConfidenceBadge confidence={product.confidence} />
                      <Link
                        href={`/products/${product.productId}`}
                        className="text-[11.5px] text-text-muted underline hover:text-text"
                      >
                        Open BOM editor
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div>
                    {/* RAW INPUT placeholder */}
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mb-2">
                      Raw input
                    </div>
                    <div className="mb-4 rounded border border-dashed border-border/50 px-3 py-2 text-[11.5px] text-text-muted">
                      Tablet types come from product_allowed_tablets, not packaging BOM.{" "}
                      <Link
                        href={`/products/${product.productId}`}
                        className="underline hover:text-text"
                      >
                        See product BOM editor
                      </Link>
                    </div>

                    {/* UNIT, DISPLAY, CASE scope sections */}
                    {SCOPE_ORDER.map((scope) => {
                      const lines = byScope.get(scope) ?? [];
                      const note =
                        scope === "DISPLAY"
                          ? displayNote
                          : scope === "CASE"
                            ? caseNote
                            : scope === "UNIT" && struct?.tabletsPerUnit != null
                              ? `per finished unit (${struct.tabletsPerUnit} tabs)`
                              : undefined;
                      return (
                        <div key={scope} className="mb-1">
                          <ScopeLabel scope={scope} note={note} />
                          <BomTable lines={lines} />
                        </div>
                      );
                    })}

                    {/* Lines with unknown/non-standard scope */}
                    {(() => {
                      const knownScopes = new Set<string>(SCOPE_ORDER);
                      const otherLines = product.lines.filter(
                        (l) => l.perScope != null && !knownScopes.has(l.perScope),
                      );
                      if (otherLines.length === 0) return null;
                      return (
                        <div className="mb-1">
                          <ScopeLabel scope="Other" />
                          <BomTable lines={otherLines} />
                        </div>
                      );
                    })()}

                    {/* Overall missing-inputs warning */}
                    {product.missingInputs.length > 0 ? (
                      <div className="mt-3 rounded border border-warn-500/30 bg-warn-50/50 px-3 py-2 text-[11.5px] text-warn-700">
                        Missing inputs: {product.missingInputs.join(", ")}
                      </div>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
