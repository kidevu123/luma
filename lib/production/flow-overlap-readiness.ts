// FLOW-OVERLAP-2A — pure overlap readiness model (no floor behavior yet).
//
// Separates:
//   • "begin / pick up work" at a downstream station (overlap-friendly)
//   • "complete the station" (stricter; may still require global stage)
//
// Picking up work does NOT advance read_bag_state.stage. Today, scan +
// complete guards both key off global stage — that is the serial trap
// FLOW-OVERLAP-2B must fix deliberately.

import {
  EVENT_STAGE_PREREQ,
  STATION_PICKUP_FROM_STAGE,
  checkStageProgression,
} from "@/lib/production/stage-progression";

export type ProductionLane = "blisterLane" | "sealingLane" | "packagingLane";

export type LaneWipSnapshot = {
  /** Cumulative output units recorded for this lane (from events or overrides). */
  blisterOutputUnits: number;
  sealedOutputUnits: number;
  packagedOutputUnits: number;
};

export type FlowOverlapEventSlice = {
  eventType: string;
  payload?: Record<string, unknown> | null;
};

export type FlowOverlapBagSnapshot = {
  globalStage: string;
  isPaused?: boolean;
  isFinalized?: boolean;
  laneWip: LaneWipSnapshot;
  /**
   * When true, blister/sealed units came from an explicit partial signal
   * (future event types or read-model fields), not inferable from global
   * stage alone.
   */
  hasPartialBlisterSignal?: boolean;
  hasPartialSealedSignal?: boolean;
};

export type LaneReadiness = {
  canBeginOverlapWork: boolean;
  canCompleteStation: boolean;
  /** Mirrors today's serial pickup/complete guards for comparison. */
  canBeginUnderCurrentSerialRules: boolean;
  canCompleteUnderCurrentSerialRules: boolean;
  reasons: string[];
};

export type FlowOverlapReadiness = {
  bag: FlowOverlapBagSnapshot;
  blisterLane: LaneReadiness;
  sealingLane: LaneReadiness;
  packagingLane: LaneReadiness;
  /** Human-readable gaps — data or rules missing for safe overlap. */
  dataGaps: string[];
  /** Pause model note for 2B planners. */
  pauseModelAssumption: string;
};

const STAGE_RANK: Record<string, number> = {
  STARTED: 1,
  BLISTERED: 2,
  SEALED: 3,
  PACKAGED: 4,
  FINALIZED: 5,
};

function stageRank(stage: string): number {
  return STAGE_RANK[stage] ?? 0;
}

function readCount(payload: Record<string, unknown> | null | undefined): number {
  if (!payload) return 0;
  const raw = payload.count_total ?? payload.countTotal;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

/**
 * Fold append-only workflow_events into lane WIP totals.
 *
 * Today, BLISTER_COMPLETE / HANDPACK_BLISTER_COMPLETE always advance global
 * stage to BLISTERED in the projector — so blisterOutputUnits > 0 implies
 * globalStage is already BLISTERED unless future partial events exist.
 */
export function deriveLaneWipFromEvents(
  events: readonly FlowOverlapEventSlice[],
): LaneWipSnapshot & { derivedFromPartialLaneEventsOnly: boolean } {
  let blisterOutputUnits = 0;
  let sealedOutputUnits = 0;
  let packagedOutputUnits = 0;
  let sawPartialLaneEvent = false;

  for (const ev of events) {
    switch (ev.eventType) {
      case "BLISTER_COMPLETE":
      case "HANDPACK_BLISTER_COMPLETE":
        blisterOutputUnits += readCount(ev.payload ?? null);
        break;
      case "SEALING_COMPLETE":
        sealedOutputUnits += readCount(ev.payload ?? null);
        break;
      case "PACKAGING_COMPLETE":
      case "PACKAGING_SNAPSHOT":
        packagedOutputUnits += readCount(ev.payload ?? null);
        break;
      default:
        break;
    }
  }

  // No enum value for partial lane events yet — placeholder for 2B.
  for (const ev of events) {
    if (
      ev.eventType === "BLISTER_WIP_RECORDED" ||
      ev.eventType === "SEALING_WIP_RECORDED" ||
      ev.eventType === "PACKAGING_WIP_RECORDED"
    ) {
      sawPartialLaneEvent = true;
    }
  }

  return {
    blisterOutputUnits,
    sealedOutputUnits,
    packagedOutputUnits,
    derivedFromPartialLaneEventsOnly: sawPartialLaneEvent,
  };
}

function blockedByBagFlags(snapshot: FlowOverlapBagSnapshot): string | null {
  if (snapshot.isFinalized) return "Bag is finalized.";
  if (snapshot.isPaused) return "Bag is paused.";
  return null;
}

function currentSerialPickupAllowed(
  stationKind: "SEALING" | "PACKAGING",
  globalStage: string,
): boolean {
  const allowed = STATION_PICKUP_FROM_STAGE[stationKind] ?? [];
  return allowed.includes(globalStage);
}

function currentSerialCompleteAllowed(
  eventType: "SEALING_COMPLETE" | "PACKAGING_COMPLETE",
  snapshot: FlowOverlapBagSnapshot,
): boolean {
  const r = checkStageProgression({
    eventType,
    currentStage: snapshot.globalStage,
    isPaused: snapshot.isPaused ?? false,
    isFinalized: snapshot.isFinalized ?? false,
  });
  return r.allowed;
}

/**
 * Proposed overlap rules (not wired to floor yet).
 * Begin: downstream may start when upstream lane has output units > 0.
 * Complete: keep stricter — align with existing EVENT_STAGE_PREREQ until 2B
 * defines lane-close events.
 */
export function evaluateFlowOverlapReadiness(
  snapshot: FlowOverlapBagSnapshot,
): FlowOverlapReadiness {
  const dataGaps: string[] = [];
  const { globalStage, laneWip } = snapshot;
  const rank = stageRank(globalStage);

  if (
    snapshot.hasPartialBlisterSignal === undefined &&
    laneWip.blisterOutputUnits === 0 &&
    rank < stageRank("BLISTERED")
  ) {
    dataGaps.push(
      "No partial blister output is observable while globalStage is STARTED — current event types only record blister output on BLISTER_COMPLETE / HANDPACK_BLISTER_COMPLETE, which advance the whole bag to BLISTERED.",
    );
  }
  if (
    snapshot.hasPartialSealedSignal === undefined &&
    laneWip.sealedOutputUnits === 0 &&
    rank < stageRank("SEALED")
  ) {
    dataGaps.push(
      "No partial sealed output is observable while globalStage is before SEALED — SEALING_COMPLETE advances the whole bag to SEALED.",
    );
  }

  const blisterUnits =
    laneWip.blisterOutputUnits > 0 || snapshot.hasPartialBlisterSignal === true;
  const sealedUnits =
    laneWip.sealedOutputUnits > 0 || snapshot.hasPartialSealedSignal === true;

  const block = blockedByBagFlags(snapshot);

  const sealingBeginOverlap =
    !block &&
    (blisterUnits ||
      rank >= stageRank("BLISTERED") ||
      snapshot.hasPartialBlisterSignal === true);
  const sealingComplete =
    !block && currentSerialCompleteAllowed("SEALING_COMPLETE", snapshot);

  const packagingBeginOverlap =
    !block &&
    (sealedUnits ||
      rank >= stageRank("SEALED") ||
      snapshot.hasPartialSealedSignal === true);
  const packagingComplete =
    !block && currentSerialCompleteAllowed("PACKAGING_COMPLETE", snapshot);

  const sealingReasons: string[] = [];
  if (block) sealingReasons.push(block);
  if (!sealingBeginOverlap) {
    sealingReasons.push(
      "Proposed sealing begin requires blister lane output > 0 (or global BLISTERED).",
    );
  }
  if (sealingBeginOverlap && !sealingComplete) {
    sealingReasons.push(
      "Begin overlap is looser than complete — global stage must be BLISTERED for SEALING_COMPLETE today.",
    );
  }

  const packagingReasons: string[] = [];
  if (block) packagingReasons.push(block);
  if (!packagingBeginOverlap) {
    packagingReasons.push(
      "Proposed packaging begin requires sealed lane output > 0 (or global SEALED).",
    );
  }
  if (packagingBeginOverlap && !packagingComplete) {
    packagingReasons.push(
      "Begin overlap is looser than complete — global stage must be SEALED for PACKAGING_COMPLETE today.",
    );
  }

  return {
    bag: snapshot,
    blisterLane: {
      canBeginOverlapWork: !block && rank >= stageRank("STARTED"),
      canCompleteStation:
        !block &&
        checkStageProgression({
          eventType: "BLISTER_COMPLETE",
          currentStage: globalStage,
          isPaused: snapshot.isPaused ?? false,
          isFinalized: snapshot.isFinalized ?? false,
        }).allowed,
      canBeginUnderCurrentSerialRules: false,
      canCompleteUnderCurrentSerialRules:
        !block &&
        checkStageProgression({
          eventType: "BLISTER_COMPLETE",
          currentStage: globalStage,
          isPaused: snapshot.isPaused ?? false,
          isFinalized: snapshot.isFinalized ?? false,
        }).allowed,
      reasons: [],
    },
    sealingLane: {
      canBeginOverlapWork: sealingBeginOverlap,
      canCompleteStation: sealingComplete,
      canBeginUnderCurrentSerialRules:
        !block && currentSerialPickupAllowed("SEALING", globalStage),
      canCompleteUnderCurrentSerialRules: sealingComplete,
      reasons: sealingReasons,
    },
    packagingLane: {
      canBeginOverlapWork: packagingBeginOverlap,
      canCompleteStation: packagingComplete,
      canBeginUnderCurrentSerialRules:
        !block && currentSerialPickupAllowed("PACKAGING", globalStage),
      canCompleteUnderCurrentSerialRules: packagingComplete,
      reasons: packagingReasons,
    },
    dataGaps,
    pauseModelAssumption:
      "read_bag_state.is_paused is global per bag today — pausing at blister blocks sealing complete and would affect any station working the same bag until BAG_RESUMED. Per-station pause requires session-scoped pause in 2B/2C.",
  };
}

/** Documented future event types (not in schema yet). */
export const PROPOSED_PARTIAL_LANE_EVENT_TYPES = [
  "BLISTER_WIP_RECORDED",
  "SEALING_WIP_RECORDED",
  "PACKAGING_WIP_RECORDED",
] as const;

export { EVENT_STAGE_PREREQ, STATION_PICKUP_FROM_STAGE };
