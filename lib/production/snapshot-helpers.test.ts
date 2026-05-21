import { describe, it, expect } from "vitest";
import {
  reconcileBagTotal,
  formatBagTotalLine,
} from "./snapshot-helpers";

describe("reconcileBagTotal — bag total = matched PVC/FOIL segment sum", () => {
  it("Bag 1 (single segment per role, totals match): total = 20324", () => {
    const r = reconcileBagTotal({
      workflow_bag_id: "8a08c639-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      pvc_total: 20324,
      foil_total: 20324,
      segment_count: 2,
    });
    expect(r.bag_total).toBe(20324);
    expect(r.mismatch).toBe(false);
  });

  it("Bag 2 after change-roll mid-bag (TEST C worked example): total = 19738", () => {
    // The bug we're fixing: previously 4 segments / 3 distinct lots
    // = 13158, but pvc=foil=19738 → bag_total should be 19738.
    const r = reconcileBagTotal({
      workflow_bag_id: "7dd73a89-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      pvc_total: 19738,
      foil_total: 19738,
      segment_count: 4,
    });
    expect(r.bag_total).toBe(19738);
    expect(r.mismatch).toBe(false);
  });

  it("flags mismatch when PVC and FOIL totals differ (data integrity warning)", () => {
    const r = reconcileBagTotal({
      workflow_bag_id: "test",
      pvc_total: 19738,
      foil_total: 19000,
      segment_count: 4,
    });
    expect(r.bag_total).toBeNull();
    expect(r.mismatch).toBe(true);
  });

  it("zero segments gives total=0, no mismatch", () => {
    const r = reconcileBagTotal({
      workflow_bag_id: "fresh",
      pvc_total: 0,
      foil_total: 0,
      segment_count: 0,
    });
    expect(r.bag_total).toBe(0);
    expect(r.mismatch).toBe(false);
  });

  it("never returns the buggy SUM / COUNT(DISTINCT lot) value", () => {
    // The old formula: 39476 / 3 = 13158.67. The new formula must
    // never produce 13158 when pvc=foil=19738.
    const r = reconcileBagTotal({
      workflow_bag_id: "regression",
      pvc_total: 19738,
      foil_total: 19738,
      segment_count: 4,
    });
    expect(r.bag_total).not.toBe(13158);
    expect(r.bag_total).toBe(19738);
  });
});

describe("formatBagTotalLine — display output", () => {
  it("renders matched totals with the bag total inline", () => {
    const line = formatBagTotalLine({
      workflow_bag_id: "8a08c639-bag1",
      pvc_total: 20324,
      foil_total: 20324,
      segment_count: 2,
      bag_total: 20324,
      mismatch: false,
    });
    expect(line).toContain("total= 20324");
    expect(line).toContain("pvc= 20324");
    expect(line).toContain("foil= 20324");
    expect(line).toContain("segments= 2");
    expect(line).not.toContain("WARN");
  });

  it("renders WARN + per-role values when totals differ", () => {
    const line = formatBagTotalLine({
      workflow_bag_id: "mismatch-bag",
      pvc_total: 19738,
      foil_total: 19000,
      segment_count: 4,
      bag_total: null,
      mismatch: true,
    });
    expect(line).toMatch(/total=\s+WARN/);
    expect(line).toContain("pvc= 19738");
    expect(line).toContain("foil= 19000");
    expect(line).toMatch(/PVC\/FOIL totals differ/);
  });

  it("Bag 2 TEST C output matches the worked example", () => {
    const display = reconcileBagTotal({
      workflow_bag_id: "7dd73a89",
      pvc_total: 19738,
      foil_total: 19738,
      segment_count: 4,
    });
    const line = formatBagTotalLine(display);
    expect(line).toContain("total= 19738");
    expect(line).not.toContain("13158");
  });
});
