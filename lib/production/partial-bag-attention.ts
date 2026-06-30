// P2-PARTIAL-KEEP — "needs review" signal for held partial bottle bags.
//
// Goal: help admins spot the small number of held partials that are in a
// confusing/ambiguous state, WITHOUT alarming the many healthy ones. A healthy
// held partial (QR held, a known system remaining > 0, no big operator/system
// disagreement) returns needsReview=false.

export type PartialBagAttention = {
  needsReview: boolean;
  /** Operator-facing reason, present only when needsReview is true. */
  reason: string | null;
};

const OK: PartialBagAttention = { needsReview: false, reason: null };

// Material-disagreement thresholds (both must be exceeded to flag), chosen so
// rounding / small weigh-back differences never trip the signal.
const DISAGREEMENT_MIN_ABS = 100; // tablets
const DISAGREEMENT_MIN_FRACTION = 0.25; // 25% of the system figure

/** Decide whether a held partial bag needs admin review.
 *  - Not a held partial → never flagged.
 *  - Held but the system remaining is unknown (null) → review (confirm the
 *    physical count before reuse; this is the no-clean-allocation-session case).
 *  - Operator estimate disagrees materially with the system remaining → review.
 *  - Otherwise healthy → no flag. */
export function derivePartialBagAttention(args: {
  isHeldPartial: boolean;
  systemRemainingQty: number | null;
  operatorRemainingEstimate: number | null;
}): PartialBagAttention {
  if (!args.isHeldPartial) return OK;

  if (args.systemRemainingQty == null) {
    return {
      needsReview: true,
      reason: "Remaining unconfirmed — verify the physical bag before reuse.",
    };
  }

  const sys = args.systemRemainingQty;
  const op = args.operatorRemainingEstimate;
  if (op != null) {
    const diff = Math.abs(op - sys);
    if (diff >= DISAGREEMENT_MIN_ABS && diff >= sys * DISAGREEMENT_MIN_FRACTION) {
      return {
        needsReview: true,
        reason: "Operator estimate differs from system remaining — review.",
      };
    }
  }

  return OK;
}
