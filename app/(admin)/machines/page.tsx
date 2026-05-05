import { Sliders } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listMachines, listStations } from "@/lib/db/queries/machines";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { CreateMachineForm, CreateStationForm, RotateTokenButton } from "./forms";

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
                  <TH className="text-right">Cards / turn</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <tbody>
                {machines.length === 0 ? (
                  <TR>
                    <TD className="text-text-subtle text-center py-6">
                      No machines yet — add one to start scanning.
                    </TD>
                    <TD />
                    <TD />
                    <TD />
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
            <DataTable>
              <THead>
                <TR>
                  <TH>Label</TH>
                  <TH>Kind</TH>
                  <TH>Machine</TH>
                  <TH>Token</TH>
                  <TH className="text-right">Action</TH>
                </TR>
              </THead>
              <tbody>
                {stationRows.length === 0 ? (
                  <TR>
                    <TD className="text-text-subtle text-center py-6" colSpan={5}>
                      No stations yet.
                    </TD>
                  </TR>
                ) : (
                  stationRows.map(({ station, machineName }) => (
                    <TR key={station.id}>
                      <TD className="font-medium">{station.label}</TD>
                      <TD className="text-xs text-text-muted">{station.kind}</TD>
                      <TD className="text-xs text-text-muted">{machineName ?? "—"}</TD>
                      <TD className="font-mono text-[11px] text-text-muted truncate max-w-[140px]">
                        {station.scanToken}
                      </TD>
                      <TD className="text-right">
                        <RotateTokenButton stationId={station.id} />
                      </TD>
                    </TR>
                  ))
                )}
              </tbody>
            </DataTable>
            <CreateStationForm machines={machines} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
