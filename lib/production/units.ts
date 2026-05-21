// Unit lexicon + conversion helpers for the metric API. Mirrors
// station_standards.output_unit and due_targets.target_unit.
//
// Critical rule: unit types do NOT freely convert. A station that
// counts BAGS does not implicitly become DISPLAYS without an
// explicit packaging spec. Functions below take an explicit
// conversion (from a product's packaging spec) — never a magic
// constant.

import type { OutputUnit } from "./types";

/** Display strings for the unit lexicon — used in MetricResult.unit. */
export const UNIT_LABELS: Record<OutputUnit, string> = {
  BAG: "bags",
  DISPLAY: "displays",
  CASE: "cases",
  TABLET: "tablets",
  BOTTLE: "bottles",
  CARD: "cards",
};

/** Convert from one output unit to another, given a per-product
 *  packaging spec. Returns null when the conversion isn't defined
 *  by the spec (the metric layer uses null to surface as
 *  "Insufficient data" rather than guess). */
export function convertUnits(
  qty: number,
  fromUnit: OutputUnit,
  toUnit: OutputUnit,
  spec: PackagingConversion,
): number | null {
  if (fromUnit === toUnit) return qty;
  // Cards / displays / cases pipeline. We treat CARD ≡ BAG for the
  // moment (1 production card = 1 bag) since the schema currently
  // expresses card output via masterCases / displaysMade /
  // looseCards. If a future product distinguishes them per-bag,
  // add a `cardsPerBag` field to PackagingConversion.
  const inUnit = fromUnit === "CARD" ? "BAG" : fromUnit;
  const outUnit = toUnit === "CARD" ? "BAG" : toUnit;
  if (inUnit === outUnit) return qty;
  switch (`${inUnit}->${outUnit}`) {
    case "DISPLAY->CASE":
      return spec.displaysPerCase != null
        ? qty / spec.displaysPerCase
        : null;
    case "CASE->DISPLAY":
      return spec.displaysPerCase != null
        ? qty * spec.displaysPerCase
        : null;
    case "DISPLAY->BAG":
      return spec.bagsPerDisplay != null
        ? qty / spec.bagsPerDisplay
        : null;
    case "BAG->DISPLAY":
      return spec.bagsPerDisplay != null
        ? qty * spec.bagsPerDisplay
        : null;
    case "TABLET->BOTTLE":
      return spec.tabletsPerBottle != null
        ? qty / spec.tabletsPerBottle
        : null;
    case "BOTTLE->TABLET":
      return spec.tabletsPerBottle != null
        ? qty * spec.tabletsPerBottle
        : null;
    case "BOTTLE->DISPLAY":
      return spec.bottlesPerDisplay != null
        ? qty / spec.bottlesPerDisplay
        : null;
    case "DISPLAY->BOTTLE":
      return spec.bottlesPerDisplay != null
        ? qty * spec.bottlesPerDisplay
        : null;
    default:
      return null;
  }
}

/** Per-product packaging conversion factors — sourced from the
 *  product table at query time, never hard-coded. */
export interface PackagingConversion {
  displaysPerCase: number | null;
  bagsPerDisplay: number | null;
  tabletsPerBottle: number | null;
  bottlesPerDisplay: number | null;
}

/** Derive routes from a machine kind. The metric layer uses this
 *  to lane-filter queries without hard-coding machine UUIDs. */
export function routeForMachineKind(
  kind: string,
): "CARD" | "BOTTLE" | "BOTH" {
  if (kind === "BLISTER" || kind === "SEALING" || kind === "PACKAGING") {
    return "CARD";
  }
  if (
    kind === "BOTTLE_HANDPACK" ||
    kind === "BOTTLE_CAP_SEAL" ||
    kind === "BOTTLE_STICKER"
  ) {
    return "BOTTLE";
  }
  return "BOTH";
}
