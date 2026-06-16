"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Search, Settings2 } from "lucide-react";
import { StatusPill } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProductDialog } from "./product-dialog";

export type ProductRow = {
  id: string;
  sku: string;
  name: string;
  kind: "CARD" | "BOTTLE" | "VARIETY";
  productFamily: string | null;
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
  zohoItemId: string | null;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
  zohoLiveCommitEnabled: boolean;
  dailyUnitGoal: number | null;
  isActive: boolean;
  createdAt: Date;
  allowedCount: number;
  allowedTabletIds: string[];
};

type KindFilter = "ALL" | "CARD" | "BOTTLE" | "VARIETY";

// TEMPORARY: derived from product name until product_family column exists.
function deriveProductFamily(name: string): string {
  const trimmed = name.trim();
  const dashIdx = trimmed.indexOf(" - ");
  if (dashIdx !== -1) return trimmed.slice(0, dashIdx).trim();
  return trimmed
    .replace(/\s+(nct|ncf|bottle|variety\s*pack|pack)$/i, "")
    .trim();
}

function tabletLabel(row: ProductRow): string {
  if (row.kind === "VARIETY") return "Mixed";
  if (row.allowedCount === 0) return "Not mapped";
  return String(row.allowedCount);
}

function tabletCls(row: ProductRow): string {
  if (row.kind === "VARIETY") return "text-text-muted";
  if (row.allowedCount === 0) return "text-warn-700 font-medium";
  return "text-text";
}

export function ProductsBrowser({ rows }: { rows: ProductRow[] }) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("ALL");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== "ALL" && r.kind !== kindFilter) return false;
      if (q) {
        const hay = `${r.name} ${r.sku}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, kindFilter]);

  // Summary stats from ALL rows (not filtered).
  const totalActive = rows.filter((r) => r.isActive).length;
  const cardCount = rows.filter((r) => r.kind === "CARD").length;
  const bottleCount = rows.filter((r) => r.kind === "BOTTLE").length;
  const varietyCount = rows.filter((r) => r.kind === "VARIETY").length;
  const missingMapping = rows.filter(
    (r) => r.kind !== "VARIETY" && r.allowedCount === 0,
  ).length;

  // Group filtered rows by derived family.
  const grouped = useMemo(() => {
    const map = new Map<string, ProductRow[]>();
    for (const r of filtered) {
      const family = deriveProductFamily(r.name);
      const arr = map.get(family) ?? [];
      arr.push(r);
      map.set(family, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const kindCounts: Record<string, number> = { ALL: rows.length, CARD: cardCount, BOTTLE: bottleCount, VARIETY: varietyCount };
  const kindLabels: KindFilter[] = ["ALL", "CARD", "BOTTLE", "VARIETY"];

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Active" value={String(totalActive)} />
        <StatCard label="Cards" value={String(cardCount)} />
        <StatCard label="Bottles" value={String(bottleCount)} />
        <StatCard label="Variety" value={String(varietyCount)} />
        <StatCard
          label="Missing mapping"
          value={String(missingMapping)}
          tone={missingMapping > 0 ? "warn" : "good"}
        />
      </div>

      {/* Search + kind filter */}
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or SKU…"
            className="w-full h-9 pl-8 pr-3 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700/20"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
          {kindLabels.map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`h-7 px-3 rounded-md text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                kindFilter === k
                  ? "bg-brand-700 text-white"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {k === "ALL" ? `All (${kindCounts.ALL})` : `${k} (${kindCounts[k]})`}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/70 bg-surface-2/40 p-6 text-sm text-text-muted text-center">
          No products match your search.
        </div>
      )}

      {/* Grouped product sections */}
      {grouped.map(([family, familyRows]) => (
        <Card key={family}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-sm font-semibold text-text-strong">
              {family}
              <span className="ml-2 text-[11px] font-normal text-text-muted">
                {familyRows.length} {familyRows.length === 1 ? "product" : "products"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            <DataTable className="border-0 rounded-none">
              <THead>
                <TR>
                  <TH>SKU</TH>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH className="text-right">tabs/unit</TH>
                  <TH className="text-right">units/display</TH>
                  <TH className="text-right">displays/case</TH>
                  <TH className="text-right">tablets</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <tbody>
                {familyRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono text-xs text-text-muted">{r.sku}</TD>
                    <TD className="font-medium">
                      <Link href={`/products/${r.id}`} className="hover:underline text-text">
                        {r.name}
                      </Link>
                    </TD>
                    <TD>
                      <KindChip kind={r.kind} />
                    </TD>
                    <TD className="text-right tabular-nums text-text-muted text-[12px]">
                      {r.tabletsPerUnit ?? "—"}
                    </TD>
                    <TD className="text-right tabular-nums text-text-muted text-[12px]">
                      {r.unitsPerDisplay ?? "—"}
                    </TD>
                    <TD className="text-right tabular-nums text-text-muted text-[12px]">
                      {r.displaysPerCase ?? "—"}
                    </TD>
                    <TD className={`text-right tabular-nums text-[12px] ${tabletCls(r)}`}>
                      {tabletLabel(r)}
                    </TD>
                    <TD>
                      <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                        {r.isActive ? "Active" : "Inactive"}
                      </StatusPill>
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/products/${r.id}`}
                          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
                        >
                          <Settings2 className="h-3 w-3" />
                          BOM
                        </Link>
                        <ProductDialog row={r} triggerLabel="Edit" />
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function KindChip({ kind }: { kind: "CARD" | "BOTTLE" | "VARIETY" }) {
  const cls =
    kind === "CARD"    ? "bg-info-50 text-info-700 border-info-500/40" :
    kind === "BOTTLE"  ? "bg-good-50 text-good-700 border-good-500/40" :
                         "bg-warn-50 text-warn-700 border-warn-500/40";
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {kind}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "neutral";
}) {
  const valueCls =
    tone === "good" ? "text-good-700" :
    tone === "warn" ? "text-warn-700" :
    "text-text-strong";
  return (
    <div className="rounded-xl border border-border/60 bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}
