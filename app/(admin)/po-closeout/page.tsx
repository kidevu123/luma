import Link from "next/link";
import { ClipboardCheck, ArrowRight } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listCloseoutPoOptions } from "@/lib/db/queries/po-closeout";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function PoCloseoutListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdmin();
  const { q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();
  const pos = await listCloseoutPoOptions();
  const filtered = query
    ? pos.filter(
        (p) =>
          p.poNumber.toLowerCase().includes(query) ||
          (p.vendorName ?? "").toLowerCase().includes(query),
      )
    : pos;

  return (
    <div className="space-y-5">
      <PageHeader
        title="PO closeout"
        description="One place to see, per PO, which bags are done and which still need a Luma action. Pick a PO to open its closeout command center."
      />

      <form className="flex gap-2" action="/po-closeout" method="get">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search PO number or vendor…"
          className="w-full max-w-sm rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
          Search
        </button>
      </form>

      {filtered.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No POs found" description="Adjust your search, or receive a tablet PO first." />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>PO #</TH>
              <TH>Vendor</TH>
              <TH>PO status</TH>
              <TH>{" "}</TH>
            </TR>
          </THead>
          <tbody>
            {filtered.map((p) => (
              <TR key={p.id}>
                <TD className="font-mono text-xs font-semibold">{p.poNumber}</TD>
                <TD className="text-sm">{p.vendorName ?? "—"}</TD>
                <TD>
                  <StatusPill kind="neutral">{p.status}</StatusPill>
                </TD>
                <TD className="text-right">
                  <Link href={`/po-closeout/${p.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                    Open closeout <ArrowRight className="h-3 w-3" />
                  </Link>
                </TD>
              </TR>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
