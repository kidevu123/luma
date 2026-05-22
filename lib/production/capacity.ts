export interface CapacityRowSortable {
  product: { name: string };
  tablets: number;
  runnableUnits: number | null;
  runnableDisplays: number | null;
  runnableCases: number | null;
}

/**
 * A row "has data" when at least one meaningful capacity figure is nonzero:
 * pills on hand, runnable units, runnable display boxes, or runnable cases.
 * Rows with runnableUnits === 0 (configured but fully constrained) do NOT
 * count — zero capacity is not actionable.
 */
export function hasCapacityData(row: CapacityRowSortable): boolean {
  return (
    row.tablets > 0 ||
    (row.runnableUnits !== null && row.runnableUnits > 0) ||
    (row.runnableDisplays !== null && row.runnableDisplays > 0) ||
    (row.runnableCases !== null && row.runnableCases > 0)
  );
}

/**
 * Sort capacity rows: rows with any meaningful data first, then zero/no-data
 * rows. Within each group, alphabetical by product name.
 * Returns a new array; does not mutate the input.
 */
export function sortCapacityRows<T extends CapacityRowSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const aScore = hasCapacityData(a) ? 0 : 1;
    const bScore = hasCapacityData(b) ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.product.name.localeCompare(b.product.name);
  });
}
