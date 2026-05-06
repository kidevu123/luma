// Shared metrics loader. Builds the same set of per-bag /
// per-machine / per-operator cuts that the overview page uses,
// scoped optionally to a "lane" (BLISTER, CARD, BOTTLE, PACKAGING).
// One source of truth so the per-station pages and the overview
// stay in sync.

import { sql, gte, eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  readBagMetrics,
  readDailyThroughput,
  readOperatorDaily,
  workflowEvents,
  products,
  machines,
  stations,
} from "@/lib/db/schema";

export type Lane = "all" | "blister" | "card" | "bottle" | "packaging";

const LANE_MACHINE_KINDS: Record<Lane, string[]> = {
  all: [],
  blister: ["BLISTER", "COMBINED"],
  card: ["SEALING", "PACKAGING", "COMBINED"],
  bottle: ["BOTTLE_HANDPACK", "BOTTLE_CAP_SEAL", "BOTTLE_STICKER"],
  packaging: ["PACKAGING", "COMBINED"],
};

export const LANE_LABEL: Record<Lane, string> = {
  all: "All lanes",
  blister: "Blister station",
  card: "Card flow",
  bottle: "Bottle flow",
  packaging: "Packaging",
};

export async function loadMetrics(lane: Lane, days: number) {
  try {
    return await loadMetricsInner(lane, days);
  } catch (err) {
    console.error(`[metrics-loader] lane=${lane} days=${days} failed:`, err);
    throw err;
  }
}

async function loadMetricsInner(lane: Lane, days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Fetch all finalized-bag metrics in window. Filter in JS so we
  // can match by machineIds (UUID array) without re-deriving from
  // workflow_events. Cheap: bag counts are O(thousands/year).
  const allBags = await db
    .select()
    .from(readBagMetrics)
    .where(gte(readBagMetrics.finalizedAt, since));

  let machineIdsForLane: Set<string> | null = null;
  if (lane !== "all") {
    const kinds = LANE_MACHINE_KINDS[lane];
    if (kinds.length > 0) {
      // Use IN with explicit values rather than ANY(::enum[]) — the
      // array+cast pattern is brittle when postgres-js serializes a
      // JS array against a custom enum type.
      const machineRows = await db
        .select({ id: machines.id, kind: machines.kind })
        .from(machines)
        .where(
          sql`${machines.kind}::text IN (${sql.join(
            kinds.map((k) => sql`${k}`),
            sql`, `,
          )})`,
        );
      machineIdsForLane = new Set(machineRows.map((m) => m.id));
    }
  }

  const bags = machineIdsForLane
    ? allBags.filter((b) =>
        (b.machineIds ?? []).some((mid) => machineIdsForLane!.has(mid)),
      )
    : allBags;

  // Daily throughput in window — used for trend chart.
  const dailyRows = await db
    .select({
      day: readDailyThroughput.day,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
      packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
    .groupBy(readDailyThroughput.day)
    .orderBy(sql`${readDailyThroughput.day} ASC`);

  // Downtime breakdown by reason, scoped to lane via machine kind.
  const downtimeByReason = (await db.execute(sql`
    WITH paired AS (
      SELECT
        s.machine_id,
        m.kind AS machine_kind,
        COALESCE(p.payload->>'reason', 'other') AS reason,
        p.occurred_at AS paused_at,
        (
          SELECT MIN(r.occurred_at) FROM workflow_events r
          WHERE r.workflow_bag_id = p.workflow_bag_id
            AND r.event_type = 'BAG_RESUMED'
            AND r.occurred_at > p.occurred_at
        ) AS resumed_at
      FROM workflow_events p
      LEFT JOIN stations s ON s.id = p.station_id
      LEFT JOIN machines m ON m.id = s.machine_id
      WHERE p.event_type = 'BAG_PAUSED'
        AND p.occurred_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      reason,
      COUNT(*)::int AS occurrences,
      COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS total_seconds,
      COALESCE(AVG(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS avg_seconds
    FROM paired
    WHERE resumed_at IS NOT NULL
      ${
        lane === "all"
          ? sql``
          : sql`AND machine_kind::text IN (${sql.join(
              LANE_MACHINE_KINDS[lane].map((k) => sql`${k}`),
              sql`, `,
            )})`
      }
    GROUP BY reason
    ORDER BY total_seconds DESC
  `)) as unknown as Array<{
    reason: string;
    occurrences: number;
    total_seconds: number;
    avg_seconds: number;
  }>;

  // Operator perf scoped to lane is best-effort: we don't tie
  // operators to specific machines today, so for non-"all" lanes
  // we'd ideally walk events. For v1, return all operators ranked
  // by bags — close enough.
  const operators = await db
    .select({
      operatorCode: readOperatorDaily.operatorCode,
      bags: sql<number>`COALESCE(SUM(${readOperatorDaily.bagsFinalized}),0)::int`,
      activeSeconds: sql<number>`COALESCE(SUM(${readOperatorDaily.activeSecondsTotal}),0)::int`,
      damages: sql<number>`COALESCE(SUM(${readOperatorDaily.damageCountTotal}),0)::int`,
    })
    .from(readOperatorDaily)
    .where(sql`${readOperatorDaily.day} >= ${sinceStr}`)
    .groupBy(readOperatorDaily.operatorCode)
    .orderBy(sql`SUM(${readOperatorDaily.bagsFinalized}) DESC`)
    .limit(10);

  return {
    bags,
    dailyRows,
    downtimeByReason,
    operators,
    days,
    lane,
  };
}
