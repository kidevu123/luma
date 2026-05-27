import type { AuditLogRow } from "@/lib/db/queries/audit-log";

export type BagEditHistoryEntry = {
  id: number;
  createdAt: Date;
  action: string;
  actionLabel: string;
  actorLabel: string;
  summaryLines: string[];
  kind: "bag" | "qr";
};

export type BagEditHistory = {
  bagId: string;
  bagNumber: number;
  receiptLabel: string | null;
  entries: BagEditHistoryEntry[];
};

const BAG_EDIT_ACTION = "inventory_bag.edit";

export function formatAuditActorLabel(
  actorRole: string | null,
  actorEmail: string | null,
): string {
  if (actorEmail) return actorEmail;
  if (actorRole) return actorRole;
  return "System";
}

export function formatAuditActionLabel(action: string): string {
  switch (action) {
    case BAG_EDIT_ACTION:
      return "Bag edited";
    case "qr_card.released_at_bag_edit":
      return "QR card released";
    case "qr_card.reserved_at_bag_edit":
      return "QR card reserved";
    default:
      return action.replace(/_/g, " ");
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function formatWeightGrams(grams: unknown): string | null {
  if (typeof grams !== "number" || Number.isNaN(grams)) return null;
  return `${(grams / 1000).toFixed(3)} kg`;
}

function formatFieldChange(
  label: string,
  beforeVal: unknown,
  afterVal: unknown,
  format?: (v: unknown) => string | null,
): string | null {
  const b = format ? format(beforeVal) : formatScalar(beforeVal);
  const a = format ? format(afterVal) : formatScalar(afterVal);
  if (b === a) return null;
  if (b == null && a == null) return null;
  return `${label}: ${b ?? "—"} → ${a ?? "—"}`;
}

function formatScalar(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return null;
}

function summarizeInventoryBagEdit(
  before: unknown,
  after: unknown,
  batchLabels?: Map<string, string>,
): string[] {
  const b = asRecord(before);
  const a = asRecord(after);
  if (!b || !a) return ["Bag record updated (details in audit log)."];

  const lines: string[] = [];
  const weight = formatFieldChange(
    "Weight",
    b.weightGrams,
    a.weightGrams,
    formatWeightGrams,
  );
  if (weight) lines.push(weight);

  const receipt = formatFieldChange(
    "Receipt #",
    b.internalReceiptNumber,
    a.internalReceiptNumber,
  );
  if (receipt) lines.push(receipt);

  const qr = formatFieldChange("QR token", b.bagQrCode, a.bagQrCode);
  if (qr) lines.push(qr);

  const notes = formatFieldChange("Notes", b.notes, a.notes);
  if (notes) lines.push(notes);

  const batchBefore = typeof b.batchId === "string" ? b.batchId : null;
  const batchAfter = typeof a.batchId === "string" ? a.batchId : null;
  if (batchBefore !== batchAfter) {
    const from =
      (batchBefore && batchLabels?.get(batchBefore)) ?? batchBefore ?? "—";
    const to = (batchAfter && batchLabels?.get(batchAfter)) ?? batchAfter ?? "—";
    lines.push(`Supplier lot: ${from} → ${to}`);
  }

  const reason =
    typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : null;
  if (reason) lines.push(`Reason: ${reason}`);

  if (lines.length === 0) return ["Bag record updated (no field diff in audit snapshot)."];
  return lines;
}

function summarizeQrCardEdit(before: unknown, after: unknown): string[] {
  const b = asRecord(before);
  const a = asRecord(after);
  const token =
    (typeof b?.scanToken === "string" && b.scanToken) ||
    (typeof a?.scanToken === "string" && a.scanToken) ||
    null;
  const statusBefore = typeof b?.status === "string" ? b.status : "—";
  const statusAfter = typeof a?.status === "string" ? a.status : "—";
  const lines = [
    token ? `Card: ${token}` : null,
    `Status: ${statusBefore} → ${statusAfter}`,
  ].filter((x): x is string => x != null);
  const reason =
    typeof a?.reason === "string" && a.reason.trim() ? a.reason.trim() : null;
  if (reason) lines.push(`Reason: ${reason}`);
  return lines.length > 0 ? lines : ["QR card updated."];
}

export function summarizeAuditRow(
  row: Pick<AuditLogRow, "action" | "before" | "after">,
  batchLabels?: Map<string, string>,
): string[] {
  switch (row.action) {
    case BAG_EDIT_ACTION:
      return summarizeInventoryBagEdit(row.before, row.after, batchLabels);
    case "qr_card.released_at_bag_edit":
    case "qr_card.reserved_at_bag_edit":
      return summarizeQrCardEdit(row.before, row.after);
    default:
      return [`${formatAuditActionLabel(row.action)} (see audit log for raw details).`];
  }
}

export function auditRowToHistoryEntry(
  row: AuditLogRow,
  kind: "bag" | "qr",
  batchLabels?: Map<string, string>,
): BagEditHistoryEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actionLabel: formatAuditActionLabel(row.action),
    actorLabel: formatAuditActorLabel(row.actorRole, row.actorEmail),
    summaryLines: summarizeAuditRow(row, batchLabels),
    kind,
  };
}

/** Collect scan tokens referenced in bag edit audits (for QR context lookup). */
export function collectQrTokensFromBagAudits(
  rows: AuditLogRow[],
  currentBagQrCode: string | null,
): string[] {
  const tokens = new Set<string>();
  if (currentBagQrCode?.trim()) tokens.add(currentBagQrCode.trim());
  for (const row of rows) {
    if (row.action !== BAG_EDIT_ACTION) continue;
    const b = asRecord(row.before);
    const a = asRecord(row.after);
    if (typeof b?.bagQrCode === "string" && b.bagQrCode.trim()) {
      tokens.add(b.bagQrCode.trim());
    }
    if (typeof a?.bagQrCode === "string" && a.bagQrCode.trim()) {
      tokens.add(a.bagQrCode.trim());
    }
  }
  return [...tokens];
}

export function groupBagEditHistories(params: {
  bags: Array<{
    id: string;
    bagNumber: number;
    internalReceiptNumber: string | null;
    bagQrCode: string | null;
  }>;
  bagAudits: AuditLogRow[];
  qrAudits: AuditLogRow[];
  batchLabels?: Map<string, string>;
}): BagEditHistory[] {
  const byBagId = new Map<string, AuditLogRow[]>();
  for (const row of params.bagAudits) {
    if (!row.targetId) continue;
    const list = byBagId.get(row.targetId) ?? [];
    list.push(row);
    byBagId.set(row.targetId, list);
  }

  const qrByToken = new Map<string, AuditLogRow[]>();
  for (const row of params.qrAudits) {
    const b = asRecord(row.before);
    const a = asRecord(row.after);
    const token =
      (typeof b?.scanToken === "string" && b.scanToken) ||
      (typeof a?.scanToken === "string" && a.scanToken) ||
      null;
    if (!token) continue;
    const list = qrByToken.get(token) ?? [];
    list.push(row);
    qrByToken.set(token, list);
  }

  return params.bags.map((bag) => {
    const bagRows = byBagId.get(bag.id) ?? [];
    const tokens = collectQrTokensFromBagAudits(bagRows, bag.bagQrCode);
    const qrRows: AuditLogRow[] = [];
    for (const token of tokens) {
      const related = qrByToken.get(token);
      if (related) qrRows.push(...related);
    }

    const seenQrIds = new Set<number>();
    const entries: BagEditHistoryEntry[] = [];

    for (const row of bagRows) {
      entries.push(auditRowToHistoryEntry(row, "bag", params.batchLabels));
    }
    for (const row of qrRows) {
      if (seenQrIds.has(row.id)) continue;
      seenQrIds.add(row.id);
      entries.push(auditRowToHistoryEntry(row, "qr", params.batchLabels));
    }

    entries.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return {
      bagId: bag.id,
      bagNumber: bag.bagNumber,
      receiptLabel: bag.internalReceiptNumber,
      entries,
    };
  });
}

export function bagEditCountLabel(entryCount: number): string {
  if (entryCount === 0) return "No edits";
  if (entryCount === 1) return "1 edit";
  return `${entryCount} edits`;
}
