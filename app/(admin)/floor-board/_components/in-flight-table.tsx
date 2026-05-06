// Top 20 in-flight bags table. Shows the longest-running unfinalized
// bags so the lead can prioritize finalize/release decisions. Click
// → bag detail page (placeholder href).
//
// Compact bag inventory strip — single row of mini cards (one per
// tablet type) replacing the previous full table. Available count
// is the prominent number; in-use + emptied are tiny secondary text.

import * as React from "react";
import Link from "next/link";
import { Hourglass, Pill, PauseCircle, CircleSlash } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/page-header";
import type { InFlightBagRow } from "../_loaders";

const STAGE_KIND: Record<string, "ok" | "warn" | "info" | "neutral"> = {
  STARTED: "neutral",
  BLISTERED: "info",
  SEALED: "info",
  PACKAGED: "ok",
  FINALIZED: "ok",
};

const ONE_MIN = 60_000;
const ONE_HOUR = 60 * ONE_MIN;

function fmtElapsed(ms: number): string {
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / ONE_MIN);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `${hours}h ${rem.toString().padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return `${days}d ${remH.toString().padStart(2, "0")}h`;
}

function fmtTimeAgo(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < ONE_HOUR) return `${Math.floor(ms / ONE_MIN)}m`;
  if (ms < 24 * ONE_HOUR) return `${Math.floor(ms / ONE_HOUR)}h`;
  return `${Math.floor(ms / (24 * ONE_HOUR))}d`;
}

export function TopInFlightTable({ rows }: { rows: InFlightBagRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hourglass className="h-4 w-4 text-amber-700" />
          Longest-running bags · in flight
          <span className="ml-auto text-[11px] font-normal text-text-muted tabular-nums">
            top {rows.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable className="border-0 rounded-none">
          <THead>
            <TR>
              <TH>Receipt</TH>
              <TH>Product</TH>
              <TH>Stage</TH>
              <TH className="text-right">Elapsed</TH>
              <TH className="text-right">Last event</TH>
            </TR>
          </THead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>
                No bags in flight (last 14 days).
              </EmptyRow>
            ) : (
              rows.map((r) => {
                const elapsed = Date.now() - r.startedAt.getTime();
                return (
                  <TR key={r.bagId}>
                    <TD className="font-mono text-xs">
                      <Link
                        href={`/bags/${r.bagId}`}
                        className="hover:text-brand-700 hover:underline"
                      >
                        {r.receiptNumber ?? r.bagId.slice(0, 8)}
                      </Link>
                    </TD>
                    <TD className="text-xs truncate max-w-[180px]">
                      {r.productName ?? (
                        <span className="text-text-subtle">—</span>
                      )}
                    </TD>
                    <TD>
                      <span className="inline-flex items-center gap-1">
                        <StatusPill
                          kind={STAGE_KIND[r.stage ?? "STARTED"] ?? "neutral"}
                        >
                          {r.stage ?? "STARTED"}
                        </StatusPill>
                        {r.isPaused && (
                          <PauseCircle
                            className="h-3 w-3 text-amber-700"
                            aria-label="paused"
                          />
                        )}
                        {r.isOnHold && (
                          <CircleSlash
                            className="h-3 w-3 text-red-700"
                            aria-label="on hold"
                          />
                        )}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums text-xs">
                      {fmtElapsed(elapsed)}
                    </TD>
                    <TD className="text-right tabular-nums text-xs text-text-muted">
                      {fmtTimeAgo(r.lastEventAt)}
                    </TD>
                  </TR>
                );
              })
            )}
          </tbody>
        </DataTable>
      </CardContent>
    </Card>
  );
}

// ─── Compact bag inventory strip ─────────────────────────────────────────

export function BagInventoryStrip({
  rows,
}: {
  rows: Array<{
    tabletName: string | null;
    tabletSku: string | null;
    available: number;
    inUse: number;
    emptied: number;
  }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Pill className="h-4 w-4 text-brand-700" />
          Bag inventory in stock
          <span className="ml-auto text-[11px] font-normal text-text-muted tabular-nums">
            {rows.length} types ·{" "}
            {rows
              .reduce((s, r) => s + r.available, 0)
              .toLocaleString()}{" "}
            available
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-text-muted">
            No raw inventory yet. Receive a shipment from /inbound.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-1.5">
            {rows.map((r, i) => (
              <div
                key={i}
                className="rounded border border-border/70 bg-surface-2/30 px-2 py-1.5"
              >
                <p className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold truncate">
                  {r.tabletName ?? "—"}
                </p>
                <p className="text-lg font-semibold tabular-nums leading-tight">
                  {r.available.toLocaleString()}
                </p>
                <p className="text-[10px] text-text-muted leading-tight">
                  {r.inUse}u · {r.emptied}e
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
