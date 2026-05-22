// app/(admin)/floor-board/_components/widgets/floor-map-widget.tsx
"use client";

import { groupStationsByStep, PACK_OUT_KINDS } from "@/lib/floor-command/step-groups";
import type { StationWithLive, StepGroup } from "@/lib/floor-command/types";
import { Users } from "lucide-react";

function BlisterSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="mc-base" x="5" y="5" width="90" height="50" rx="4" />
      <rect className="mc-body" x="10" y="12" width="55" height="36" rx="2" />
      <rect className="mc-body-d" x="68" y="12" width="22" height="36" rx="2" />
      <rect className="mc-panel" x="14" y="16" width="47" height="28" rx="1" />
      <rect className="mc-glass" x="16" y="18" width="43" height="24" rx="1" />
      <rect className="mc-glow" x="14" y="37" width="47" height="4" rx="1" />
      <circle className="mc-det" cx="73" cy="20" r="3" />
      <circle className="mc-det" cx="83" cy="20" r="3" />
      <rect className="mc-scrn" x="70" y="28" width="16" height="12" rx="1" />
    </svg>
  );
}

function SealerSvg() {
  return (
    <svg viewBox="0 0 100 32" className="w-full h-full" aria-hidden="true">
      <rect className="mc-base" x="3" y="3" width="94" height="26" rx="3" />
      <rect className="mc-body" x="8" y="7" width="60" height="18" rx="2" />
      <rect className="mc-body-d" x="72" y="7" width="18" height="18" rx="2" />
      <rect className="mc-panel" x="12" y="10" width="52" height="12" rx="1" />
      <rect className="mc-glow" x="12" y="18" width="52" height="2" />
      <rect className="mc-seam" x="8" y="15" width="60" height="1" />
      <circle className="mc-det" cx="76" cy="13" r="2" />
      <circle className="mc-det" cx="84" cy="13" r="2" />
    </svg>
  );
}

function StickerSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <circle className="mc-base" cx="20" cy="30" r="18" />
      <circle className="mc-body" cx="20" cy="30" r="12" />
      <circle className="mc-body-d" cx="20" cy="30" r="6" />
      <rect className="mc-body" x="44" y="10" width="20" height="40" rx="3" />
      <rect className="mc-body-d" x="68" y="10" width="20" height="40" rx="3" />
      <rect className="mc-glass" x="46" y="12" width="16" height="36" rx="2" />
      <rect className="mc-glass" x="70" y="12" width="16" height="36" rx="2" />
    </svg>
  );
}

function PackagingSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="mc-base" x="10" y="20" width="50" height="35" rx="2" />
      <rect className="mc-body" x="13" y="23" width="44" height="29" rx="1" />
      <polygon className="mc-body-d" points="10,20 35,5 60,20" />
      <polygon className="mc-panel" points="13,20 35,8 57,20" />
      <rect className="mc-glow" x="18" y="38" width="34" height="3" rx="1" />
      <rect className="mc-base" x="65" y="30" width="30" height="25" rx="2" />
      <rect className="mc-body" x="67" y="32" width="26" height="21" rx="1" />
      <polygon className="mc-body-d" points="65,30 80,20 95,30" />
    </svg>
  );
}

function HandpackSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="mc-base" x="5" y="30" width="90" height="25" rx="3" />
      <rect className="mc-body" x="8" y="33" width="84" height="19" rx="2" />
      <rect className="mc-seam" x="8" y="42" width="84" height="1" />
      <circle className="mc-det" cx="20" cy="22" r="8" />
      <circle className="mc-body-d" cx="20" cy="22" r="5" />
      <circle className="mc-det" cx="50" cy="20" r="8" />
      <circle className="mc-body-d" cx="50" cy="20" r="5" />
      <circle className="mc-det" cx="80" cy="22" r="8" />
      <circle className="mc-body-d" cx="80" cy="22" r="5" />
    </svg>
  );
}

function MachineSvg({ kind }: { kind: string }) {
  switch (kind) {
    case "BLISTER":
    case "BOTTLE_HANDPACK":
      return <BlisterSvg />;
    case "SEALING":
    case "BOTTLE_CAP_SEAL":
      return <SealerSvg />;
    case "BOTTLE_STICKER":
      return <StickerSvg />;
    case "PACKAGING":
    case "COMBINED":
      return <PackagingSvg />;
    case "HANDPACK_BLISTER":
      return <HandpackSvg />;
    default:
      return <PackagingSvg />;
  }
}

function formatBusyTime(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

type CardStatus = "running" | "paused" | "idle" | "empty";

function getCardStatus(station: StationWithLive): CardStatus {
  if (!station.lastEventAt) return "empty";
  const now = Date.now();
  const age = now - station.lastEventAt.getTime();
  if (station.currentWorkflowBagId) {
    return age < 30 * 60 * 1000 ? "running" : "paused";
  }
  return age < 5 * 60 * 1000 ? "idle" : "empty";
}

const CARD_STATUS_STYLES: Record<CardStatus, string> = {
  running: "border-emerald-500/60",
  paused: "border-amber-500/50",
  idle: "border-slate-600/50",
  empty: "border-slate-700/30 opacity-50",
};

function MachineCard({ station }: { station: StationWithLive }) {
  const status = getCardStatus(station);
  const isPack = PACK_OUT_KINDS.includes(station.kind);

  return (
    <div
      className={`flex flex-col rounded border bg-slate-900 p-2 gap-1 ${CARD_STATUS_STYLES[status]}`}
      style={{ minWidth: 120 }}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold text-slate-300 truncate">
          {station.label}
        </span>
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            status === "running"
              ? "bg-emerald-400"
              : status === "paused"
                ? "bg-amber-400"
                : status === "idle"
                  ? "bg-slate-500"
                  : "bg-slate-700"
          }`}
        />
      </div>

      {isPack ? (
        <div className="flex items-center gap-1 h-10 text-slate-500">
          <Users size={14} />
          <span className="text-[10px]">hand pack</span>
        </div>
      ) : (
        <div className="h-10 opacity-70">
          <MachineSvg kind={station.kind} />
        </div>
      )}

      {station.currentEmployeeName && (
        <div className="text-[10px] text-slate-400 truncate">
          {station.currentEmployeeName}
        </div>
      )}
      {station.currentProductName && (
        <div className="text-[10px] text-slate-500 truncate">
          {station.currentProductName}
        </div>
      )}
      {station.machineTargetBagsPerHour !== null &&
        station.busyForSeconds !== null && (
          <div className="text-[10px] text-slate-500">
            {formatBusyTime(station.busyForSeconds)} on bag · target{" "}
            {station.machineTargetBagsPerHour}/hr
          </div>
        )}
    </div>
  );
}

function StepColumn({ group }: { group: StepGroup }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-1">
        {group.label}
      </div>
      <div className="flex flex-col gap-2">
        {group.stations.map((s) => (
          <MachineCard key={s.id} station={s} />
        ))}
      </div>
    </div>
  );
}

export function FloorMapWidget({ stations }: { stations: StationWithLive[] }) {
  const groups = groupStationsByStep(stations);

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No active stations found. Add stations in master data.
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 p-3 overflow-x-auto h-full">
      {groups.map((group, i) => (
        <div key={group.label} className="flex items-start gap-3">
          <StepColumn group={group} />
          {i < groups.length - 1 && (
            <div className="flex items-center self-center">
              <div className="w-6 h-px bg-slate-600" />
              <div className="w-0 h-0 border-t-4 border-b-4 border-l-4 border-t-transparent border-b-transparent border-l-slate-600" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
