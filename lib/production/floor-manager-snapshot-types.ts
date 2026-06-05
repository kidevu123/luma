/** Client-safe types for the live-floor production manager dashboard. */

import type { ShiftActivityMetrics } from "@/lib/production/shift-throughput";

export type MachineProductionRow = {
  machineId: string;
  name: string;
  kind: string;
  /** Stations tied to this machine (labels). */
  stationLabels: string[];
  /** Bag / receipt currently on this machine (from live station). */
  currentReceiptNumber: string | null;
  currentProductName: string | null;
  currentOperatorName: string | null;
  currentBagStartedAt: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  /** Avg total cycle (7d finalized bags that touched this machine). */
  avgCycleSec7d: number | null;
  avgActiveCycleSec7d: number | null;
  p90CycleSec7d: number | null;
  /** Same metrics, shift window only. */
  avgCycleSecShift: number | null;
  bagsFinalizedShift: number;
  unitsProducedShift: number;
  unitsPerHourShift: number | null;
  todayFinalized: number;
  todayUnits: number;
  todayBlistered: number;
  todaySealed: number;
  todayPackaged: number;
};

export type StationScanRow = {
  stationId: string;
  label: string;
  kind: string;
  machineId: string | null;
  machineName: string | null;
  /** What is scanned / active at this station right now. */
  receiptNumber: string | null;
  productName: string | null;
  operatorName: string | null;
  workflowBagId: string | null;
  stage: string | null;
  isPaused: boolean;
  isOnHold: boolean;
  reworkPending: boolean;
  lastEventType: string | null;
  lastEventAt: string | null;
  busyForSeconds: number | null;
  idleMinutes: number | null;
};

export type MachineRollRow = {
  packagingLotId: string;
  rollNumber: string | null;
  materialRole: "PVC" | "FOIL" | string | null;
  materialKind: string | null;
  materialName: string | null;
  mountedAt: string | null;
  startingWeightGrams: number | null;
  projectedRemainingGrams: number | null;
  projectedBlistersRemaining: number | null;
  confidence: string;
};

export type StationCommandRow = {
  stationId: string;
  stationLabel: string;
  stationKind: string;
  machineId: string | null;
  machineName: string | null;
  machineKind: string | null;
  cardsPerTurn: number | null;
  targetBagsPerHour: number | null;
  workflowBagId: string | null;
  bagLabel: string | null;
  bagLabelSecondary: string | null;
  receiptNumber: string | null;
  productName: string | null;
  poNumber: string | null;
  cardLabel: string | null;
  stage: string | null;
  startedAt: string | null;
  elapsedSeconds: number | null;
  operatorName: string | null;
  operatorCode: string | null;
  activeOperatorName: string | null;
  activeOperatorSource: string | null;
  isPaused: boolean;
  isOnHold: boolean;
  reworkPending: boolean;
  lastEventType: string | null;
  lastEventAt: string | null;
  busyForSeconds: number | null;
  idleMinutes: number | null;
  queueWip: number | null;
  queueOldestMinutes: number | null;
  queueStatus: string | null;
  activeRolls: MachineRollRow[];
  todayFinalized: number;
  todayUnits: number;
  todayBlistered: number;
  todaySealed: number;
  todayPackaged: number;
  avgCycleSecShift: number | null;
  avgCycleSec7d: number | null;
};

export type ProductMaterialYieldRow = {
  productId: string;
  productName: string;
  bagsFinalized: number;
  inputPills: number;
  unitsYielded: number;
  displaysMade: number;
  casesMade: number;
  damagedUnits: number;
  rippedCards: number;
  /** units_yielded / input_pill_count × 100 when input known. */
  yieldPct: number | null;
  /** (damaged + ripped) / (units + damaged + ripped) × 100 */
  damageRatePct: number | null;
  avgCycleSec: number | null;
  avgActiveCycleSec: number | null;
};

export type OperatorLeaderRow = {
  displayName: string;
  bagsFinalized: number;
  activeHours: number;
  unitsPerHour: number | null;
  damageEvents: number;
  reworkSent: number;
};

export type DowntimeReasonRow = {
  reason: string;
  occurrences: number;
  totalMinutes: number;
};

export type InFlightBagRow = {
  workflowBagId: string;
  receiptNumber: string | null;
  productName: string | null;
  stage: string | null;
  elapsedMinutes: number;
  isPaused: boolean;
  isOnHold: boolean;
};

export type RecentFinalizedRow = {
  receiptNumber: string | null;
  productName: string | null;
  finalizedAt: string;
  minutesAgo: number;
  totalCycleSec: number;
  unitsYielded: number;
};

export type StageCycleBenchmarkRow = {
  stage: string;
  label: string;
  avgSecShift: number | null;
  avgSec7d: number | null;
  bagsShift: number;
};

export type WipStageRow = {
  stage: string;
  label: string;
  count: number;
  oldestMinutes: number;
};

export type FloorManagerSnapshot = {
  shiftDayKey: string;
  plant: {
    bagsInFlow: number;
    bagsFinalizedShift: number;
    unitsYieldedShift: number;
    avgCycleSecShift: number | null;
    avgYieldPctShift: number | null;
    damageRatePctShift: number | null;
    pauseCostUsdToday: number;
    pauseMinutesToday: number;
    materialRunwayDays: number | null;
    laneImbalanceLabel: string | null;
    damageClusterActive: boolean;
  };
  stationCommandRows: StationCommandRow[];
  machines: MachineProductionRow[];
  stations: StationScanRow[];
  products: ProductMaterialYieldRow[];
  operators: OperatorLeaderRow[];
  downtimeToday: DowntimeReasonRow[];
  inFlight: InFlightBagRow[];
  recentFinalized: RecentFinalizedRow[];
  wipByStage: WipStageRow[];
  stageCycles: StageCycleBenchmarkRow[];
  flavorToday: Array<{
    productName: string;
    units: number;
    bags: number;
  }>;
  dataGaps: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "crit" | "missing";
    value: string;
    detail: string;
    href?: string;
  }>;
  shiftActivity: ShiftActivityMetrics;
};
