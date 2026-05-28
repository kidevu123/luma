import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DASHBOARD_TZ, todayEtDateKey } from "./loaders";

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
