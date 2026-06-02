import { Info, Sliders } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import {
  listMachinesGrouped,
  listStationsGrouped,
} from "@/lib/db/queries/machines";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import {
  CreateMachineForm,
  CreateStationForm,
  DeactivateMachineButton,
  DeactivateStationButton,
  EditCardsPerPressForm,
  EditMachineNameForm,
  EditStationLabelForm,
  ReactivateMachineButton,
  ReactivateStationButton,
  RotateTokenButton,
} from "./forms";
import { CopyFloorUrl } from "./copy-floor-url";

export const dynamic = "force-dynamic";

function StationCard({
  station,
  machineName,
  inactive,
}: {
  station: {
    id: string;
    label: string;
    kind: string;
    scanToken: string;
    isActive: boolean;
  };
  machineName: string | null;
  inactive?: boolean;
}) {
  return (
    <li
      className={`rounded-lg border p-3 space-y-2 ${
        inactive
          ? "border-border/50 bg-surface-subtle/60 opacity-90"
          : "border-border/70 bg-surface"
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1 space-y-2">
          <EditStationLabelForm stationId={station.id} currentLabel={station.label} />
          <p className="text-[11px] text-text-subtle">
            {station.kind}
            {machineName ? ` · ${machineName}` : ""}
          </p>
          <StatusPill kind={station.isActive ? "ok" : "neutral"}>
            {station.isActive ? "Active" : "Inactive"}
          </StatusPill>
        </div>
        <div className="flex flex-col items-end gap-1">
          {station.isActive ? (
            <>
              <RotateTokenButton stationId={station.id} />
              <DeactivateStationButton stationId={station.id} />
            </>
          ) : (
            <ReactivateStationButton stationId={station.id} />
          )}
        </div>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-text-subtle mb-1">
          Floor URL
        </p>
        <CopyFloorUrl token={station.scanToken} />
        <p className="text-[10px] text-text-subtle mt-1.5 leading-relaxed">
          Scan token is stable when you edit the name. Rotate only if a tablet
          walks off. Inactive stations show a block message on the floor.
        </p>
      </div>
    </li>
  );
}

export default async function MachinesPage() {
  await requireAdmin();
  const [{ active: machines, inactive: inactiveMachines }, { active: stations, inactive: inactiveStations }] =
    await Promise.all([listMachinesGrouped(), listStationsGrouped()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Machines & stations"
        description="Manage floor scan stations and linked machines. Deactivate instead of delete when history exists. Scan tokens stay stable when you rename."
      />

      <div className="rounded-lg border border-border bg-surface-subtle px-4 py-3 flex gap-3 text-sm text-text-muted">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-text-subtle" aria-hidden />
        <div className="space-y-1 leading-relaxed">
          <p>
            <span className="font-semibold text-text">Stations</span> are floor
            scan URLs. Each gets a unique token at creation.
          </p>
          <p>
            <span className="font-semibold text-text">Machines</span> are physical
            equipment optionally linked to a station.
          </p>
          <p>
            Stations with production history cannot be hard-deleted — deactivate
            them instead. Kind/type cannot be changed after creation.
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active machines</CardTitle>
            <Sliders className="h-4 w-4 text-text-subtle" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-4">
            <DataTable>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH className="text-right">Cards / press</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <tbody>
                {machines.length === 0 ? (
                  <TR>
                    <TD className="text-text-subtle text-center py-6" colSpan={4}>
                      No active machines — add one below or reactivate an inactive one.
                    </TD>
                  </TR>
                ) : (
                  machines.map((m) => (
                    <TR key={m.id}>
                      <TD>
                        <EditMachineNameForm machineId={m.id} currentName={m.name} />
                      </TD>
                      <TD className="text-xs text-text-muted">{m.kind}</TD>
                      <TD className="text-right">
                        <EditCardsPerPressForm
                          machineId={m.id}
                          currentValue={m.cardsPerTurn}
                          machineKind={m.kind}
                        />
                      </TD>
                      <TD>
                        <DeactivateMachineButton machineId={m.id} />
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
            <CardTitle>Active stations</CardTitle>
            <Sliders className="h-4 w-4 text-text-subtle" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-4">
            {stations.length === 0 ? (
              <p className="text-sm text-text-muted">
                No active stations. Add one below or reactivate from the inactive
                list.
              </p>
            ) : (
              <ul className="space-y-2">
                {stations.map(({ station, machineName }) => (
                  <StationCard
                    key={station.id}
                    station={station}
                    machineName={machineName}
                  />
                ))}
              </ul>
            )}
            <CreateStationForm machines={machines} />
          </CardContent>
        </Card>
      </div>

      {(inactiveMachines.length > 0 || inactiveStations.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Inactive machines</CardTitle>
            </CardHeader>
            <CardContent>
              {inactiveMachines.length === 0 ? (
                <p className="text-sm text-text-muted">None</p>
              ) : (
                <DataTable>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Kind</TH>
                      <TH>Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {inactiveMachines.map((m) => (
                      <TR key={m.id}>
                        <TD className="font-medium">{m.name}</TD>
                        <TD className="text-xs text-text-muted">{m.kind}</TD>
                        <TD>
                          <ReactivateMachineButton machineId={m.id} />
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Inactive stations</CardTitle>
            </CardHeader>
            <CardContent>
              {inactiveStations.length === 0 ? (
                <p className="text-sm text-text-muted">None</p>
              ) : (
                <ul className="space-y-2">
                  {inactiveStations.map(({ station, machineName }) => (
                    <StationCard
                      key={station.id}
                      station={station}
                      machineName={machineName}
                      inactive
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
