// The pure half of the operator screen (P4b Task 3).
//
// operator-screen.tsx is presentational: it switches on NextAction and
// renders. Every decision that is not "put this string in this box" lives
// here, so it can be tested without a DOM, a database, or a clock:
//
//   - which product submission the screen makes on its own (the AUTO rule)
//   - how the CompletionInput[] the engine hands down becomes the
//     AdvanceInput.inputs the engine expects back
//   - which of the two partial-bag screens the spec calls for
//   - the ? Help checklist, derived from the SAME evaluateChecks() that
//     produced the view's blockers (spec: "a single code path, not two")
//
// This module may import the rest of lib/production; the floor component
// may not (eslint no-restricted-imports on app/(floor)/**). Anything the
// screen needs from a non-engine module is wrapped here and re-exported
// through the engine barrel.

import { evaluateChecks } from "./resolve-exceptions";
import type { CheckResult } from "./resolve-exceptions";
import type {
  AdvanceInput,
  CompletionInput,
  CurrentWork,
  NextAction,
  StationView,
  UpNextBag,
} from "./types";
import {
  getPauseReasonsForStation,
  type PauseReason,
} from "@/lib/production/station-pause-reasons";
import {
  parseNonnegativeIntegerInput,
  pauseCounterSnapshotFieldLabel,
  pauseCounterSnapshotHelperText,
  stationRequiresBlisterCounterSnapshot,
} from "@/lib/production/blister-counter-snapshot";
import {
  floorSupervisorToolsForStation,
  type FloorSupervisorToolLink,
} from "@/lib/production/floor-station-mobile-nav";

// ── the AUTO product rule ─────────────────────────────────────────────

export type AutoProductSubmission = {
  productId: string;
  /** Idempotency key for the screen's "submit this once" guard. Both
   *  parts matter: the bag id so a NEW bag with the same single product
   *  gets its own attempt, and the product id so a view that somehow
   *  changes its mind is not treated as the same attempt. */
  key: string;
};

/** Should the screen submit a product WITHOUT asking the operator?
 *
 *  The rule is the spec's: a pick with exactly one option is not a
 *  question, it is master data's answer, so the screen sends it and the
 *  operator never sees a one-button chooser.
 *
 *  CURRENTLY UNREACHABLE through getStationView, deliberately kept:
 *  resolveProductChoice() returns AUTO (not PICK) for exactly one
 *  compatible product, and buildNextAction only emits PICK_PRODUCT for
 *  the PICK case — so today a single compatible product leaves the bag
 *  BLOCKED on PRODUCT_UNRESOLVED with no productId in the view for the
 *  screen to submit. That engine gap is not this module's to close (P4b
 *  Task 1 left AUTO display-only on purpose). When it closes, the screen
 *  already behaves correctly instead of rendering a pointless single
 *  button. */
export function autoProductSubmission(
  view: StationView,
): AutoProductSubmission | null {
  const action = view.nextAction;
  if (action.kind !== "PICK_PRODUCT") return null;
  if (action.options.length !== 1) return null;
  const only = action.options[0];
  if (!only) return null;
  const bagId = view.current?.workflowBagId ?? "no-bag";
  return { productId: only.productId, key: `${bagId}:${only.productId}` };
}

/** The loop guard, as a function rather than an inline `!==` in an
 *  effect, so the "submit once" promise is testable.
 *
 *  A rejected submission does NOT clear the attempted key: the view the
 *  screen re-reads after a failure looks identical to the one that
 *  failed, so retrying on it would spin forever against an engine that
 *  has already said no. The operator's own gesture (a fresh scan, a new
 *  bag) produces a different key and unblocks the next attempt. */
export function shouldSubmitAutoProduct(
  next: AutoProductSubmission | null,
  attemptedKey: string | null,
): boolean {
  if (!next) return false;
  return next.key !== attemptedKey;
}

// ── completion inputs ─────────────────────────────────────────────────

/** Field label with its unit, e.g. "Cases (cases)". Units are the
 *  engine's own (CompletionInput.unit); null unit renders bare. */
export function completionFieldLabel(input: CompletionInput): string {
  return input.unit ? `${input.label} (${input.unit})` : input.label;
}

export type CompletionAssembly =
  | { ok: true; inputs: AdvanceInput["inputs"] }
  | { ok: false; message: string };

/** Raw form strings -> AdvanceInput.inputs, or the first operator-facing
 *  problem with them.
 *
 *  Only the keys the engine ASKED for are read: a value left over in the
 *  form state for a field the current operation does not want is
 *  dropped rather than sent. That matters beyond tidiness — presence of
 *  `cases`/`displays`/`loose` is what routes a COMBINED station's
 *  gesture to PACKAGING (isPackagingShapedComplete), so a stale value
 *  would silently re-route the write.
 *
 *  Absent-vs-undefined: under exactOptionalPropertyTypes an unfilled
 *  optional field must leave the KEY OFF, not set it to undefined. */
export function assembleCompletionInputs(
  inputs: readonly CompletionInput[],
  values: Readonly<Record<string, string>>,
): CompletionAssembly {
  const out: AdvanceInput["inputs"] = {};
  for (const input of inputs) {
    const raw = (values[input.key] ?? "").trim();
    if (raw === "") {
      if (input.required) {
        return {
          ok: false,
          message: `Enter ${input.label.toLowerCase()} before finishing.`,
        };
      }
      continue;
    }
    const parsed = parseNonnegativeIntegerInput(raw);
    if (parsed == null) {
      return { ok: false, message: `${input.label} must be a whole number.` };
    }
    // Explicit per key rather than a computed index + cast: the compiler
    // checks each assignment against AdvanceInput.inputs, so a new
    // CompletionInput key cannot reach the engine under a name the
    // engine does not read.
    switch (input.key) {
      case "counter":
        out.counter = parsed;
        break;
      case "damaged":
        out.damaged = parsed;
        break;
      case "cases":
        out.cases = parsed;
        break;
      case "displays":
        out.displays = parsed;
        break;
      case "loose":
        out.loose = parsed;
        break;
    }
  }
  return { ok: true, inputs: out };
}

// ── partial bags ──────────────────────────────────────────────────────

export type PartialScreen =
  /** HIGH / MEDIUM confidence — the estimate is shown and accepted with
   *  one button. */
  | { mode: "USE_ESTIMATE"; estimate: number }
  /** LOW confidence (or no estimate at all) — the operator counts. */
  | { mode: "ENTER_QUANTITY" };

/** Which of the spec's two partial screens to render.
 *
 *  Fails toward asking: needsEntry wins, and a missing estimate is an
 *  entry screen too. Showing "Estimated remaining: —" with a [ Use bag ]
 *  button would ask the operator to accept a number Luma does not have
 *  (luma-data-honesty). */
export function partialScreenFor(action: NextAction): PartialScreen | null {
  if (action.kind !== "RESOLVE_PARTIAL") return null;
  if (action.needsEntry || action.estimate == null) return { mode: "ENTER_QUANTITY" };
  return { mode: "USE_ESTIMATE", estimate: action.estimate };
}

// ── ? Help ────────────────────────────────────────────────────────────

/** The spec's checklist, rebuilt from the SAME evaluateChecks() the view
 *  came from.
 *
 *  The facts are reconstructed from the view's own blocker CODES rather
 *  than re-derived from raw state, which is what makes the guarantee
 *  ("the help screen cannot disagree with why the button is disabled")
 *  hold: a row fails here exactly when the engine put its blocker on the
 *  view, and the labels, order and sentences all come from the engine
 *  function, not from a copy in the UI.
 *
 *  Two view shapes need care:
 *    - No current bag (SCAN_TO_CLAIM / OPEN_SHIFT). The three rows that
 *      describe a bag IN HAND — recognized, product, station — are
 *      DROPPED rather than shown failing. assembleStationView does
 *      evaluate them as false in this case, but buildNextAction never
 *      consults them (it returns SCAN_TO_CLAIM first), so rendering three
 *      red crosses on a perfectly healthy idle station would tell the
 *      operator something is wrong when nothing is. helpIdleNote() says
 *      what is actually true instead.
 *    - PICK_PRODUCT. The product check DID fail (that is why there is a
 *      pick); buildNextAction promotes it over the blocker because the
 *      operator can answer it. Help still shows it as the open item. */
export function helpChecklistForView(view: StationView): CheckResult[] {
  const action = view.nextAction;
  const codes = new Set<string>(
    action.kind === "BLOCKED"
      ? action.blockers.map((b) => b.code)
      : action.kind === "PICK_PRODUCT"
        ? ["PRODUCT_UNRESOLVED"]
        : [],
  );
  const hasBag = view.current != null;
  const rows = evaluateChecks({
    bagRecognized: !codes.has("BAG_UNRECOGNIZED"),
    productResolved: !codes.has("PRODUCT_UNRESOLVED"),
    operationResolved: !codes.has("OPERATION_UNRESOLVED"),
    materialsAvailable: !codes.has("MATERIALS_UNAVAILABLE"),
    upstreamStageComplete: !codes.has("UPSTREAM_INCOMPLETE"),
    bagPaused: codes.has("BAG_PAUSED"),
    bagFinalized: codes.has("BAG_FINALIZED"),
    bagOnHold: codes.has("BAG_ON_HOLD"),
    // The engine's own waitingForLabel is not carried on StationView;
    // passing null keeps the generic sentence rather than inventing a
    // station name the view does not know.
    waitingForLabel: null,
  });
  if (hasBag) return rows;
  return rows.filter((row) => !BAG_IN_HAND_CHECK_IDS.has(row.id));
}

/** The rows that only mean anything once a bag is at the station. */
const BAG_IN_HAND_CHECK_IDS: ReadonlySet<string> = new Set([
  "bag",
  "product",
  "operation",
]);

/** What ? Help says INSTEAD of the dropped rows: the neutral truth about
 *  an idle station, never a fault. Null once a bag is in hand. */
export function helpIdleNote(view: StationView): string | null {
  return view.current == null ? "No bag at this station yet." : null;
}

/** raiseProductionException's detail column, as the action's zod schema
 *  bounds it. Kept next to the builder so the two cannot drift. */
export const EXCEPTION_DETAIL_MAX_LENGTH = 500;

/** The note [ Notify supervisor ] sends: every open item, in the
 *  engine's own words, truncated to what the action will accept. A long
 *  checklist must not turn a supervisor call into a validation error the
 *  operator cannot act on. */
export function helpNotifyDetail(checks: readonly CheckResult[]): string {
  const sentences = checks
    .filter((c) => !c.passed && c.blocker != null)
    .map((c) => c.blocker?.operatorSentence ?? "")
    .filter((s) => s !== "");
  const text =
    sentences.join(" ") || "Operator asked for help from the station screen.";
  if (text.length <= EXCEPTION_DETAIL_MAX_LENGTH) return text;
  return `${text.slice(0, EXCEPTION_DETAIL_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The sentence the ? Help footer explains, or null when nothing is
 *  blocking. First blocker only — the spec shows one sentence. */
export function primaryBlockerSentence(action: NextAction): string | null {
  if (action.kind !== "BLOCKED") return null;
  return action.blockers[0]?.operatorSentence ?? null;
}

// ── chrome ────────────────────────────────────────────────────────────

export type OperatorPauseModel = {
  reasons: PauseReason[];
  defaultReason: string;
};

export function operatorPauseModel(stationKind: string): OperatorPauseModel {
  const reasons = getPauseReasonsForStation(stationKind);
  return { reasons, defaultReason: reasons[0]?.value ?? "other" };
}

/** Does this station+reason pause need a counter reading first? Wraps
 *  the blister-counter-snapshot rule so the component does not import it
 *  across the floor boundary. */
export function pauseNeedsCounterSnapshot(
  stationKind: string,
  reason: string,
): boolean {
  return stationRequiresBlisterCounterSnapshot(stationKind, reason);
}

export function pauseCounterSnapshotCopy(reason: string): {
  label: string;
  helper: string;
} {
  return {
    label: pauseCounterSnapshotFieldLabel(reason),
    helper: pauseCounterSnapshotHelperText(reason),
  };
}

/** "Change material" targets — today the rolls sub-page, and only at the
 *  station kinds that mount rolls. Empty list means the More sheet omits
 *  the entry rather than linking somewhere that will refuse. */
export function operatorMaterialLinks(
  token: string,
  stationKind: string,
): FloorSupervisorToolLink[] {
  return floorSupervisorToolsForStation(token, stationKind);
}

// ── small display helpers ─────────────────────────────────────────────

/** Progress as a 0-100 integer for the bar, or null when there is
 *  nothing honest to draw (no progress, or an expected of 0). */
export function progressPercent(progress: CurrentWork["progress"]): number | null {
  if (!progress || progress.expected <= 0) return null;
  const pct = Math.round((progress.done / progress.expected) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** The UP NEXT line: "1042 · Chocolate Brown", plus the honest wait when
 *  the bag is still upstream and an ETA exists. */
export function upNextSummary(bag: UpNextBag): string {
  const parts = [bag.bagLabel];
  if (bag.productName) parts.push(bag.productName);
  if (bag.readyState === "UPSTREAM_RUNNING") {
    parts.push(
      bag.etaMinutes != null ? `ready in ~${bag.etaMinutes} min` : "still upstream",
    );
  }
  return parts.join(" · ");
}

export type { CheckResult, FloorSupervisorToolLink, PauseReason };
