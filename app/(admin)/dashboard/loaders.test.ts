import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DASHBOARD_TZ, todayEtDateKey, weekdayEt, businessDaysRemainingInWeekEt } from "./loaders";

const loadersSrc = readFileSync(join(__dirname, "loaders.ts"), "utf8");
const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("DASHBOARD-FINALIZED-TABLETS-1 · finalized count source", () => {
  it("counts finalized bags from workflow_bags by ET day, not read_daily_throughput", () => {
    expect(loadersSrc).toMatch(/from\(workflowBags\)/);
    expect(loadersSrc).toMatch(/finalizedDayEtSql/);
    expect(loadersSrc).toMatch(/America\/New_York/);
    expect(loadersSrc).not.toMatch(/readDailyThroughput/);
  });

  it("dashboard page imports loaders instead of inline read_daily_throughput queries", () => {
    expect(pageSrc).toMatch(/from "\.\/loaders"/);
    expect(pageSrc).not.toMatch(/readDailyThroughput/);
  });

  it("uses Eastern timezone for today bucket", () => {
    expect(DASHBOARD_TZ).toBe("America/New_York");
    expect(todayEtDateKey(new Date("2026-05-28T18:57:31.517Z"))).toBe("2026-05-28");
  });
});

describe("DASHBOARD-PREDICTION-DATE-COPY-1 · ET weekday for weekly prediction", () => {
  it("weekdayEt uses America/New_York, not server local time", () => {
    // Friday 11:00 ET
    expect(weekdayEt(new Date("2026-05-29T15:00:00.000Z"))).toBe(5);
    // Tuesday 10:00 ET
    expect(weekdayEt(new Date("2026-05-26T14:00:00.000Z"))).toBe(2);
  });

  it("businessDaysRemainingInWeekEt is zero on Friday and weekend", () => {
    expect(businessDaysRemainingInWeekEt(new Date("2026-05-29T15:00:00.000Z"))).toBe(
      0,
    );
    expect(businessDaysRemainingInWeekEt(new Date("2026-05-30T15:00:00.000Z"))).toBe(
      0,
    );
  });

  it("dashboard page uses calendar-aware prediction copy helper", () => {
    expect(pageSrc).toMatch(/buildWeeklyPredictionDetail/);
    expect(pageSrc).not.toMatch(/tomorrow morning's first hour/i);
    expect(pageSrc).not.toMatch(/Push tomorrow morning/i);
  });
});

describe("DASHBOARD-FINALIZED-TABLETS-1 · tablet totals for top flavors", () => {
  it("sums read_bag_metrics.units_yielded, not inventory_bags.pill_count", () => {
    expect(loadersSrc).toMatch(/readBagMetrics\.unitsYielded/);
    expect(loadersSrc).toMatch(/innerJoin\(readBagMetrics/);
    const topFlavorsBlock = loadersSrc.slice(
      loadersSrc.indexOf("getTopFlavorsByFinalized"),
      loadersSrc.indexOf("export async function getActivityHeartbeat"),
    );
    expect(topFlavorsBlock).not.toMatch(/inventoryBags\.pillCount/);
  });

  it("keeps bag count and tablet sum in the same grouped query", () => {
    expect(loadersSrc).toMatch(/bagsFinalized: sql<number>`COUNT\(\*\)::int`/);
    expect(loadersSrc).toMatch(/unitsFinalized: sql<number>`COALESCE\(SUM\(\$\{readBagMetrics\.unitsYielded\}\)/);
  });
});

describe("DASHBOARD-FINALIZED-TABLETS-1 · Bag 117 regression shape", () => {
  it("documents why read_daily_throughput under-counts (machine_id gate)", () => {
    expect(loadersSrc).toMatch(/machine_id/);
    expect(loadersSrc).toMatch(/units_yielded/);
  });
});
