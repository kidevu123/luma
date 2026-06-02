import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildShiftReview,
  buildShiftReviewBagRow,
  flagShiftReviewBag,
  type ShiftReviewBagInput,
} from "@/lib/production/shift-review";

const ROOT = join(__dirname, "../..");

function baseBag(overrides: Partial<ShiftReviewBagInput> = {}): ShiftReviewBagInput {
  return {
    workflowBagId: "bag-1",
    receiptNumber: "R-100",
    bagNumber: "12",
    productName: "Choco Drift",
    tabletTypeName: null,
    productKind: "CARD",
    stage: "BLISTERED",
    isFinalized: false,
    isPaused: false,
    hasFinishedLot: false,
    inventoryBagId: "inv-1",
    stationIds: ["station-blister"],
    stationNames: ["Blister 1"],
    stationKinds: ["BLISTER"],
    segments: [],
    pauseEvents: [],
    blisterCloseOutCounts: [],
    activeRollLotIds: ["pvc-old", "foil-old"],
    hasBlisterWorkflowActivity: false,
    ...overrides,
  };
}

function pairedSegments(args: {
  reason: string;
  count: number;
  groupId?: string;
}): ShiftReviewBagInput["segments"] {
  const groupId = args.groupId ?? "group-1";
  return [
    {
      segmentReason: args.reason,
      counterSegmentCount: args.count,
      packagingLotId: "pvc-old",
      rollRole: "PVC",
      segmentGroupId: groupId,
      occurredAt: "2026-06-02T15:00:00.000Z",
    },
    {
      segmentReason: args.reason,
      counterSegmentCount: args.count,
      packagingLotId: "foil-old",
      rollRole: "FOIL",
      segmentGroupId: groupId,
      occurredAt: "2026-06-02T15:00:00.000Z",
    },
  ];
}

describe("SHIFT-REVIEW-1 · review helper", () => {
  it("summarizes bags, stations, and segment counts", () => {
    const result = buildShiftReview({
      window: {
        from: new Date("2026-06-02T00:00:00.000Z"),
        to: new Date("2026-06-02T23:59:59.000Z"),
        label: "test window",
      },
      bags: [
        baseBag({
          segments: pairedSegments({ reason: "PAUSE_SNAPSHOT", count: 100 }),
        }),
        baseBag({
          workflowBagId: "bag-2",
          receiptNumber: "R-200",
          segments: pairedSegments({ reason: "ROLL_CHANGE", count: 200, groupId: "g2" }),
        }),
      ],
      stationCount: 1,
    });

    expect(result.summary.bagsTouched).toBe(2);
    expect(result.summary.stationsTouched).toBe(1);
    expect(result.summary.totalCounterSegments).toBe(4);
    expect(result.summary.totalPauseSnapshots).toBe(1);
    expect(result.summary.totalRollChangeSnapshots).toBe(1);
  });

  it("sorts flagged rows before clean rows", () => {
    const result = buildShiftReview({
      window: {
        from: new Date("2026-06-02T00:00:00.000Z"),
        to: new Date("2026-06-02T23:59:59.000Z"),
      },
      bags: [
        baseBag({ workflowBagId: "clean", receiptNumber: "CLEAN" }),
        baseBag({
          workflowBagId: "flagged",
          receiptNumber: "FLAGGED",
          segments: [
            {
              segmentReason: "BAG_COMPLETE",
              counterSegmentCount: 100,
              packagingLotId: "pvc-old",
              rollRole: "PVC",
              segmentGroupId: "close-1",
              occurredAt: "2026-06-02T16:00:00.000Z",
            },
            {
              segmentReason: "PAUSE_SNAPSHOT",
              counterSegmentCount: 100,
              packagingLotId: "pvc-old",
              rollRole: "PVC",
              segmentGroupId: "pause-1",
              occurredAt: "2026-06-02T15:00:00.000Z",
            },
          ],
        }),
      ],
      stationCount: 1,
    });

    expect(result.bags[0]?.workflowBagId).toBe("flagged");
    expect(result.bags[0]?.hasFlags).toBe(true);
  });

  it("does not flag a clean normal shift", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        segments: pairedSegments({ reason: "SHIFT_END_SNAPSHOT", count: 516 }),
        pauseEvents: [
          {
            reason: "shift_end",
            counterSnapshotCount: 516,
            counterSnapshotReason: "SHIFT_END_SNAPSHOT",
            occurredAt: "2026-06-02T15:00:00.000Z",
          },
        ],
        hasBlisterWorkflowActivity: true,
      }),
    );
    expect(flags.filter((flag) => flag.nextAction !== "no_action_needed")).toEqual([]);
  });
});

describe("SHIFT-REVIEW-1 · flags", () => {
  it("flags duplicate-looking pause/end-shift segments", () => {
    const segments = [
      ...pairedSegments({ reason: "PAUSE_SNAPSHOT", count: 100, groupId: "g1" }),
      ...pairedSegments({ reason: "PAUSE_SNAPSHOT", count: 100, groupId: "g2" }),
    ];
    const flags = flagShiftReviewBag(baseBag({ segments }));
    expect(flags.some((flag) => flag.code === "DUPLICATE_LOOKING_SEGMENT")).toBe(true);
  });

  it("flags close-out matching prior pause/end-shift count", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        segments: [
          ...pairedSegments({ reason: "SHIFT_END_SNAPSHOT", count: 516, groupId: "shift" }),
          ...pairedSegments({ reason: "BAG_COMPLETE", count: 516, groupId: "close" }),
        ],
      }),
    );
    expect(flags.some((flag) => flag.code === "CLOSEOUT_MATCHES_PRIOR_PAUSE")).toBe(true);
  });

  it("flags missing paired PVC/foil segment", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        segments: [
          {
            segmentReason: "PAUSE_SNAPSHOT",
            counterSegmentCount: 100,
            packagingLotId: "pvc-old",
            rollRole: "PVC",
            segmentGroupId: "solo",
            occurredAt: "2026-06-02T15:00:00.000Z",
          },
        ],
      }),
    );
    expect(flags.some((flag) => flag.code === "MISSING_PAIRED_SEGMENT")).toBe(true);
  });

  it("flags missing lineage on blister activity", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        inventoryBagId: null,
        segments: pairedSegments({ reason: "ROLL_CHANGE", count: 50 }),
        hasBlisterWorkflowActivity: true,
      }),
    );
    expect(flags.some((flag) => flag.code === "MISSING_LINEAGE")).toBe(true);
  });

  it("flags finalized bag with suspicious segments for Sahil review", () => {
    const row = buildShiftReviewBagRow(
      baseBag({
        isFinalized: true,
        segments: [
          ...pairedSegments({ reason: "SHIFT_END_SNAPSHOT", count: 516, groupId: "shift" }),
          ...pairedSegments({ reason: "BAG_COMPLETE", count: 516, groupId: "close" }),
        ],
      }),
    );
    expect(row.flags.some((flag) => flag.code === "FINALIZED_SUSPICIOUS")).toBe(true);
    expect(row.flags.some((flag) => flag.nextAction === "stop_floor_call_sahil")).toBe(true);
  });

  it("marks hand-pack-only bags as not applicable", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        stationKinds: ["HANDPACK_BLISTER"],
        stationNames: ["Hand pack"],
      }),
    );
    expect(flags.some((flag) => flag.code === "NOT_APPLICABLE_HANDPACK")).toBe(true);
  });

  it("flags missing shift-end snapshot conservatively", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        isPaused: true,
        pauseEvents: [
          {
            reason: "shift_end",
            counterSnapshotCount: 200,
            counterSnapshotReason: "SHIFT_END_SNAPSHOT",
            occurredAt: "2026-06-02T15:00:00.000Z",
          },
        ],
        segments: [],
      }),
    );
    expect(flags.some((flag) => flag.code === "MISSING_SHIFT_END_SNAPSHOT")).toBe(true);
  });

  it("stays conservative when data is incomplete", () => {
    const flags = flagShiftReviewBag(
      baseBag({
        inventoryBagId: null,
        activeRollLotIds: [],
        hasBlisterWorkflowActivity: true,
        segments: [],
      }),
    );
    expect(flags.some((flag) => flag.message.toLowerCase().includes("review recommended"))).toBe(
      true,
    );
    expect(flags.some((flag) => flag.message.toLowerCase().includes("wrong"))).toBe(false);
  });
});

describe("SHIFT-REVIEW-1 · mutation guards", () => {
  const pageSrc = readFileSync(join(ROOT, "app/(admin)/shift-review/page.tsx"), "utf8");
  const loaderSrc = readFileSync(
    join(ROOT, "lib/production/shift-review-loader.ts"),
    "utf8",
  );
  const helperSrc = readFileSync(join(ROOT, "lib/production/shift-review.ts"), "utf8");

  it("page does not use write actions or server mutations", () => {
    expect(pageSrc).not.toMatch(/"use server"/);
    expect(pageSrc).not.toMatch(/projectEvent/);
    expect(pageSrc).not.toMatch(/writeAudit/);
    expect(pageSrc).not.toMatch(/\.insert\(/);
    expect(pageSrc).not.toMatch(/\.update\(/);
    expect(pageSrc).not.toMatch(/\.delete\(/);
  });

  it("loader is read-only", () => {
    expect(loaderSrc).not.toMatch(/projectEvent/);
    expect(loaderSrc).not.toMatch(/writeAudit/);
    expect(loaderSrc).not.toMatch(/\.insert\(/);
    expect(loaderSrc).not.toMatch(/\.update\(/);
    expect(loaderSrc).not.toMatch(/\.delete\(/);
    expect(loaderSrc).not.toMatch(/rebuildRollUsage/);
  });

  it("helper has no apply path", () => {
    expect(helperSrc).not.toMatch(/applyMaterialChangeRecovery/);
    expect(helperSrc).not.toMatch(/confirmMaterialChangeRecovery/);
  });
});
