// Operator-on-shift table — top 8 operators in last 24h. OP-1E:
// renders employees.fullName when accountability resolved, falls
// back to the typed operator_code for legacy events. Confidence
// badge marks legacy code-only rows as LOW.

import * as React from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import type { OperatorOnShiftRow } from "../_loaders";

function fmtTimeAgo(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "now";
  const ONE_MIN = 60_000;
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * ONE_MIN) return `${Math.floor(ms / ONE_MIN)}m ago`;
  if (ms < 24 * 60 * ONE_MIN)
    return `${Math.floor(ms / (60 * ONE_MIN))}h ago`;
  return `${Math.floor(ms / (24 * 60 * ONE_MIN))}d ago`;
}

export function OperatorOnShiftCard({
  rows,
  hasOperatorPayload,
}: {
  rows: OperatorOnShiftRow[];
  hasOperatorPayload: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4 text-brand-700" />
          Operators on shift · last 24h
          <span className="ml-auto text-[11px] font-normal text-text-muted tabular-nums">
            {rows.length} active
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!hasOperatorPayload ? (
          <p className="px-4 py-4 text-sm text-text-muted">
            No operator activity in the last 24 hours —{" "}
            <Link
              href="/settings/legacy-import"
              className="underline text-brand-700 hover:text-brand-800"
            >
              run the synthesizer
            </Link>{" "}
            on legacy data, or operators will populate this once they
            open a shift on a station.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-text-muted">
            No operator activity in the last 24 hours.
          </p>
        ) : (
          <DataTable className="border-0 rounded-none">
            <THead>
              <TR>
                <TH>Operator</TH>
                <TH>Code</TH>
                <TH className="text-right">Events</TH>
                <TH className="text-right">Stations</TH>
                <TH>Last seen</TH>
              </TR>
            </THead>
            <tbody>
              {rows.map((o) => (
                <TR key={o.groupKey}>
                  <TD className="font-semibold">
                    {o.displayName}
                    {o.confidence === "LOW" && (
                      <span className="ml-2 rounded bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 text-[10px]">
                        legacy code only
                      </span>
                    )}
                  </TD>
                  <TD className="font-mono text-text-muted text-xs">
                    {o.operatorCode ?? "—"}
                  </TD>
                  <TD className="text-right tabular-nums">{o.events}</TD>
                  <TD className="text-right tabular-nums">
                    {o.distinctStations}
                  </TD>
                  <TD className="text-xs text-text-muted">
                    {fmtTimeAgo(o.lastEventAt)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}
