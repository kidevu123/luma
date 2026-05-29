// Phase H.x4 + VALIDATION-2E — Floor roll-management page.
//
// What an operator at a station sees on a tablet to mount, unmount,
// or weigh PVC/foil rolls bound to that station's machine. The forms
// themselves are client components (rolls-forms.tsx) so we can show
// pending / success / error state instead of silently swallowing the
// server action result.

import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  stations,
  machines,
  packagingLots,
  packagingMaterials,
  readStationLive,
  workflowBags,
  qrCards,
} from "@/lib/db/schema";
import { getActiveRollsForMachine } from "@/lib/production/active-rolls";
import { formatGramsAsKg } from "@/lib/inbound/roll-weight";
import { filterSelectableIdleRollLots } from "@/lib/production/idle-roll-lots";
import {
  MountRollForm,
  UnmountRollForm,
  WeighRollForm,
  ChangeRollForm,
} from "../rolls-forms";

export const dynamic = "force-dynamic";

export default async function FloorRollsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [stationRow] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.scanToken, token));
  if (!stationRow) notFound();

  const { station, machine } = stationRow;

  const [activeRolls, availableLots] = await Promise.all([
    machine ? getActiveRollsForMachine(machine.id) : Promise.resolve([]),
    db
      .select({
        id: packagingLots.id,
        status: packagingLots.status,
        rollNumber: packagingLots.rollNumber,
        netWeightGrams: packagingLots.netWeightGrams,
        currentEstimateGrams: packagingLots.currentWeightGramsEstimate,
        materialName: packagingMaterials.name,
        materialKind: packagingMaterials.kind,
      })
      .from(packagingLots)
      .innerJoin(
        packagingMaterials,
        eq(packagingMaterials.id, packagingLots.packagingMaterialId),
      )
      .where(and(eq(packagingLots.status, "AVAILABLE"))),
  ]);
  const idleRollLots = filterSelectableIdleRollLots(availableLots);
  const idleLotsForForm = idleRollLots.map((l) => ({
    id: l.id,
    rollNumber: l.rollNumber,
    netWeightGrams: l.netWeightGrams,
    currentEstimateGrams: l.currentEstimateGrams,
    materialName: l.materialName,
  }));
  const activeRollsForForm = activeRolls.map((r) => ({
    packagingLotId: r.packagingLotId,
    rollNumber: r.rollNumber,
    role: r.role as "PVC" | "FOIL",
  }));

  // Active bag at THIS station — drives the change-roll form's
  // workflowBagId hidden input. Pulled from read_station_live so the
  // operator never types a UUID. Filtered to bags that are still alive
  // (not finalized).
  const [activeBagRow] = await db
    .select({
      bagId: readStationLive.currentWorkflowBagId,
      cardLabel: qrCards.label,
      bagStartedAt: workflowBags.startedAt,
      bagFinalizedAt: workflowBags.finalizedAt,
    })
    .from(readStationLive)
    .leftJoin(workflowBags, eq(workflowBags.id, readStationLive.currentWorkflowBagId))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, readStationLive.currentWorkflowBagId))
    .where(eq(readStationLive.stationId, station.id));
  const activeBag =
    activeBagRow?.bagId && !activeBagRow.bagFinalizedAt
      ? {
          id: activeBagRow.bagId,
          label: activeBagRow.cardLabel ?? `bag ${activeBagRow.bagId.slice(0, 8)}`,
          startedAt: (activeBagRow.bagStartedAt as unknown as string) ?? null,
        }
      : null;

  return (
    <main className="min-h-dvh bg-page p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
          Roll management
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{station.label}</h1>
        <p className="text-xs text-text-muted">
          {station.kind}
          {machine ? ` · ${machine.name}` : " · No machine bound"}
        </p>
      </header>

      <Section title="Active rolls">
        {!machine ? (
          <Empty>Station has no machine bound — rolls cannot be tracked.</Empty>
        ) : activeRolls.length === 0 ? (
          <Empty>No active rolls mounted on this machine.</Empty>
        ) : (
          <div className="space-y-2">
            {activeRolls.map((r) => (
              <div
                key={r.packagingLotId}
                className="rounded-xl border border-border bg-surface p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {r.role} · {r.rollNumber ?? "(no roll #)"}
                    </div>
                    <div className="text-xs text-text-muted">{r.materialName}</div>
                  </div>
                  <div className="text-xs text-right tabular-nums">
                    <div>
                      {r.currentWeightEstimateGrams != null
                        ? `${formatGramsAsKg(r.currentWeightEstimateGrams)} est.`
                        : "—"}
                    </div>
                    <div className="text-text-muted">
                      mounted {new Date(r.mountedAt).toLocaleString()}
                    </div>
                    <div className="text-text-muted">conf {r.confidence}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Mount roll">
        {!machine ? (
          <Empty>Station has no machine bound — cannot mount.</Empty>
        ) : idleRollLots.length === 0 ? (
          <Empty>
            No roll inventory available. Receive rolls in
            /inbound/packaging-materials first.
          </Empty>
        ) : (
          <MountRollForm
            token={token}
            stationId={station.id}
            idleRollLots={idleLotsForForm}
          />
        )}
      </Section>

      <Section title="Unmount roll">
        {activeRolls.length === 0 ? (
          <Empty>No rolls to unmount.</Empty>
        ) : (
          <UnmountRollForm
            token={token}
            stationId={station.id}
            activeRolls={activeRollsForForm}
          />
        )}
      </Section>

      <Section title="Weigh roll">
        {activeRolls.length === 0 ? (
          <Empty>No rolls mounted to weigh.</Empty>
        ) : (
          <WeighRollForm
            token={token}
            stationId={station.id}
            activeRolls={activeRollsForForm}
          />
        )}
      </Section>

      <Section title="Change roll mid-bag">
        {activeRolls.length === 0 ? (
          <Empty>No active rolls to change.</Empty>
        ) : idleRollLots.length === 0 ? (
          <Empty>
            No replacement roll inventory available. Receive rolls in
            /inbound/packaging-materials first.
          </Empty>
        ) : !activeBag ? (
          <Empty>
            No active bag at this station. Scan a card on the main station page
            to start a bag, then return here. The mid-bag segment must be
            allocated to a real bag — typing a UUID is not allowed.
          </Empty>
        ) : (
          <ChangeRollForm
            token={token}
            stationId={station.id}
            activeBag={activeBag}
            idleRollLots={idleLotsForForm}
          />
        )}
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface border border-border p-4 sm:p-5 space-y-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>;
}
