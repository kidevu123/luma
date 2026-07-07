import Link from "next/link";
import { ClipboardCheck, ArrowRight } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listCloseoutPoIndexRollups } from "@/lib/db/queries/po-closeout";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = { title: "PO Closeout" };

// BAG-PRODUCTION-SUMMARY-1 — Active/Closed tabs so admins can focus on live
// work. Bucketing is conservative (lib/production/po-closeout.ts): a PO is
// Closed only when every received bag is resolved and nothing is blocked on
// Zoho; ambiguity always lands in Active.
const TABS = [
  { key: "active", label: "Active POs" },
  { key: "closed", label: "Closed POs" },
  { key: "all", label: "All" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function PoCloseoutListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  await requireAdmin();
  const { q, tab } = await searchParams;
  const activeTab: TabKey =
    tab === "closed" || tab === "all" ? (tab as TabKey) : "active";
  const query = (q ?? "").trim().toLowerCase();

  const pos = await listCloseoutPoIndexRollups();
  const activeCount = pos.filter((p) => p.bucket === "ACTIVE").length;
  const closedCount = pos.length - activeCount;

  const byTab =
    activeTab === "all"
      ? pos
      : pos.filter((p) =>
          activeTab === "active" ? p.bucket === "ACTIVE" : p.bucket === "CLOSED",
        );
  const filtered = query
    ? byTab.filter(
        (p) =>
          p.poNumber.toLowerCase().includes(query) ||
          (p.vendorName ?? "").toLowerCase().includes(query),
      )
    : byTab;

  const tabCount = (key: TabKey) =>
    key === "all" ? pos.length : key === "active" ? activeCount : closedCount;

  return (
    <div className="space-y-5">
      <PageHeader
        title="PO closeout"
        description="One place to see, per PO, which bags are done and which still need a Luma action. Active means at least one bag or Zoho output still needs attention; Closed means no manual Luma action remains."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/po-closeout?tab=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium",
                activeTab === t.key
                  ? "bg-brand-700 text-white"
                  : "text-text-muted hover:bg-surface-2",
              )}
            >
              {t.label} ({tabCount(t.key)})
            </Link>
          ))}
        </div>
        <form className="flex gap-2" action="/po-closeout" method="get">
          <input type="hidden" name="tab" value={activeTab} />
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search PO number or vendor…"
            className="w-64 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            Search
          </button>
        </form>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={
            activeTab === "closed"
              ? "No closed POs match"
              : activeTab === "active"
                ? "No active POs match"
                : "No POs found"
          }
          description={
            query
              ? "Adjust your search."
              : activeTab === "closed"
                ? "A PO shows here once every bag is resolved and Zoho output is queued or committed."
                : "Receive a tablet PO first."
          }
        />
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>PO #</TH>
              <TH>Vendor</TH>
              <TH>PO status</TH>
              <TH>Closeout</TH>
              <TH className="text-right">Receives</TH>
              <TH className="text-right">Bags</TH>
              <TH className="text-right">Done</TH>
              <TH className="text-right">Open</TH>
              <TH className="text-right">Zoho blockers</TH>
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
                <TD>
                  <StatusPill kind={p.bucket === "CLOSED" ? "ok" : "warn"}>
                    {p.bucket === "CLOSED" ? "Closed" : "Active"}
                  </StatusPill>
                </TD>
                <TD className="text-right tabular-nums text-xs">{p.receiveCount}</TD>
                <TD className="text-right tabular-nums text-xs">{p.bagCount}</TD>
                <TD className="text-right tabular-nums text-xs text-good-700">
                  {p.doneBagCount}
                </TD>
                <TD
                  className={cn(
                    "text-right tabular-nums text-xs",
                    p.openBagCount > 0 ? "font-semibold text-warn-700" : "text-text-muted",
                  )}
                >
                  {p.openBagCount}
                </TD>
                <TD
                  className={cn(
                    "text-right tabular-nums text-xs",
                    p.zohoBlockerCount > 0 ? "font-semibold text-crit-700" : "text-text-muted",
                  )}
                >
                  {p.zohoBlockerCount}
                </TD>
                <TD className="text-right">
                  <Link
                    href={`/po-closeout/${p.id}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                  >
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
