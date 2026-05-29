// ROLL-WEIGHT-KG-INPUT-1 — pure helpers for kg ↔ grams conversion at
// the roll-receive boundary. The DB stores integer grams; the UI
// accepts decimal kg. These two functions are the only place that
// conversion happens.

/** Convert a user-entered kg value to integer grams for DB storage.
 *  Rounds to the nearest gram. Returns null when input is null/undefined. */
export function kgToGrams(kg: number | null | undefined): number | null {
  if (kg == null) return null;
  return Math.round(kg * 1000);
}

/** Format stored integer grams as a human-readable kg string.
 *  Strips trailing decimal zeros (12000 → "12 kg", 12400 → "12.4 kg").
 *  Returns "—" for null / undefined. */
export function formatGramsAsKg(grams: number | null | undefined): string {
  if (grams == null) return "—";
  return `${+((grams / 1000).toFixed(3))} kg`;
}
