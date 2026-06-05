"use client";

import {
  actionItems,
  cardState,
  CARD_STATE_LABEL,
  formatDuration,
  machineSubtitle,
  shiftTotalLabel,
  TV_STATE_COLORS,
} from "@/lib/floor-command/station-tile-utils";
import { formatWeightKg } from "@/lib/ui/luma-display";
import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";

type Props = {
  row: StationCommandRow;
};

export function TvStationTile({ row }: Props) {
  const actions = actionItems(row);
  const state = cardState(row, actions);
  const colors = TV_STATE_COLORS[state];
  const operator = row.activeOperatorName ?? row.operatorName;
  const bagLabel = row.bagLabel ?? row.receiptNumber ?? "—";
  const pauseNote = row.isPaused
    ? actions.find((a) => a.toLowerCase().includes("pause")) ?? "Paused"
    : null;

  const pvcRoll = row.activeRolls.find(
    (r) => r.materialRole === "PVC" || r.materialKind?.includes("PVC"),
  );
  const foilRoll = row.activeRolls.find(
    (r) => r.materialRole === "FOIL" || r.materialKind?.includes("FOIL"),
  );

  const detailPills: Array<{ text: string; alert?: boolean }> = [];
  if (operator) detailPills.push({ text: operator });
  if (pvcRoll?.projectedRemainingGrams != null) {
    detailPills.push({
      text: `PVC ${formatWeightKg(pvcRoll.projectedRemainingGrams)}`,
    });
  }
  if (foilRoll?.projectedRemainingGrams != null) {
    detailPills.push({
      text: `Foil ${formatWeightKg(foilRoll.projectedRemainingGrams)}`,
    });
  }
  if (row.todayBlistered > 0 && row.stationKind.includes("BLISTER")) {
    detailPills.push({ text: `${row.todayBlistered} blistered` });
  }
  if (row.todaySealed > 0 && (row.stationKind === "SEALING" || row.stationKind === "COMBINED")) {
    detailPills.push({ text: `${row.todaySealed} sealed` });
  }
  if (row.todayPackaged > 0 && row.stationKind === "PACKAGING") {
    detailPills.push({ text: `${row.todayPackaged} packaged` });
  }
  for (const a of actions) {
    if (
      a !== "Paused" &&
      !detailPills.some((p) => p.text === a)
    ) {
      detailPills.push({ text: a, alert: true });
    }
  }

  return (
    <article
      className="tv-station"
      style={
        {
          "--state": colors.state,
          "--state-border": colors.border,
          "--glow": colors.glow,
        } as React.CSSProperties
      }
    >
      <div className="tv-station-top">
        <span className="tv-dot" />
        <span className="tv-station-name">{row.stationLabel}</span>
        <span className="tv-badge">{CARD_STATE_LABEL[state]}</span>
      </div>
      <div className="tv-machine">{machineSubtitle(row)}</div>
      {row.workflowBagId ? (
        <>
          <div className="tv-bag">{bagLabel}</div>
          {row.productName && (
            <div className="tv-product">{row.productName}</div>
          )}
        </>
      ) : pauseNote ? (
        <div className="tv-bag" style={{ fontSize: 14 }}>
          {pauseNote}
        </div>
      ) : (row.queueWip ?? 0) > 0 ? (
        <div className="tv-bag" style={{ fontSize: 14, color: "#ffd18a" }}>
          {row.queueWip} in queue
        </div>
      ) : (
        <div className="tv-bag" style={{ fontSize: 13, color: "#66798c" }}>
          No active bag
        </div>
      )}
      {detailPills.length > 0 && (
        <div className="tv-details">
          {detailPills.map((p) => (
            <span
              key={p.text}
              className={p.alert ? "tv-pill alert" : "tv-pill"}
            >
              {p.text}
            </span>
          ))}
        </div>
      )}
      <div className="tv-station-foot">
        <span>{shiftTotalLabel(row)}</span>
        <span>
          {row.elapsedSeconds != null
            ? formatDuration(row.elapsedSeconds)
            : row.idleMinutes != null
              ? `idle ${row.idleMinutes}m`
              : "—"}
        </span>
      </div>
    </article>
  );
}
