import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assessRebuildSafety,
  findVoidedWorkflowEventIds,
  synthesizerSupportsVoidedBagFinalization,
} from "./bag-finalization-void";
import {
  DEFAULT_TARGET,
  verifyLegacyPartialFinalizationRepair,
} from "./legacy-partial-finalization-repair";
import { buildPartialSealingClosePayload } from "./sealing-partial-closeout";

const synthSrc = readFileSync(
  resolve(process.cwd(), "lib/legacy/read-model-synthesizer.ts"),
  "utf8",
);

const partialClosePayload = buildPartialSealingClosePayload({
  sealedPartialCount: 1656,
  reason: "END_OF_SHIFT",
});

const baseEvents = [
  {
    id: "evt-partial-seal",
    eventType: "SEALING_COMPLETE",
    occurredAt: "2026-06-03T16:16:41.000Z",
    payload: { ...partialClosePayload, lane_close: false },
  },
  {
    id: "evt-packaging",
    eventType: "PACKAGING_COMPLETE",
    occurredAt: "2026-06-03T16:17:47.000Z",
    payload: { master_cases: 1 },
  },
  {
    id: "evt-finalized",
    eventType: "BAG_FINALIZED",
    occurredAt: "2026-06-03T16:18:00.000Z",
    payload: {},
  },
];

const baseCurrent = {
  workflowBag: {
    id: DEFAULT_TARGET.workflowBagId,
    inventoryBagId: DEFAULT_TARGET.inventoryBagId,
    finalizedAt: new Date("2026-06-03T16:18:00.000Z"),
    receiptNumber: DEFAULT_TARGET.receiptNumber,
  },
  readBagState: { stage: "FINALIZED", isFinalized: true },
  inventoryBag: {
    id: DEFAULT_TARGET.inventoryBagId,
    status: "AVAILABLE",
    bagQrCode: DEFAULT_TARGET.bagCardToken,
    internalReceiptNumber: DEFAULT_TARGET.receiptNumber,
  },
  qrCard: {
    id: "card-104",
    scanToken: DEFAULT_TARGET.bagCardToken,
    label: "Bag Card 104",
    status: "IDLE",
    assignedWorkflowBagId: null,
  },
};

describe("verifyLegacyPartialFinalizationRepair", () => {
  it("refuses wrong workflow id", () => {
    const r = verifyLegacyPartialFinalizationRepair({
      ...DEFAULT_TARGET,
      workflowBagId: "00000000-0000-0000-0000-000000000099",
      events: baseEvents,
      current: baseCurrent,
      synthesizerSupportsVoid: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.abortReason).toMatch(/not found|mismatch/i);
  });

  it("refuses when partial_close evidence is missing", () => {
    const r = verifyLegacyPartialFinalizationRepair({
      ...DEFAULT_TARGET,
      events: [
        {
          id: "evt-packaging",
          eventType: "PACKAGING_COMPLETE",
          occurredAt: "2026-06-03T16:17:47.000Z",
          payload: {},
        },
        baseEvents[2]!,
      ],
      current: baseCurrent,
      synthesizerSupportsVoid: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.abortReason).toMatch(/partial_close|Missing SEALING_COMPLETE/i);
  });

  it("refuses when lane_close=true after partial close", () => {
    const r = verifyLegacyPartialFinalizationRepair({
      ...DEFAULT_TARGET,
      events: [
        ...baseEvents,
        {
          id: "evt-lane-close",
          eventType: "SEALING_COMPLETE",
          occurredAt: "2026-06-03T16:20:00.000Z",
          payload: { lane_close: true },
        },
      ],
      current: baseCurrent,
      synthesizerSupportsVoid: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.abortReason).toMatch(/Whole-lane sealing close/i);
  });

  it("refuses when QR card is assigned to another workflow", () => {
    const r = verifyLegacyPartialFinalizationRepair({
      ...DEFAULT_TARGET,
      events: baseEvents,
      current: {
        ...baseCurrent,
        qrCard: {
          ...baseCurrent.qrCard,
          status: "ASSIGNED",
          assignedWorkflowBagId: "00000000-0000-0000-0000-000000000199",
        },
      },
      synthesizerSupportsVoid: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.abortReason).toMatch(/another workflow/i);
  });

  it("dry-run proposes void correction and rebuild-safe repair when synthesizer supports void", () => {
    const r = verifyLegacyPartialFinalizationRepair({
      ...DEFAULT_TARGET,
      events: baseEvents,
      current: baseCurrent,
      synthesizerSupportsVoid: synthesizerSupportsVoidedBagFinalization(synthSrc),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposedMutations.some((m) => m.kind === "append_void_correction")).toBe(
        true,
      );
      expect(r.rebuildSafety.survivesReadModelRebuild).toBe(true);
      expect(r.rebuildSafety.requiresVoidCorrectionEvent).toBe(true);
      expect(r.resumableStage).toBe("BLISTERED");
    }
  });

  it("documents that read-model-only repair would be undone without void correction", () => {
    const safety = assessRebuildSafety({
      events: baseEvents,
      bagFinalizedEventId: "evt-finalized",
      hasVoidCorrection: false,
      synthesizerSupportsVoid: true,
    });
    expect(safety.survivesReadModelRebuild).toBe(false);
    expect(safety.summary).toMatch(/undone/i);
  });
});

describe("bag-finalization-void helpers", () => {
  it("findVoidedWorkflowEventIds reads correction_kind rows", () => {
    const ids = findVoidedWorkflowEventIds([
      {
        eventType: "SUBMISSION_CORRECTED",
        payload: {
          correction_kind: "VOID_ERRONEOUS_BAG_FINALIZATION",
          corrected_event_id: "evt-finalized",
        },
      },
    ]);
    expect(ids.has("evt-finalized")).toBe(true);
  });
});

describe("repair script contracts", () => {
  it("defaults to dry-run and requires explicit apply env flags", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/repair-bag-card-104-legacy-partial-finalization.ts"),
      "utf8",
    );
    expect(src).toMatch(/DRY-RUN/);
    expect(src).toMatch(/ALLOW_PRODUCTION_REPAIR/);
    expect(src).toMatch(/CONFIRM_WORKFLOW_BAG_ID/);
    expect(src).toMatch(/CONFIRM_BAG_CARD/);
    expect(src).not.toMatch(/applyByDefault\s*=\s*true/);
  });

  it("apply path writes partial_bag.legacy_finalization_repair audit action", () => {
    const src = readFileSync(
      resolve(process.cwd(), "lib/production/legacy-partial-finalization-repair.ts"),
      "utf8",
    );
    expect(src).toMatch(/partial_bag\.legacy_finalization_repair/);
    expect(src).toMatch(/VOID_ERRONEOUS_BAG_FINALIZATION/);
  });
});
