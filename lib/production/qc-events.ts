// QC-1 — QC event payload contracts.
//
// Five event types share a workflow_events table but each carries a
// type-specific JSON payload. This module is the single source of truth
// for what those payloads look like, plus the Zod schemas that QC-2's
// server actions will run before calling projectEvent.
//
// QC-1 ships contracts + validators only. No emit-side helpers, no DB
// writes — those land in QC-2. The contract is shaped so QC-2 CANNOT
// land a QC event without OP-1 accountability fields (the resolver
// output is required input on every emit shape) and CANNOT silently
// overwrite a corrected event (SUBMISSION_CORRECTED requires both
// original and corrected snapshots).
//
// Why Zod: already used across floor actions
// (operator-session-actions.ts, bag-allocation-actions.ts, roll-
// actions.ts) — staying consistent keeps QC validation legible to
// anyone who's read the rest of the floor wiring.

import { z } from "zod";
import type { AccountabilitySource } from "@/lib/projector";

// ─── Reason codes ──────────────────────────────────────────────────────
//
// Payload-only enum (no DB enum) so we can extend without an
// ALTER TYPE migration. This list is the union across all five event
// types; per-event Zod schemas may narrow it. OTHER is allowed but
// requires `notes` to land — caught in the refine() at the bottom of
// each event schema.

export const QC_REASON_CODES = [
  "DAMAGED_PACKAGING",
  "RIPPED_CARD",
  "BAD_SEAL",
  "LABEL_ISSUE",
  "COUNT_VARIANCE",
  "WRONG_MATERIAL",
  "MACHINE_SETUP",
  "OPERATOR_ERROR",
  "SUPPLIER_DEFECT",
  "CONTAMINATION_RISK",
  "REWORK_NEEDED",
  "SCRAP_APPROVED",
  "SUPERVISOR_CORRECTION",
  "OTHER",
] as const;

export type QCReasonCode = (typeof QC_REASON_CODES)[number];

export const qcReasonCodeSchema = z.enum(QC_REASON_CODES);

// ─── Units ─────────────────────────────────────────────────────────────
//
// Stays narrow on purpose. New units land here only when we have an
// honest reconciliation path for them.

export const QC_UNITS = [
  "units",
  "cards",
  "displays",
  "cases",
  "bottles",
  "blisters",
  "kg",
  "g",
  "m",
] as const;

export type QCUnit = (typeof QC_UNITS)[number];

export const qcUnitSchema = z.enum(QC_UNITS);

// ─── Accountability source mirror ──────────────────────────────────────
//
// Re-exports the projector's AccountabilitySource as a Zod schema so QC
// payloads validate the same set of source labels OP-1 produces. Kept
// in lock-step manually (each value listed) so a future change in the
// projector forces a deliberate edit here too.

export const ACCOUNTABILITY_SOURCES = [
  "LOGGED_IN_USER",
  "EMPLOYEE_PICKER",
  "EMPLOYEE_CODE",
  "BADGE_SCAN",
  "SUPERVISOR_OVERRIDE",
  "STATION_OPERATOR_SESSION",
  "LEGACY_TEXT",
  "MANUAL_TEXT",
] as const satisfies ReadonlyArray<AccountabilitySource>;

export const accountabilitySourceSchema = z.enum(ACCOUNTABILITY_SOURCES);

// ─── Shared sub-schemas ────────────────────────────────────────────────

const uuidSchema = z.string().uuid();

/** Every QC event must carry full OP-1 accountability. The QC-2 server
 *  actions will resolve these from resolveStationAccountability /
 *  resolveAdminAccountability and pass them through unchanged. */
export const qcAccountabilitySchema = z.object({
  accountable_employee_id: uuidSchema.nullable(),
  accountability_source: accountabilitySourceSchema,
  accountable_employee_name_snapshot: z.string().min(1).max(200),
  /** Nullable for floor-PWA paths where there's no logged-in user
   *  (anonymous URL-token auth). QC-2 will refuse floor scrap entries
   *  without an actor; this schema doesn't enforce that — the action
   *  layer does, because the rule is action-specific. */
  entered_by_user_id: uuidSchema.nullable(),
});

export type QCAccountability = z.infer<typeof qcAccountabilitySchema>;

/** Shared base payload extends to every QC event type. Each event-
 *  specific schema spreads this in via .extend(). Quantity is the
 *  unit count for damage/rework/scrap; correction events override
 *  by omitting quantity/unit/reason_code and providing their own
 *  shape (they describe an edit, not a unit movement). */
const sharedBaseSchema = z.object({
  client_event_id: uuidSchema,
  quantity: z.number().int().positive(),
  unit: qcUnitSchema,
  reason_code: qcReasonCodeSchema,
  notes: z.string().max(2000).nullable().optional(),
  photo_keys: z.array(z.string().min(1).max(200)).max(20).nullable().optional(),
  accountable_employee_id: qcAccountabilitySchema.shape.accountable_employee_id,
  accountability_source: qcAccountabilitySchema.shape.accountability_source,
  accountable_employee_name_snapshot:
    qcAccountabilitySchema.shape.accountable_employee_name_snapshot,
  entered_by_user_id: qcAccountabilitySchema.shape.entered_by_user_id,
});

/** OTHER reason code requires non-empty notes. Reused by every event
 *  whose reason_code field is the shared union. */
function otherNeedsNotes<T extends { reason_code: QCReasonCode; notes?: string | null | undefined }>(
  payload: T,
  ctx: z.RefinementCtx,
): void {
  if (payload.reason_code === "OTHER") {
    const n = payload.notes;
    if (n == null || n.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message: "notes required when reason_code is OTHER",
      });
    }
  }
}

// ─── 1. PACKAGING_DAMAGE_RETURN ────────────────────────────────────────

export const packagingDamageReturnPayloadSchema = sharedBaseSchema
  .extend({
    bag_id: uuidSchema,
    product_id: uuidSchema.nullable().optional(),
    station_id: uuidSchema.nullable().optional(),
    machine_id: uuidSchema.nullable().optional(),
    material_lot_id: uuidSchema.nullable().optional(),
    packaging_lot_id: uuidSchema.nullable().optional(),
    /** One of the QC reason codes, repeated as `damage_type` to make
     *  reconciliation filters readable ("show me all BAD_SEAL damage"
     *  reads better than "reason_code=BAD_SEAL events that are
     *  PACKAGING_DAMAGE_RETURN"). Must equal reason_code. */
    damage_type: qcReasonCodeSchema,
    /** "SCRAP" | "REWORK" | "INSPECT" | null — operator's suggestion to
     *  the supervisor. Non-binding; supervisor still decides. */
    disposition_suggestion: z
      .enum(["SCRAP", "REWORK", "INSPECT"])
      .nullable()
      .optional(),
    /** Which inventory ledger this damage touches. Packaging damage is
     *  packaging-material loss by definition; raw-product loss is
     *  optional and depends on whether pills were also lost when the
     *  card/blister failed. QC-5 reads these flags to decide which
     *  ledger to decrement (deferred until then; QC-2 captures the
     *  signal honestly). */
    affects_packaging_material: z.boolean().optional().default(true),
    affects_raw_product: z.boolean().optional().default(false),
  })
  .superRefine((payload, ctx) => {
    otherNeedsNotes(payload, ctx);
    if (payload.damage_type !== payload.reason_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["damage_type"],
        message: "damage_type must equal reason_code",
      });
    }
  });

export type PackagingDamageReturnPayload = z.infer<
  typeof packagingDamageReturnPayloadSchema
>;

// ─── 2. REWORK_SENT ────────────────────────────────────────────────────

export const reworkSentPayloadSchema = sharedBaseSchema
  .extend({
    bag_id: uuidSchema,
    from_station_id: uuidSchema.nullable().optional(),
    to_station_id: uuidSchema.nullable().optional(),
    /** Optional FK to the PACKAGING_DAMAGE_RETURN that triggered this
     *  rework. Null when packaging sends rework directly without
     *  raising a separate damage row. */
    linked_event_id: uuidSchema.nullable().optional(),
    rework_reason: qcReasonCodeSchema,
    expected_return_quantity: z.number().int().positive().nullable().optional(),
  })
  .superRefine((payload, ctx) => {
    otherNeedsNotes(payload, ctx);
    if (payload.rework_reason !== payload.reason_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rework_reason"],
        message: "rework_reason must equal reason_code",
      });
    }
  });

export type ReworkSentPayload = z.infer<typeof reworkSentPayloadSchema>;

// ─── 3. REWORK_RECEIVED ────────────────────────────────────────────────
//
// Receiver-side acknowledgment. quantity (shared base) holds the
// originally-sent quantity; received_quantity holds what actually
// landed. partial=true permits received_quantity < quantity.

export const reworkReceivedPayloadSchema = sharedBaseSchema
  .extend({
    bag_id: uuidSchema,
    from_station_id: uuidSchema.nullable().optional(),
    to_station_id: uuidSchema.nullable().optional(),
    /** Must point at a REWORK_SENT row. QC-2 verifies the FK; this
     *  schema only enforces shape. */
    linked_event_id: uuidSchema.nullable().optional(),
    received_quantity: z.number().int().positive(),
    partial: z.boolean(),
  })
  .superRefine((payload, ctx) => {
    otherNeedsNotes(payload, ctx);
    // Full receive: received_quantity must equal quantity. Partial:
    // received_quantity must be strictly less than quantity (else it's
    // a full receive miscategorized as partial).
    if (!payload.partial && payload.received_quantity !== payload.quantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["received_quantity"],
        message:
          "received_quantity must equal quantity when partial is false",
      });
    }
    if (payload.partial && payload.received_quantity >= payload.quantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["received_quantity"],
        message:
          "partial receive requires received_quantity < quantity",
      });
    }
  });

export type ReworkReceivedPayload = z.infer<
  typeof reworkReceivedPayloadSchema
>;

// ─── 4. SCRAP_RECORDED ─────────────────────────────────────────────────
//
// Scrap is the only event whose unit-count fields are separate from
// the shared base. shared quantity/unit describe the *count of units
// affected* at the originating bag/station; scrap_quantity/scrap_unit
// describe what's actually being written off in the inventory ledger
// (typically the same but allowed to differ when the originating event
// counted cards and the scrap ledger keys on kg of material).

export const scrapRecordedPayloadSchema = sharedBaseSchema
  .extend({
    bag_id: uuidSchema.nullable().optional(),
    material_lot_id: uuidSchema.nullable().optional(),
    packaging_lot_id: uuidSchema.nullable().optional(),
    /** Optional FK to the PACKAGING_DAMAGE_RETURN being resolved. The
     *  partial-unique on workflow_events (migration 0026) prevents two
     *  SCRAP_RECORDED events linking to the same source. */
    linked_event_id: uuidSchema.nullable().optional(),
    scrap_quantity: z.number().int().positive(),
    scrap_unit: qcUnitSchema,
    scrap_reason: qcReasonCodeSchema,
    /** Which inventory ledger this scrap moves. At least one must be
     *  true (enforced in superRefine). QC-5 wires the actual material
     *  decrement against these flags. */
    affects_raw_product: z.boolean(),
    affects_packaging_material: z.boolean(),
    /** Always populated by QC-2 actions — the supervisor's user id.
     *  Null only on synthesizer-emitted rows (legacy backfill). */
    correction_actor_user_id: uuidSchema.nullable().optional(),
    correction_actor_employee_id: uuidSchema.nullable().optional(),
  })
  .superRefine((payload, ctx) => {
    otherNeedsNotes(payload, ctx);
    if (payload.scrap_reason !== payload.reason_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scrap_reason"],
        message: "scrap_reason must equal reason_code",
      });
    }
    // At least one affected scope must be named.
    const hasBag = payload.bag_id != null;
    const hasMatLot = payload.material_lot_id != null;
    const hasPkgLot = payload.packaging_lot_id != null;
    if (!hasBag && !hasMatLot && !hasPkgLot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bag_id"],
        message:
          "scrap requires at least one of bag_id, material_lot_id, packaging_lot_id",
      });
    }
    // At least one ledger flag must be set.
    if (!payload.affects_raw_product && !payload.affects_packaging_material) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affects_packaging_material"],
        message:
          "scrap must affect raw product, packaging material, or both",
      });
    }
  });

export type ScrapRecordedPayload = z.infer<typeof scrapRecordedPayloadSchema>;

// ─── 5. SUBMISSION_CORRECTED ───────────────────────────────────────────
//
// Distinct shape — describes an edit, not a unit movement. quantity /
// unit / reason_code don't apply; correction_reason replaces them.
// preserves_original_accountable_employee MUST be true — the contract
// would let a supervisor flip it but the action layer will refuse. The
// boolean lives in payload purely so audit consumers can confirm the
// rule was honored from the row itself without joining workflow_events
// twice.

export const submissionCorrectedPayloadSchema = z
  .object({
    client_event_id: uuidSchema,
    corrected_event_id: uuidSchema,
    corrected_event_type: z.string().min(1),
    original_value: z.unknown(),
    corrected_value: z.unknown(),
    correction_reason: qcReasonCodeSchema,
    preserves_original_accountable_employee: z.literal(true),
    notes: z.string().max(2000).nullable().optional(),
    photo_keys: z
      .array(z.string().min(1).max(200))
      .max(20)
      .nullable()
      .optional(),
    accountable_employee_id: qcAccountabilitySchema.shape.accountable_employee_id,
    accountability_source: qcAccountabilitySchema.shape.accountability_source,
    accountable_employee_name_snapshot:
      qcAccountabilitySchema.shape.accountable_employee_name_snapshot,
    entered_by_user_id: qcAccountabilitySchema.shape.entered_by_user_id,
  })
  .superRefine((payload, ctx) => {
    if (payload.correction_reason === "OTHER") {
      const n = payload.notes;
      if (n == null || n.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["notes"],
          message: "notes required when correction_reason is OTHER",
        });
      }
    }
    // entered_by_user_id MUST be present on a correction (a correction
    // requires a logged-in supervisor — there is no anonymous path).
    if (payload.entered_by_user_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entered_by_user_id"],
        message: "correction requires entered_by_user_id",
      });
    }
  });

export type SubmissionCorrectedPayload = z.infer<
  typeof submissionCorrectedPayloadSchema
>;

// ─── Dispatch ──────────────────────────────────────────────────────────

export const QC_EVENT_TYPES = [
  "PACKAGING_DAMAGE_RETURN",
  "REWORK_SENT",
  "REWORK_RECEIVED",
  "SCRAP_RECORDED",
  "SUBMISSION_CORRECTED",
] as const;

export type QCEventType = (typeof QC_EVENT_TYPES)[number];

export type QCPayload =
  | PackagingDamageReturnPayload
  | ReworkSentPayload
  | ReworkReceivedPayload
  | ScrapRecordedPayload
  | SubmissionCorrectedPayload;

export const qcPayloadSchemas = {
  PACKAGING_DAMAGE_RETURN: packagingDamageReturnPayloadSchema,
  REWORK_SENT: reworkSentPayloadSchema,
  REWORK_RECEIVED: reworkReceivedPayloadSchema,
  SCRAP_RECORDED: scrapRecordedPayloadSchema,
  SUBMISSION_CORRECTED: submissionCorrectedPayloadSchema,
} as const;

export type ValidateResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: z.ZodIssue[] };

function toResult<T>(parsed: z.SafeParseReturnType<unknown, T>): ValidateResult<T> {
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, issues: parsed.error.issues };
}

export function validatePackagingDamageReturnPayload(
  input: unknown,
): ValidateResult<PackagingDamageReturnPayload> {
  return toResult(packagingDamageReturnPayloadSchema.safeParse(input));
}

export function validateReworkSentPayload(
  input: unknown,
): ValidateResult<ReworkSentPayload> {
  return toResult(reworkSentPayloadSchema.safeParse(input));
}

export function validateReworkReceivedPayload(
  input: unknown,
): ValidateResult<ReworkReceivedPayload> {
  return toResult(reworkReceivedPayloadSchema.safeParse(input));
}

export function validateScrapRecordedPayload(
  input: unknown,
): ValidateResult<ScrapRecordedPayload> {
  return toResult(scrapRecordedPayloadSchema.safeParse(input));
}

export function validateSubmissionCorrectedPayload(
  input: unknown,
): ValidateResult<SubmissionCorrectedPayload> {
  return toResult(submissionCorrectedPayloadSchema.safeParse(input));
}

/** Single-entry dispatch used by QC-2 actions that accept the event
 *  type as a discriminator. Returns ok=false with the issue list on
 *  failure; callers turn that into an action-shaped error response. */
export function validateQcPayload(
  eventType: QCEventType,
  payload: unknown,
): ValidateResult<QCPayload> {
  switch (eventType) {
    case "PACKAGING_DAMAGE_RETURN":
      return validatePackagingDamageReturnPayload(payload);
    case "REWORK_SENT":
      return validateReworkSentPayload(payload);
    case "REWORK_RECEIVED":
      return validateReworkReceivedPayload(payload);
    case "SCRAP_RECORDED":
      return validateScrapRecordedPayload(payload);
    case "SUBMISSION_CORRECTED":
      return validateSubmissionCorrectedPayload(payload);
  }
}

/** Pure helper: does this payload carry full accountability fields?
 *  QC-2 invariant scanners will use this to refuse anonymous events
 *  at the action boundary before they reach projectEvent. */
export function payloadHasAccountability(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const src = payload["accountability_source"];
  const name = payload["accountable_employee_name_snapshot"];
  if (typeof src !== "string") return false;
  if (typeof name !== "string" || name.trim().length === 0) return false;
  if (!(ACCOUNTABILITY_SOURCES as ReadonlyArray<string>).includes(src)) {
    return false;
  }
  return true;
}
