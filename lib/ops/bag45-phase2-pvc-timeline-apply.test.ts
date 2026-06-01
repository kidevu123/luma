import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  PHASE2_COUNTS,
  PHASE2_IDS,
} from "@/lib/ops/bag45-phase2-pvc-timeline-dry-run";
import {
  PHASE2_AUDIT_ACTIONS,
  PHASE2_CONFIRM_STRING,
  PHASE2_EXPECTED_TOTALS,
  assertPhase2ApplySourceGuard,
  assertPhase2ProposalIntegrity,
  buildBag24CorrectionSpecs,
  buildPhase2ApplyProposal,
  detectBag45HasPhase1,
  parseBag45Phase2Cli,
  validatePhase2ApplyGate,
  validatePhase2ApplyGuards,
  type Phase2ApplyState,
} from "@/lib/ops/bag45-phase2-pvc-timeline-apply";

function baseState(overrides: Partial<Phase2ApplyState> = {}): Phase2ApplyState {
  const bag45Workflow = [
    {
      eventType: "BAG_PAUSED",
      occurredAt: "2026-05-30T22:00:00Z",
      reason: "shift_end",
      counterSnapshot: 187,
      countTotal: null,
    },
    {
      eventType: "BAG_PAUSED",
      occurredAt: "2026-06-01T11:16:00Z",
      reason: "machine_jam",
      counterSnapshot: 18,
      countTotal: null,
    },
  ];
  const bag24Detailed = [
    {
      id: "755",
      rollNumber: "Legacy FOIL-01",
      lotId: PHASE2_IDS.legacyFoil01,
      packagingMaterialId: "foil-mat",
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      occurredAt: "2026-06-01T20:33:21Z",
      segmentCount: 645,
      segmentReason: "ROLL_CHANGE",
      segmentGroupId: PHASE2_IDS.bag24RollChangeGroupId,
      bagTotalAfter: 645,
      rollTotalAfter: 6091,
      payload: {},
    },
    {
      id: "756",
      rollNumber: "Legacy PVC-02",
      lotId: PHASE2_IDS.legacyPvc02,
      packagingMaterialId: "pvc-mat",
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      occurredAt: "2026-06-01T20:33:21Z",
      segmentCount: 645,
      segmentReason: "ROLL_CHANGE",
      segmentGroupId: PHASE2_IDS.bag24RollChangeGroupId,
      bagTotalAfter: 1290,
      rollTotalAfter: 3244,
      payload: {},
    },
    {
      id: "757",
      rollNumber: "Legacy PVC-02",
      lotId: PHASE2_IDS.legacyPvc02,
      packagingMaterialId: "pvc-mat",
      eventType: "ROLL_DEPLETED",
      occurredAt: "2026-06-01T20:33:21Z",
      segmentCount: null,
      segmentReason: null,
      segmentGroupId: PHASE2_IDS.bag24RollChangeGroupId,
      bagTotalAfter: null,
      rollTotalAfter: null,
      payload: {},
    },
    {
      id: "758",
      rollNumber: "PVC-2",
      lotId: PHASE2_IDS.pvc2,
      packagingMaterialId: "pvc-mat",
      eventType: "ROLL_MOUNTED",
      occurredAt: "2026-06-01T20:33:21Z",
      segmentCount: null,
      segmentReason: null,
      segmentGroupId: PHASE2_IDS.bag24RollChangeGroupId,
      bagTotalAfter: null,
      rollTotalAfter: null,
      payload: {},
    },
    {
      id: "759",
      rollNumber: "Legacy FOIL-01",
      lotId: PHASE2_IDS.legacyFoil01,
      packagingMaterialId: "foil-mat",
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      occurredAt: "2026-06-01T21:01:31Z",
      segmentCount: 359,
      segmentReason: "BAG_COMPLETE",
      segmentGroupId: null,
      bagTotalAfter: 1649,
      rollTotalAfter: 6450,
      payload: {},
    },
    {
      id: "760",
      rollNumber: "PVC-2",
      lotId: PHASE2_IDS.pvc2,
      packagingMaterialId: "pvc-mat",
      eventType: "ROLL_COUNTER_SEGMENT_RECORDED",
      occurredAt: "2026-06-01T21:01:31Z",
      segmentCount: 359,
      segmentReason: "BAG_COMPLETE",
      segmentGroupId: null,
      bagTotalAfter: 1649,
      rollTotalAfter: 359,
      payload: {},
    },
  ];

  return {
    bag45: {
      workflowEvents: bag45Workflow,
      materialEvents: [],
      stage: "STARTED",
      segmentSumOnPvc: 205,
      has516: false,
      pvc1EventCount: 0,
    },
    bag24: {
      workflowEvents: [
        {
          eventType: "BLISTER_COMPLETE",
          occurredAt: "2026-06-01T21:01:31Z",
          reason: null,
          counterSnapshot: null,
          countTotal: 359,
        },
      ],
      materialEvents: [],
      rollChange645OnLegacyPvc02: true,
      rollChange645OnPvc1: false,
      has359Complete: true,
      materialRowsDetailed: bag24Detailed,
      pvc645SegmentRow: bag24Detailed[1]!,
      pvc645DepletedRow: bag24Detailed[2]!,
      pvc2MountRow: bag24Detailed[3]!,
      foil645Row: bag24Detailed[0]!,
      blister359Rows: [bag24Detailed[4]!, bag24Detailed[5]!],
    },
    rolls: [
      {
        rollNumber: "Legacy PVC-02",
        lotId: PHASE2_IDS.legacyPvc02,
        status: "DEPLETED",
        segmentSum: 3449,
        maxRollTotal: 3449,
      },
      {
        rollNumber: "PVC-1",
        lotId: PHASE2_IDS.pvc1,
        status: "AVAILABLE",
        segmentSum: 0,
        maxRollTotal: null,
      },
      {
        rollNumber: "PVC-2",
        lotId: PHASE2_IDS.pvc2,
        status: "IN_USE",
        segmentSum: 635,
        maxRollTotal: 635,
      },
      {
        rollNumber: "Legacy FOIL-01",
        lotId: PHASE2_IDS.legacyFoil01,
        status: "IN_USE",
        segmentSum: 6931,
        maxRollTotal: 6931,
      },
    ],
    activeMounted: [
      { rollNumber: "Legacy FOIL-01", status: "IN_USE" },
      { rollNumber: "PVC-2", status: "IN_USE" },
    ],
    bag45WorkflowBagId: PHASE2_IDS.bag45WorkflowBagId,
    bag24WorkflowBagId: PHASE2_IDS.bag24WorkflowBagId,
    bag45HasPhase1: true,
    activePvcRollNumber: "PVC-2",
    ...overrides,
  };
}

describe("Bag 45 Phase 2 PVC timeline apply helpers", () => {
  it("1. dry-run default writes nothing (apply=false)", () => {
    const opts = parseBag45Phase2Cli(["node", "script.ts"]);
    expect(opts.apply).toBe(false);
    expect(validatePhase2ApplyGate(opts).ok).toBe(true);
  });

  it("2. apply requires --apply", () => {
    expect(
      validatePhase2ApplyGate(parseBag45Phase2Cli(["node", "script.ts"])).ok,
    ).toBe(true);
    expect(
      validatePhase2ApplyGate(parseBag45Phase2Cli(["node", "script.ts", "--apply"]))
        .ok,
    ).toBe(false);
  });

  it("3. apply requires exact confirm string", () => {
    expect(
      validatePhase2ApplyGate(
        parseBag45Phase2Cli([
          "node",
          "script.ts",
          "--apply",
          "--confirm",
          "WRONG",
          "--audit-reason",
          "ok",
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validatePhase2ApplyGate(
        parseBag45Phase2Cli([
          "node",
          "script.ts",
          "--apply",
          "--confirm",
          PHASE2_CONFIRM_STRING,
          "--audit-reason",
          "ok",
        ]),
      ).ok,
    ).toBe(true);
  });

  it("4. apply requires audit reason", () => {
    const gate = validatePhase2ApplyGate(
      parseBag45Phase2Cli([
        "node",
        "script.ts",
        "--apply",
        "--confirm",
        PHASE2_CONFIRM_STRING,
      ]),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toMatch(/audit-reason/);
  });

  it("5. blocks if Bag 45 516 already exists", () => {
    const blockers = validatePhase2ApplyGuards(
      baseState({ bag45: { ...baseState().bag45, has516: true } }),
    );
    expect(blockers.some((b) => b.includes("516"))).toBe(true);
  });

  it("6. blocks if Bag 24 645 group missing", () => {
    const s = baseState();
    const blockers = validatePhase2ApplyGuards({
      ...s,
      bag24: {
        ...s.bag24,
        pvc645SegmentRow: null,
        rollChange645OnLegacyPvc02: false,
      },
    });
    expect(blockers.some((b) => b.includes("645"))).toBe(true);
  });

  it("7. blocks if Bag 24 645 already corrected to PVC-1", () => {
    const blockers = validatePhase2ApplyGuards(
      baseState({
        bag24: {
          ...baseState().bag24,
          rollChange645OnLegacyPvc02: false,
          rollChange645OnPvc1: true,
        },
      }),
    );
    expect(blockers.some((b) => b.includes("PVC-1"))).toBe(true);
  });

  it("8. blocks if Bag 24 359 would be touched (missing complete rows)", () => {
    const s = baseState();
    const blockers = validatePhase2ApplyGuards({
      ...s,
      bag24: { ...s.bag24, blister359Rows: [], has359Complete: false },
    });
    expect(blockers.some((b) => b.includes("359"))).toBe(true);
  });

  it("9. blocks if PVC-2 mount would change (missing mount row)", () => {
    const s = baseState();
    const blockers = validatePhase2ApplyGuards({
      ...s,
      bag24: { ...s.bag24, pvc2MountRow: null },
    });
    expect(blockers.some((b) => b.includes("PVC-2"))).toBe(true);
  });

  it("10. blocks if FOIL 645 would change (missing foil row)", () => {
    const s = baseState();
    const blockers = validatePhase2ApplyGuards({
      ...s,
      bag24: { ...s.bag24, foil645Row: null },
    });
    expect(blockers.some((b) => b.includes("FOIL 645"))).toBe(true);
  });

  it("11. Bag 45 516 assigned to Legacy PVC-02, not PVC-1", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(
      proposal.bag45MaterialInserts.some(
        (m) =>
          m.lotId === PHASE2_IDS.legacyPvc02 &&
          m.segmentCount === PHASE2_COUNTS.bag45PvcChange,
      ),
    ).toBe(true);
    expect(
      proposal.bag45MaterialInserts.some(
        (m) => m.lotId === PHASE2_IDS.pvc1 && m.segmentCount === 516,
      ),
    ).toBe(false);
  });

  it("12. PVC-1 mounted after Bag 45 516", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    const mount = proposal.bag45MaterialInserts.find(
      (m) => m.lotId === PHASE2_IDS.pvc1 && m.eventType === "ROLL_MOUNTED",
    );
    expect(mount).toBeDefined();
    assertPhase2ProposalIntegrity(proposal);
  });

  it("13. Bag 24 645 reassigned to PVC-1", () => {
    const specs = buildBag24CorrectionSpecs(baseState());
    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.afterLotId === PHASE2_IDS.pvc1)).toBe(true);
  });

  it("14. PVC-2 does not receive prior 645", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.rollTotalsAfter["PVC-2"]).toBe(635);
    expect(proposal.rollTotalsBefore["PVC-2"]).toBe(635);
    const corrections = buildBag24CorrectionSpecs(baseState());
    expect(corrections.every((c) => c.afterLotId !== PHASE2_IDS.pvc2)).toBe(true);
  });

  it("15. 359 BLISTER_COMPLETE remains untouched", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.bag24UntouchedEventIds).toContain("759");
    expect(proposal.bag24UntouchedEventIds).toContain("760");
    expect(proposal.bag24Corrections.every((c) => !["759", "760"].includes(c.eventId))).toBe(
      true,
    );
  });

  it("16. expected total math Legacy PVC-02 3449→3320, PVC-1 0→645, PVC-2 unchanged, FOIL +516", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.rollTotalsBefore["Legacy PVC-02"]).toBe(3449);
    expect(proposal.rollTotalsAfter["Legacy PVC-02"]).toBe(PHASE2_EXPECTED_TOTALS.legacyPvc02);
    expect(proposal.rollTotalsAfter["PVC-1"]).toBe(PHASE2_EXPECTED_TOTALS.pvc1);
    expect(proposal.rollTotalsAfter["PVC-2"]).toBe(PHASE2_EXPECTED_TOTALS.pvc2);
    expect(proposal.rollTotalsAfter["Legacy FOIL-01"]).toBe(
      6931 + PHASE2_EXPECTED_TOTALS.legacyFoil01Delta,
    );
  });

  it("17. audit rows planned", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.auditActions).toContain(PHASE2_AUDIT_ACTIONS.bag45);
    expect(proposal.auditActions).toContain(PHASE2_AUDIT_ACTIONS.bag24);
  });

  it("18. rebuild required/planned", () => {
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.rebuildSteps.some((s) => s.includes("rebuildRollUsage"))).toBe(true);
    expect(proposal.rebuildSteps.some((s) => s.includes("rebuildMaterialLotState"))).toBe(
      true,
    );
  });

  it("19. source guard: no Zoho, migrations, or unrelated table writes", () => {
    const applySrc = readFileSync(
      join(process.cwd(), "lib/ops/bag45-phase2-pvc-timeline-apply.ts"),
      "utf8",
    );
    expect(applySrc).not.toMatch(/from\s+["']@?\/?.*zoho/i);
    expect(() =>
      assertPhase2ApplySourceGuard('import x from "@/lib/zoho/foo"'),
    ).toThrow(/zoho/);
    expect(() =>
      assertPhase2ApplySourceGuard("exec drizzle-kit migrate"),
    ).toThrow(/migrations/);
    expect(PHASE2_CONFIRM_STRING).toBe("APPLY_BAG45_PHASE2_PVC_TIMELINE");
  });

  it("20. script has no apply unless confirm gate passes", () => {
    expect(detectBag45HasPhase1(baseState().bag45.workflowEvents)).toBe(true);
    expect(
      validatePhase2ApplyGuards(
        baseState({ bag45HasPhase1: false }),
      ).some((b) => b.includes("Phase 1")),
    ).toBe(true);
    const proposal = buildPhase2ApplyProposal(baseState());
    expect(proposal.warnings.some((w) => w.includes("append-only"))).toBe(true);
  });
});
