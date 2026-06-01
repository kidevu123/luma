import { describe, it, expect } from "vitest";
import {
  BAG45_PHASE1_DEFAULTS,
  PHASE1_CONFIRM_STRING,
  assertPhase1ProposalHasNoForbiddenActions,
  buildPhase1Proposal,
  computePhase1BagSegmentTotal,
  computePhase1MaterialDeltas,
  detectExistingPhase1Conflict,
  parseBag45Phase1Cli,
  validateApplyGate,
  validatePhase1Timestamps,
} from "./bag45-phase1-backfill";

describe("Bag 45 Phase 1 backfill helpers", () => {
  const card = {
    id: "90690748-9f2f-4213-9c34-f9e277cad88d",
    label: "Card #45",
    scanToken: "bag-card-45",
    assignedWorkflowBagId: null as string | null,
  };

  it("dry-run default does not set apply", () => {
    const opts = parseBag45Phase1Cli(["node", "script.ts"]);
    expect(opts.apply).toBe(false);
    expect(opts.confirm).toBeNull();
  });

  it("apply requires --apply and exact confirm string", () => {
    expect(validateApplyGate(parseBag45Phase1Cli(["node", "script.ts"])).ok).toBe(
      true,
    );
    expect(
      validateApplyGate(
        parseBag45Phase1Cli(["node", "script.ts", "--apply"]),
      ).ok,
    ).toBe(false);
    expect(
      validateApplyGate(
        parseBag45Phase1Cli([
          "node",
          "script.ts",
          "--apply",
          "--confirm",
          "WRONG",
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateApplyGate(
        parseBag45Phase1Cli([
          "node",
          "script.ts",
          "--apply",
          "--confirm",
          PHASE1_CONFIRM_STRING,
        ]),
      ).ok,
    ).toBe(false);
  });

  it("refuses missing timestamps on apply", () => {
    const gate = validateApplyGate(
      parseBag45Phase1Cli([
        "node",
        "script.ts",
        "--apply",
        "--confirm",
        PHASE1_CONFIRM_STRING,
        "--audit-reason",
        "approved",
      ]),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toMatch(/shift-end-at/);
  });

  it("refuses if Card 45 already has matching workflow events", () => {
    const err = detectExistingPhase1Conflict(
      {
        workflowBagId: "bag-1",
        workflowEvents: [
          {
            eventType: "BAG_PAUSED",
            payload: { reason: "shift_end", counter_snapshot_count: 187 },
          },
        ],
        materialSegments: [],
      },
      187,
      18,
    );
    expect(err).toMatch(/workflow pause events already exist/);
  });

  it("refuses if material 187/18 already exist", () => {
    const err = detectExistingPhase1Conflict(
      {
        workflowBagId: "bag-1",
        workflowEvents: [],
        materialSegments: [{ count: 18, lotId: BAG45_PHASE1_DEFAULTS.legacyFoil01LotId }],
      },
      187,
      18,
    );
    expect(err).toMatch(/material segments/);
  });

  it("refuses to insert 516 via count flags", () => {
    expect(BAG45_PHASE1_DEFAULTS.forbiddenPvcChangeCount).toBe(516);
    const proposal = buildPhase1Proposal({
      card,
      inventoryBagId: BAG45_PHASE1_DEFAULTS.expectedInventoryBagId,
      tabletTypeId: null,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      shiftEndCount: 187,
      machineJamCount: 18,
      existingWorkflowBagId: null,
      rollNumbers: { legacyPvc02: "Legacy PVC-02", legacyFoil01: "Legacy FOIL-01" },
    });
    expect(() =>
      assertPhase1ProposalHasNoForbiddenActions({
        ...proposal,
        materialEvents: [
          ...proposal.materialEvents,
          {
            eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
            rollNumber: "Legacy PVC-02",
            lotId: BAG45_PHASE1_DEFAULTS.legacyPvc02LotId,
            counterSegmentCount: 516,
            segmentReason: "ROLL_CHANGE" as "PAUSE_SNAPSHOT",
            occurredAt: "2026-06-01T17:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/516/);
  });

  it("refuses to mount PVC-1 in proposal material events", () => {
    const proposal = buildPhase1Proposal({
      card,
      inventoryBagId: BAG45_PHASE1_DEFAULTS.expectedInventoryBagId,
      tabletTypeId: null,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      shiftEndCount: 187,
      machineJamCount: 18,
      existingWorkflowBagId: null,
      rollNumbers: { legacyPvc02: "Legacy PVC-02", legacyFoil01: "Legacy FOIL-01" },
    });
    expect(() =>
      assertPhase1ProposalHasNoForbiddenActions({
        ...proposal,
        materialEvents: [
          {
            eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
            rollNumber: "PVC-1",
            lotId: BAG45_PHASE1_DEFAULTS.pvc1LotId,
            counterSegmentCount: 18,
            segmentReason: "PAUSE_SNAPSHOT",
            occurredAt: "2026-06-01T17:30:00.000Z",
          },
        ],
      }),
    ).toThrow(/PVC-1/);
  });

  it("refuses PVC-2 lot in material events", () => {
    expect(() =>
      assertPhase1ProposalHasNoForbiddenActions({
        materialEvents: [
          {
            eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
            rollNumber: "PVC-2",
            lotId: BAG45_PHASE1_DEFAULTS.pvc2LotId,
            counterSegmentCount: 18,
            segmentReason: "PAUSE_SNAPSHOT",
            occurredAt: "2026-06-01T17:30:00.000Z",
          },
        ],
        workflowEvents: [],
        nonActions: [],
      }),
    ).toThrow(/PVC-2/);
  });

  it("does not touch Bag 24 in proposal", () => {
    const proposal = buildPhase1Proposal({
      card,
      inventoryBagId: BAG45_PHASE1_DEFAULTS.expectedInventoryBagId,
      tabletTypeId: null,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      shiftEndCount: 187,
      machineJamCount: 18,
      existingWorkflowBagId: null,
      rollNumbers: { legacyPvc02: "Legacy PVC-02", legacyFoil01: "Legacy FOIL-01" },
    });
    const json = JSON.stringify(proposal);
    expect(json).not.toContain(BAG45_PHASE1_DEFAULTS.bag24WorkflowBagId);
    expect(proposal.nonActions.some((n) => n.includes("Bag 24"))).toBe(true);
  });

  it("proposed total for Bag 45 Phase 1 = 205", () => {
    expect(computePhase1BagSegmentTotal(187, 18)).toBe(205);
    const proposal = buildPhase1Proposal({
      card,
      inventoryBagId: BAG45_PHASE1_DEFAULTS.expectedInventoryBagId,
      tabletTypeId: null,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      shiftEndCount: 187,
      machineJamCount: 18,
      existingWorkflowBagId: null,
      rollNumbers: { legacyPvc02: "Legacy PVC-02", legacyFoil01: "Legacy FOIL-01" },
    });
    expect(proposal.bagSegmentTotalAfter).toBe(205);
  });

  it("material proposed totals: Legacy PVC-02 +205, FOIL +205, PVC-1/2 +0", () => {
    expect(computePhase1MaterialDeltas(187, 18)).toEqual({
      legacyPvc02: 205,
      legacyFoil01: 205,
      pvc1: 0,
      pvc2: 0,
    });
  });

  it("audit reason required for apply gate", () => {
    const gate = validateApplyGate({
      workflowCardToken: "bag-card-45",
      shiftEndCount: 187,
      machineJamCount: 18,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      auditReason: "",
      apply: true,
      confirm: PHASE1_CONFIRM_STRING,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toMatch(/audit-reason/);
  });

  it("validates timestamp order and before Bag 24", () => {
    const bag24 = BAG45_PHASE1_DEFAULTS.bag24CardAssignedAtIso;
    expect(
      validatePhase1Timestamps(
        new Date("2026-06-01T18:00:00.000Z"),
        new Date("2026-06-01T17:30:00.000Z"),
        bag24,
      ).ok,
    ).toBe(false);
    expect(
      validatePhase1Timestamps(
        new Date("2026-06-01T19:14:00.000Z"),
        new Date("2026-06-01T19:15:00.000Z"),
        bag24,
      ).ok,
    ).toBe(false);
    expect(
      validatePhase1Timestamps(
        new Date("2026-06-01T17:00:00.000Z"),
        new Date("2026-06-01T17:30:00.000Z"),
        bag24,
      ).ok,
    ).toBe(true);
  });

  it("proposal has four material segments only on legacy rolls", () => {
    const proposal = buildPhase1Proposal({
      card,
      inventoryBagId: BAG45_PHASE1_DEFAULTS.expectedInventoryBagId,
      tabletTypeId: null,
      shiftEndAt: new Date("2026-06-01T17:00:00.000Z"),
      machineJamAt: new Date("2026-06-01T17:30:00.000Z"),
      shiftEndCount: 187,
      machineJamCount: 18,
      existingWorkflowBagId: null,
      rollNumbers: { legacyPvc02: "Legacy PVC-02", legacyFoil01: "Legacy FOIL-01" },
    });
    expect(proposal.materialEvents).toHaveLength(4);
    expect(proposal.workflowEvents).toHaveLength(5);
    expect(
      proposal.materialEvents.every(
        (e) =>
          e.lotId === BAG45_PHASE1_DEFAULTS.legacyPvc02LotId ||
          e.lotId === BAG45_PHASE1_DEFAULTS.legacyFoil01LotId,
      ),
    ).toBe(true);
  });
});
