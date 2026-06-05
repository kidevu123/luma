export type FloorDataGapStatus = "ok" | "warn" | "crit" | "missing";

export type FloorDataGapRow = {
  id: string;
  label: string;
  status: FloorDataGapStatus;
  value: string;
  detail: string;
  href?: string;
};

export type FloorDataGapInput = {
  productionCalendars: number;
  stationStandards: number;
  laborRates: number;
  dueTargets: number;
  productsWithDailyGoals: number;
  activeMachinesWithTargets: number;
  activeStations: number;
  stationLiveRows: number;
  queueRows: number;
  inFlightWithoutState: number;
  readDailyUnits: number;
  bagMetricUnits: number;
  materialBurnRows7d: number;
  readOperatorDailyRows: number;
  damageEvents7d: number;
  reworkEvents7d: number;
  scrapEvents7d: number;
  correctionEvents7d: number;
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function buildFloorDataGaps(input: FloorDataGapInput): FloorDataGapRow[] {
  const rows: FloorDataGapRow[] = [];

  const missingOeeInputs = [
    input.productionCalendars === 0 ? "calendar" : null,
    input.stationStandards === 0 ? "station standards" : null,
  ].filter(Boolean);
  rows.push({
    id: "oee",
    label: "OEE readiness",
    status: missingOeeInputs.length > 0 ? "missing" : "ok",
    value: missingOeeInputs.length > 0 ? "Not computed" : "Ready",
    detail:
      missingOeeInputs.length > 0
        ? `Needs ${missingOeeInputs.join(" + ")} before true OEE is shown.`
        : `${plural(input.productionCalendars, "calendar")} + ${plural(
            input.stationStandards,
            "standard",
          )} configured.`,
    href: "/standards",
  });

  const hasScheduleInput =
    input.dueTargets > 0 || input.productsWithDailyGoals > 0;
  rows.push({
    id: "schedule",
    label: "Plan / due targets",
    status: hasScheduleInput ? "ok" : "missing",
    value: hasScheduleInput ? "Ready" : "No target",
    detail: hasScheduleInput
      ? `${input.dueTargets} due target(s), ${input.productsWithDailyGoals} product goal(s).`
      : "Set product daily goals or due targets to show ahead/behind.",
    href: "/standards/due-targets",
  });

  rows.push({
    id: "labor-cost",
    label: "Labor costing",
    status: input.laborRates > 0 ? "ok" : "missing",
    value: input.laborRates > 0 ? "Ready" : "No rates",
    detail:
      input.laborRates > 0
        ? `${plural(input.laborRates, "rate")} configured; ${plural(
            input.readOperatorDailyRows,
            "operator rollup",
          )} today.`
        : "Operator activity is tracked, but labor cost needs rate rows.",
    href: "/standards/labor-rates",
  });

  rows.push({
    id: "throughput-units",
    label: "Daily units projector",
    status:
      input.bagMetricUnits > 0 && input.readDailyUnits === 0 ? "warn" : "ok",
    value:
      input.readDailyUnits > 0
        ? input.readDailyUnits.toLocaleString()
        : input.bagMetricUnits > 0
          ? "Drift"
          : "No units",
    detail:
      input.bagMetricUnits > 0 && input.readDailyUnits === 0
        ? "Bag metrics have yielded units; rebuild daily throughput after deploy."
        : "Daily throughput units reconcile with bag metrics.",
    href: "/metrics#daily-throughput",
  });

  const liveIssues = [
    input.stationLiveRows < input.activeStations
      ? `${input.activeStations - input.stationLiveRows} station live row(s) missing`
      : null,
    input.queueRows === 0 ? "queue projector empty" : null,
    input.inFlightWithoutState > 0
      ? `${input.inFlightWithoutState} WIP bags missing state`
      : null,
  ].filter(Boolean);
  rows.push({
    id: "live-read-models",
    label: "Live read models",
    status: liveIssues.length > 0 ? "crit" : "ok",
    value: liveIssues.length > 0 ? "Repair" : "Healthy",
    detail:
      liveIssues.length > 0
        ? liveIssues.join("; ")
        : `${input.stationLiveRows}/${input.activeStations} stations and ${input.queueRows} queue rows online.`,
    href: "/workflow-validation",
  });

  rows.push({
    id: "material-runway",
    label: "Material runway",
    status: input.materialBurnRows7d > 0 ? "ok" : "missing",
    value: input.materialBurnRows7d > 0 ? "Ready" : "No burn",
    detail:
      input.materialBurnRows7d > 0
        ? `${plural(input.materialBurnRows7d, "burn row")} in the 7-day window.`
        : "Packaging runway needs material burn rows from consumption events.",
    href: "/material-alerts",
  });

  const qcSignal = input.damageEvents7d + input.reworkEvents7d + input.correctionEvents7d;
  rows.push({
    id: "scrap-qc",
    label: "QC scrap signal",
    status: qcSignal > 0 && input.scrapEvents7d === 0 ? "warn" : "ok",
    value:
      input.scrapEvents7d > 0
        ? `${input.scrapEvents7d} scrap`
        : qcSignal > 0
          ? "No scrap"
          : "Quiet",
    detail:
      qcSignal > 0 && input.scrapEvents7d === 0
        ? "Damage/rework/correction exists, but no explicit scrap events were recorded."
        : "QC events are flowing; explicit scrap appears when operators record it.",
    href: "/qc-review",
  });

  rows.push({
    id: "safety",
    label: "Safety incidents",
    status: "missing",
    value: "Not collected",
    detail: "No Luma safety incident source exists yet; do not treat days-without-incident as measured.",
  });

  return rows;
}
