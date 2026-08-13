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
  raiseDowntimeStarted,
  raiseProductionException,
  raiseQaHoldRelease,
  raiseQaHoldStarted,
  resolveStationByToken,
  PRODUCTION_EXCEPTION_CATEGORIES,
  type AdvanceInput,
  type Blocker,
} from "@/lib/production/engine";

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
  counter: countField,
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
 *  RESOLVE_PARTIAL is accepted and forwarded even though the engine
 *  currently REFUSES it (intentToEventType returns null for that intent,
 *  so advanceBag answers with a blocker). That is deliberate: the screen
 *  renders the spec's partial screens now, and the operator sees the
 *  engine's own refusal rather than a UI-invented message. Closing it is
 *  engine work, not this file's. */
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
    counter: optionalField(formData, "counter"),
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

const claimSchema = z
  .object({
    token: z.string(),
    stationId: z.string().uuid(),
    clientEventId: z.string().regex(UUID_RE, "Invalid client event id."),
    /** The camera's decoded string, or the code typed under More. */
    scanToken: z.string().min(1).max(200).optional(),
    /** The expected bag, when the screen already knows which one. */
    workflowBagId: z.string().uuid().optional(),
  })
  .refine((d) => d.scanToken != null || d.workflowBagId != null, {
    message: "Scan a bag QR or enter its code.",
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

/** SCAN_TO_CLAIM's write. Every refusal an operator can cause — wrong
 *  station, already claimed, paused, not ready — comes back from
 *  claimQueuedBag's own guards, not from a pre-check here. */
export async function claimScannedBagAction(
  formData: FormData,
): Promise<OperatorActionResult & { workflowBagId?: string }> {
  const parsed = claimSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    clientEventId: formData.get("clientEventId"),
    scanToken: optionalField(formData, "scanToken"),
    workflowBagId: optionalField(formData, "workflowBagId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  let workflowBagId: string;
  try {
    await authStation(d.token, d.stationId);
    // A scan wins over the expected bag: the operator is holding what
    // they scanned, and claiming the queue head instead would attribute
    // work to the wrong bag.
    const resolved = d.scanToken
      ? await resolveScannedWorkflowBagId(d.scanToken)
      : (d.workflowBagId ?? null);
    if (!resolved) {
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
    const result = await raiseQaHoldRelease({
      stationId: d.stationId,
      workflowBagId: d.workflowBagId,
      clientEventId: d.clientEventId,
      ...(d.detail != null ? { detail: d.detail } : {}),
    });
    if (!result.ok) return fail(result.blocker);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not release this." };
  }

  revalidateFloor(d.token);
  return { ok: true };
}
