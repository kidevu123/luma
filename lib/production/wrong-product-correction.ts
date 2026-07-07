// ADMIN-CORRECTION-WIZARD-1 — pure evaluator + preview builder for the
// wrong-product correction flow. A wrong-product correction remaps a
// workflow bag (and its derived output) to the product staff SHOULD have
// selected, without touching station history. This module holds all the
// safety math; the transactional apply lives in
// wrong-product-correction-service.ts.
//
// Fail closed: anything ambiguous or unsafe is a blocker with an exact
// recommendation, never a silent pass.

export const WRONG_PRODUCT_CORRECTION_SOURCE =
  "ADMIN_WRONG_PRODUCT_CORRECTION" as const;

export type WrongProductCorrectionBlocker = {
  code: string;
  message: string;
  recommendation: string;
};

export type WrongProductCorrectionWarning = {
  code: string;
  message: string;
};

export type CorrectionProductFacts = {
  id: string;
  sku: string;
  name: string;
  /** products.kind — CARD | BOTTLE | VARIETY. Kind IS the route family. */
  kind: string;
  tabletsPerUnit: number | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
  isActive: boolean;
  /** Whether product_allowed_tablets permits the bag's tablet type. */
  allowsBagTabletType: boolean;
};

export type WrongProductCorrectionCounts = {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  bottlesCompleted: number;
};

export type CorrectionAllocationSession = {
  /** raw_bag_allocation_sessions.allocation_status (OPEN/CLOSED/…/VOIDED). */
  status: string;
  startingBalanceQty: number | null;
};

export type WrongProductCorrectionArgs = {
  oldProduct: CorrectionProductFacts | null;
  newProduct: CorrectionProductFacts | null;
  isFinalized: boolean;
  /** read_bag_state.excluded_from_output || recovery_status set. */
  alreadyQuarantined: boolean;
  zohoOutputCommitted: boolean;
  /** finished_lots.status when a lot exists for this workflow bag. */
  lotStatus: string | null;
  /** Non-voided allocation sessions linked to this workflow bag. */
  allocationSessions: CorrectionAllocationSession[];
  /** Packaging counts; null when the bag has no packaging submission yet. */
  counts: WrongProductCorrectionCounts | null;
};

export type WrongProductCorrectionVerdict = {
  allowed: boolean;
  blockers: WrongProductCorrectionBlocker[];
  warnings: WrongProductCorrectionWarning[];
};

/** Same formula as computeUnitsYieldedFromPackagingCounts (bag metrics),
 *  but strict: case/display counts with missing packaging structure are a
 *  hard null (blocker), never a silent loose-only fallback. */
export function computeUnitsUnderProduct(
  counts: WrongProductCorrectionCounts,
  product: Pick<CorrectionProductFacts, "unitsPerDisplay" | "displaysPerCase">,
): number | null {
  const needsStructure = counts.masterCases > 0 || counts.displaysMade > 0;
  if (needsStructure) {
    if (!product.unitsPerDisplay || !product.displaysPerCase) return null;
    return (
      counts.masterCases * product.unitsPerDisplay * product.displaysPerCase +
      counts.displaysMade * product.unitsPerDisplay +
      counts.looseCards +
      counts.bottlesCompleted
    );
  }
  return counts.looseCards + counts.bottlesCompleted;
}

export function computeExpectedConsumption(
  units: number | null,
  tabletsPerUnit: number | null,
): number | null {
  if (units == null || tabletsPerUnit == null) return null;
  return units * tabletsPerUnit;
}

const TERMINAL_ALLOCATION_STATUSES = new Set([
  "CLOSED",
  "RETURNED_TO_STOCK",
  "DEPLETED",
]);

export function evaluateWrongProductCorrection(
  args: WrongProductCorrectionArgs,
): WrongProductCorrectionVerdict {
  const blockers: WrongProductCorrectionBlocker[] = [];
  const warnings: WrongProductCorrectionWarning[] = [];
  const block = (code: string, message: string, recommendation: string) =>
    blockers.push({ code, message, recommendation });

  const { oldProduct, newProduct } = args;

  if (!newProduct) {
    block(
      "PRODUCT_NOT_FOUND",
      "The selected correct product could not be loaded.",
      "Pick a product from the candidate list.",
    );
  }

  if (args.alreadyQuarantined) {
    block(
      "ALREADY_QUARANTINED",
      "This workflow was already recovered/quarantined and is excluded from output.",
      "Recovered workflows cannot be product-remapped. Start the correct workflow instead.",
    );
  }

  if (args.zohoOutputCommitted) {
    block(
      "ZOHO_COMMITTED",
      "A Zoho production output for this workflow is already COMMITTED.",
      "Committed output cannot be corrected here. Resolve in Zoho (manual adjustment / RMA), then review.",
    );
  }

  if (args.lotStatus === "SHIPPED" || args.lotStatus === "RECALLED") {
    block(
      "LOT_SHIPPED_OR_RECALLED",
      `The finished lot for this workflow is ${args.lotStatus}.`,
      "Shipped/recalled lots are immutable. Handle through recall/RMA workflows.",
    );
  }

  if (newProduct) {
    if (oldProduct && newProduct.id === oldProduct.id) {
      block(
        "SAME_PRODUCT",
        "The selected product is the same as the current product.",
        "Pick the product staff should have selected.",
      );
    }
    if (!newProduct.isActive) {
      block(
        "PRODUCT_INACTIVE",
        `${newProduct.name} is inactive.`,
        "Reactivate the product in master data first, or pick an active product.",
      );
    }
    const oldKind = oldProduct?.kind ?? null;
    if (
      newProduct.kind === "VARIETY" ||
      oldKind === "VARIETY" ||
      (oldKind != null && newProduct.kind !== oldKind)
    ) {
      block(
        "ROUTE_INCOMPATIBLE",
        `Routes differ: current run is ${oldKind ?? "unknown"}, corrected product is ${newProduct.kind}.`,
        "A product on a different route cannot reuse this run's output. Use the wrong-route correction (quarantine + start correct workflow).",
      );
    }
    if (!newProduct.allowsBagTabletType) {
      block(
        "TABLET_NOT_ALLOWED",
        `${newProduct.name} does not allow this bag's tablet type.`,
        "Fix the product's allowed tablets in master data if this pairing is correct, then retry.",
      );
    }
    if (newProduct.tabletsPerUnit == null) {
      block(
        "PRODUCT_SETUP_INCOMPLETE",
        `${newProduct.name} has no tablets-per-unit configured.`,
        "Complete product setup (tablets per unit) before correcting to it.",
      );
    }
    if (args.counts) {
      const newUnits = computeUnitsUnderProduct(args.counts, newProduct);
      if (newUnits == null) {
        block(
          "PRODUCT_SETUP_INCOMPLETE",
          `${newProduct.name} is missing packaging structure (units per display / displays per case) needed to reinterpret the submitted counts.`,
          "Complete product setup (packaging structure) before correcting to it.",
        );
      }
    }
    if (newProduct.defaultShelfLifeDays == null) {
      warnings.push({
        code: "MISSING_SHELF_LIFE",
        message: `${newProduct.name} has no default shelf life — a future auto-issued finished lot will block on product setup until it is configured.`,
      });
    }
  }

  // Allocation session state must be unambiguous before consumption math
  // can be rewritten.
  const sessions = args.allocationSessions;
  if (sessions.length > 1) {
    block(
      "ALLOCATION_AMBIGUOUS",
      "This workflow has more than one allocation session — consumption cannot be recalculated safely.",
      "Resolve the allocation sessions on the partial-bags page first.",
    );
  }
  const session = sessions.length === 1 ? sessions[0] : null;
  if (session && session.status === "OPEN") {
    block(
      "ALLOCATION_OPEN",
      "This workflow's allocation session is still OPEN.",
      "Close or deplete the allocation session (production output close-out) before correcting the product.",
    );
  }
  if (session && !TERMINAL_ALLOCATION_STATUSES.has(session.status) && session.status !== "OPEN") {
    block(
      "ALLOCATION_AMBIGUOUS",
      `Allocation session status ${session.status} is not a recognized terminal state.`,
      "Review the allocation session manually before correcting.",
    );
  }
  if (
    session &&
    TERMINAL_ALLOCATION_STATUSES.has(session.status) &&
    session.startingBalanceQty != null &&
    args.counts &&
    newProduct
  ) {
    const newUnits = computeUnitsUnderProduct(args.counts, newProduct);
    const newConsumed = computeExpectedConsumption(
      newUnits,
      newProduct.tabletsPerUnit,
    );
    if (newConsumed != null && newConsumed > session.startingBalanceQty) {
      block(
        "NEGATIVE_REMAINING",
        `Corrected consumption (${newConsumed} tablets) exceeds the session starting balance (${session.startingBalanceQty}).`,
        "Correct the starting balance / allocation first, or verify the intended product — this pairing is physically impossible.",
      );
    }
  }

  if (
    args.lotStatus === "RELEASED" ||
    args.lotStatus === "PENDING_QC" ||
    args.lotStatus === "ON_HOLD"
  ) {
    warnings.push({
      code: "LOT_WILL_HOLD",
      message:
        "The existing finished lot will be rebuilt under the corrected product and placed ON_HOLD — it must be re-reviewed and re-released.",
    });
    warnings.push({
      code: "ZOHO_OP_WILL_VOID",
      message:
        "Any uncommitted Zoho production output op will be voided — a fresh preview/queue is required after correction.",
    });
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

export type WrongProductAllocationImpact = {
  sessionStatus: string;
  startingBalanceQty: number | null;
  oldConsumed: number | null;
  newConsumed: number | null;
  oldEnding: number | null;
  newEnding: number | null;
};

export type WrongProductCorrectionPreview = {
  oldProductId: string | null;
  oldProductName: string | null;
  newProductId: string | null;
  newProductName: string | null;
  oldRoute: string | null;
  newRoute: string | null;
  counts: WrongProductCorrectionCounts | null;
  oldUnits: number | null;
  newUnits: number | null;
  oldExpectedConsumption: number | null;
  newExpectedConsumption: number | null;
  allocationImpact: WrongProductAllocationImpact | null;
  finishedLotImpact:
    | "NONE"
    | "UPDATE_AND_HOLD"
    | "BLOCKED_COMMITTED"
    | "BLOCKED_SHIPPED_OR_RECALLED";
  zohoImpact: "NONE" | "VOID_UNCOMMITTED_REBUILD" | "BLOCKED_COMMITTED";
  poCloseoutImpact: string;
};

export function buildWrongProductCorrectionPreview(
  args: WrongProductCorrectionArgs & { hasUncommittedZohoOp: boolean },
): WrongProductCorrectionPreview {
  const { oldProduct, newProduct, counts } = args;
  const oldUnits =
    counts && oldProduct ? computeUnitsUnderProduct(counts, oldProduct) : null;
  const newUnits =
    counts && newProduct ? computeUnitsUnderProduct(counts, newProduct) : null;
  const oldConsumed = computeExpectedConsumption(
    oldUnits,
    oldProduct?.tabletsPerUnit ?? null,
  );
  const newConsumed = computeExpectedConsumption(
    newUnits,
    newProduct?.tabletsPerUnit ?? null,
  );

  const session =
    args.allocationSessions.length === 1 ? args.allocationSessions[0] : null;
  const allocationImpact: WrongProductAllocationImpact | null = session
    ? {
        sessionStatus: session.status,
        startingBalanceQty: session.startingBalanceQty,
        oldConsumed,
        newConsumed,
        oldEnding:
          session.startingBalanceQty != null && oldConsumed != null
            ? session.startingBalanceQty - oldConsumed
            : null,
        newEnding:
          session.startingBalanceQty != null && newConsumed != null
            ? session.startingBalanceQty - newConsumed
            : null,
      }
    : null;

  let finishedLotImpact: WrongProductCorrectionPreview["finishedLotImpact"] =
    "NONE";
  if (args.lotStatus != null) {
    if (args.zohoOutputCommitted) {
      finishedLotImpact = "BLOCKED_COMMITTED";
    } else if (args.lotStatus === "SHIPPED" || args.lotStatus === "RECALLED") {
      finishedLotImpact = "BLOCKED_SHIPPED_OR_RECALLED";
    } else {
      finishedLotImpact = "UPDATE_AND_HOLD";
    }
  }

  let zohoImpact: WrongProductCorrectionPreview["zohoImpact"] = "NONE";
  if (args.zohoOutputCommitted) {
    zohoImpact = "BLOCKED_COMMITTED";
  } else if (args.hasUncommittedZohoOp) {
    zohoImpact = "VOID_UNCOMMITTED_REBUILD";
  }

  const poCloseoutImpact =
    finishedLotImpact === "UPDATE_AND_HOLD"
      ? "PO Closeout row moves to QC review (lot on hold) — release and queue Zoho under the corrected product to finish."
      : finishedLotImpact === "NONE"
        ? "PO Closeout continues normally — auto-issue / release / Zoho queue will use the corrected product."
        : "PO Closeout row stays blocked until the committed/shipped output is resolved externally.";

  return {
    oldProductId: oldProduct?.id ?? null,
    oldProductName: oldProduct?.name ?? null,
    newProductId: newProduct?.id ?? null,
    newProductName: newProduct?.name ?? null,
    oldRoute: oldProduct?.kind ?? null,
    newRoute: newProduct?.kind ?? null,
    counts,
    oldUnits,
    newUnits,
    oldExpectedConsumption: oldConsumed,
    newExpectedConsumption: newConsumed,
    allocationImpact,
    finishedLotImpact,
    zohoImpact,
    poCloseoutImpact,
  };
}
