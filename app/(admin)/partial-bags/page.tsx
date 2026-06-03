// PARTIAL-1 Task C — Available Partial Bags admin page.

import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { loadAvailablePartialBags } from "@/lib/production/partial-bags";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function PartialBagsPage() {
  await requireAdmin();
  const rows = await loadAvailablePartialBags();

  const count = rows.length;
  const cardTitle =
    count === 0
      ? "No partial bags"
      : `${count} bag${count === 1 ? "" : "s"} available`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Available Partial Bags"
        description="Raw bags that have been partially consumed in a production run and are ready for reuse. QR cards remain assigned to the physical bag until it is depleted."
      />

      <Card>
        <CardHeader>
          <CardTitle>{cardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {count === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted italic">
              All raw bags are either fresh (unused), in progress, or depleted.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">QR token</th>
                    <th className="text-left py-2 pr-3">Tablet type</th>
                    <th className="text-left py-2 pr-3">Supplier lot</th>
                    <th className="text-left py-2 pr-3">Receipt #</th>
                    <th className="text-right py-2 pr-3">Declared</th>
                    <th className="text-right py-2 pr-3">Remaining</th>
                    <th className="text-left py-2 pr-3">Last product</th>
                    <th className="text-left py-2 pr-3">Last used</th>
                    <th className="text-left py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map((row) => {
                    const remainingCell =
                      row.remainingEstimate == null ? (
                        <span className="italic text-text-muted">unknown</span>
                      ) : row.remainingEstimate < 100 ? (
                        <span className="text-amber-600 font-medium">
                          {row.remainingEstimate.toLocaleString()}
                        </span>
                      ) : (
                        row.remainingEstimate.toLocaleString()
                      );

                    const receiptLabel =
                      row.internalReceiptNumber ??
                      (row.receiveId ? row.receiveId.slice(0, 8) : "—");

                    const receiptCell =
                      row.receiveId ? (
                        <Link
                          href={`/inbound/${row.receiveId}`}
                          className="underline underline-offset-2 hover:text-brand-700"
                        >
                          {receiptLabel}
                        </Link>
                      ) : (
                        receiptLabel
                      );

                    return (
                      <tr
                        key={row.bagId}
                        className="hover:bg-surface-2 transition-colors"
                      >
                        <td className="py-2 pr-3 font-mono text-[11px] text-text-strong">
                          {row.bagQrCode ?? "—"}
                        </td>
                        <td className="py-2 pr-3">
                          {row.tabletTypeName ?? "—"}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px]">
                          {row.supplierLot ?? "—"}
                        </td>
                        <td className="py-2 pr-3">{receiptCell}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {row.declaredPillCount != null
                            ? row.declaredPillCount.toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {remainingCell}
                        </td>
                        <td className="py-2 pr-3">
                          {row.lastUsedProductName ?? "—"}
                        </td>
                        <td className="py-2 pr-3">
                          {row.lastUsedAt
                            ? row.lastUsedAt.toLocaleDateString("en-CA")
                            : "—"}
                        </td>
                        <td className="py-2 flex flex-wrap gap-1">
                          <Link
                            href={`/production/start?inventoryBagId=${row.bagId}`}
                            className="inline-flex items-center px-2 py-1 rounded border border-brand-300 bg-brand-50 text-brand-700 text-[11px] font-medium hover:bg-brand-100 transition-colors"
                          >
                            Start run
                          </Link>
                          <Link
                            href="/floor-board"
                            className="inline-flex items-center px-2 py-1 rounded border border-border bg-surface text-[11px] font-medium hover:bg-surface-2 transition-colors"
                          >
                            Live floor
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
