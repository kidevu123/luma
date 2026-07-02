// RECEIVES-BY-PO-1 — pure grouping of the flat Receives list into per-PO
// groups for the Inbound / Receives page. UI-only: no DB, no receive-model
// change. Kept pure so the totals / status-summary / null-safety rules are
// unit-testable without a database.

/** Minimal shape the grouping needs. The page's listReceives() rows satisfy
 *  this structurally; the full row type is preserved via the generic so the
 *  renderer keeps every field (receiveName, tabletTypes, etc.). */
export type GroupableReceive = {
  receive: {
    id: string;
    receivedAt: Date | string | null;
    closedAt: Date | string | null;
    poId: string | null;
  };
  poNumber: string | null;
  vendor: string | null;
  bagCount: number | null;
};

export type ReceiveGroupStatus = {
  label: "Open" | "Closed" | "Mixed";
  openCount: number;
  closedCount: number;
};

export type PoReceiveGroup<T extends GroupableReceive> = {
  /** Stable grouping key (poId, or a sentinel for PO-less receives). */
  key: string;
  poNumber: string | null;
  vendor: string | null;
  receives: T[];
  totalReceives: number;
  totalBags: number;
  latestReceivedAt: Date | null;
  status: ReceiveGroupStatus;
};

const NO_PO_KEY = "__no_po__";

/** Parse a timestamptz that may arrive as a Date or an ISO string. Returns null
 *  for missing / unparseable values so sorting can push them to the end. */
function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Descending by timestamp; nulls sort last (stable). */
function byReceivedAtDesc(a: Date | null, b: Date | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b.getTime() - a.getTime();
}

function summarizeStatus(receives: GroupableReceive[]): ReceiveGroupStatus {
  let openCount = 0;
  let closedCount = 0;
  for (const r of receives) {
    if (r.receive.closedAt != null) closedCount++;
    else openCount++;
  }
  const label: ReceiveGroupStatus["label"] =
    openCount > 0 && closedCount > 0 ? "Mixed" : closedCount > 0 ? "Closed" : "Open";
  return { label, openCount, closedCount };
}

/** Group the flat receive list by PO. Groups are ordered by their latest
 *  received timestamp (desc), and receives within a group are also newest-first
 *  — preserving the page's existing newest-first feel. PO-less receives collapse
 *  into a single "Unknown PO" group (poNumber = null). */
export function groupReceivesByPo<T extends GroupableReceive>(
  rows: T[],
): PoReceiveGroup<T>[] {
  const groups = new Map<string, PoReceiveGroup<T>>();

  for (const row of rows) {
    const key = row.receive.poId ?? NO_PO_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        poNumber: row.poNumber,
        vendor: row.vendor,
        receives: [],
        totalReceives: 0,
        totalBags: 0,
        latestReceivedAt: null,
        status: { label: "Open", openCount: 0, closedCount: 0 },
      };
      groups.set(key, group);
    }
    // First non-null vendor / poNumber wins (defensive against a stray null).
    if (group.poNumber == null && row.poNumber != null) group.poNumber = row.poNumber;
    if (group.vendor == null && row.vendor != null) group.vendor = row.vendor;
    group.receives.push(row);
    group.totalBags += row.bagCount ?? 0;

    const received = toDate(row.receive.receivedAt);
    if (received != null && (group.latestReceivedAt == null || received > group.latestReceivedAt)) {
      group.latestReceivedAt = received;
    }
  }

  const result = Array.from(groups.values());
  for (const g of result) {
    g.receives.sort((a, b) =>
      byReceivedAtDesc(toDate(a.receive.receivedAt), toDate(b.receive.receivedAt)),
    );
    g.totalReceives = g.receives.length;
    g.status = summarizeStatus(g.receives);
  }
  result.sort((a, b) => byReceivedAtDesc(a.latestReceivedAt, b.latestReceivedAt));
  return result;
}

/** Compact "5 receives · 46 bags · Open" summary line for a PO group header. */
export function formatReceiveGroupSummary(group: {
  totalReceives: number;
  totalBags: number;
  status: ReceiveGroupStatus;
}): string {
  const receivesLabel = `${group.totalReceives} ${group.totalReceives === 1 ? "receive" : "receives"}`;
  const bagsLabel = `${group.totalBags} ${group.totalBags === 1 ? "bag" : "bags"}`;
  return `${receivesLabel} · ${bagsLabel} · ${group.status.label}`;
}
