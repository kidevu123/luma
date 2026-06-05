// Editable submission fields per station event type — used by admin
// correction UI on /workflow-submissions and /qc-review.

export const CORRECTABLE_SUBMISSION_EVENT_TYPES = [
  "BLISTER_COMPLETE",
  "HANDPACK_BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
] as const;

export type CorrectableSubmissionEventType =
  (typeof CORRECTABLE_SUBMISSION_EVENT_TYPES)[number];

export type SubmissionCorrectionFieldSpec = {
  key: string;
  label: string;
};

const PACKAGING_FIELDS: SubmissionCorrectionFieldSpec[] = [
  { key: "master_cases", label: "Cases" },
  { key: "displays_made", label: "Displays" },
  { key: "loose_cards", label: "Loose cards" },
  { key: "damaged_packaging", label: "Damaged packaging" },
  { key: "ripped_cards", label: "Ripped cards" },
];

export const SUBMISSION_CORRECTION_FIELDS: Record<
  CorrectableSubmissionEventType,
  SubmissionCorrectionFieldSpec[]
> = {
  BLISTER_COMPLETE: [{ key: "count_total", label: "Blister count" }],
  HANDPACK_BLISTER_COMPLETE: [{ key: "count_total", label: "Handpack count" }],
  SEALING_COMPLETE: [
    { key: "count_total", label: "Sealed count" },
    { key: "packs_remaining", label: "Packs remaining" },
  ],
  PACKAGING_COMPLETE: PACKAGING_FIELDS,
  BOTTLE_HANDPACK_COMPLETE: [{ key: "count_total", label: "Handpack count" }],
  BOTTLE_CAP_SEAL_COMPLETE: [{ key: "count_total", label: "Cap/seal count" }],
  BOTTLE_STICKER_COMPLETE: [{ key: "count_total", label: "Sticker count" }],
};

export function isCorrectableSubmissionEventType(
  eventType: string,
): eventType is CorrectableSubmissionEventType {
  return (CORRECTABLE_SUBMISSION_EVENT_TYPES as readonly string[]).includes(
    eventType,
  );
}

/** Read a numeric field from payload, accepting snake_case and camelCase. */
export function readSubmissionFieldValue(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const k of [key, camel]) {
    const v = payload[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.max(0, Math.floor(v));
    }
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    }
  }
  return null;
}

/** Build corrected_value object from form field map (only changed keys). */
export function buildCorrectedValueFromFields(
  eventType: CorrectableSubmissionEventType,
  originalPayload: Record<string, unknown>,
  fieldValues: Record<string, number | null>,
): Record<string, number> {
  const specs = SUBMISSION_CORRECTION_FIELDS[eventType];
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const next = fieldValues[spec.key];
    if (next === null || next === undefined) continue;
    const prev = readSubmissionFieldValue(originalPayload, spec.key);
    if (prev === next) continue;
    out[spec.key] = next;
  }
  return out;
}

/** Original-value snapshot for SUBMISSION_CORRECTED (field subset only). */
export function buildOriginalValueSnapshot(
  eventType: CorrectableSubmissionEventType,
  payload: Record<string, unknown>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of SUBMISSION_CORRECTION_FIELDS[eventType]) {
    const v = readSubmissionFieldValue(payload, spec.key);
    if (v !== null) out[spec.key] = v;
  }
  return out;
}
