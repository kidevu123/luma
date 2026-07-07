// PO-CLOSEOUT-COMMAND-CENTER-1 — pure classifier tests.

import { describe, it, expect } from "vitest";
import {
  classifyPoCloseoutRow,
  derivePoOverallStatus,
  summarizeRowStatuses,
  type PoCloseoutRowInput,
} from "./po-closeout";

// A fully-closed-out bag: released + committed to Zoho.
const doneRow: PoCloseoutRowInput = {
  inventoryBagId: "bag-1",
  bagNumber: 1,
  receiptNumber: "PO1-R1-B1-1",
  tabletName: "Spearmint",
  bagQrCode: "bag-card-1",
  workflowBagId: "wf-1",
  finishedLotId: "lot-1",
  finishedLotNumber: "L1",
  receiveId: "rcv-1",
  bagStatus: "EMPTIED",
  hasReceiveContext: true,
  tabletTypeId: "tab-1",
  hasWorkflow: true,
  workflowFinalized: true,
  excludedFromOutput: false,
  hasFinishedLot: true,
  lotStatus: "RELEASED",
  floorReadinessCodes: [],
  qrRepairSafe: false,
  qrIdleUnsafe: false,
  autoIssue: null,
  rebaseAvailable: false,
  releaseStatus: null,
  releaseMessage: null,
  zoho: "COMMITTED",
};

describe("classifyPoCloseoutRow — journey", () => {
  it("released + committed = DONE", () => {
    const r = classifyPoCloseoutRow(doneRow);
    expect(r.status).toBe("DONE");
    expect(r.action).toBe("NONE");
    expect(r.checklist.finishedLotReleasedOrHeld).toBe(true);
    expect(r.checklist.zohoQueuedOrCommittedOrNa).toBe(true);
  });

  it("released + queued Zoho = DONE; released + no Zoho op = DONE (not applicable)", () => {
    expect(classifyPoCloseoutRow({ ...doneRow, zoho: "QUEUED" }).status).toBe("DONE");
    expect(classifyPoCloseoutRow({ ...doneRow, zoho: "NOT_APPLICABLE" }).status).toBe("DONE");
  });

  it("released + FAILED Zoho op = BLOCKED with retry action", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "FAILED" });
    expect(r.status).toBe("BLOCKED");
    expect(r.action).toBe("QUEUE_OR_RETRY_ZOHO");
  });

  it("released + Zoho ready-to-queue = READY_FOR_ACTION (NOT done — admin must queue)", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "READY_TO_QUEUE" });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.status).not.toBe("DONE");
    expect(r.action).toBe("QUEUE_OR_RETRY_ZOHO");
    expect(r.checklist.zohoQueuedOrCommittedOrNa).toBe(false);
    expect(r.reason).toMatch(/not queued/i);
  });

  it("PO-CLOSEOUT-ZOHO-DONE-1: released + Zoho required + NO op (READY_TO_QUEUE) is NOT done", () => {
    // The loader maps a missing op to READY_TO_QUEUE when Zoho is required.
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "READY_TO_QUEUE" });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.checklist.zohoQueuedOrCommittedOrNa).toBe(false);
  });

  it("released + NOT_APPLICABLE = DONE with an explicit 'disabled' reason (not just 'no op')", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "NOT_APPLICABLE" });
    expect(r.status).toBe("DONE");
    expect(r.reason).toMatch(/disabled|not required/i);
    expect(r.reason).not.toMatch(/no op found/i);
  });

  it("released + NOT_READY (op mid-preview/mapping) = NEEDS_REVIEW, not done", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "NOT_READY" });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.checklist.zohoQueuedOrCommittedOrNa).toBe(false);
  });

  it("PENDING_QC / ON_HOLD lots never surface a Zoho ready-to-queue verdict", () => {
    // They resolve at the QC step, before the Zoho step.
    expect(classifyPoCloseoutRow({ ...doneRow, lotStatus: "PENDING_QC", releaseStatus: "NEEDS_QC_REVIEW", zoho: "READY_TO_QUEUE" }).action).not.toBe("QUEUE_OR_RETRY_ZOHO");
    expect(classifyPoCloseoutRow({ ...doneRow, lotStatus: "ON_HOLD", zoho: "READY_TO_QUEUE" }).action).toBe("REVIEW_QC_HOLD");
  });

  it("finalized without lot + autoIssuable = READY_FOR_ACTION auto-issue", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow,
      bagStatus: "IN_USE",
      hasFinishedLot: false,
      finishedLotId: null,
      lotStatus: null,
      zoho: "NOT_APPLICABLE",
      autoIssue: { autoIssuable: true, action: "AUTO_ISSUE_NOW", label: "Ready", nextStep: "Issue" },
    });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.action).toBe("AUTO_ISSUE_FINISHED_LOT");
    expect(r.checklist.finishedLotIssued).toBe(false);
  });

  it("finalized without lot + REPAIR_ALLOCATION + rebase available = READY (correct starting balance)", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "IN_USE", hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE",
      autoIssue: { autoIssuable: false, action: "REPAIR_ALLOCATION", label: "x", nextStep: "Correct balance" },
      rebaseAvailable: true,
    });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.action).toBe("CORRECT_STARTING_BALANCE");
  });

  it("finalized without lot + REPAIR_ALLOCATION + no rebase = NEEDS_REVIEW (record remaining)", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "IN_USE", hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE",
      autoIssue: { autoIssuable: false, action: "REPAIR_ALLOCATION", label: "x", nextStep: "Record remaining" },
      rebaseAvailable: false,
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("RECORD_REMAINING_OR_CLOSE_PARTIAL");
  });

  it("finalized without lot + FIX_PRODUCT_SETUP = BLOCKED", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "IN_USE", hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE",
      autoIssue: { autoIssuable: false, action: "FIX_PRODUCT_SETUP", label: "x", nextStep: "Fix product" },
    });
    expect(r.status).toBe("BLOCKED");
    expect(r.action).toBe("FIX_PRODUCT_SETUP");
  });

  it("PENDING_QC + AUTO_RELEASE_READY = READY_FOR_ACTION auto-release", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, lotStatus: "PENDING_QC", zoho: "NOT_APPLICABLE", releaseStatus: "AUTO_RELEASE_READY", releaseMessage: "clean" });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.action).toBe("AUTO_RELEASE_FINISHED_LOT");
  });

  it("PENDING_QC + NEEDS_QC_REVIEW = NEEDS_REVIEW; + BLOCKED = BLOCKED", () => {
    expect(classifyPoCloseoutRow({ ...doneRow, lotStatus: "PENDING_QC", releaseStatus: "NEEDS_QC_REVIEW", releaseMessage: "hold" }).status).toBe("NEEDS_REVIEW");
    expect(classifyPoCloseoutRow({ ...doneRow, lotStatus: "PENDING_QC", releaseStatus: "BLOCKED", releaseMessage: "conflict" }).status).toBe("BLOCKED");
  });

  it("ON_HOLD lot = NEEDS_REVIEW review-QC-hold", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, lotStatus: "ON_HOLD", zoho: "NOT_APPLICABLE" });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("REVIEW_QC_HOLD");
  });

  it("AVAILABLE bag + safe lost QR reservation = READY_FOR_ACTION repair", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "AVAILABLE", hasWorkflow: false, workflowFinalized: false,
      hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE",
      qrRepairSafe: true,
    });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.action).toBe("REPAIR_QR_RESERVATION");
  });

  it("missing receipt (floor block) = BLOCKED", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, floorReadinessCodes: ["BLOCKED_MISSING_RECEIPT"] });
    expect(r.status).toBe("BLOCKED");
    expect(r.reason).toMatch(/receipt/i);
    expect(r.checklist.noBlocker).toBe(false);
  });

  it("excluded from output = DONE (no lot expected)", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "IN_USE", excludedFromOutput: true, hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE",
    });
    expect(r.status).toBe("DONE");
  });

  it("finalized but no workflow (received, not processed) fails closed to NEEDS_REVIEW", () => {
    const r = classifyPoCloseoutRow({
      ...doneRow, bagStatus: "AVAILABLE", hasWorkflow: false, workflowFinalized: false,
      hasFinishedLot: false, finishedLotId: null, lotStatus: null, zoho: "NOT_APPLICABLE", qrRepairSafe: false,
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("START_OR_FINALIZE_WORKFLOW");
  });

  it("unknown Zoho status on a released lot fails closed to NEEDS_REVIEW", () => {
    const r = classifyPoCloseoutRow({ ...doneRow, zoho: "UNCLEAR" });
    expect(r.status).toBe("NEEDS_REVIEW");
  });
});

describe("PO rollup", () => {
  it("derivePoOverallStatus prioritises BLOCKED > NEEDS_REVIEW > ACTION_READY > DONE", () => {
    expect(derivePoOverallStatus(["DONE", "READY_FOR_ACTION", "NEEDS_REVIEW", "BLOCKED"])).toBe("BLOCKED");
    expect(derivePoOverallStatus(["DONE", "READY_FOR_ACTION", "NEEDS_REVIEW"])).toBe("NEEDS_REVIEW");
    expect(derivePoOverallStatus(["DONE", "READY_FOR_ACTION"])).toBe("ACTION_READY");
    expect(derivePoOverallStatus(["DONE", "DONE"])).toBe("DONE");
    expect(derivePoOverallStatus([])).toBe("DONE");
  });

  it("summarizeRowStatuses counts each bucket", () => {
    const s = summarizeRowStatuses(["DONE", "DONE", "READY_FOR_ACTION", "NEEDS_REVIEW", "BLOCKED"]);
    expect(s).toEqual({ total: 5, done: 2, readyForAction: 1, needsReview: 1, blocked: 1 });
  });

  it("PO overall is NOT DONE when a released lot is READY_TO_QUEUE (or FAILED)", () => {
    const readyToQueue = classifyPoCloseoutRow({ ...doneRow, zoho: "READY_TO_QUEUE" }).status;
    const committed = classifyPoCloseoutRow(doneRow).status;
    expect(derivePoOverallStatus([committed, readyToQueue])).toBe("ACTION_READY");
    const failed = classifyPoCloseoutRow({ ...doneRow, zoho: "FAILED" }).status;
    expect(derivePoOverallStatus([committed, failed])).toBe("BLOCKED");
    // All committed/queued → DONE.
    const queued = classifyPoCloseoutRow({ ...doneRow, zoho: "QUEUED" }).status;
    expect(derivePoOverallStatus([committed, queued])).toBe("DONE");
  });
});

// ADMIN-CORRECTION-WIZARD-1 — recovered/quarantined rows carry an explicit
// next action instead of collapsing into DONE.
describe("classifyPoCloseoutRow — recovery statuses", () => {
  const recoveredBase: PoCloseoutRowInput = {
    ...doneRow,
    bagStatus: "IN_USE",
    excludedFromOutput: true,
    hasFinishedLot: false,
    finishedLotId: null,
    lotStatus: null,
    zoho: "NOT_APPLICABLE",
  };

  it("wrong-route recovered = NEEDS_REVIEW with start-correct-workflow action", () => {
    const r = classifyPoCloseoutRow({
      ...recoveredBase,
      recoveryStatus: "WRONG_ROUTE_RECOVERED",
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("START_OR_FINALIZE_WORKFLOW");
    expect(r.reason).toMatch(/wrong route recovered/i);
    expect(r.actionLabel).toMatch(/start correct workflow/i);
  });

  it("voided from output = NEEDS_REVIEW with manual review action", () => {
    const r = classifyPoCloseoutRow({
      ...recoveredBase,
      recoveryStatus: "VOIDED_FROM_OUTPUT",
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("REVIEW_MANUALLY");
    expect(r.reason).toMatch(/manual review/i);
  });

  it("external recovery required (Zoho committed) = BLOCKED", () => {
    const r = classifyPoCloseoutRow({
      ...recoveredBase,
      recoveryStatus: "EXTERNAL_RECOVERY_REQUIRED",
    });
    expect(r.status).toBe("BLOCKED");
    expect(r.action).toBe("REVIEW_MANUALLY");
    expect(r.reason).toMatch(/committed/i);
  });

  it("excluded WITHOUT a recovery status stays DONE (legacy exclusions)", () => {
    const r = classifyPoCloseoutRow({ ...recoveredBase, recoveryStatus: null });
    expect(r.status).toBe("DONE");
  });

  it("unknown recovery status fails closed to NEEDS_REVIEW", () => {
    const r = classifyPoCloseoutRow({
      ...recoveredBase,
      recoveryStatus: "SOMETHING_NEW",
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.action).toBe("REVIEW_MANUALLY");
  });
});
