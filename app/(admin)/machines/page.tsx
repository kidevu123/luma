import { Sliders } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listMachines, listStations } from "@/lib/db/queries/machines";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { CreateMachineForm, CreateStationForm, RotateTokenButton } from "./forms";
import { CopyFloorUrl } from "./copy-floor-url";

export const dynamic = "force-dynamic";

export default async function MachinesPage() {
  await requireAdmin();
  const [machines, stationRows] = await Promise.all([
    listMachines(),
    listStations(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Machines & stations"
        description="A station is a QR scan target on the floor. Stations can be linked to a machine so completion events sync into output. Tokens are rotated from this page."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Machines</CardTitle>
            <Sliders className="h-4 w-4 text-text-subtle" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-4">
            <DataTable>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH className="text-right">Units / cycle</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <tbody>
                {machines.length === 0 ? (
                  <TR>
                    <TD className="text-text-subtle text-center py-6" colSpan={4}>
                      No machines yet — add one to start scanning.
                    </TD>
                  </TR>
                ) : (
                  machines.map((m) => (
                    <TR key={m.id}>
                      <TD className="font-medium">{m.name}</TD>
                      <TD className="text-xs text-text-muted">{m.kind}</TD>
                      <TD className="text-right tabular-nums">{m.cardsPerTurn}</TD>
                      <TD>
                        <StatusPill kind={m.isActive ? "ok" : "neutral"}>
                          {m.isActive ? "Active" : "Inactive"}
                        </StatusPill>
                      </TD>
                    </TR>
                  ))
                )}
              </tbody>
            </DataTable>
            <CreateMachineForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stations</CardTitle>
            <Sliders className="h-4 w-4 text-text-subtle" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-4">
            {stationRows.length === 0 ? (
              <p className="text-sm text-text-muted">
                No stations yet. Add one below — it'll get a unique scan
                URL you can open on a tablet.
              </p>
            ) : (
              <ul className="space-y-2">
                {stationRows.map(({ station, machineName }) => (
                  <li
                    key={station.id}
                    className="rounded-lg border border-border/70 bg-surface p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{station.label}</p>
                        <p className="text-[11px] text-text-subtle">
                          {station.kind}
                          {machineName ? ` · ${machineName}` : ""}
                        </p>
                      </div>
                      <RotateTokenButton stationId={station.id} />
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-text-subtle mb-1">
                        Floor URL
                      </p>
                      <CopyFloorUrl token={station.scanToken} />
                      <p className="text-[10px] text-text-subtle mt-1.5 leading-relaxed">
                        Open this URL on the tablet at the station. The
                        scan token is the auth — anyone with the URL can
                        record events at that station, so rotate it if
                        a tablet walks off.
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <CreateStationForm machines={machines} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
