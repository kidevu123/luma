import { describe, it, expect } from "vitest";
import { buildWeeklyPredictionDetail } from "./prediction-copy";

describe("DASHBOARD-PREDICTION-DATE-COPY-1 · weekly prediction detail copy", () => {
  it("Friday: does not mention tomorrow or by Friday", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 1,
      predictedExtra: 0,
      businessDaysRemaining: 0,
      weekdayEt: 5,
    });
    expect(detail).toMatch(/last production day/i);
    expect(detail).toMatch(/today/i);
    expect(detail).not.toMatch(/tomorrow/i);
    expect(detail).not.toMatch(/by Friday/i);
  });

  it("Tuesday: may mention tomorrow through Friday, not the broken Friday-on-Friday pattern", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 4,
      predictedExtra: 12,
      businessDaysRemaining: 3,
      weekdayEt: 2,
    });
    expect(detail).toMatch(/tomorrow through Friday/i);
    expect(detail).toMatch(/about 12 more bags/i);
    expect(detail).not.toMatch(/by Friday.*tomorrow|tomorrow.*by Friday/i);
  });

  it("Thursday: mentions Friday as target without tomorrow", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 3,
      predictedExtra: 3,
      businessDaysRemaining: 1,
      weekdayEt: 4,
    });
    expect(detail).toMatch(/by Friday/i);
    expect(detail).not.toMatch(/tomorrow/i);
  });

  it("no recent throughput: avoids fake precision", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 0,
      predictedExtra: 5,
      businessDaysRemaining: 2,
      weekdayEt: 2,
    });
    expect(detail).toMatch(/Limited recent finalize data/i);
    expect(detail).not.toMatch(/tomorrow/i);
  });

  it("weekend: closes the weekly window plainly", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 2,
      predictedExtra: 0,
      businessDaysRemaining: 0,
      weekdayEt: 6,
    });
    expect(detail).toMatch(/Mon–Fri window is closed/i);
    expect(detail).not.toMatch(/tomorrow/i);
  });

  it("at/above pace mid-week: no push for extra bags", () => {
    const detail = buildWeeklyPredictionDetail({
      dailyAvg7: 5,
      predictedExtra: 0,
      businessDaysRemaining: 2,
      weekdayEt: 3,
    });
    expect(detail).toMatch(/on track/i);
    expect(detail).not.toMatch(/tomorrow/i);
  });
});
