// ROLL-INTAKE-UX-LEGACY-1 — shared filter for mount / change-roll dropdowns.
// Only AVAILABLE roll-kind lots are selectable; depleted/scrapped/in-use are excluded.

import { inferRollRole } from "@/lib/production/roll-role";

export const ROLL_MATERIAL_KINDS = [
  "PVC_ROLL",
  "FOIL_ROLL",
  "BLISTER_FOIL",
] as const;

export type RollMaterialKind = (typeof ROLL_MATERIAL_KINDS)[number];

export function isRollMaterialKind(kind: string): kind is RollMaterialKind {
  return ROLL_MATERIAL_KINDS.includes(kind as RollMaterialKind);
}

/** True when a lot may appear in “mount new roll” / idle-roll pickers. */
export function isSelectableIdleRollLot(lot: {
  status: string;
  materialKind: string;
}): boolean {
  return lot.status === "AVAILABLE" && isRollMaterialKind(lot.materialKind);
}

export function filterSelectableIdleRollLots<
  T extends { status: string; materialKind: string },
>(lots: readonly T[]): T[] {
  return lots.filter(isSelectableIdleRollLot);
}

/** Filter idle lots to PVC or FOIL mount role (material kind is source of truth). */
export function idleRollLotMatchesRole(
  lot: { materialKind: string },
  role: "PVC" | "FOIL",
): boolean {
  return inferRollRole(lot.materialKind, null) === role;
}

export function filterIdleRollLotsForRole<
  T extends { materialKind: string },
>(lots: readonly T[], role: "PVC" | "FOIL"): T[] {
  return lots.filter((lot) => idleRollLotMatchesRole(lot, role));
}
