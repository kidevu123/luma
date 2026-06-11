// Floor-board v2 loaders — 7-day context that the live snapshot
// doesn't carry. Everything else on the board comes from
// getFloorManagerSnapshot.
//
// Per CLAUDE.md (luma): no bare `${date}` in raw SQL; read models only.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { products, readBagMetrics, readDailyThroughput } from "@/lib/db/schema";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type DailyOutputPoint = {
  /** Local day key (YYYY-MM-DD), matches read_daily_throughput.day. */
  day: string;
  units: number;
  displays: number;
  cases: number;
  bagsFinalized: number;
  isToday: boolean;
};

export type SevenDayContext = {
  /** Oldest → newest. 7 complete days followed by today. */
  daily: DailyOutputPoint[];
  /** Average units/day over the 7 complete days that had output. */
  avgUnitsPerDay: number | null;
  bestDayUnits: number;
};

/** Generate the previous `n` day keys before (and excluding) todayKey. */
function previousDayKeys(todayKey: string, n: number): string[] {
  const base = new Date(`${todayKey}T00:00:00Z`);
  const keys: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Daily output for the trailing 7 complete days plus today, zero-filled
 * so the chart always shows a full week even on quiet days.
 */
export async function getSevenDayContext(
  todayKey: string,
): Promise<SevenDayContext> {
  const historyKeys = previousDayKeys(todayKey, 7);
  const allKeys = [...historyKeys, todayKey];
  const minKey = historyKeys[0] ?? todayKey;

  const rows = await db
    .select({
      day: sql<string>`${readDailyThroughput.day}::text`,
      units: sql<number>`COALESCE(SUM(${readDailyThroughput.unitsProduced}), 0)::int`,
      displays: sql<number>`COALESCE(SUM(${readDailyThroughput.displaysProduced}), 0)::int`,
      cases: sql<number>`COALESCE(SUM(${readDailyThroughput.casesProduced}), 0)::int`,
      bagsFinalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}), 0)::int`,
    })
    .from(readDailyThroughput)
    .where(sql`${readDailyThroughput.day} >= ${minKey}::date`)
    .groupBy(readDailyThroughput.day);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const daily: DailyOutputPoint[] = allKeys.map((day) => {
    const row = byDay.get(day);
    return {
      day,
      units: row?.units ?? 0,
      displays: row?.displays ?? 0,
      cases: row?.cases ?? 0,
      bagsFinalized: row?.bagsFinalized ?? 0,
      isToday: day === todayKey,
    };
  });

  const completeDaysWithOutput = daily.filter((d) => !d.isToday && d.units > 0);
  const avgUnitsPerDay =
    completeDaysWithOutput.length > 0
      ? Math.round(
          completeDaysWithOutput.reduce((s, d) => s + d.units, 0) /
            completeDaysWithOutput.length,
        )
      : null;
  const bestDayUnits = daily.reduce((m, d) => Math.max(m, d.units), 0);

  return { daily, avgUnitsPerDay, bestDayUnits };
}

export type FlavorOutputRow = {
  productName: string;
  units7d: number;
  bags7d: number;
};

/** Per-flavor output over the trailing 7 days, busiest first. */
export async function getFlavorOutput7d(limit = 8): Promise<FlavorOutputRow[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const rows = await db
    .select({
      productName: sql<string>`COALESCE(${products.name}, 'Unmapped product')`,
      units7d: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
      bags7d: sql<number>`COUNT(*)::int`,
    })
    .from(readBagMetrics)
    .leftJoin(products, sql`${products.id} = ${readBagMetrics.productId}`)
    .where(sql`${readBagMetrics.finalizedAt} >= ${since.toISOString()}::timestamptz`)
    .groupBy(products.name)
    .orderBy(sql`SUM(${readBagMetrics.unitsYielded}) DESC`)
    .limit(limit);
  return rows;
}

export type DamageContext = {
  damaged7d: number;
  units7d: number;
  /** (damaged + ripped) / units produced, percent. Null when no output. */
  ratePct7d: number | null;
};

/** 7-day damage picture with a unit-correct denominator. */
export async function getDamage7d(): Promise<DamageContext> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const [agg] = await db
    .select({
      damaged: sql<number>`COALESCE(SUM(${readBagMetrics.damagedPackaging} + ${readBagMetrics.rippedCards}), 0)::int`,
      units: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
    })
    .from(readBagMetrics)
    .where(sql`${readBagMetrics.finalizedAt} >= ${since.toISOString()}::timestamptz`);

  const damaged = agg?.damaged ?? 0;
  const units = agg?.units ?? 0;
  const denominator = units + damaged;
  return {
    damaged7d: damaged,
    units7d: units,
    ratePct7d:
      denominator > 0 ? +((damaged / denominator) * 100).toFixed(2) : null,
  };
}
