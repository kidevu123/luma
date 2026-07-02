// SPLIT-BAG-1 — system-derived allocation closeout from production output.
//
// A physical raw bag can be split across products: Product 1 draws some
// tablets, then the same bag is reused for Product 2. Product 1's allocation
// session stays OPEN, which blocks Product 2's start. When Luma already has
// enough production output counts for Product 1, it can DERIVE the consumed and
// remaining tablet counts instead of forcing a manual count / weigh-back:
//
//   system_consumed  = output_units * tablets_per_unit
//   system_remaining = starting_tablet_count - system_consumed
//
// This is an HONEST estimate derived from production output — NOT a physical
// count. It is labelled `SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT` everywhere it is
// stored/shown, and it never overrides an operator/physical/weigh-back count.
//
// The math is deliberately CONSERVATIVE and fails closed: it only produces a
// result when every input is unambiguous and the remaining is >= 0. Any doubt
// returns an explicit, operator-facing reason so the caller can direct the user
// to the right manual tool instead of a dead-end error.

/** The production stage whose output count was used to derive consumption.
 *  Deeper stages are preferred (a tablet that reached packaging definitely came
 *  out of the bag). */
export type SystemDerivedOutputStage = "FINISHED" | "PACKAGING" | "SEALING";

export type SystemDerivedBlockReason =
  | "SESSION_NOT_OPEN"
  | "MULTIPLE_OPEN_SESSIONS"
  | "STARTING_COUNT_UNKNOWN"
  | "MISSING_OUTPUT_COUNTS"
  | "MISSING_TABLETS_PER_UNIT"
  | "NEGATIVE_REMAINING";

export type SystemDerivedInput = {
  /** allocation_status of the session being resolved — must be OPEN. */
  sessionStatus: string;
  /** How many OPEN sessions exist on this physical bag — must be exactly 1. */
  openSessionCount: number;
  /** Starting tablet balance of the session (or bag). */
  startingBalanceQty: number | null;
  /** Tablets per finished unit for the prior run's product (null/0 for variety). */
  tabletsPerUnit: number | null;
  /** Deepest available production output unit count for the prior run. */
  outputUnits: number | null;
  /** Which stage that count came from (for the audit trail + display). */
  outputStage: SystemDerivedOutputStage | null;
};

export type SystemDerivedResult =
  | {
      eligible: true;
      startingTabletCount: number;
      derivedConsumedTablets: number;
      derivedRemainingTablets: number;
      outputStage: SystemDerivedOutputStage;
      outputUnits: number;
      tabletsPerUnit: number;
    }
  | { eligible: false; reason: SystemDerivedBlockReason; message: string };

/** Pick the deepest recorded output count. A tablet that reached a downstream
 *  stage certainly left the bag, so deeper stages give the most defensible
 *  "produced" figure. Returns null when nothing usable was recorded. */
export function pickDeepestOutput(stage: {
  finishedOutput: number | null;
  packagedOutput: number | null;
  sealedOutput: number | null;
}): { units: number; stage: SystemDerivedOutputStage } | null {
  if (stage.finishedOutput != null && stage.finishedOutput > 0) {
    return { units: stage.finishedOutput, stage: "FINISHED" };
  }
  if (stage.packagedOutput != null && stage.packagedOutput > 0) {
    return { units: stage.packagedOutput, stage: "PACKAGING" };
  }
  if (stage.sealedOutput != null && stage.sealedOutput > 0) {
    return { units: stage.sealedOutput, stage: "SEALING" };
  }
  return null;
}

/** Pure, conservative derivation. Fails closed with an explicit reason. */
export function deriveSystemRemainingFromOutput(
  input: SystemDerivedInput,
): SystemDerivedResult {
  if (input.sessionStatus !== "OPEN") {
    return {
      eligible: false,
      reason: "SESSION_NOT_OPEN",
      message: `The prior allocation is already ${input.sessionStatus.toLowerCase()} — there is nothing to resolve.`,
    };
  }
  if (input.openSessionCount > 1) {
    return {
      eligible: false,
      reason: "MULTIPLE_OPEN_SESSIONS",
      message:
        "This bag has more than one open allocation session — resolve them individually in the Partial Bag Workbench.",
    };
  }
  if (
    input.startingBalanceQty == null ||
    !Number.isFinite(input.startingBalanceQty) ||
    input.startingBalanceQty <= 0
  ) {
    return {
      eligible: false,
      reason: "STARTING_COUNT_UNKNOWN",
      message:
        "The bag's starting tablet count is unknown — record a physical or weigh-back count to resolve.",
    };
  }
  if (
    input.outputUnits == null ||
    input.outputStage == null ||
    !Number.isFinite(input.outputUnits) ||
    input.outputUnits <= 0
  ) {
    return {
      eligible: false,
      reason: "MISSING_OUTPUT_COUNTS",
      message:
        "No production output counts were recorded for the prior run — there is nothing to derive consumption from. Record a manual count instead.",
    };
  }
  if (
    input.tabletsPerUnit == null ||
    !Number.isFinite(input.tabletsPerUnit) ||
    input.tabletsPerUnit <= 0
  ) {
    return {
      eligible: false,
      reason: "MISSING_TABLETS_PER_UNIT",
      message:
        "This product has no tablets-per-unit configured (e.g. a variety pack), so output can't be converted to tablets. Record a manual count instead.",
    };
  }

  const derivedConsumedTablets = Math.round(
    input.outputUnits * input.tabletsPerUnit,
  );
  const derivedRemainingTablets =
    input.startingBalanceQty - derivedConsumedTablets;
  if (derivedRemainingTablets < 0) {
    return {
      eligible: false,
      reason: "NEGATIVE_REMAINING",
      message: `Calculated consumption (${derivedConsumedTablets.toLocaleString()} tablets) exceeds the starting count (${input.startingBalanceQty.toLocaleString()}). Review the counts before resolving.`,
    };
  }

  return {
    eligible: true,
    startingTabletCount: input.startingBalanceQty,
    derivedConsumedTablets,
    derivedRemainingTablets,
    outputStage: input.outputStage,
    outputUnits: input.outputUnits,
    tabletsPerUnit: input.tabletsPerUnit,
  };
}

/** Canonical source label written to the session, ledger event, and audit so
 *  a system-derived remaining is never mistaken for a physical count. */
export const SYSTEM_DERIVED_SOURCE = "SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT";

/** Human-readable label for the stage used, for admin/floor display. */
export function labelSystemDerivedStage(
  stage: SystemDerivedOutputStage,
): string {
  switch (stage) {
    case "FINISHED":
      return "finished-lot output";
    case "PACKAGING":
      return "packaging output";
    case "SEALING":
      return "sealing output";
  }
}
