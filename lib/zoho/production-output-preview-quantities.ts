// ZOHO-PRODUCTION-OUTPUT — map Luma packaging metrics to Zoho preview quantities.

export type ProductionOutputQuantityBasis = {
  unitsProduced: number;
  displaysProduced: number | null;
  casesProduced: number | null;
  looseCards: number | null;
  /**
   * Product structure: how many displays are packed into one case.
   * Required to compute the correct display_assembly_quantity when cases > 0.
   * When null or 0, case-embedded displays are not counted (falls back to
   * loose-displays-only). Callers must supply this from products.displaysPerCase.
   */
  displaysPerCase: number | null;
};

/** Loose cards are finished singles not in display/case packaging — not extra output. */
export function mapProductionOutputPreviewQuantities(
  basis: ProductionOutputQuantityBasis,
): {
  quantity_good: number;
  quantity_loose: number;
  unit_assembly_quantity: number;
  display_assembly_quantity: number;
  case_assembly_quantity: number;
} {
  const units = Math.max(0, basis.unitsProduced);
  const displays = Math.max(0, basis.displaysProduced ?? 0);
  const cases = Math.max(0, basis.casesProduced ?? 0);
  const loose = Math.max(0, basis.looseCards ?? 0);
  const dpc = Math.max(0, basis.displaysPerCase ?? 0);

  const allLooseSingles =
    units > 0 && displays === 0 && cases === 0 && loose === units;

  // display_assembly_quantity = loose displays + case-embedded displays.
  // Case-embedded displays are only counted when displaysPerCase is known (> 0).
  const displayAssemblyQuantity = displays + cases * dpc;

  return {
    quantity_good: units,
    quantity_loose: allLooseSingles ? 0 : loose,
    unit_assembly_quantity: units,
    display_assembly_quantity: displayAssemblyQuantity,
    case_assembly_quantity: cases,
  };
}
