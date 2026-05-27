import type { AuditLogRow } from "@/lib/db/queries/audit-log";
import {
  formatAuditActionLabel,
  formatAuditActorLabel,
  summarizeAuditRow,
} from "@/lib/receive/bag-edit-history";

export type AuditLogViewRow = {
  id: number;
  createdAt: Date;
  action: string;
  actionLabel: string;
  actorLabel: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  summaryLine: string;
  detailLines: string[];
  hasRawDetails: boolean;
};

const KNOWN_SUMMARY_ACTIONS = new Set([
  "inventory_bag.edit",
  "qr_card.released_at_bag_edit",
  "qr_card.reserved_at_bag_edit",
]);

export function formatAuditTargetLabel(
  targetType: string,
  targetId: string | null,
): string {
  if (!targetId) return targetType;
  const short =
    targetId.length > 12 ? `${targetId.slice(0, 8)}…` : targetId;
  return `${targetType} · ${short}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function formatScalar(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Generic before/after diff for actions without a dedicated formatter. */
export function summarizeGenericAuditDiff(
  before: unknown,
  after: unknown,
  maxLines = 8,
): string[] {
  const b = asRecord(before);
  const a = asRecord(after);
  if (!b && !a) return [];

  const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
  const lines: string[] = [];
  for (const key of keys) {
    if (lines.length >= maxLines) break;
    const bv = b?.[key];
    const av = a?.[key];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    const bs = formatScalar(bv);
    const as_ = formatScalar(av);
    if (bs == null && as_ == null) {
      lines.push(`${key}: (object changed)`);
    } else {
      lines.push(`${key}: ${bs ?? "—"} → ${as_ ?? "—"}`);
    }
  }
  return lines;
}

export function buildAuditLogViewRow(row: AuditLogRow): AuditLogViewRow {
  const actionLabel = formatAuditActionLabel(row.action);
  const actorLabel = formatAuditActorLabel(row.actorRole, row.actorEmail);
  const targetLabel = formatAuditTargetLabel(row.targetType, row.targetId);

  let detailLines: string[];
  if (KNOWN_SUMMARY_ACTIONS.has(row.action)) {
    detailLines = summarizeAuditRow(row);
  } else {
    const generic = summarizeGenericAuditDiff(row.before, row.after);
    detailLines =
      generic.length > 0
        ? generic
        : summarizeAuditRow(row);
  }

  const summaryLine =
    detailLines[0] ??
    actionLabel;

  const hasRawDetails =
    row.before != null ||
    row.after != null ||
    detailLines.length > 0;

  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actionLabel,
    actorLabel,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel,
    summaryLine,
    detailLines,
    hasRawDetails,
  };
}

export function buildAuditLogViewRows(rows: AuditLogRow[]): AuditLogViewRow[] {
  return rows.map(buildAuditLogViewRow);
}
