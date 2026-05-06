// Floor station landing — what an operator sees on a tablet at a
// production station after scanning the station QR. The URL token
// is the station's scan_token (cryptographic identifier; rotated
// from /machines admin).
//
// Each station only sees the bag CURRENTLY at this station — driven
// by read_station_live.currentWorkflowBagId. No cross-station
// leak.

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  stations,
  machines,
  qrCards,
  workflowBags,
  readBagState,
  readStationLive,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ScanCardForm } from "./scan-card-form";
import { StageActionButtons } from "./stage-action-buttons";

export const dynamic = "force-dynamic";

export default async function FloorStationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [station] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.scanToken, token));
  if (!station) notFound();

  // The bag at THIS station (and only this one) lives in
  // read_station_live.currentWorkflowBagId. Joining qr_cards back
  // gives us the card label + scan token for display.
  const [currentAtStation] = await db
    .select({
      bag: workflowBags,
      card: qrCards,
      state: readBagState,
    })
    .from(readStationLive)
    .innerJoin(workflowBags, eq(readStationLive.currentWorkflowBagId, workflowBags.id))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(eq(readStationLive.stationId, station.station.id));

  // Idle cards available to scan, sorted by label so the dropdown
  // is predictable. Eventually replace with a scan-only input.
  const idleCards = await db
    .select()
    .from(qrCards)
    .where(eq(qrCards.status, "IDLE"));

  return (
    <main className="min-h-dvh bg-page p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
            Station
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{station.station.label}</h1>
          <p className="text-xs text-text-muted">
            {station.station.kind}
            {station.machine ? ` · ${station.machine.name}` : ""}
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium">
          Online
        </span>
      </header>

      <section className="rounded-2xl bg-surface border border-border p-5 space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
          Current bag
        </p>
        {!currentAtStation ? (
          <div className="py-3">
            <p className="text-sm text-text-muted mb-3">
              No bag at this station. Scan a card to begin.
            </p>
            <ScanCardForm
              token={token}
              stationId={station.station.id}
              idleCards={idleCards.map((c) => ({
                id: c.id,
                label: c.label,
                scanToken: c.scanToken,
              }))}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/70 bg-surface-2/40 p-4">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-base font-semibold tracking-tight">
                  {currentAtStation.card?.label ?? "—"}
                </p>
                <span className="font-mono text-[11px] text-text-subtle">
                  {currentAtStation.bag.id.slice(0, 8)}
                </span>
              </div>
              <p className="text-xs text-text-muted">
                Started{" "}
                {currentAtStation.bag.startedAt
                  ? new Date(
                      currentAtStation.bag.startedAt as unknown as string,
                    ).toLocaleTimeString()
                  : "—"}
                {currentAtStation.state?.currentOperatorCode
                  ? ` · operator ${currentAtStation.state.currentOperatorCode}`
                  : ""}
              </p>
            </div>
            <StageActionButtons
              token={token}
              stationId={station.station.id}
              stationKind={station.station.kind}
              workflowBagId={currentAtStation.bag.id}
              isPaused={currentAtStation.state?.isPaused ?? false}
            />
          </div>
        )}
      </section>

      <p className="text-center text-[10px] text-text-subtle">
        Luma · {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "dev"}
      </p>
    </main>
  );
}
