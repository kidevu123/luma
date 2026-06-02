import { describe, expect, it } from "vitest";
import {
  COUNTER_SNAPSHOT_CLOSEOUT_DOUBLE_COUNT_ERROR,
  COUNTER_SNAPSHOT_DUPLICATE_ERROR,
  COUNTER_SNAPSHOT_INVALID_COUNT_ERROR,
  COUNTER_SNAPSHOT_MISSING_ROLLS_ERROR,
  type RecentSegmentRow,
  validateBlisterCounterSnapshot,
} from "./counter-snapshot-guard";

const PVC = "pvc-lot-1";
const FOIL = "foil-lot-1";
const ACTIVE = [PVC, FOIL];

function pauseSegment(
  count: number,
  reason: "PAUSE_SNAPSHOT" | "SHIFT_END_SNAPSHOT",
  group = "group-1",
): RecentSegmentRow[] {
  return [
    {
      segmentReason: reason,
      counterSegmentCount: count,
      packagingLotId: PVC,
      segmentGroupId: group,
      oldLotId: null,
      newLotId: null,
      changedRole: null,
    },
    {
      segmentReason: reason,
      counterSegmentCount: count,
      packagingLotId: FOIL,
      segmentGroupId: group,
      oldLotId: null,
      newLotId: null,
      changedRole: null,
    },
  ];
}

describe("COUNTER-SNAPSHOT-GUARD-1 · validateBlisterCounterSnapshot", () => {
  it("allows valid machine_jam pause snapshot", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_machine_jam",
      submittedCount: 58,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("allows valid shift_end pause snapshot", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_shift_end",
      submittedCount: 187,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(true);
  });

  it("blocks duplicate machine_jam snapshot with same rolls and count", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_machine_jam",
      submittedCount: 58,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: pauseSegment(58, "PAUSE_SNAPSHOT"),
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
  });

  it("blocks duplicate shift_end snapshot with same rolls and count", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_shift_end",
      submittedCount: 187,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: pauseSegment(187, "SHIFT_END_SNAPSHOT"),
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
  });

  it("allows same count after roll change when rolls differ from pause duplicate check", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_machine_jam",
      submittedCount: 58,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ["pvc-lot-2", FOIL],
      recentSegments: pauseSegment(58, "PAUSE_SNAPSHOT"),
    });
    expect(result.ok).toBe(true);
  });

  it("blocks negative counts", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_machine_jam",
      submittedCount: -1,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_INVALID_COUNT_ERROR);
  });

  it("blocks non-integer counts", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 12.5,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_INVALID_COUNT_ERROR);
  });

  it("blocks NaN counts", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: Number.NaN,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(false);
  });

  it("allows zero count when allowZero is true", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_shift_end",
      submittedCount: 0,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(true);
  });

  it("blocks zero count when requirePositive is true", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 0,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
    });
    expect(result.ok).toBe(false);
  });

  it("blocks positive count when active rolls are missing", () => {
    const result = validateBlisterCounterSnapshot({
      context: "pause_machine_jam",
      submittedCount: 10,
      allowZero: true,
      requirePositive: false,
      activeRollLotIds: [],
      recentSegments: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_MISSING_ROLLS_ERROR);
  });

  it("allows valid roll-change snapshot", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 645,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
      rollChange: {
        changedRole: "PVC",
        oldLotId: PVC,
        newLotId: "pvc-lot-2",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("blocks duplicate roll-change snapshot", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 645,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [
        {
          segmentReason: "ROLL_CHANGE",
          counterSegmentCount: 645,
          packagingLotId: PVC,
          segmentGroupId: "rc-1",
          oldLotId: PVC,
          newLotId: "pvc-lot-2",
          changedRole: "PVC",
        },
      ],
      rollChange: {
        changedRole: "PVC",
        oldLotId: PVC,
        newLotId: "pvc-lot-2",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_DUPLICATE_ERROR);
  });

  it("allows partial roll swap path when roll change context differs", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 645,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [
        {
          segmentReason: "ROLL_CHANGE",
          counterSegmentCount: 645,
          packagingLotId: PVC,
          segmentGroupId: "rc-1",
          oldLotId: PVC,
          newLotId: "pvc-lot-2",
          changedRole: "PVC",
        },
      ],
      rollChange: {
        changedRole: "PVC",
        oldLotId: PVC,
        newLotId: "pvc-lot-3",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("allows depleted roll swap when old/new lot pair differs", () => {
    const result = validateBlisterCounterSnapshot({
      context: "roll_change",
      submittedCount: 120,
      allowZero: false,
      requirePositive: true,
      activeRollLotIds: ACTIVE,
      recentSegments: [],
      rollChange: {
        changedRole: "FOIL",
        oldLotId: FOIL,
        newLotId: "foil-lot-2",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("allows valid blister close-out count", () => {
    const result = validateBlisterCounterSnapshot({
      context: "blister_close_out",
      submittedCount: 359,
      allowZero: false,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: pauseSegment(187, "SHIFT_END_SNAPSHOT", "pause-1"),
    });
    expect(result.ok).toBe(true);
  });

  it("blocks blister close-out that repeats a pause/end-shift count", () => {
    const result = validateBlisterCounterSnapshot({
      context: "blister_close_out",
      submittedCount: 187,
      allowZero: false,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: pauseSegment(187, "SHIFT_END_SNAPSHOT"),
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe(COUNTER_SNAPSHOT_CLOSEOUT_DOUBLE_COUNT_ERROR);
  });

  it("does not block close-out matching prior roll-change count", () => {
    const result = validateBlisterCounterSnapshot({
      context: "blister_close_out",
      submittedCount: 645,
      allowZero: false,
      requirePositive: false,
      activeRollLotIds: ACTIVE,
      recentSegments: [
        {
          segmentReason: "ROLL_CHANGE",
          counterSegmentCount: 645,
          packagingLotId: PVC,
          segmentGroupId: "rc-1",
          oldLotId: PVC,
          newLotId: "pvc-lot-2",
          changedRole: "PVC",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});
