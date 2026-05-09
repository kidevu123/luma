// Phase H.x7 — Product packaging requirements panel.

import { requireAdmin } from "@/lib/auth-guards";
import { loadProductPackagingRequirementsPanel } from "@/lib/production/material-panels";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";

export const dynamic = "force-dynamic";

export default async function ProductPackagingRequirementsPage() {
  await requireAdmin();
  const panel = await loadProductPackagingRequirementsPanel();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product packaging requirements"
        description="Read-only BOM view by product. Missing product structure or packaging BOM stays explicit; no requirements are inferred."
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
        panel.products.map((product) => (
          <Card key={product.productId}>
            <CardHeader>
              <CardTitle>
                <span>{product.productName}</span>
                <span className="ml-2 font-mono text-xs text-text-muted">{product.productSku}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {product.lines.length === 0 ? (
                <div className="rounded border border-dashed border-border/70 bg-page p-4 text-sm text-text-muted">
                  <div className="font-medium text-text">Product packaging requirements missing</div>
                  <div className="mt-1 text-[11px]">
                    missing inputs: {product.missingInputs.join(", ")}
                  </div>
                  <div className="mt-2"><ConfidenceBadge confidence={product.confidence} /></div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-text-muted text-xs uppercase">
                      <tr>
                        <th className="text-left p-2">Required material</th>
                        <th className="text-left p-2">Type</th>
                        <th className="text-right p-2">Quantity needed</th>
                        <th className="text-left p-2">Scope</th>
                        <th className="text-right p-2">Waste allowance</th>
                        <th className="text-left p-2">Conf.</th>
                        <th className="text-left p-2">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.lines.map((line) => (
                        <tr
                          key={`${line.productId}-${line.materialId}-${line.perScope}`}
                          className="border-t border-border/40"
                        >
                          <td className="p-2">
                            <div>{line.materialName ?? "Missing material"}</div>
                            <div className="font-mono text-[10px] text-text-muted">
                              {line.materialSku ?? "Missing SKU"}
                            </div>
                          </td>
                          <td className="p-2">{line.materialKind ?? "Missing"}</td>
                          <td className="p-2 text-right tabular-nums">
                            {line.qtyNeeded ?? "Missing"} {line.unit ?? ""}
                          </td>
                          <td className="p-2">{line.perScope ?? "Missing"}</td>
                          <td className="p-2 text-right tabular-nums">
                            {line.wasteAllowancePct ?? 0}%
                          </td>
                          <td className="p-2"><ConfidenceBadge confidence={line.confidence} /></td>
                          <td className="p-2">
                            {line.missingInputs.length > 0
                              ? `missing inputs: ${line.missingInputs.join(", ")}`
                              : line.label}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
