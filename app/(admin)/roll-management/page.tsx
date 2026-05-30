// ROLL-MANAGEMENT-ACCESS-1 — admin landing for floor roll mount/weigh/change.

import Link from "next/link";
import { eq, and, inArray } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { stations, machines } from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MaterialsTabs } from "@/components/ui/materials-tabs";
import { FLOOR_ROLL_STATION_KINDS } from "@/lib/production/floor-station-mobile-nav";
import { ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

const ROLL_STATION_KINDS = [...FLOOR_ROLL_STATION_KINDS] as string[];

export default async function RollManagementPage() {
  await requireAdmin();

  const stationRows = await db
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
      scanToken: stations.scanToken,
      machineName: machines.name,
    })
    .from(stations)
    .leftJoin(machines, eq(machines.id, stations.machineId))
    .where(
      and(
        eq(stations.isActive, true),
        inArray(stations.kind, ROLL_STATION_KINDS as ("BLISTER" | "COMBINED")[]),
      ),
    )
    .orderBy(stations.label);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roll management"
        description="Mount, weigh, unmount, and change PVC/foil rolls at blister-room stations. Each link opens the same floor roll page operators use from the station supervisor tools."
      />
      <MaterialsTabs />

      <Card>
        <CardHeader>
          <CardTitle>Blister-room stations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {stationRows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No active blister or combined stations are configured.
            </p>
          ) : (
            stationRows.map((s) => (
              <div
                key={s.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-border bg-page px-4 py-3"
              >
                <div>
                  <div className="font-semibold text-sm">{s.label}</div>
                  <div className="text-xs text-text-muted capitalize">
                    {s.kind.replace(/_/g, " ").toLowerCase()}
                    {s.machineName ? ` · ${s.machineName}` : " · No machine bound"}
                  </div>
                </div>
                <Link
                  href={`/floor/${s.scanToken}/rolls`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800 transition-colors"
                >
                  Open roll management
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-text-muted">
        Operators can still reach roll management from the station page via
        Supervisor tools → Rolls. This page is a supervisor shortcut from the
        office UI.
      </p>
    </div>
  );
}
