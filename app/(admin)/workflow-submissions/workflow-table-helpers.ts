// Pure helpers for workflow-submissions table rendering.
// Dates cross the RSC → client boundary as ISO strings; formatters
// must accept both Date and string (Next.js serializes Date props).

export function coerceToDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

export function formatWorkflowDatetime(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const date = coerceToDate(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16);
}

export function formatWorkflowTimestamp(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const date = coerceToDate(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function coerceEventCount(n: number | string | bigint): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  const parsed = Number(n);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}
