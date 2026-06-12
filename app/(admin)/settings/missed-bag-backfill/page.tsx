import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { machines, stations } from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MissedBagBackfillForm } from "./backfill-form";

export const dynamic = "force-dynamic";

export default async function MissedBagBackfillPage() {
  await requireAdmin();

  const blisterStations = await db
    .select({
      id: stations.id,
      label: stations.label,
      machineName: machines.name,
    })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.kind, "BLISTER"));

  const stationOptions = blisterStations.map((s) => ({
    id: s.id,
    label: `${s.label}${s.machineName ? ` · ${s.machineName}` : ""}`,
  }));

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Settings
        </Link>
        <PageHeader
          title="Missed blister bag backfill"
          description="Record a bag that was run on the floor but never scanned — card assignment, PVC roll change, and blister complete — with historical timestamps."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Backfill form</CardTitle>
        </CardHeader>
        <CardContent>
          {stationOptions.length === 0 ? (
            <p className="text-sm text-red-700">
              No BLISTER station found. Configure machines and stations first.
            </p>
          ) : (
            <MissedBagBackfillForm stations={stationOptions} />
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-text-muted leading-relaxed">
        CLI equivalent:{" "}
        <code className="font-mono text-[10px]">
          tsx scripts/apply-missed-blister-bag-backfill.ts
        </code>
      </p>
    </div>
  );
}
