/** PRODUCTION-DATA-ENTRY-HARDENING-1 — conservative ready-for-floor checks.
 *
 * Pure evaluation only: no DB, no guessing missing lineage.
 * Receipt/tablet/PO context come from inventory_bags + receive joins.
 * Product is deferred to sealing (saveSealingProductAction); not required here.
 */

export const BAG_QR_PLACEHOLDER_PREFIX = "BAG-";

export type FloorReadinessLevel = "READY_FOR_FLOOR" | "BLOCKED" | "WARNING";

export type FloorReadinessCode =
  | "BLOCKED_MISSING_RECEIPT"
  | "BLOCKED_MISSING_TABLET"
  | "BLOCKED_MISSING_INVENTORY_BAG_LINK"
  | "BLOCKED_MISSING_QR_LINK"
  | "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT"
  | "BLOCKED_QR_NOT_RAW_BAG"
  | "BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED"
  | "BLOCKED_QR_RESERVATION_LOST"
  | "BLOCKED_QR_ALREADY_ACTIVE"
  | "WARNING_QR_IDLE_IN_PRODUCTION"
  | "WARNING_QR_IDLE_BAG_DEPLETED"
  | "WARNING_LEGACY_BAG"
  | "WARNING_PRODUCT_DEFERRED_TO_SEALING"
  | "WARNING_ALREADY_ASSIGNED_OR_ACTIVE"
  | "WARNING_INCOMPLETE_OPTIONAL_CONTEXT"
  | "WARNING_BAG_QR_PLACEHOLDER_ONLY";

export type FloorReadinessEvaluation = {
  level: FloorReadinessLevel;
  codes: FloorReadinessCode[];
  /** Short admin/receiving action — no internal IDs. */
  adminAction: string | null;
};

export type QrCardReadinessInput = {
  cardType: string;
  status: string;
  assignedWorkflowBagId: string | null | undefined;
  scanToken: string;
};

export type InventoryBagReadinessInput = {
  internalReceiptNumber: string | null;
  tabletTypeId: string | null;
  bagQrCode: string | null;
  /** False when small_box / receive chain is broken. */
  hasReceiveContext: boolean;
  receivePoId: string | null;
  qrCard: QrCardReadinessInput | null;
  /** inventory_bags.status. Distinguishes a genuine lost intake reservation
   *  (AVAILABLE bag + idle QR = re-reservable) from expected post-production
   *  history (IN_USE/EMPTIED bag whose QR was correctly released at
   *  finalize/deplete). Optional: when absent, treated as floor-eligible so
   *  existing callers keep the v1.19.2 "reservation lost" behavior. */
  bagStatus?: string | null;
};

export type WorkflowBagReadinessInput = {
  inventoryBagId: string | null;
  /** Legacy TT denorm — display fallback only, never makes bag ready. */
  legacyReceiptNumber: string | null;
  productId: string | null;
  inventoryBag: InventoryBagReadinessInput | null;
  qrCard: QrCardReadinessInput | null;
  isFinalized?: boolean;
};

export function isBagQrPlaceholder(bagQrCode: string | null | undefined): boolean {
  if (!bagQrCode) return false;
  return bagQrCode.trim().startsWith(BAG_QR_PLACEHOLDER_PREFIX);
}

function hasReceipt(internalReceiptNumber: string | null): boolean {
  return (
    internalReceiptNumber != null && internalReceiptNumber.trim().length > 0
  );
}

function buildResult(
  codes: FloorReadinessCode[],
  adminAction: string | null,
): FloorReadinessEvaluation {
  if (codes.length === 0) {
    return {
      level: "READY_FOR_FLOOR",
      codes: [],
      adminAction: null,
    };
  }
  const hasBlock = codes.some((c) => c.startsWith("BLOCKED_"));
  return {
    level: hasBlock ? "BLOCKED" : "WARNING",
    codes,
    adminAction,
  };
}

/** Evaluate a received inventory bag before floor production. */
export function evaluateInventoryBagReadiness(
  input: InventoryBagReadinessInput,
): FloorReadinessEvaluation {
  const codes: FloorReadinessCode[] = [];

  if (!input.hasReceiveContext) {
    codes.push("BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT");
  } else if (input.receivePoId == null) {
    codes.push("WARNING_INCOMPLETE_OPTIONAL_CONTEXT");
  }

  if (!hasReceipt(input.internalReceiptNumber)) {
    codes.push("BLOCKED_MISSING_RECEIPT");
  }

  if (!input.tabletTypeId) {
    codes.push("BLOCKED_MISSING_TABLET");
  }

  const qr = input.bagQrCode?.trim() ?? "";
  if (qr.length === 0) {
    codes.push("BLOCKED_MISSING_QR_LINK");
  } else if (isBagQrPlaceholder(qr)) {
    if (!input.qrCard || input.qrCard.cardType !== "RAW_BAG") {
      codes.push("WARNING_BAG_QR_PLACEHOLDER_ONLY");
      codes.push("BLOCKED_MISSING_QR_LINK");
    }
  }

  if (input.qrCard) {
    appendQrCardCodes(codes, input.qrCard, {
      forInventoryBag: true,
      bagStatus: input.bagStatus,
    });
  } else if (qr.length > 0 && !isBagQrPlaceholder(qr)) {
    codes.push("BLOCKED_MISSING_QR_LINK");
  }

  return buildResult(codes, adminActionForCodes(codes));
}

/** True when the bag is (or is treated as) floor-eligible — an idle QR here is a
 *  genuine lost intake reservation. Non-AVAILABLE bags (IN_USE/EMPTIED/…) whose
 *  QR is idle are expected post-production history, not a lost reservation. */
function isFloorEligibleBagStatus(bagStatus: string | null | undefined): boolean {
  return bagStatus == null || bagStatus === "AVAILABLE";
}

function isDepletedBagStatus(bagStatus: string | null | undefined): boolean {
  return bagStatus === "EMPTIED" || bagStatus === "DEPLETED";
}

/** Preview readiness for a not-yet-saved intake row (Receive pills form). */
export type RawBagIntakeDraftReadinessInput = {
  receiptNumber: string;
  tabletTypeId: string | null;
  bagQrCode: string | null;
  hasReceiveContext: boolean;
  receivePoId: string | null;
};

/** Same rules as saved bags; treats a entered physical QR as reserved on save. */
export function evaluateRawBagIntakeDraftReadiness(
  input: RawBagIntakeDraftReadinessInput,
): FloorReadinessEvaluation {
  const qr = input.bagQrCode?.trim() ?? "";
  const qrCard: QrCardReadinessInput | null =
    qr.length > 0 && !isBagQrPlaceholder(qr)
      ? {
          cardType: "RAW_BAG",
          status: "ASSIGNED",
          assignedWorkflowBagId: null,
          scanToken: qr,
        }
      : null;

  return evaluateInventoryBagReadiness({
    internalReceiptNumber: input.receiptNumber.trim() || null,
    tabletTypeId: input.tabletTypeId,
    bagQrCode: qr || null,
    hasReceiveContext: input.hasReceiveContext,
    receivePoId: input.receivePoId,
    qrCard,
  });
}

/** Evaluate a floor QR card before fresh-bag scan. */
export function evaluateQrCardReadiness(
  input: QrCardReadinessInput & {
    inventoryBag: InventoryBagReadinessInput | null;
    /** Ready partial restart — stale ASSIGNED/IDLE card state must not block. */
    allowPartialBagRestart?: boolean;
  },
): FloorReadinessEvaluation {
  const codes: FloorReadinessCode[] = [];

  if (input.cardType !== "RAW_BAG") {
    codes.push("BLOCKED_QR_NOT_RAW_BAG");
    return buildResult(codes, adminActionForCodes(codes));
  }

  appendQrCardCodes(codes, input, {
    forInventoryBag: false,
    ...(input.allowPartialBagRestart
      ? { allowPartialBagRestart: true }
      : {}),
  });

  if (!input.inventoryBag) {
    codes.push("BLOCKED_MISSING_INVENTORY_BAG_LINK");
    return buildResult(codes, adminActionForCodes(codes));
  }

  const bagEval = evaluateInventoryBagReadiness(input.inventoryBag);
  for (const code of bagEval.codes) {
    if (!codes.includes(code)) codes.push(code);
  }

  return buildResult(codes, adminActionForCodes(codes));
}

/** Evaluate an existing workflow bag (e.g. display only). */
export function evaluateWorkflowBagReadiness(
  input: WorkflowBagReadinessInput,
): FloorReadinessEvaluation {
  const codes: FloorReadinessCode[] = [];

  if (!input.inventoryBagId || !input.inventoryBag) {
    codes.push("BLOCKED_MISSING_INVENTORY_BAG_LINK");
    if (
      input.legacyReceiptNumber &&
      input.legacyReceiptNumber.trim().length > 0
    ) {
      codes.push("WARNING_LEGACY_BAG");
    }
  } else {
    const bagEval = evaluateInventoryBagReadiness({
      ...input.inventoryBag,
      qrCard: input.qrCard ?? input.inventoryBag.qrCard,
    });
    for (const code of bagEval.codes) {
      if (!codes.includes(code)) codes.push(code);
    }
  }

  if (!input.productId) {
    codes.push("WARNING_PRODUCT_DEFERRED_TO_SEALING");
  }

  if (
    input.qrCard?.assignedWorkflowBagId &&
    !input.isFinalized
  ) {
    if (!codes.includes("BLOCKED_QR_ALREADY_ACTIVE")) {
      codes.push("WARNING_ALREADY_ASSIGNED_OR_ACTIVE");
    }
  }

  return buildResult(codes, adminActionForCodes(codes));
}

function appendQrCardCodes(
  codes: FloorReadinessCode[],
  card: QrCardReadinessInput,
  opts: {
    forInventoryBag: boolean;
    allowPartialBagRestart?: boolean;
    bagStatus?: string | null | undefined;
  },
): void {
  if (card.cardType !== "RAW_BAG") {
    if (!codes.includes("BLOCKED_QR_NOT_RAW_BAG")) {
      codes.push("BLOCKED_QR_NOT_RAW_BAG");
    }
    return;
  }

  if (card.status === "IDLE") {
    if (!opts.allowPartialBagRestart) {
      if (opts.forInventoryBag) {
        // The bag's bag_qr_code points at THIS RAW_BAG card, but the card is
        // IDLE. What that means depends on the bag's own status:
        //   - AVAILABLE (floor-eligible): a genuine LOST intake reservation —
        //     re-reservable (v1.19.2).
        //   - EMPTIED/DEPLETED: the bag is spent; its QR was correctly released
        //     — no floor reservation is needed. Informational only.
        //   - IN_USE (or other): the bag already went through production and its
        //     QR was correctly released at finalize; re-reserving as intake is
        //     WRONG. Flag for production-side review, not re-reservation.
        if (isFloorEligibleBagStatus(opts.bagStatus)) {
          if (!codes.includes("BLOCKED_QR_RESERVATION_LOST")) {
            codes.push("BLOCKED_QR_RESERVATION_LOST");
          }
        } else if (isDepletedBagStatus(opts.bagStatus)) {
          if (!codes.includes("WARNING_QR_IDLE_BAG_DEPLETED")) {
            codes.push("WARNING_QR_IDLE_BAG_DEPLETED");
          }
        } else if (!codes.includes("WARNING_QR_IDLE_IN_PRODUCTION")) {
          codes.push("WARNING_QR_IDLE_IN_PRODUCTION");
        }
      } else if (!codes.includes("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED")) {
        codes.push("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
      }
    }
    return;
  }

  if (card.status !== "ASSIGNED") {
    if (!codes.includes("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED")) {
      codes.push("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
    }
    return;
  }

  if (card.assignedWorkflowBagId) {
    if (opts.allowPartialBagRestart) {
      return;
    }
    if (opts.forInventoryBag) {
      if (!codes.includes("WARNING_ALREADY_ASSIGNED_OR_ACTIVE")) {
        codes.push("WARNING_ALREADY_ASSIGNED_OR_ACTIVE");
      }
    } else {
      if (!codes.includes("BLOCKED_QR_ALREADY_ACTIVE")) {
        codes.push("BLOCKED_QR_ALREADY_ACTIVE");
      }
    }
  }
}

function adminActionForCodes(codes: FloorReadinessCode[]): string | null {
  if (codes.length === 0) return null;
  const priority: FloorReadinessCode[] = [
    "BLOCKED_MISSING_INVENTORY_BAG_LINK",
    "BLOCKED_MISSING_QR_LINK",
    "BLOCKED_QR_RESERVATION_LOST",
    "BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED",
    "BLOCKED_QR_NOT_RAW_BAG",
    "BLOCKED_QR_ALREADY_ACTIVE",
    "BLOCKED_MISSING_RECEIPT",
    "BLOCKED_MISSING_TABLET",
    "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT",
    "WARNING_BAG_QR_PLACEHOLDER_ONLY",
    "WARNING_LEGACY_BAG",
    "WARNING_INCOMPLETE_OPTIONAL_CONTEXT",
  ];
  const primary =
    priority.find((c) => codes.includes(c)) ?? codes[0] ?? null;
  if (!primary) return null;

  switch (primary) {
    case "BLOCKED_MISSING_RECEIPT":
      return "Add or correct the receipt number on the inventory bag at receiving.";
    case "BLOCKED_MISSING_TABLET":
      return "Assign the correct tablet type on the inventory bag.";
    case "BLOCKED_MISSING_INVENTORY_BAG_LINK":
      return "Link this QR card to a received inventory bag before floor start.";
    case "BLOCKED_MISSING_QR_LINK":
      return "Assign a physical RAW_BAG QR card to this bag at receiving (not a BAG- placeholder only).";
    case "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT":
      return "Complete receive/PO linkage for this bag in inbound receiving.";
    case "BLOCKED_QR_NOT_RAW_BAG":
      return "Use a RAW_BAG floor card, not a variety or other card type.";
    case "BLOCKED_QR_RESERVATION_LOST":
      return "This QR is on the bag but its card is idle (reservation lost) — re-reserve it here.";
    case "WARNING_QR_IDLE_IN_PRODUCTION":
      return "Bag is in production and its QR is idle — production QR state needs review (do not re-reserve as intake).";
    case "WARNING_QR_IDLE_BAG_DEPLETED":
      return "Bag is depleted/emptied — its QR was released and no floor reservation is needed.";
    case "BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED":
      return "Receive and reserve this QR on the Receive Pills page before scanning at the floor.";
    case "BLOCKED_QR_ALREADY_ACTIVE":
      return "This QR is already in an active production run. Do not start again.";
    case "WARNING_BAG_QR_PLACEHOLDER_ONLY":
      return "Replace the system BAG- placeholder with a physical QR card assignment.";
    case "WARNING_LEGACY_BAG":
      return "Legacy bag — PM/supervisor repair only; do not start new floor production.";
    case "WARNING_INCOMPLETE_OPTIONAL_CONTEXT":
      return "Link a verified PO to the receive, or confirm manual PO reference is intentional.";
    case "WARNING_PRODUCT_DEFERRED_TO_SEALING":
      return null;
    case "WARNING_ALREADY_ASSIGNED_OR_ACTIVE":
      return "QR is reserved or active — confirm bag state before starting.";
    default:
      return "Complete receiving data entry before floor start.";
  }
}

/** Operator-safe floor message when fresh-bag start is blocked. */
export function floorReadinessOperatorMessage(
  evaluation: FloorReadinessEvaluation,
): string {
  if (evaluation.level === "READY_FOR_FLOOR") return "";

  const detail = operatorDetailForCodes(evaluation.codes);
  return `This bag is not ready for the floor. ${detail} Ask receiving or admin to fix it before scanning.`;
}

function operatorDetailForCodes(codes: FloorReadinessCode[]): string {
  if (codes.includes("BLOCKED_MISSING_RECEIPT")) {
    return "Missing receipt number.";
  }
  if (codes.includes("BLOCKED_MISSING_TABLET")) {
    return "Missing tablet type.";
  }
  if (
    codes.includes("BLOCKED_MISSING_QR_LINK") ||
    codes.includes("WARNING_BAG_QR_PLACEHOLDER_ONLY")
  ) {
    return "Missing physical QR link to this received bag.";
  }
  if (codes.includes("BLOCKED_MISSING_INVENTORY_BAG_LINK")) {
    return "This QR is not linked to a received bag.";
  }
  if (codes.includes("BLOCKED_QR_RESERVATION_LOST")) {
    return "This QR is on the bag but idle (reservation lost) — ask admin to re-reserve it.";
  }
  if (codes.includes("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED")) {
    return "This QR has not been received and reserved yet.";
  }
  if (codes.includes("BLOCKED_QR_NOT_RAW_BAG")) {
    return "This is not a raw-bag floor card.";
  }
  if (codes.includes("BLOCKED_QR_ALREADY_ACTIVE")) {
    return "This bag is already in production.";
  }
  if (codes.includes("BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT")) {
    return "Missing receive or PO context.";
  }
  if (codes.includes("WARNING_LEGACY_BAG")) {
    return "Legacy bag missing received-bag context.";
  }
  return "Missing required receiving information.";
}

export function floorReadinessLabel(
  evaluation: FloorReadinessEvaluation,
): string {
  if (evaluation.level === "READY_FOR_FLOOR") return "Ready for floor";
  if (evaluation.level === "BLOCKED") return "Not ready for floor";
  return "Review before floor";
}

/** Receiving/admin copy — Blocked / Warning instead of longer labels. */
export function floorReadinessAdminLabel(
  evaluation: FloorReadinessEvaluation,
): string {
  if (evaluation.level === "READY_FOR_FLOOR") return "Ready for floor";
  if (evaluation.level === "BLOCKED") return "Blocked";
  return "Warning";
}

export type FloorReadinessDetailLines = {
  readyDetail: string | null;
  blocked: string[];
  warnings: string[];
};

/** Human-language checklist lines for admin tables (no internal codes). */
export function floorReadinessDetailLines(
  evaluation: FloorReadinessEvaluation,
  maxEach = 3,
): FloorReadinessDetailLines {
  if (evaluation.level === "READY_FOR_FLOOR") {
    return {
      readyDetail:
        "Receipt, tablet type, and physical QR are linked for floor start.",
      blocked: [],
      warnings: [],
    };
  }
  const blocked: string[] = [];
  const warnings: string[] = [];
  for (const code of evaluation.codes) {
    const line = readinessReasonLineForCode(code);
    if (!line) continue;
    if (code.startsWith("BLOCKED_")) {
      if (blocked.length < maxEach && !blocked.includes(line)) {
        blocked.push(line);
      }
    } else if (code.startsWith("WARNING_")) {
      if (warnings.length < maxEach && !warnings.includes(line)) {
        warnings.push(line);
      }
    }
  }
  return { readyDetail: null, blocked, warnings };
}

function readinessReasonLineForCode(code: FloorReadinessCode): string | null {
  switch (code) {
    case "BLOCKED_MISSING_RECEIPT":
      return "Missing receipt number";
    case "BLOCKED_MISSING_TABLET":
      return "Missing tablet type";
    case "BLOCKED_MISSING_QR_LINK":
      return "Missing physical QR card on this bag";
    case "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT":
      return "Missing receive or PO context";
    case "BLOCKED_MISSING_INVENTORY_BAG_LINK":
      return "QR not linked to a received bag";
    case "BLOCKED_QR_NOT_RAW_BAG":
      return "Not a raw-bag floor card";
    case "BLOCKED_QR_RESERVATION_LOST":
      return "QR set on this bag but idle (reservation lost) — re-reserve";
    case "WARNING_QR_IDLE_IN_PRODUCTION":
      return "In production, QR idle — production QR state needs review";
    case "WARNING_QR_IDLE_BAG_DEPLETED":
      return "Depleted/emptied — no floor reservation needed";
    case "BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED":
      return "QR not reserved for this receive yet";
    case "BLOCKED_QR_ALREADY_ACTIVE":
      return "QR already in an active production run";
    case "WARNING_BAG_QR_PLACEHOLDER_ONLY":
      return "System BAG- placeholder only — assign a physical QR";
    case "WARNING_LEGACY_BAG":
      return "Legacy bag — supervisor repair only";
    case "WARNING_PRODUCT_DEFERRED_TO_SEALING":
      return "Finished product chosen at sealing (expected)";
    case "WARNING_ALREADY_ASSIGNED_OR_ACTIVE":
      return "QR reserved or already active — confirm bag state";
    case "WARNING_INCOMPLETE_OPTIONAL_CONTEXT":
      return "Receive has no linked PO (manual reference)";
    default:
      return null;
  }
}

export function floorReadinessBadgeClass(
  evaluation: FloorReadinessEvaluation,
): string {
  if (evaluation.level === "READY_FOR_FLOOR") {
    return "bg-good-50/80 text-good-800 border-good-200";
  }
  if (evaluation.level === "BLOCKED") {
    return "bg-red-50 text-red-800 border-red-200";
  }
  return "bg-warn-50/80 text-warn-800 border-warn-200";
}
