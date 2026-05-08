// Phase H.x4 — Floor roll-management page.
//
// What an operator at a station sees on a tablet to mount, unmount,
// or weigh PVC/foil rolls bound to that station's machine. Active
// rolls are shown at the top so it's obvious whether the machine
// has rolls loaded; below that are the three action forms.
//
// The page is intentionally simple: scan-or-pick a roll, fill in
// minimal data, submit. No clever animations. The operator works
// fast and the data must round-trip honestly.

import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
import {
  mountRollAction,
  unmountRollAction,
  weighRollAction,
  changeRollAction,
} from "../roll-actions";

export const dynamic = "force-dynamic";

const ROLL_KINDS = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"] as const;

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

  // Active rolls and idle (AVAILABLE) roll lots — the lists the
  // operator picks from. Filter to roll kinds only; non-roll lots
  // (caps, labels, etc.) never appear here.
  const [activeRolls, availableLots] = await Promise.all([
    machine ? getActiveRollsForMachine(machine.id) : Promise.resolve([]),
    db
      .select({
        id: packagingLots.id,
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
  const idleRollLots = availableLots.filter((l) =>
    ROLL_KINDS.includes(l.materialKind as (typeof ROLL_KINDS)[number]),
  );

  // Active bag at THIS station — the segment will be allocated to it
  // (alongside the active PVC + active foil rolls). Pulled from
  // read_station_live so the operator never types a UUID. Filtered to
  // bags that are still alive (not finalized).
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
          startedAt: activeBagRow.bagStartedAt,
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
                        ? `${r.currentWeightEstimateGrams} g est.`
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
          <Empty>No roll inventory available. Receive rolls in /inbound/packaging-materials first.</Empty>
        ) : (
          <form
            action={async (fd) => {
              "use server";
              await mountRollAction(fd);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />
            <Field label="Roll lot">
              <select
                name="packagingLotId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="">— Select roll —</option>
                {idleRollLots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.rollNumber ?? lot.id.slice(0, 8)} · {lot.materialName} ·{" "}
                    {lot.netWeightGrams != null ? `${lot.netWeightGrams} g` : "weight ?"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <div className="flex gap-2">
                {(["PVC", "FOIL"] as const).map((r) => (
                  <label key={r} className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded border border-border bg-surface text-sm cursor-pointer">
                    <input type="radio" name="role" value={r} required />
                    {r}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Starting weight (g, optional override)">
              <input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                name="startingWeightGrams"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
              />
            </Field>
            <Field label="Notes (optional)">
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </Field>
            <Submit>Mount roll</Submit>
          </form>
        )}
      </Section>

      <Section title="Unmount roll">
        {activeRolls.length === 0 ? (
          <Empty>No rolls to unmount.</Empty>
        ) : (
          <form
            action={async (fd) => {
              "use server";
              await unmountRollAction(fd);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />
            <Field label="Active roll">
              <select
                name="packagingLotId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="">— Select active roll —</option>
                {activeRolls.map((r) => (
                  <option key={r.packagingLotId} value={r.packagingLotId}>
                    {r.role} · {r.rollNumber ?? r.packagingLotId.slice(0, 8)} ·{" "}
                    {r.currentWeightEstimateGrams != null
                      ? `${r.currentWeightEstimateGrams} g`
                      : "weight ?"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Final weight (g, optional)">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                name="endingWeightGrams"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
              />
              <p className="text-[11px] text-text-muted mt-1">
                Leave blank if not weighed back. Lot stays AVAILABLE; confidence
                will be MEDIUM until a weigh-back lands.
              </p>
            </Field>
            <Field label="Notes (optional)">
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </Field>
            <Submit>Unmount roll</Submit>
          </form>
        )}
      </Section>

      <Section title="Weigh roll">
        {activeRolls.length === 0 ? (
          <Empty>No rolls mounted to weigh.</Empty>
        ) : (
          <form
            action={async (fd) => {
              "use server";
              await weighRollAction(fd);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />
            <Field label="Active roll">
              <select
                name="packagingLotId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="">— Select active roll —</option>
                {activeRolls.map((r) => (
                  <option key={r.packagingLotId} value={r.packagingLotId}>
                    {r.role} · {r.rollNumber ?? r.packagingLotId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Current weight (g)">
              <input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                required
                name="currentWeightGrams"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
              />
            </Field>
            <Field label="Notes (optional)">
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </Field>
            <Submit>Record weight</Submit>
          </form>
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
          <form
            action={async (fd) => {
              "use server";
              await changeRollAction(fd);
            }}
            className="space-y-3"
          >
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="stationId" value={station.id} />
            <input type="hidden" name="clientEventId" value={randomUUID()} />
            <input type="hidden" name="workflowBagId" value={activeBag.id} />
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs space-y-0.5">
              <div className="font-semibold text-amber-900">
                Segment will be allocated to: {activeBag.label}
              </div>
              <div className="text-amber-900/80 font-mono text-[10px]">
                bag {activeBag.id.slice(0, 8)} · started{" "}
                {activeBag.startedAt
                  ? new Date(activeBag.startedAt).toLocaleString()
                  : "—"}
              </div>
              <div className="text-amber-900/80">
                Counter goes to the old roll, the still-active other-role roll,
                and this bag.
              </div>
            </div>
            <p className="text-xs text-text-muted">
              Use this when a roll runs out (or is changed out) mid-bag. Enter
              the machine counter when this roll stopped — that count goes to the
              old roll AND to the other active roll for the segment.
            </p>
            <Field label="Role being changed">
              <div className="flex gap-2">
                {(["PVC", "FOIL"] as const).map((r) => (
                  <label
                    key={r}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded border border-border bg-surface text-sm cursor-pointer"
                  >
                    <input type="radio" name="role" value={r} required />
                    {r}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Counter when this roll stopped (segment count)">
              <input
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                required
                name="counterSegmentCount"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
              />
            </Field>
            <Field label="New roll lot (replacement)">
              <select
                name="newPackagingLotId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="">— Select new roll —</option>
                {idleRollLots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.rollNumber ?? lot.id.slice(0, 8)} · {lot.materialName} ·{" "}
                    {lot.netWeightGrams != null ? `${lot.netWeightGrams} g` : "weight ?"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes (optional)">
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </Field>
            <Submit>Change roll</Submit>
          </form>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function Submit({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-sm font-medium px-4 py-3 transition-colors"
    >
      {children}
    </button>
  );
}
