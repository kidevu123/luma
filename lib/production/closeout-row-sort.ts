// CLOSEOUT-SORT-1 — pure sort/filter helpers for the PO closeout bag table.
// Nulls always sort last regardless of direction; sorting is stable and
// non-mutating so the page can apply it to server-loaded rows.

export type CloseoutSortKey = "receipt" | "tablet" | "started" | "completed";
export type CloseoutSortDir = "asc" | "desc";

export type SortableCloseoutRow = {
  receiptNumber: string | null;
  tabletName: string | null;
  startedAt: Date | null;
  finalizedAt: Date | null;
};

function compareNullable<V>(
  a: V | null,
  b: V | null,
  cmp: (x: V, y: V) => number,
  dir: CloseoutSortDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last in both directions
  if (b == null) return -1;
  const c = cmp(a, b);
  return dir === "asc" ? c : -c;
}

export function sortCloseoutRows<T extends SortableCloseoutRow>(
  rows: T[],
  key: CloseoutSortKey,
  dir: CloseoutSortDir,
): T[] {
  const out = [...rows];
  const byString = (x: string, y: string) => x.localeCompare(y);
  const byDate = (x: Date, y: Date) => x.getTime() - y.getTime();
  out.sort((a, b) => {
    switch (key) {
      case "receipt": return compareNullable(a.receiptNumber, b.receiptNumber, byString, dir);
      case "tablet": return compareNullable(a.tabletName, b.tabletName, byString, dir);
      case "started": return compareNullable(a.startedAt, b.startedAt, byDate, dir);
      case "completed": return compareNullable(a.finalizedAt, b.finalizedAt, byDate, dir);
    }
  });
  return out;
}

export function listDistinctTablets(rows: Array<{ tabletName: string | null }>): string[] {
  return [...new Set(rows.map((r) => r.tabletName).filter((t): t is string => t != null))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function filterRowsByTablet<T extends { tabletName: string | null }>(
  rows: T[],
  tablet: string | null,
): T[] {
  if (tablet == null || tablet === "") return rows;
  return rows.filter((r) => r.tabletName === tablet);
}
