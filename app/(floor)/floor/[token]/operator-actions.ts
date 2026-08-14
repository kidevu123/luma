"use server";

// P4b Task 3 — the operator screen's write surface.
//
// Deliberately thin. Each action does four things and nothing else:
// parse the form, authenticate the station, delegate to ONE engine
// function, and turn the engine's Blocker into the { error } shape the
// client component already renders. No stage rules, no station-kind
// switches, no event names — all of that is the engine's, and duplicating
// any of it here is what the P4b boundary exists to prevent.
//
// Everything is imported from @/lib/production/engine (the barrel) and
// nowhere else in lib/production: this file must add ZERO
// no-restricted-imports violations to the floor count.
//
// Reused AS-IS from the existing files instead of re-created here:
//   pauseBagAction / resumeBagAction / setOperatorAction  -> ./actions
//   saveSealingProductAction (delegates to assignBagProduct) -> ./actions
//   openOperatorSessionAction / endOperatorSessionAction  -> ./operator-session-actions

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { qrCards } from "@/lib/db/schema";
import {
  advanceBag,
  assertStationActiveForFloorActions,
  claimQueuedBag,
  closeSupervisorSession,
  openSupervisorSession,
  raiseDowntimeStarted,
  raiseProductionException,
  raiseQaHoldRelease,
  raiseQaHoldStarted,
  requireSupervisorSession,
  resolveFreshBagStart,
  resolveStationByToken,
  PRODUCTION_EXCEPTION_CATEGORIES,
  SUPERVISOR_GATE_REFUSAL_CODE,
  SUPERVISOR_GATE_REFUSAL_SENTENCE,
  type AdvanceInput,
  type Blocker,
  type FreshBagStart,
} from "@/lib/production/engine";
import { writeAudit } from "@/lib/db/audit";
// SCAN-FIRST-1 — the fresh-bag start transaction stays where it is.
// scanCardAction is a "use server" export, so calling it from this
// module is a server-to-server call, not a second implementation.
import { scanCardAction } from "./actions";

/** What every action on this file returns. `code` is the engine's stable
 *  blocker code — never shown to the operator, but it lets the screen
 *  decide (e.g. reopen the camera on SCAN_AGAIN) without string-matching
 *  the sentence. */
export type OperatorActionResult =
  | { ok: true }
  | { error: string; code?: string; suggestedAction?: Blocker["suggestedAction"] };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same contract as actions.ts:authStation — resolve by scan token,
 *  refuse a token that does not own the station the form names, refuse an
 *  inactive station. Kept here (rather than imported) because actions.ts
 *  does not export it: a "use server" module may only export async
 *  functions. */
async function authStation(token: string, stationIdFromForm: string) {
  const station = await resolveStationByToken(token);
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) throw new Error("Station mismatch.");
  assertStationActiveForFloorActions(station);
  return station;
}

function fail(blocker: Blocker): OperatorActionResult {
  return {
    error: blocker.operatorSentence,
    code: blocker.code,
    suggestedAction: blocker.suggestedAction,
  };
}

function revalidateFloor(token: string): void {
  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
}

// ── advance ───────────────────────────────────────────────────────────

const countField = z.coerce.number().int().min(0).optional();

const advanceSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  operatorSessionId: z.string().uuid(),
  // CLAIM is served by claimScannedBagAction below (it needs the scan
  // resolution); this action carries the work intents.
  intent: z.enum(["COMPLETE", "CONFIRM_BAG_EMPTY", "RESOLVE_PARTIAL"]),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
  productId: z.string().uuid().optional(),
  // Presence, not coercion: z.coerce.boolean("false") is TRUE, which is
  // exactly the wrong default for "keep this bag open".
  keepBagPartial: z.literal("true").optional(),
  partialRemainingEstimate: countField,
  /** RESOLVE_PARTIAL's lead gate — the badge code that closes a
   *  raw-bag allocation ledger (same gate as
   *  resolveScannedBagAllocationAction). Also the per-form
   *  accountability override recordStageEvent already accepts. */
  overrideEmployeeCode: z.string().max(40).optional(),
  /** SEALING-PARTIAL-CLOSEOUT-1 — "Close sealing early". Only read when
   *  the intent/operation pair resolves to SEALING_COMPLETE on a pure
   *  SEALING station; recordStageEvent ignores it everywhere else and
   *  validates the reason itself (validateSealingPartialCloseInput), so
   *  this schema deliberately does not re-check the vocabulary. */
  sealingCloseMode: z.enum(["whole", "partial"]).optional(),
  partialCloseReason: z.string().max(40).optional(),
  partialCloseReasonNote: z.string().max(500).optional(),
  counter: countField,
  counterPresses: countField,
  damaged: countField,
  cases: countField,
  displays: countField,
  loose: countField,
  physicalQty: countField,
});

function optionalField(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The screen's single work gesture: DONE, "Yes, bag empty", and the
 *  partial-bag resolution all land here. Which event that becomes is
 *  advanceBag's decision, from the bag's route — this action does not
 *  know and must not guess.
 *
 *  advanceBag returns the POST-WRITE StationView on success and this
 *  action discards it, answering { ok: true } and letting revalidatePath
 *  re-render the page: the screen is a server-rendered `view` prop, so a
 *  returned view would have to be held in client state and would then
 *  compete with the SSE/revalidate refresh for which one is current —
 *  two sources of truth for the same screen. Task 5 owns that call once
 *  the component is mounted and the refresh path is visible.
 *
 *  RESOLVE_PARTIAL is a real intent as of Task 5: advanceBag routes it to
 *  resolvePartialAllocation, which closes the prior run's raw-bag
 *  allocation session against either the system-derived remaining or the
 *  operator's physical count. It is lead-gated there, which is why this
 *  schema carries overrideEmployeeCode. */
export async function advanceBagAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = advanceSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    operatorSessionId: formData.get("operatorSessionId"),
    intent: formData.get("intent"),
    clientEventId: formData.get("clientEventId"),
    productId: optionalField(formData, "productId"),
    keepBagPartial: optionalField(formData, "keepBagPartial"),
    partialRemainingEstimate: optionalField(formData, "partialRemainingEstimate"),
    overrideEmployeeCode: optionalField(formData, "overrideEmployeeCode"),
    sealingCloseMode: optionalField(formData, "sealingCloseMode"),
    partialCloseReason: optionalField(formData, "partialCloseReason"),
    partialCloseReasonNote: optionalField(formData, "partialCloseReasonNote"),
    counter: optionalField(formData, "counter"),
    counterPresses: optionalField(formData, "counterPresses"),
    damaged: optionalField(formData, "damaged"),
    cases: optionalField(formData, "cases"),
    displays: optionalField(formData, "displays"),
    loose: optionalField(formData, "loose"),
    physicalQty: optionalField(formData, "physicalQty"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  // exactOptionalPropertyTypes: an absent count must leave the KEY OFF,
  // not set it to undefined — advanceBag reads presence, not truthiness
  // (a real 0 is a reading), and isPackagingShapedComplete routes on it.
  const inputs: AdvanceInput["inputs"] = {
    ...(d.counter != null ? { counter: d.counter } : {}),
    ...(d.counterPresses != null ? { counterPresses: d.counterPresses } : {}),
    ...(d.damaged != null ? { damaged: d.damaged } : {}),
    ...(d.cases != null ? { cases: d.cases } : {}),
    ...(d.displays != null ? { displays: d.displays } : {}),
    ...(d.loose != null ? { loose: d.loose } : {}),
    ...(d.physicalQty != null ? { physicalQty: d.physicalQty } : {}),
  };

  try {
    await authStation(d.token, d.stationId);
    const result = await advanceBag({
      stationId: d.stationId,
      workflowBagId: d.workflowBagId,
      operatorSessionId: d.operatorSessionId,
      intent: d.intent,
      clientEventId: d.clientEventId,
      inputs,
      ...(d.productId != null ? { productId: d.productId } : {}),
      ...(d.overrideEmployeeCode != null
        ? { overrideEmployeeCode: d.overrideEmployeeCode }
        : {}),
      // Absent stays absent: recordStageEvent defaults sealingCloseMode
      // to "whole", and a present-but-undefined key would be a partial
      // close nobody asked for under exactOptionalPropertyTypes.
      ...(d.sealingCloseMode != null
        ? { sealingCloseMode: d.sealingCloseMode }
        : {}),
      ...(d.partialCloseReason != null
        ? { partialCloseReason: d.partialCloseReason }
        : {}),
      ...(d.partialCloseReasonNote != null
        ? { partialCloseReasonNote: d.partialCloseReasonNote }
        : {}),
      ...(d.keepBagPartial === "true" ? { keepBagPartial: true } : {}),
      ...(d.partialRemainingEstimate != null
        ? { partialRemainingEstimate: d.partialRemainingEstimate }
        : {}),
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not record this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

// ── claim ─────────────────────────────────────────────────────────────

// P5-SUPERVISOR Task 4 fix round 1 — scanToken is REQUIRED. Physical
// possession of the QR IS the control on the scan path; before this
// round the schema accepted a workflowBagId-only request as a
// fallback, and the P5 manual-bag-pick tool became the first caller
// to exercise that path — turning "supervisor-only" into a cosmetic
// affordance (a hand-crafted request against the ungated action
// would claim a queued bag while the station was locked). The manual
// override now goes through supervisorClaimBagAction, which requires
// a live supervisor session server-side. workflowBagId remains only
// as an expected-bag HINT that MUST accompany a scan (pre-P5 call
// sites always sent both); a workflowBagId-only request is refused
// with the standard invalid-input shape.
const claimSchema = z
  .object({
    token: z.string(),
    stationId: z.string().uuid(),
    clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
    /** The camera's decoded string, or the code typed under More.
     *  REQUIRED — physical possession is the control on this path. */
    scanToken: z.string().min(1).max(200),
    /** Expected-bag hint that accompanies a scan (pre-P5 callers
     *  always sent it alongside scanToken). Never used on its own —
     *  the resolved scan wins over the hint anyway. */
    workflowBagId: z.string().uuid().optional(),
    /** SCAN-FIRST-1 — the fresh-start half. Only read when the scanned
     *  card has no workflow bag yet and this station kind must record a
     *  product at start (BOTTLE_HANDPACK). */
    productId: z.string().uuid().optional(),
    /** P1-PARTIAL — the operator's confirmation that this partial bag
     *  is the one they are starting, and (LOW confidence only) the
     *  supervisor badge that rule requires. Forwarded verbatim to
     *  scanCardAction, which owns both gates. */
    confirmPartialReuse: z.literal("true").optional(),
    partialReuseSupervisorCode: z.string().max(40).optional(),
  });

/** Resolve a scanned/typed QR string to the workflow bag it is carrying.
 *
 *  The one piece of non-delegating work on this file, and it is here
 *  because the engine's claim takes a workflowBagId while the operator's
 *  gesture produces a QR string: read_bag_queue carries no scan token to
 *  match against, and matching the composed bag LABEL would be a guess.
 *  Read-only, one row, no fallback that could claim the wrong bag — an
 *  unrecognized or unassigned card resolves to null and the caller
 *  answers with the engine's BAG_UNRECOGNIZED blocker.
 *
 *  The qr_cards.id fallback mirrors lookupCardByTokenAction: labels
 *  printed before QR-SCAN-PAYLOAD-1 encode the row id instead of the
 *  scan token, and it is gated on UUID shape because a non-UUID against
 *  a uuid column throws 22P02. */
async function resolveScannedWorkflowBagId(scanToken: string): Promise<string | null> {
  const token = scanToken.trim();
  const [byToken] = await db
    .select({ workflowBagId: qrCards.assignedWorkflowBagId })
    .from(qrCards)
    .where(eq(qrCards.scanToken, token));
  if (byToken) return byToken.workflowBagId;
  if (!UUID_RE.test(token)) return null;
  const [byId] = await db
    .select({ workflowBagId: qrCards.assignedWorkflowBagId })
    .from(qrCards)
    .where(eq(qrCards.id, token));
  return byId?.workflowBagId ?? null;
}

/** What SCAN_TO_CLAIM can answer with beyond ok/error. Two of the four
 *  answers are neither: the scan is mid-flight and the operator owes one
 *  more input before the bag can start. */
export type ClaimScanResult =
  | { ok: true; workflowBagId?: string }
  | {
      error: string;
      code?: string;
      suggestedAction?: Blocker["suggestedAction"];
    }
  /** SCAN-FIRST-1 — the scan started a NEW bag rather than claiming a
   *  queued one, and this station kind records the product at start.
   *  The screen shows these and re-submits with productId. */
  | { needsProduct: { options: { productId: string; name: string; sku: string }[] } }
  /** P1-PARTIAL — the scanned bag is a partial from an earlier run and
   *  the operator must confirm before the run opens. The screen shows
   *  the spec's partial screen and re-submits with confirmPartialReuse
   *  (plus a supervisor badge when the confidence is LOW). */
  | {
      partialReuse: {
        estimate: number | null;
        confidence: string | null;
        previousProductName: string | null;
      };
    };

/** SCAN_TO_CLAIM's write. Every refusal an operator can cause — wrong
 *  station, already claimed, paused, not ready — comes back from
 *  claimQueuedBag's own guards, not from a pre-check here.
 *
 *  SCAN-FIRST-1: one gesture, two meanings. A card that already carries
 *  a workflow bag is CLAIMED; a RAW_BAG card that does not is STARTED,
 *  by delegating to scanCardAction (the transaction that creates the
 *  bag, and the owner of the partial-reuse and readiness gates). The
 *  operator screen has no fresh-card list and no pickup list, so this
 *  branch is the only way a first-operation station can begin work
 *  after the cutover. */
export async function claimScannedBagAction(
  formData: FormData,
): Promise<ClaimScanResult> {
  const parsed = claimSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    clientEventId: formData.get("clientEventId"),
    scanToken: optionalField(formData, "scanToken"),
    workflowBagId: optionalField(formData, "workflowBagId"),
    productId: optionalField(formData, "productId"),
    confirmPartialReuse: optionalField(formData, "confirmPartialReuse"),
    partialReuseSupervisorCode: optionalField(
      formData,
      "partialReuseSupervisorCode",
    ),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  let workflowBagId: string;
  try {
    const station = await authStation(d.token, d.stationId);
    // A scan wins over the expected bag hint: the operator is holding
    // what they scanned, and claiming the queue head instead would
    // attribute work to the wrong bag.
    const resolved = await resolveScannedWorkflowBagId(d.scanToken);
    if (!resolved) {
      const fresh = await resolveFreshBagStart({
        scanToken: d.scanToken,
        stationKind: station.kind,
      });
      if (fresh) {
        return startFreshBag({
          token: d.token,
          stationId: d.stationId,
          fresh,
          ...(d.productId != null ? { productId: d.productId } : {}),
          confirmPartialReuse: d.confirmPartialReuse === "true",
          ...(d.partialReuseSupervisorCode != null
            ? { partialReuseSupervisorCode: d.partialReuseSupervisorCode }
            : {}),
        });
      }
      return {
        error: "This code was not recognized. Try scanning again.",
        code: "BAG_UNRECOGNIZED",
        suggestedAction: "SCAN_AGAIN",
      };
    }
    workflowBagId = resolved;
    const result = await claimQueuedBag({
      stationId: d.stationId,
      workflowBagId,
      clientEventId: d.clientEventId,
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not pick up this bag." };
  }

  revalidateFloor(d.token);
  return { ok: true, workflowBagId };
}

// ── supervisor claim (manual bag pick) ───────────────────────────────
//
// P5-SUPERVISOR Task 4 fix round 1 — the manual override for
// "operator can't scan the QR, pick from the queue". This is the
// ONLY server entry that claims a queued bag without a scan; every
// other path (camera, typed code) goes through claimScannedBagAction
// which requires scanToken. The gate here is a LIVE supervisor
// session for this station (view.supervisor hides the panel; this
// check refuses hand-crafted requests when locked). Delegates the
// write to the same P4b claim path (claimQueuedBag) — no bespoke
// claim logic.

const supervisorClaimSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
});

/** Manual bag pick from the More sheet's supervisor tools. Gate:
 *  requireSupervisorSession refuses without a live session; audit
 *  row records the supervisor session + employee that authorised
 *  the pick (no secrets). */
export async function supervisorClaimBagAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = supervisorClaimSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    clientEventId: formData.get("clientEventId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    // Read-only tx for the gate — claimQueuedBag opens its own
    // write tx afterwards, matching the releaseQaHoldAction pattern.
    const supSession = await db.transaction((tx) =>
      requireSupervisorSession(tx, d.stationId),
    );
    if (!supSession) {
      return {
        error: SUPERVISOR_GATE_REFUSAL_SENTENCE,
        code: SUPERVISOR_GATE_REFUSAL_CODE,
      };
    }
    const result = await claimQueuedBag({
      stationId: d.stationId,
      workflowBagId: d.workflowBagId,
      clientEventId: d.clientEventId,
    });
    if (!result.ok) return fail(result.blocker);
    await writeAudit({
      actorId: null,
      actorRole: null,
      action: "floor.supervisor.manual_bag_claim",
      targetType: "WorkflowBag",
      targetId: d.workflowBagId,
      after: {
        station_id: d.stationId,
        supervisor_session_id: supSession.id,
        supervisor_employee_id: supSession.employeeId,
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not pick up this bag." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

/** SCAN-FIRST-1's start half. Delegates the whole write to
 *  scanCardAction — this function only decides whether the operator
 *  still owes an answer (a product pick, a partial confirmation) before
 *  that action can run, and translates its structured refusals into the
 *  shapes the screen renders.
 *
 *  Deliberately NOT re-implemented here: the readiness gate, the
 *  partial-restart rules, the LOW-confidence supervisor requirement and
 *  the allocation-session open all live in scanCardAction's transaction
 *  and stay there. Duplicating any of them would give the floor two
 *  answers to the same question. */
async function startFreshBag(args: {
  token: string;
  stationId: string;
  fresh: FreshBagStart;
  productId?: string;
  confirmPartialReuse: boolean;
  partialReuseSupervisorCode?: string;
}): Promise<ClaimScanResult> {
  let productId = args.productId ?? null;
  if (args.fresh.needsProduct && !productId) {
    // Exactly one compatible product is master data's answer, not an
    // operator question — the same AUTO rule the sealing pick follows.
    if (args.fresh.options.length === 1) {
      productId = args.fresh.options[0]?.productId ?? null;
    } else if (args.fresh.options.length > 1) {
      return { needsProduct: { options: args.fresh.options } };
    }
    // Zero options falls through: scanCardAction's own
    // checkFirstOpProductSelection produces the operator-facing message
    // for "master data has nothing this bag can become".
  }

  const fd = new FormData();
  fd.set("token", args.token);
  fd.set("stationId", args.stationId);
  fd.set("cardId", args.fresh.cardId);
  if (productId) fd.set("productId", productId);
  if (args.confirmPartialReuse) fd.set("confirmPartialReuse", "true");
  if (args.partialReuseSupervisorCode) {
    fd.set("partialReuseSupervisorCode", args.partialReuseSupervisorCode);
  }

  const result = await scanCardAction(fd);
  if (!result) return { ok: true };
  if (result.partialReuseConfirmationRequired && result.partialContext) {
    return {
      partialReuse: {
        estimate: result.partialContext.remainingEstimate,
        confidence: result.partialContext.remainingConfidence,
        previousProductName: result.partialContext.previousProductName,
      },
    };
  }
  if (result.openAllocationBlock) {
    return {
      error: result.openAllocationBlock.message,
      code: "OPEN_ALLOCATION_ON_BAG",
      suggestedAction: "NOTIFY_SUPERVISOR",
    };
  }
  if (result.error) return { error: result.error };
  revalidateFloor(args.token);
  return { ok: true };
}

// ── exceptions ────────────────────────────────────────────────────────

const exceptionSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid().optional(),
  category: z.enum(PRODUCTION_EXCEPTION_CATEGORIES),
  detail: z.string().min(1).max(500),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
});

/** The exception emitter behind ? Help's [ Notify supervisor ] (and, from
 *  Task 4, the categories of Report problem that have no dedicated
 *  event). raiseProductionException is total — every failure is already a
 *  Blocker — so there is nothing to translate but the shape. */
export async function raiseProductionExceptionAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = exceptionSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: optionalField(formData, "workflowBagId"),
    category: formData.get("category"),
    detail: formData.get("detail"),
    clientEventId: formData.get("clientEventId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    const result = await raiseProductionException({
      stationId: d.stationId,
      category: d.category,
      detail: d.detail,
      clientEventId: d.clientEventId,
      ...(d.workflowBagId != null ? { workflowBagId: d.workflowBagId } : {}),
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not send this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

// Report Problem's MACHINE and QUALITY categories share this shape —
// station + optional bag + one detail string — but not the exception
// category enum, since neither becomes a PRODUCTION_EXCEPTION_RAISED.
const reportDetailSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid().optional(),
  detail: z.string().min(1).max(500),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
});

/** Report Problem's MACHINE category, second write. The first —
 *  pauseBagAction — is called by the client directly (it already has
 *  its own floor action) and its outcome is NOT a precondition here: a
 *  bag that is already paused for another reason must not block the
 *  downtime record. raiseDowntimeStarted is total, like
 *  raiseProductionException, so there is nothing to translate but the
 *  shape. */
export async function raiseDowntimeAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = reportDetailSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: optionalField(formData, "workflowBagId"),
    detail: formData.get("detail"),
    clientEventId: formData.get("clientEventId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    const result = await raiseDowntimeStarted({
      stationId: d.stationId,
      detail: d.detail,
      clientEventId: d.clientEventId,
      ...(d.workflowBagId != null ? { workflowBagId: d.workflowBagId } : {}),
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not send this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

/** Report Problem's QUALITY category. Exactly one write — no pause
 *  attempt (Task 4's mapping table: QUALITY is QA_HOLD_STARTED alone). */
export async function raiseQaHoldAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = reportDetailSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: optionalField(formData, "workflowBagId"),
    detail: formData.get("detail"),
    clientEventId: formData.get("clientEventId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    const result = await raiseQaHoldStarted({
      stationId: d.stationId,
      detail: d.detail,
      clientEventId: d.clientEventId,
      ...(d.workflowBagId != null ? { workflowBagId: d.workflowBagId } : {}),
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not send this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

// P4b Task 4 fix round 2 (N1) — the release half. workflowBagId is
// REQUIRED (unlike reportDetailSchema's optional one): this action is
// reached only from qc-panel.tsx, which already knows the bag it is
// rendered for and has no "release whatever is pinned" use case the
// way Report Problem's other categories do. detail stays optional —
// see raise-qa-hold-release.ts's header for why: releasing must be at
// least as easy as raising was hard to leave in place.
const releaseQaHoldSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  detail: z.string().max(500).optional(),
  clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
});

/** qc-panel.tsx's [ Release hold ] — the only place this is reachable
 *  from, shown only when the current bag's read_bag_state.is_on_hold
 *  is true. */
export async function releaseQaHoldAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = releaseQaHoldSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    detail: optionalField(formData, "detail"),
    clientEventId: formData.get("clientEventId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    // P5-SUPERVISOR Task 4 — server-side gate. Release hold is a QC
    // supervisor action (view.supervisor hides the qc-panel button;
    // this check refuses a hand-crafted request when locked). Runs a
    // dedicated read-only tx because raiseQaHoldRelease opens its own
    // write tx afterward.
    const supSession = await db.transaction((tx) =>
      requireSupervisorSession(tx, d.stationId),
    );
    if (!supSession) {
      return {
        error: SUPERVISOR_GATE_REFUSAL_SENTENCE,
        code: SUPERVISOR_GATE_REFUSAL_CODE,
      };
    }
    const result = await raiseQaHoldRelease({
      stationId: d.stationId,
      workflowBagId: d.workflowBagId,
      clientEventId: d.clientEventId,
      ...(d.detail != null ? { detail: d.detail } : {}),
    });
    if (!result.ok) return fail(result.blocker);
    // P5-SUPERVISOR Task 4 — audit the gated write. QA_HOLD_RELEASED is
    // written as a workflow_events row by raiseQaHoldRelease; this
    // audit_log row records the supervisor session that authorised it.
    await writeAudit({
      actorId: null,
      actorRole: null,
      action: "floor.supervisor.qa_hold_release",
      targetType: "WorkflowBag",
      targetId: d.workflowBagId,
      after: {
        station_id: d.stationId,
        supervisor_session_id: supSession.id,
        supervisor_employee_id: supSession.employeeId,
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not release this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

// ── supervisor session ────────────────────────────────────────────────

const supervisorUnlockSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  employeeCode: z.string().min(1).max(40),
  /** Cleartext PIN from the sheet. Never logged, never in error strings.
   *  The server barrel's openSupervisorSession applies argon2id verify. */
  pin: z.string().min(1).max(100),
});

/** Supervisor sheet: unlock a 15-minute supervisor session for the
 *  station. Delegates entirely to openSupervisorSession — no stage
 *  rules, no session management logic. The action's only contribution
 *  is parse -> authStation -> delegate -> translate refusal shape.
 *
 *  PIN DISCIPLINE: the `pin` field never appears in any error string,
 *  any log, or any audit payload. openSupervisorSession writes all of
 *  that and the guarantee is in that module. This action's only PIN
 *  contact is the schema field and the delegate argument — same rule
 *  supervisor-session.ts enforces via its source-scan test. */
export async function supervisorUnlockAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = supervisorUnlockSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    employeeCode: formData.get("employeeCode"),
    pin: formData.get("pin"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    const result = await openSupervisorSession({
      stationId: d.stationId,
      employeeCode: d.employeeCode,
      pin: d.pin,
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not unlock supervisor mode." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}

const supervisorLockSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
});

/** Supervisor banner: [ Exit ] closes the open session and re-renders
 *  the screen in locked state. A no-open-session call is a harmless
 *  no-op (closeSupervisorSession returns { closed: false }). */
export async function supervisorLockAction(
  formData: FormData,
): Promise<OperatorActionResult> {
  const parsed = supervisorLockSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  try {
    await authStation(d.token, d.stationId);
    await closeSupervisorSession(d.stationId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not exit supervisor mode." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}
