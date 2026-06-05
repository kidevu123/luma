"use client";

import { formatDateTimeEst } from "@/lib/ui/luma-display";

// MATERIAL-ROLL-CHANGE-1 — PVC/Foil roll status + mid-bag change on the
// main BLISTER/COMBINED station page. Reuses changeRollAction via
// ChangeRollForm from rolls-forms.tsx (same path as /floor/{token}/rolls).

import * as React from "react";
import { ChangeRollForm } from "./rolls-forms";
import { formatGramsAsKg } from "@/lib/inbound/roll-weight";

export type StationRollStatus = {
  role: "PVC" | "FOIL";
  rollNumber: string | null;
  materialName: string;
  materialKind: string;
  currentWeightEstimateGrams: number | null;
  mountedAt: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

type IdleLot = {
  id: string;
  rollNumber: string | null;
  netWeightGrams: number | null;
  currentEstimateGrams: number | null;
  materialName: string;
  materialKind: string;
};

type ActiveBag = {
  id: string;
  label: string;
  startedAt: Date | string | null;
};

export function StationRollPanel({
  token,
  stationId,
  machineBound,
  activeRolls,
  idleRollLots,
  activeBag,
  requiredChangeRole = null,
}: {
  token: string;
  stationId: string;
  machineBound: boolean;
  activeRolls: StationRollStatus[];
  idleRollLots: IdleLot[];
  activeBag: ActiveBag | null;
  requiredChangeRole?: "PVC" | "FOIL" | null;
}) {
  const [openRole, setOpenRole] = React.useState<"PVC" | "FOIL" | null>(
    requiredChangeRole,
  );

  React.useEffect(() => {
    if (requiredChangeRole) setOpenRole(requiredChangeRole);
  }, [requiredChangeRole]);

  function rollFor(role: "PVC" | "FOIL"): StationRollStatus | undefined {
    return activeRolls.find((r) => r.role === role);
  }

  function canChange(role: "PVC" | "FOIL"): boolean {
    return (
      machineBound &&
      activeBag != null &&
      rollFor(role) != null &&
      idleRollLots.length > 0
    );
  }

  return (
    <section className="rounded-2xl bg-surface border border-border p-4 space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-subtle">
        Machine rolls
      </p>

      {!machineBound ? (
        <p className="text-sm text-text-muted">
          Station has no machine bound — rolls cannot be tracked.
        </p>
      ) : (
        <>
          {requiredChangeRole ? (
            <RollChangeRequiredCard
              role={requiredChangeRole}
              activeRoll={rollFor(requiredChangeRole) ?? null}
            />
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            {(["PVC", "FOIL"] as const).map((role) => {
              const roll = rollFor(role);
              return (
                <div
                  key={role}
                  className="rounded-xl border border-border/70 bg-page/50 px-3 py-2 text-sm"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {role}
                  </div>
                  {roll ? (
                    <>
                      <div className="font-medium truncate">
                        {roll.rollNumber ?? "(no roll #)"}
                      </div>
                      <div className="text-xs text-text-muted truncate">
                        {roll.materialName}
                      </div>
                    </>
                  ) : (
                    <div className="text-text-muted">Not mounted</div>
                  )}
                </div>
              );
            })}
          </div>

          {openRole == null ? (
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => setOpenRole("PVC")}
                disabled={!canChange("PVC")}
                className="flex-1 rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-sm font-medium px-4 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Change PVC roll
              </button>
              <button
                type="button"
                onClick={() => setOpenRole("FOIL")}
                disabled={!canChange("FOIL")}
                className="flex-1 rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white text-sm font-medium px-4 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Change Foil roll
              </button>
            </div>
          ) : activeBag && (!requiredChangeRole || rollFor(openRole)) ? (
            <ChangeRollForm
              token={token}
              stationId={stationId}
              activeBag={activeBag}
              idleRollLots={idleRollLots}
              fixedRole={openRole}
              replacementInputMode={requiredChangeRole ? "text" : "select"}
              showEndingWeight={requiredChangeRole != null}
              onCancel={() => setOpenRole(null)}
            />
          ) : null}

          {!activeBag ? (
            <p className="text-xs text-text-muted">
              Scan a card to start a bag before changing rolls mid-bag. Mount
              or unmount between bags via Supervisor tools → Rolls.
            </p>
          ) : !rollFor("PVC") && !rollFor("FOIL") ? (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No rolls mounted — mount rolls before close-out so consumption
              can be tracked. Use Supervisor tools → Rolls to mount.
            </p>
          ) : idleRollLots.length === 0 ? (
            <p className="text-xs text-text-muted">
              No replacement roll inventory available. Receive rolls in inbound
              first.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function RollChangeRequiredCard({
  role,
  activeRoll,
}: {
  role: "PVC" | "FOIL";
  activeRoll: StationRollStatus | null;
}) {
  const label = role === "PVC" ? "PVC" : "Foil";
  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 space-y-2">
      <div>
        <p className="font-semibold">{label} roll change required</p>
        <p className="text-xs text-amber-900/80">
          Complete the roll change below, then resume the bag when the machine is ready.
        </p>
      </div>
      {activeRoll ? (
        <div className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-xs">
          <div className="font-semibold">
            Current {label} roll: {activeRoll.rollNumber ?? "(no roll #)"}
          </div>
          <div className="text-amber-900/80">
            {activeRoll.materialName} · {activeRoll.materialKind}
          </div>
          <div className="text-amber-900/70">
            {activeRoll.currentWeightEstimateGrams != null
              ? `${formatGramsAsKg(activeRoll.currentWeightEstimateGrams)} estimated`
              : "Weight estimate missing"}{" "}
            · conf {activeRoll.confidence} · mounted{" "}
            {formatDateTimeEst(activeRoll.mountedAt)}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-300 bg-white/70 px-3 py-2 text-xs font-medium">
          No active {label} roll is mounted for this machine. Supervisor check required.
        </div>
      )}
    </div>
  );
}
