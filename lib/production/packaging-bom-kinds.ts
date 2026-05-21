// PBOM-1 — packaging BOM kind / scope filtering.
//
// Why this exists: the Packaging BOM page used to expose every active
// row in packaging_materials in one giant dropdown, including
// PVC_ROLL, FOIL_ROLL, and BLISTER_FOIL. Those three are machine
// consumables for the DPP115 blister process — their usage is
// computed from roll mounting, weigh-back, counter segments, and
// blister_material_standards. They are NOT per-unit / per-display /
// per-case packaging BOM lines and configuring them as such silently
// produces nonsense consumption math.
//
// This module is the single source of truth for which packaging-
// material kinds are allowed at each BOM scope. The UI uses it to
// build the filtered dropdown; the server action uses it to refuse
// invalid lines that bypass the dropdown.

import type { packagingMaterialKindEnum } from "@/lib/db/schema";

/** Mirror of the packaging_material_kind pgEnum, kept as a literal
 *  union so refactor of the enum forces a refactor here.
 *  The schema array is authoritative; this matches it 1:1. */
export type PackagingMaterialKind =
  (typeof packagingMaterialKindEnum)["enumValues"][number];

export type PackagingBomScope = "UNIT" | "DISPLAY" | "CASE";

/** Machine consumables — configured under blister_material_standards
 *  / roll usage, never under Packaging BOM. Server refuses these
 *  even when an admin somehow sneaks them past the UI filter. */
export const MACHINE_CONSUMABLE_KINDS: ReadonlyArray<PackagingMaterialKind> = [
  "PVC_ROLL",
  "FOIL_ROLL",
  "BLISTER_FOIL",
] as const;

export function isMachineConsumableKind(
  kind: PackagingMaterialKind,
): boolean {
  return (MACHINE_CONSUMABLE_KINDS as ReadonlyArray<string>).includes(kind);
}

/** Kinds eligible at each scope. UNIT = per finished card/bottle/etc.
 *  DISPLAY = per shipper / shelf-ready display. CASE = per master case
 *  outer. The intent is the *physical packaging consumed* at that
 *  packaging level, not process inputs (PVC/foil) and not finished
 *  goods (a master case is not "consumed" by another master case). */
const ALLOWED_KINDS_BY_SCOPE: Record<
  PackagingBomScope,
  ReadonlyArray<PackagingMaterialKind>
> = {
  // Per-finished-unit packaging. For card SKUs, this is the printed
  // card itself. For bottle SKUs, this is the bottle + cap + label
  // + induction seal + desiccant/cotton. Heat-seal film + shrink
  // band may also be per-unit on certain SKUs (over-wrap).
  UNIT: [
    "BOTTLE",
    "CAP",
    "LABEL",
    "INDUCTION_SEAL",
    "DESICCANT",
    "COTTON",
    "INSERT",
    "HEAT_SEAL_FILM",
    "SHRINK_BAND",
    "OTHER",
  ],
  // Per-display packaging. A shipper / shelf-ready display box, plus
  // any per-display insert. Other levels (UNIT / CASE) are
  // counted-of, not consumed-by, the display itself.
  DISPLAY: ["DISPLAY", "INSERT", "OTHER"],
  // Per-master-case packaging. The outer corrugated box (CASE) and
  // any case-level insert / label.
  CASE: ["CASE", "INSERT", "LABEL", "OTHER"],
};

/** Set of kinds allowed at a given scope. Returns a new array per
 *  call (cheap, list ≤ 10 entries). */
export function allowedKindsForScope(
  scope: PackagingBomScope,
): ReadonlyArray<PackagingMaterialKind> {
  return ALLOWED_KINDS_BY_SCOPE[scope];
}

/** Predicate the server action uses to reject a saved BOM line. UI
 *  may also use this to gray out invalid combinations. */
export function isKindAllowedAtScope(
  kind: PackagingMaterialKind,
  scope: PackagingBomScope,
): boolean {
  if (isMachineConsumableKind(kind)) return false;
  return (ALLOWED_KINDS_BY_SCOPE[scope] as ReadonlyArray<string>).includes(kind);
}

/** Operator-facing message for refused combinations. Drives the UI
 *  banner + the server-side error string the action returns when
 *  someone forces an invalid (kind, scope) through the form. */
export function describeRejection(
  kind: PackagingMaterialKind,
  scope: PackagingBomScope,
): string {
  if (isMachineConsumableKind(kind)) {
    return `${kind} is a blister-machine consumable — configure it under blister material standards (PVC / foil roll usage), not Packaging BOM.`;
  }
  return `${kind} is not a valid material at scope ${scope}. Allowed at ${scope}: ${ALLOWED_KINDS_BY_SCOPE[scope].join(", ")}.`;
}
