import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "roll-actions.ts"), "utf8");
const changeIdx = src.indexOf("export async function changeRollAction");
const changeBlock = changeIdx >= 0 ? src.slice(changeIdx, changeIdx + 18000) : "";

describe("PARTIAL-ROLL-SWAP-1 · changeRollAction contract", () => {
  it("requires an explicit old-roll ending state", () => {
    expect(src).toMatch(/oldRollEndState:\s*z\.enum\(\["depleted",\s*"removed_partial"\]/);
    expect(changeBlock).toMatch(/oldRollEndState:\s*formData\.get\("oldRollEndState"\)/);
  });

  it("preserves the depleted roll-change path", () => {
    expect(changeBlock).toMatch(/d\.oldRollEndState === "depleted"/);
    expect(changeBlock).toMatch(/eventType:\s*"ROLL_DEPLETED"/);
    expect(changeBlock).toMatch(/\.set\(\{\s*status:\s*"DEPLETED"\s*\}/s);
    expect(changeBlock).toMatch(/final_roll_yield_blisters:\s*oldFinalYield/);
  });

  it("partial roll-change emits ROLL_UNMOUNTED instead of ROLL_DEPLETED", () => {
    const partialIdx = changeBlock.indexOf('eventType: "ROLL_UNMOUNTED"');
    expect(partialIdx).toBeGreaterThan(0);
    const partialBlock = changeBlock.slice(partialIdx, partialIdx + 2600);
    expect(partialBlock).not.toMatch(/ROLL_DEPLETED/);
    expect(partialBlock).toMatch(/old_roll_end_state:\s*d\.oldRollEndState/);
    expect(partialBlock).toMatch(/counter_segment_count:\s*d\.counterSegmentCount/);
    expect(partialBlock).toMatch(/status:\s*"AVAILABLE"/);
  });

  it("records the old-roll segment before ending the old roll and mounting replacement", () => {
    const segmentIdx = changeBlock.indexOf('eventType: "ROLL_COUNTER_SEGMENT_RECORDED"');
    const depletedIdx = changeBlock.indexOf('eventType: "ROLL_DEPLETED"');
    const unmountedIdx = changeBlock.indexOf('eventType: "ROLL_UNMOUNTED"');
    const mountedIdx = changeBlock.lastIndexOf('eventType: "ROLL_MOUNTED"');
    expect(segmentIdx).toBeGreaterThan(0);
    expect(segmentIdx).toBeLessThan(depletedIdx);
    expect(segmentIdx).toBeLessThan(unmountedIdx);
    expect(depletedIdx).toBeLessThan(mountedIdx);
    expect(unmountedIdx).toBeLessThan(mountedIdx);
  });

  it("payload links old lot, new lot, change reason, and segment group", () => {
    expect(changeBlock).toMatch(/change_reason:\s*"material_swap"/);
    expect(changeBlock).toMatch(/old_lot_id:\s*oldLot\.packaging_lot_id/);
    expect(changeBlock).toMatch(/new_lot_id:\s*newLot\.id/);
    expect(changeBlock).toMatch(/segment_group_id:\s*segmentGroupId/);
  });
});
