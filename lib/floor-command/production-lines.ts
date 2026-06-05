/**
 * Canonical production line definitions for floor-board layout.
 *
 * Card route (primary at Haute): raw bag → blister → sealing → packaging → finalize.
 * Bottle route: handpack → cap seal → sticker → packaging.
 *
 * Station ordering on /floor-board follows these steps left-to-right.
 * See docs/PRODUCTION_LINE_LAYOUT.md for operator-facing explanation.
 */

import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";
import type { StationKind } from "@/lib/floor-command/types";

export type ProductionLineStep = {
  step: number;
  key: string;
  label: string;
  /** What the operator does at this step */
  role: string;
  /** Which station kinds belong to this step */
  stationKinds: StationKind[];
  /** Typical machine kinds at this step */
  machineKinds?: string[];
};

export type ProductionLineDefinition = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  steps: ProductionLineStep[];
};

/** Primary card / blister display route. */
export const CARD_PRODUCTION_LINE: ProductionLineDefinition = {
  id: "card_route",
  name: "Card route (blister → seal → pack)",
  shortName: "Card line",
  description:
    "Raw inventory bag is blistered, sealed into displays, then packed into master cases. Product is chosen at blister or sealing depending on station setup.",
  steps: [
    {
      step: 1,
      key: "blister",
      label: "Blister / form",
      role:
        "Mount PVC + foil rolls. Scan raw bag card. Machine forms blisters; operator enters machine cycle count (× cards/turn on counter).",
      stationKinds: ["BLISTER", "HANDPACK_BLISTER"],
      machineKinds: ["BLISTER"],
    },
    {
      step: 2,
      key: "sealing",
      label: "Sealing",
      role:
        "Pick finished product/flavor. Seal blisters into display cards. Counter = presses × cards per press.",
      stationKinds: ["SEALING", "COMBINED"],
      machineKinds: ["SEALING"],
    },
    {
      step: 3,
      key: "packaging",
      label: "Packaging",
      role:
        "Count master cases, displays made, and loose cards. Finalizes bag output for yield and inventory.",
      stationKinds: ["PACKAGING"],
      machineKinds: ["PACKAGING"],
    },
  ],
};

/** Bottle / liquid route (when used). */
export const BOTTLE_PRODUCTION_LINE: ProductionLineDefinition = {
  id: "bottle_route",
  name: "Bottle route (fill → seal → label → pack)",
  shortName: "Bottle line",
  description: "Bottles filled, capped, labeled, then packed.",
  steps: [
    {
      step: 1,
      key: "fill",
      label: "Fill / handpack",
      role: "Select product at first op. Fill bottles from raw allocation.",
      stationKinds: ["BOTTLE_HANDPACK"],
      machineKinds: ["BOTTLE_HANDPACK"],
    },
    {
      step: 2,
      key: "cap_seal",
      label: "Cap seal",
      role: "Apply and seal caps.",
      stationKinds: ["BOTTLE_CAP_SEAL"],
      machineKinds: ["BOTTLE_CAP_SEAL"],
    },
    {
      step: 3,
      key: "sticker",
      label: "Label / induction",
      role: "Apply labels or induction seal.",
      stationKinds: ["BOTTLE_STICKER"],
      machineKinds: ["BOTTLE_STICKER"],
    },
    {
      step: 4,
      key: "packaging",
      label: "Packaging",
      role: "Case pack and finalize.",
      stationKinds: ["PACKAGING"],
      machineKinds: ["PACKAGING"],
    },
  ],
};

export const PRODUCTION_LINES: ProductionLineDefinition[] = [
  CARD_PRODUCTION_LINE,
  BOTTLE_PRODUCTION_LINE,
];

const kindToLineStep = new Map<
  string,
  { line: ProductionLineDefinition; step: ProductionLineStep }
>();

for (const line of PRODUCTION_LINES) {
  for (const step of line.steps) {
    for (const kind of step.stationKinds) {
      // Card route registers PACKAGING first; bottle line shares the kind but is secondary.
      if (!kindToLineStep.has(kind)) {
        kindToLineStep.set(kind, { line, step });
      }
    }
  }
}

export function resolveLinePlacement(stationKind: string): {
  line: ProductionLineDefinition;
  step: ProductionLineStep;
} | null {
  return kindToLineStep.get(stationKind) ?? null;
}

/** Sort key: line id, step number, then station label. Unknown kinds sort last. */
export function productionLineSortKey(row: StationCommandRow): string {
  const placement = resolveLinePlacement(row.stationKind);
  if (!placement) {
    return `z-unknown-${row.stationKind}-${row.stationLabel}`;
  }
  return `${placement.line.id}-${String(placement.step.step).padStart(2, "0")}-${row.stationLabel}`;
}

export function sortStationCommandRowsByLine(
  rows: StationCommandRow[],
): StationCommandRow[] {
  return [...rows].sort((a, b) =>
    productionLineSortKey(a).localeCompare(productionLineSortKey(b)),
  );
}

export type LineStepGroup = {
  line: ProductionLineDefinition;
  step: ProductionLineStep;
  stations: StationCommandRow[];
};

/** Group rows by line step for horizontal flow layout (card line first). */
export function groupStationCommandRowsByLine(
  rows: StationCommandRow[],
): LineStepGroup[] {
  const sorted = sortStationCommandRowsByLine(rows);
  const groups: LineStepGroup[] = [];
  for (const row of sorted) {
    const placement = resolveLinePlacement(row.stationKind);
    if (!placement) continue;
    const last = groups[groups.length - 1];
    if (
      last &&
      last.line.id === placement.line.id &&
      last.step.key === placement.step.key
    ) {
      last.stations.push(row);
    } else {
      groups.push({
        line: placement.line,
        step: placement.step,
        stations: [row],
      });
    }
  }
  return groups;
}

const CARD_PRODUCTION_KINDS: StationKind[] = [
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
  "COMBINED",
];

const BOTTLE_PRODUCTION_KINDS: StationKind[] = [
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
];

function countProductionKinds(
  rows: StationCommandRow[],
  kinds: StationKind[],
): number {
  return rows.filter((r) => kinds.includes(r.stationKind as StationKind))
    .length;
}

/** Abbreviated flow for header, e.g. "Blister → Seal → Pack". */
export function lineFlowLabel(line: ProductionLineDefinition): string {
  return line.steps.map((s) => s.label.split("/")[0]?.trim() ?? s.label).join(" → ");
}

export type LineMismatchInfo = {
  hasMismatch: boolean;
  primary: ProductionLineDefinition;
  cardCount: number;
  bottleCount: number;
  secondary: ProductionLineDefinition;
};

/** Primary line — do not infer card line from a lone PACKAGING station. */
export function primaryLineForRows(
  rows: StationCommandRow[],
): ProductionLineDefinition {
  const cardCount = countProductionKinds(rows, CARD_PRODUCTION_KINDS);
  const bottleCount = countProductionKinds(rows, BOTTLE_PRODUCTION_KINDS);

  if (cardCount > 0 && bottleCount === 0) return CARD_PRODUCTION_LINE;
  if (bottleCount > 0 && cardCount === 0) return BOTTLE_PRODUCTION_LINE;
  if (bottleCount > cardCount) return BOTTLE_PRODUCTION_LINE;
  if (cardCount > bottleCount) return CARD_PRODUCTION_LINE;
  return CARD_PRODUCTION_LINE;
}

export function lineMismatchInfo(
  rows: StationCommandRow[],
): LineMismatchInfo | null {
  const cardCount = countProductionKinds(rows, CARD_PRODUCTION_KINDS);
  const bottleCount = countProductionKinds(rows, BOTTLE_PRODUCTION_KINDS);
  if (cardCount === 0 || bottleCount === 0) return null;

  const primary = primaryLineForRows(rows);
  const secondary =
    primary.id === CARD_PRODUCTION_LINE.id
      ? BOTTLE_PRODUCTION_LINE
      : CARD_PRODUCTION_LINE;

  return {
    hasMismatch: true,
    primary,
    cardCount,
    bottleCount,
    secondary,
  };
}

/** All steps for a line, including empty steps (for full column layout). */
export function buildLineStepGroupsForLine(
  line: ProductionLineDefinition,
  rows: StationCommandRow[],
): LineStepGroup[] {
  return line.steps.map((step) => ({
    line,
    step,
    stations: rows.filter((r) => {
      const placement = resolveLinePlacement(r.stationKind);
      return (
        placement?.line.id === line.id && placement.step.key === step.key
      );
    }),
  }));
}

export function groupsForPrimaryLine(
  rows: StationCommandRow[],
): LineStepGroup[] {
  const line = primaryLineForRows(rows);
  return buildLineStepGroupsForLine(line, rows);
}

export function groupsForLine(
  line: ProductionLineDefinition,
  rows: StationCommandRow[],
): LineStepGroup[] {
  return buildLineStepGroupsForLine(line, rows);
}

export function otherLineGroups(
  rows: StationCommandRow[],
): LineStepGroup[] {
  const primary = primaryLineForRows(rows);
  return groupStationCommandRowsByLine(rows).filter(
    (g) => g.line.id !== primary.id,
  );
}

export function secondaryLineRows(
  rows: StationCommandRow[],
  line: ProductionLineDefinition,
): StationCommandRow[] {
  return rows.filter((r) => {
    const placement = resolveLinePlacement(r.stationKind);
    return placement?.line.id !== line.id;
  });
}
