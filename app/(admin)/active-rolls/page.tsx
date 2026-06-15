// Phase H.x7 — Active rolls panel.

import { requireAdmin } from "@/lib/auth-guards";
import { loadActiveRollPanel, type ActiveRollRow } from "@/lib/production/material-panels";
import { getRollYieldReconciliation } from "@/lib/production/roll-yield-reconciliation";
import { RollYieldReconciliationPanel } from "@/app/(admin)/settings/blister-standards/_components/roll-yield-reconciliation-panel";
import { PageHeader } from "@/components/ui/page-header";
import { MaterialsTabs } from "@/components/ui/materials-tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { formatDateTimeEst, formatWeightKg } from "@/lib/ui/luma-display";

export const dynamic = "force-dynamic";

export default async function ActiveRollsPage() {
  await requireAdmin();
  const [panel, reconciliation] = await Promise.all([
    loadActiveRollPanel(),
    getRollYieldReconciliation(),
  ]);

  const reconByLot = new Map(
    reconciliation.rows.map((r) => [r.packagingLotId, r]),
  );

  return (
    <div className="space-y-5">
      <MaterialsTabs />
      <PageHeader
        title="Active rolls"
        description="PVC and foil rolls currently mounted on roll-capable machines. Missing rows mean no roll is mounted, never an inferred roll."
      />

      {reconciliation.activeRunway.length > 0 && (
        <RollYieldReconciliationPanel
          rows={reconciliation.rows}
          activeRunway={reconciliation.activeRunway}
          cardsPerTurn={reconciliation.cardsPerTurnDefault}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>By machine</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {panel.machineRows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No roll-capable machines configured.
            </p>
          ) : (
            panel.machineRows.map((machine) => {
              const pvc = machine.rolls.find((r) => r.materialRole === "PVC");
              const foil = machine.rolls.find((r) => r.materialRole === "FOIL");
              return (
                <div
                  key={machine.machineId}
                  className="rounded border border-border bg-page p-3 text-sm"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="font-semibold">{machine.machineName}</div>
                      <div className="text-[11px] text-text-muted font-mono">
                        {machine.machineId.slice(0, 8)}
                      </div>
                      {machine.warnings.length > 0 && (
                        <div className="mt-1 text-[11px] text-amber-700">
                          {machine.warnings.join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {pvc ? <RoleBadge label="PVC" roll={pvc} /> : <EmptyRoll label="PVC" />}
                      {foil ? <RoleBadge label="FOIL" roll={foil} /> : <EmptyRoll label="FOIL" />}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detail</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.rows.length === 0 ? (
            <p className="text-sm text-text-muted py-6 text-center">
              No active rolls mounted across any machine.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Role</th>
                    <th className="text-left p-2">Roll #</th>
                    <th className="text-left p-2">Machine</th>
                    <th className="text-left p-2">Mounted</th>
                    <th className="text-right p-2">Current est.</th>
                    <th className="text-right p-2">Cycles</th>
                    <th className="text-right p-2">Cards (×2)</th>
                    <th className="text-right p-2">Projected blisters left</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Conf.</th>
                    <th className="text-left p-2">Estimated vs actual</th>
                    <th className="text-left p-2">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.rows.map((r) => {
                    const recon = reconByLot.get(r.packagingLotId);
                    return (
                    <tr key={r.packagingLotId} className="border-t border-border/40">
                      <td className="p-2">{r.materialRole ?? "Missing"}</td>
                      <td className="p-2">{r.rollNumber ?? r.packagingLotId.slice(0, 8)}</td>
                      <td className="p-2">{r.machineName ?? "Unassigned"}</td>
                      <td className="p-2">
                        {r.mountedAt ? formatDateTimeEst(r.mountedAt) : "Missing"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.currentWeightGramsEstimate != null
                          ? formatWeightKg(r.currentWeightGramsEstimate)
                          : r.startingWeightGrams != null
                            ? formatWeightKg(r.startingWeightGrams)
                            : "Missing"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {recon?.machineCycles != null
                          ? recon.machineCycles.toLocaleString()
                          : "0"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {recon?.blisterRoomCards != null
                          ? recon.blisterRoomCards.toLocaleString()
                          : "0"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {recon?.remainingCardsVsManufacturer != null
                          ? recon.remainingCardsVsManufacturer.toLocaleString()
                          : r.projectedBlistersRemaining ?? "—"}
                      </td>
                      <td className="p-2 font-mono text-[10px]">{r.sourceSystem}</td>
                      <td className="p-2"><ConfidenceBadge confidence={r.confidence} /></td>
                      <td className="p-2">{r.estimateActualLabel}</td>
                      <td className="p-2 text-[10px] text-text-muted">
                        {r.warnings.length > 0 ? r.warnings.join(", ") : "None"}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RoleBadge({ label, roll }: { label: string; roll: ActiveRollRow }) {
  return (
    <span className="rounded border border-border/70 bg-surface px-2 py-1 text-[11px] tabular-nums">
      <span className="font-semibold mr-1">{label}</span>
      {roll.rollNumber ?? roll.packagingLotId.slice(0, 8)} ·{" "}
      {roll.currentWeightGramsEstimate != null
        ? formatWeightKg(roll.currentWeightGramsEstimate)
        : roll.startingWeightGrams != null
          ? formatWeightKg(roll.startingWeightGrams)
          : "Missing"}{" "}
      · <ConfidenceBadge confidence={roll.confidence} className="align-middle" />
    </span>
  );
}

function EmptyRoll({ label }: { label: string }) {
  return (
    <span className="rounded border border-dashed border-border/70 bg-surface px-2 py-1 text-[11px] text-text-muted">
      No {label} mounted
    </span>
  );
}
