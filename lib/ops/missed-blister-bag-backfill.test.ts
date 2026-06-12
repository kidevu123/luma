import { describe, it, expect } from "vitest";
import {
  MISSED_BLISTER_BAG_CONFIRM_STRING,
  buildMissedBlisterBagProposal,
  computeBagSegmentTotal,
  detectExistingMissedBagConflict,
  resolveRollChangeTimestamp,
  rollNumberLookupCandidates,
  validateMissedBlisterBagApplyGate,
  wallClockToUtcInTz,
} from "./missed-blister-bag-backfill";

describe("missed blister bag backfill helpers", () => {
  it("apply gate requires confirm phrase and audit reason", () => {
    expect(validateMissedBlisterBagApplyGate({ apply: false, confirm: null, auditReason: "x" }).ok).toBe(true);
    expect(
      validateMissedBlisterBagApplyGate({
        apply: true,
        confirm: "WRONG",
        auditReason: "operator missed recording",
      }).ok,
    ).toBe(false);
    expect(
      validateMissedBlisterBagApplyGate({
        apply: true,
        confirm: MISSED_BLISTER_BAG_CONFIRM_STRING,
        auditReason: "",
      }).ok,
    ).toBe(false);
    expect(
      validateMissedBlisterBagApplyGate({
        apply: true,
        confirm: MISSED_BLISTER_BAG_CONFIRM_STRING,
        auditReason: "operator missed recording on floor",
      }).ok,
    ).toBe(true);
  });

  it("converts Eastern wall clock to UTC for June EDT", () => {
    const d = wallClockToUtcInTz("2026-06-10", "07:11");
    expect(d.toISOString()).toBe("2026-06-10T11:11:00.000Z");
  });

  it("estimates roll change at midpoint when time unknown", () => {
    const startedAt = wallClockToUtcInTz("2026-06-10", "07:11");
    const completedAt = wallClockToUtcInTz("2026-06-10", "09:12");
    const { at, estimated } = resolveRollChangeTimestamp({ startedAt, completedAt });
    expect(estimated).toBe(true);
    expect(at.getTime()).toBeGreaterThan(startedAt.getTime());
    expect(at.getTime()).toBeLessThan(completedAt.getTime());
  });

  it("bag segment total sums roll change + blister complete counters", () => {
    expect(computeBagSegmentTotal(1630, 856)).toBe(2486);
  });

  it("roll number lookup tries PVC padded variants", () => {
    const candidates = rollNumberLookupCandidates("16", "PVC");
    expect(candidates).toContain("PVC-16");
    expect(candidates).toContain("PVC-016");
  });

  it("refuses when blister complete already exists", () => {
    expect(
      detectExistingMissedBagConflict([{ eventType: "BLISTER_COMPLETE" }]),
    ).toMatch(/BLISTER_COMPLETE/);
  });

  it("builds bag-card-18 shaped proposal", () => {
    const startedAt = wallClockToUtcInTz("2026-06-10", "07:11");
    const completedAt = wallClockToUtcInTz("2026-06-10", "09:12");
    const rollChange = resolveRollChangeTimestamp({ startedAt, completedAt });
    const proposal = buildMissedBlisterBagProposal({
      card: {
        id: "card-id",
        label: "Card #18",
        scanToken: "bag-card-18",
        assignedWorkflowBagId: null,
      },
      inventoryBagId: "inv-id",
      receiptNumber: "1893-26",
      tabletTypeId: null,
      blisterStationId: "station-id",
      blisterMachineId: "machine-id",
      existingWorkflowBagId: null,
      oldPvcLot: { id: "pvc-16", rollNumber: "PVC-16" },
      newPvcLot: { id: "pvc-17", rollNumber: "PVC-17" },
      foilLot: { id: "foil-1", rollNumber: "FOIL-01" },
      startedAt,
      rollChangeAt: rollChange.at,
      rollChangeEstimated: rollChange.estimated,
      completedAt,
      rollChangeCounter: 1630,
      blisterCompleteCounter: 856,
      auditReason: "operator could not record on floor",
    });
    expect(proposal.bagSegmentTotal).toBe(2486);
    expect(proposal.workflowEvents.map((e) => e.eventType)).toEqual([
      "CARD_ASSIGNED",
      "BLISTER_COMPLETE",
      "BAG_RELEASED",
    ]);
    expect(
      proposal.workflowEvents.find((e) => e.eventType === "BLISTER_COMPLETE")
        ?.payload.count_total,
    ).toBe(856);
    expect(proposal.materialEvents).toHaveLength(4);
  });
});
