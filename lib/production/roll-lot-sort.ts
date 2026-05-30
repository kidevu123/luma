// Natural sort for operator roll pickers (mount / mid-bag change).

export type RollLotSortable = {
  rollNumber: string | null;
  id: string;
};

type RollSortKey = {
  /** Standard numbered rolls (PVC-4) before legacy/unnumbered labels. */
  legacyBucket: 0 | 1;
  numericSuffix: number;
  label: string;
};

const LEGACY_LABEL_RE = /^legacy\b/i;

/** Parse a roll label for natural numeric ordering. */
export function rollNumberSortKey(
  rollNumber: string | null,
  fallbackId: string,
): RollSortKey {
  const label = (rollNumber?.trim() || fallbackId.slice(0, 8)).trim();
  const upper = label.toUpperCase();
  const legacyBucket: 0 | 1 =
    LEGACY_LABEL_RE.test(label) || !/\d/.test(label) ? 1 : 0;
  const match = label.match(/(\d+)\D*$/);
  const numericSuffix = match ? parseInt(match[1]!, 10) : 0;
  return { legacyBucket, numericSuffix, label: upper };
}

/** Sort roll lots for dropdowns: PVC-4 before PVC-23; legacy labels last. */
export function sortRollLotsForPicker<T extends RollLotSortable>(
  lots: readonly T[],
): T[] {
  return [...lots].sort((a, b) => {
    const ka = rollNumberSortKey(a.rollNumber, a.id);
    const kb = rollNumberSortKey(b.rollNumber, b.id);
    if (ka.legacyBucket !== kb.legacyBucket) {
      return ka.legacyBucket - kb.legacyBucket;
    }
    if (ka.numericSuffix !== kb.numericSuffix) {
      return ka.numericSuffix - kb.numericSuffix;
    }
    return ka.label.localeCompare(kb.label, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}
