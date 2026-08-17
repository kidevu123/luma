// lib/floor-command/types.ts

export type WidgetKey =
  | "floor-map"
  | "queue-health"
  | "throughput-chart"
  | "operator-board"
  | "quality-watch"
  | "machine-focus"
  | "recent-events"
  | "production-manager";

export type WidgetConfig = {
  stationId?: string; // used by machine-focus
};

export type WidgetLayout = {
  key: WidgetKey;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: WidgetConfig;
};

export type StatusLevel = "good" | "warn" | "crit" | "neutral";

export type StatusCell = {
  label: string;
  value: string;
  detail?: string;
  level: StatusLevel;
};

export type ShiftStatusData = {
  target: StatusCell;
  bottleneck: StatusCell;
  quality: StatusCell;
  attention: StatusCell;
};

export type StationKind =
  | "BLISTER"
  | "SEALING"
  | "PACKAGING"
  | "BOTTLE_HANDPACK"
  | "BOTTLE_CAP_SEAL"
  | "BOTTLE_STICKER"
  | "COMBINED"
  | "HANDPACK_BLISTER";

export type StationWithLive = {
  id: string;
  label: string;
  kind: StationKind;
  machineId: string | null;
  machineName: string | null;
  machineTargetBagsPerHour: number | null;
  isActive: boolean;
  currentWorkflowBagId: string | null;
  currentProductId: string | null;
  currentProductName: string | null;
  currentReceiptNumber: string | null;
  currentEmployeeName: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  busyForSeconds: number | null;
};

export type StepGroup = {
  label: string;
  kinds: StationKind[];
  stations: StationWithLive[];
};

export type QueueHealthRow = {
  stageKey: string;
  wip: number;
  oldestAgeSeconds: number | null;
  avgAgeSeconds: number | null;
  p90AgeSeconds: number | null;
  bagsOverThreshold: number;
  queueStatus: "EMPTY" | "FLOWING" | "AGING" | "STALLED";
};

export type ShiftTargetStatus = {
  unitsProduced: number;
  dailyGoal: number | null;
  minutesElapsed: number;
  minutesRemaining: number;
  projectedTotal: number | null;
  gapUnits: number | null;
};

export type AttentionItem = {
  type:
    | "idle_machine"
    | "rework_pending"
    | "production_exception"
    /** P5-SUPERVISOR Task 5(b) — a bagless station_exception_reports
     *  row that has not yet been acknowledged on the admin Act Now
     *  rail. Distinct from production_exception (which reads workflow
     *  _events) because the acknowledgement path is different and the
     *  severity mapping is category-only (MACHINE crit, OTHER warn). */
    | "station_report";
  label: string;
  detail: string;
  /** production_exception only — which of Report Problem's three
   *  reused-or-new events produced this row (P4b Task 4). Lets
   *  buildActNowPanel pick a severity/wording without re-parsing the
   *  label. */
  exceptionEventType?:
    | "PRODUCTION_EXCEPTION_RAISED"
    | "DOWNTIME_STARTED"
    | "QA_HOLD_STARTED";
  /** production_exception only — for the Act Now row's href, same
   *  pattern as the waiting-bag rows below. */
  receiptNumber?: string | null;
  /** station_report only — the report row's category. MACHINE lands
   *  as crit; OTHER as warn (report-problem's own two-tier ranking). */
  stationReportCategory?: "MACHINE" | "OTHER";
  /** station_report only — the report row's id, for the [ Acknowledge ]
   *  button's deep link on the admin rail (Task 6 wires the ack action). */
  stationReportId?: string;
};

export type OperatorDailyRow = {
  operatorCode: string;
  employeeId: string | null;
  bagsFinalized: number;
  activeSecondsTotal: number;
  damageEventsTotal: number;
  reworkSentTotal: number;
  correctionsTotal: number;
};

export type ThroughputDataPoint = {
  label: string;
  bagsPerHour: number;
};

export const WIDGET_CATALOG: {
  key: WidgetKey;
  label: string;
  description: string;
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  defaultIncluded: boolean;
}[] = [
  {
    key: "floor-map",
    label: "Floor Map",
    description: "Dynamic machine topology — stations from DB, grouped by step",
    defaultW: 8,
    defaultH: 6,
    minW: 6,
    minH: 4,
    defaultIncluded: true,
  },
  {
    key: "queue-health",
    label: "Queue Health",
    description: "All stages: queue depth, age, AGING/STALLED status",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    defaultIncluded: true,
  },
  {
    key: "quality-watch",
    label: "Quality Watch",
    description: "Live feed of damage, rework, and correction events",
    defaultW: 4,
    defaultH: 5,
    minW: 3,
    minH: 3,
    defaultIncluded: true,
  },
  {
    key: "throughput-chart",
    label: "Throughput Chart",
    description: "Bags/hr trend line for the shift, with target rate overlay",
    defaultW: 6,
    defaultH: 4,
    minW: 4,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "operator-board",
    label: "Operator Board",
    description: "Per-operator: bags completed, active time, damage events",
    defaultW: 6,
    defaultH: 5,
    minW: 4,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "machine-focus",
    label: "Machine Focus",
    description: "Expanded single-machine view — choose which station to watch",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "production-manager",
    label: "Production Manager",
    description:
      "Machines (cycle times), station scans, material→product yield, operators, downtime",
    defaultW: 12,
    defaultH: 10,
    minW: 8,
    minH: 6,
    defaultIncluded: true,
  },
  {
    key: "recent-events",
    label: "Recent Events",
    description: "Raw workflow event stream",
    defaultW: 4,
    defaultH: 5,
    minW: 3,
    minH: 3,
    defaultIncluded: false,
  },
];

export const DEFAULT_LAYOUT: WidgetLayout[] = [
  { key: "floor-map",     x: 0, y: 0, w: 8, h: 6 },
  { key: "queue-health",  x: 8, y: 0, w: 4, h: 4 },
  { key: "quality-watch", x: 8, y: 4, w: 4, h: 5 },
];
