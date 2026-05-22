// app/(admin)/floor-board/page.tsx
import { requireSession } from "@/lib/auth-guards";
import {
  buildShiftStatusData,
  getAttentionItems,
  getHourlyThroughput,
  getKpiStripData,
  getOperatorDailySummary,
  getQueueHealthSummary,
  getRecentEvents,
  getShiftTargetStatus,
  getStationsWithLiveState,
} from "@/lib/production/floor-command";
import { db } from "@/lib/db";
import { companies, userDashboardConfig } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { FloorCommandClient } from "./_components/floor-command-client";
import type { WidgetLayout } from "@/lib/floor-command/types";
import { DEFAULT_LAYOUT } from "@/lib/floor-command/types";
import type { WidgetGridData } from "./_components/widget-grid";

export const dynamic = "force-dynamic";

async function getCompanyTimezone(): Promise<string> {
  const rows = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .limit(1);
  return rows[0]?.timezone ?? "America/Toronto";
}

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[floor-board] ${name} FAILED:`, e);
    throw e;
  }
}

export default async function FloorBoardPage() {
  console.log("[floor-board] PAGE START");
  const user = await requireSession();
  const tz = await getCompanyTimezone();
  console.log("[floor-board] tz:", tz);

  const [
    stations,
    queues,
    targetStatus,
    attentionItems,
    operators,
    recentEvents,
    kpiData,
    hourlyThroughput,
    savedLayoutRow,
  ] = await Promise.all([
    safe("getStationsWithLiveState", () => getStationsWithLiveState()),
    safe("getQueueHealthSummary", () => getQueueHealthSummary()),
    safe("getShiftTargetStatus", () => getShiftTargetStatus(tz)),
    safe("getAttentionItems", () => getAttentionItems()),
    safe("getOperatorDailySummary", () => getOperatorDailySummary(tz)),
    safe("getRecentEvents", () => getRecentEvents(50)),
    safe("getKpiStripData", () => getKpiStripData(tz)),
    safe("getHourlyThroughput", () => getHourlyThroughput(tz)),
    safe("savedLayoutRow", () =>
      db
        .select({ layoutJson: userDashboardConfig.layoutJson })
        .from(userDashboardConfig)
        .where(
          and(
            eq(userDashboardConfig.userId, user.id),
            eq(userDashboardConfig.boardKey, "floor-command"),
          ),
        )
        .limit(1),
    ),
  ]);

  console.log("[floor-board] all fetches OK");
  console.log("[floor-board] station[0].lastEventAt:", stations[0]?.lastEventAt, typeof stations[0]?.lastEventAt);
  console.log("[floor-board] recentEvents[0].occurredAt:", recentEvents[0]?.occurredAt, typeof recentEvents[0]?.occurredAt);

  const yieldPct = kpiData.firstPassYieldPct;
  const shiftStatus = buildShiftStatusData(targetStatus, queues, yieldPct, attentionItems);

  const savedLayout =
    (savedLayoutRow[0]?.layoutJson as WidgetLayout[] | undefined) ?? DEFAULT_LAYOUT;

  const widgetData: WidgetGridData = {
    stations,
    queues,
    operators,
    recentEvents,
    throughputPoints: hourlyThroughput,
    targetBagsPerHour:
      stations.find((s) => s.machineTargetBagsPerHour !== null)
        ?.machineTargetBagsPerHour ?? null,
  };

  console.log("[floor-board] rendering FloorCommandClient");

  return (
    <FloorCommandClient
      shiftStatus={shiftStatus}
      kpiData={kpiData}
      savedLayout={savedLayout}
      widgetData={widgetData}
    />
  );
}
