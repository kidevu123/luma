import type {
  FloorManagerSnapshot,
  InFlightBagRow,
  StationScanRow,
} from "@/lib/production/floor-manager-snapshot-types";

export type OnStationRow = {
  station: StationScanRow;
  bag: InFlightBagRow;
};

export type WipPartition = {
  /** Bags with a live WIP record, currently tied to a station scan. */
  onStation: OnStationRow[];
  /** WIP bags not at any station (between steps). */
  waiting: InFlightBagRow[];
  /** Station still points at a bag that is no longer in WIP — stale projector row. */
  staleStationScans: StationScanRow[];
};

/** Split in-flight WIP so counts never double (station + waiting = all in-flight). */
export function partitionWip(snapshot: FloorManagerSnapshot): WipPartition {
  const inflightById = new Map(
    snapshot.inFlight.map((b) => [b.workflowBagId, b]),
  );

  const onStation: OnStationRow[] = [];
  const staleStationScans: StationScanRow[] = [];

  for (const station of snapshot.stations) {
    if (!station.workflowBagId) continue;
    const bag = inflightById.get(station.workflowBagId);
    if (bag) onStation.push({ station, bag });
    else staleStationScans.push(station);
  }

  const onStationIds = new Set(onStation.map((r) => r.bag.workflowBagId));
  const waiting = snapshot.inFlight.filter(
    (b) => !onStationIds.has(b.workflowBagId),
  );

  return { onStation, waiting, staleStationScans };
}

export type WaitingStageGroup = {
  stage: string | null;
  label: string;
  count: number;
  oldestMinutes: number;
  bags: InFlightBagRow[];
};

export function groupWaitingByStage(
  waiting: InFlightBagRow[],
  stageLabel: (stage: string | null) => string,
): WaitingStageGroup[] {
  const map = new Map<string, WaitingStageGroup>();

  for (const bag of waiting) {
    const key = bag.stage ?? "UNKNOWN";
    let g = map.get(key);
    if (!g) {
      g = {
        stage: bag.stage,
        label: stageLabel(bag.stage),
        count: 0,
        oldestMinutes: 0,
        bags: [],
      };
      map.set(key, g);
    }
    g.count += 1;
    g.bags.push(bag);
    g.oldestMinutes = Math.max(g.oldestMinutes, bag.elapsedMinutes);
  }

  return [...map.values()].sort((a, b) => b.oldestMinutes - a.oldestMinutes);
}
