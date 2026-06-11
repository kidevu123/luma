// One lane per production line, visually unmistakable: cyan card line,
// violet bottle line. Steps flow left → right with the waiting queue
// between steps shown on the step that will consume it.

import type {
  FloorManagerSnapshot,
  StationCommandRow,
  WipStageRow,
} from "@/lib/production/floor-manager-snapshot-types";
import {
  buildLineStepGroupsForLine,
  lineFlowLabel,
  type ProductionLineDefinition,
} from "@/lib/floor-command/production-lines";
import { formatWait, receiptLabel } from "@/lib/floor-command/floor-display";
import { board, Chip, lineAccents, type LineAccent } from "./board-ui";

// Which between-steps WIP stage feeds each card-line step.
const CARD_STEP_INBOUND: Record<string, string> = {
  blister: "STARTED",
  sealing: "BLISTERED",
  packaging: "SEALED",
};

function inboundForStep(
  lineId: string,
  stepKey: string,
  wipByStage: WipStageRow[],
): WipStageRow | null {
  if (lineId !== "card_route") return null;
  const stage = CARD_STEP_INBOUND[stepKey];
  if (!stage) return null;
  return wipByStage.find((w) => w.stage === stage) ?? null;
}

function StationCard({ row }: { row: StationCommandRow }) {
  const hasBag = row.workflowBagId != null;
  const idleMin = row.idleMinutes;
  const status = row.isOnHold
    ? { label: "On hold", tone: "crit" as const, dot: "bg-red-400" }
    : row.isPaused
      ? { label: "Paused", tone: "warn" as const, dot: "bg-amber-400" }
      : hasBag
        ? { label: "Running", tone: "ok" as const, dot: "bg-emerald-400" }
        : { label: "Idle", tone: "muted" as const, dot: "bg-slate-500" };

  const elapsedMin =
    row.elapsedSeconds != null ? Math.floor(row.elapsedSeconds / 60) : null;
  const operator = row.activeOperatorName ?? row.operatorName;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        hasBag
          ? "border-white/[0.12] bg-white/[0.03]"
          : "border-white/[0.06] bg-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${status.dot}`} />
          <p className="text-[12px] font-medium text-slate-200 truncate">
            {row.stationLabel}
          </p>
        </div>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>

      {hasBag ? (
        <div className="mt-1.5 space-y-0.5">
          <p className="text-[13px] font-medium text-slate-100 leading-tight">
            {row.productName ?? "Product not selected"}
          </p>
          <p className="text-[11px] text-slate-400 tabular-nums">
            {receiptLabel(row.receiptNumber, row.workflowBagId)}
            {elapsedMin != null ? ` · ${formatWait(elapsedMin)} on station` : ""}
          </p>
          <p className="text-[11px] text-slate-500">
            {operator ?? "No operator signed in"}
          </p>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {idleMin != null && idleMin > 0
            ? `idle ${formatWait(idleMin)}`
            : "ready"}
        </p>
      )}

      {row.activeRolls.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {row.activeRolls.map((roll) => {
            const kg =
              roll.projectedRemainingGrams != null
                ? `${(roll.projectedRemainingGrams / 1000).toFixed(1)} kg left`
                : null;
            return (
              <Chip key={roll.packagingLotId} tone="muted">
                {roll.materialRole ?? roll.materialKind ?? "roll"}
                {kg ? ` ${kg}` : ""}
              </Chip>
            );
          })}
        </div>
      ) : null}

      {row.queueWip != null && row.queueWip > 0 ? (
        <p className="mt-1.5 text-[10.5px] text-slate-500 tabular-nums">
          {row.queueWip} queued at station
          {row.queueOldestMinutes != null && row.queueOldestMinutes > 0
            ? ` · oldest ${formatWait(row.queueOldestMinutes)}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

type Props = {
  line: ProductionLineDefinition;
  accent: LineAccent;
  snapshot: FloorManagerSnapshot;
  /** Step keys to render as "shared" pointers instead of station columns. */
  sharedStepKeys?: string[];
};

export function LineLane({ line, accent, snapshot, sharedStepKeys = [] }: Props) {
  const a = lineAccents[accent];
  const groups = buildLineStepGroupsForLine(line, snapshot.stationCommandRows);
  const ownGroups = groups.filter((g) => !sharedStepKeys.includes(g.step.key));
  const stationCount = ownGroups.reduce((n, g) => n + g.stations.length, 0);

  // A line with no stations configured at all stays off the board.
  if (stationCount === 0) return null;

  const activeBags = ownGroups.reduce(
    (n, g) => n + g.stations.filter((s) => s.workflowBagId).length,
    0,
  );
  const packedWaiting =
    line.id === "card_route"
      ? (snapshot.wipByStage.find((w) => w.stage === "PACKAGED") ?? null)
      : null;

  return (
    <section className={`${board.panel} ${a.laneBorder} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2 border-b border-white/[0.05]">
        <div className="flex items-center gap-3">
          <p className={`text-[11px] font-bold tracking-[0.18em] ${a.headerText}`}>
            {a.name}
          </p>
          <p className={board.subtle}>{lineFlowLabel(line)}</p>
        </div>
        <div className="flex items-center gap-2">
          {activeBags > 0 ? (
            <Chip tone="ok">{activeBags} running</Chip>
          ) : (
            <Chip tone="muted">idle</Chip>
          )}
          {packedWaiting && packedWaiting.count > 0 ? (
            <Chip tone="info">
              {packedWaiting.count} packed · awaiting finalization
            </Chip>
          ) : null}
        </div>
      </div>

      <div
        className="grid gap-3 px-4 py-3"
        style={{
          gridTemplateColumns: `repeat(${ownGroups.length}, minmax(0, 1fr))`,
        }}
      >
        {ownGroups.map((g) => {
          const inbound = inboundForStep(line.id, g.step.key, snapshot.wipByStage);
          return (
            <div key={g.step.key} className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-1">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-400">
                  <span className={a.headerText}>{g.step.step}</span> · {g.step.label}
                </p>
                {inbound && inbound.count > 0 ? (
                  <Chip
                    tone={
                      inbound.oldestMinutes > 24 * 60
                        ? "crit"
                        : inbound.oldestMinutes > 180
                          ? "warn"
                          : "muted"
                    }
                  >
                    {inbound.count} waiting · {formatWait(inbound.oldestMinutes)}
                  </Chip>
                ) : null}
              </div>
              <div className="space-y-2">
                {g.stations.length === 0 ? (
                  <p className="text-[11px] text-slate-600 italic px-1">
                    no station configured
                  </p>
                ) : (
                  g.stations.map((row) => <StationCard key={row.stationId} row={row} />)
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sharedStepKeys.length > 0 ? (
        <p className="px-4 pb-3 text-[10.5px] text-slate-500">
          Final packaging is shared with the card line above.
        </p>
      ) : null}
    </section>
  );
}
