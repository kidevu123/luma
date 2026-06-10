// ZOHO-PRODUCTION-OUTPUT — map Luma packaging metrics to Zoho preview quantities.

export type ProductionOutputQuantityBasis = {
  unitsProduced: number;
  displaysProduced: number | null;
  casesProduced: number | null;
  looseCards: number | null;
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

  const allLooseSingles =
    units > 0 && displays === 0 && cases === 0 && loose === units;

  return {
    quantity_good: units,
    quantity_loose: allLooseSingles ? 0 : loose,
    unit_assembly_quantity: units,
    display_assembly_quantity: displays,
    case_assembly_quantity: cases,
  };
}
