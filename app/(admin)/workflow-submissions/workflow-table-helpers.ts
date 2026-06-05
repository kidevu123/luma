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

export type WorkflowSubmissionLine = {
  label: string;
  value: number | null;
  kind?: "partial" | "whole";
};

function readCountValue(
  payload: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
  }
  return null;
}

export function extractSubmissionLines(
  eventType: string,
  payload: Record<string, unknown>,
): WorkflowSubmissionLine[] {
  const count = (...keys: string[]): number | null =>
    readCountValue(payload, keys);

  switch (eventType) {
    case "BLISTER_COMPLETE":
      return [{ label: "Blistered", value: count("count_total", "countTotal") }];
    case "HANDPACK_BLISTER_COMPLETE":
      return [{ label: "Handpack blistered", value: count("count_total", "countTotal") }];
    case "SEALING_COMPLETE": {
      if (payload.partial_close === true) {
        return [
          {
            label: "Sealed partial",
            value: count("sealed_partial_count", "sealedPartialCount"),
            kind: "partial",
          },
          { label: "Remaining", value: null },
        ];
      }
      return [
        {
          label: "Sealed",
          value: count("count_total", "countTotal", "sealed_count", "sealedCount"),
          kind: "whole",
        },
        { label: "Remaining", value: count("packs_remaining", "packsRemaining") },
      ];
    }
    case "PACKAGING_COMPLETE":
      return [
        { label: "Cases", value: count("master_cases", "masterCases") },
        { label: "Displays", value: count("displays_made", "displaysMade") },
        { label: "Loose cards", value: count("loose_cards", "looseCards") },
        { label: "Damaged", value: count("damaged_packaging", "damagedPackaging") },
        { label: "Ripped", value: count("ripped_cards", "rippedCards") },
      ];
    case "BOTTLE_HANDPACK_COMPLETE":
    case "BOTTLE_CAP_SEAL_COMPLETE":
    case "BOTTLE_STICKER_COMPLETE":
      return [{ label: "Count", value: count("count_total", "countTotal") }];
    default:
      return [];
  }
}
