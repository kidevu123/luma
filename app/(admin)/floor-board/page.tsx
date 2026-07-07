// Floor board v2 — one opinionated view, rebuilt around four questions:
//   What are they making right now, and for how long?   → Now Running
//   How are the two lines flowing?                      → Card / Bottle lanes
//   What needs me?                                      → Act Now rail
//   Is the machine healthy this week, not just today?   → 7-day deck + pulse
//
// Data: getFloorManagerSnapshot (live) + _data.ts (trailing 7 days).
// Live updates via SSE (LiveRefresh → router.refresh()).

import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { getFloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot";
import { getAttentionItems } from "@/lib/production/floor-command";
import { getFloorProductionIntelligence } from "@/lib/production/floor-production-intelligence";
import { buildActNowPanel } from "@/lib/floor-command/act-now";
import {
  BOTTLE_PRODUCTION_LINE,
  CARD_PRODUCTION_LINE,
} from "@/lib/floor-command/production-lines";
import { computeShiftProgress } from "@/lib/production/shift-window";
import { getDamage7d, getFlavorOutput7d, getSevenDayContext } from "./_data";
import { ActNowRail } from "./_components/act-now-rail";
import { BoardHeader } from "./_components/board-header";
import { FlavorBoard } from "./_components/flavor-board";
import { KpiDeck } from "./_components/kpi-deck";
import { LineLane } from "./_components/line-lane";
import { NowRunning } from "./_components/now-running";
import { RecentCompletions } from "./_components/recent-completions";
import { SevenDayPulse } from "./_components/seven-day-pulse";

export const dynamic = "force-dynamic";

export const metadata = { title: "Live Floor" };

async function getCompanyTimezone(): Promise<string> {
  const rows = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .limit(1);
  return rows[0]?.timezone ?? "America/Toronto";
}

export default async function FloorBoardPage() {
  await requireSession();
  const tz = await getCompanyTimezone();

  const [snapshot, attentionItems, productionIntelligence] = await Promise.all([
    getFloorManagerSnapshot(tz),
    getAttentionItems(),
    getFloorProductionIntelligence(),
  ]);

  const [sevenDay, flavor7d, damage] = await Promise.all([
    getSevenDayContext(snapshot.shiftDayKey),
    getFlavorOutput7d(),
    getDamage7d(),
  ]);

  const actNowItems = buildActNowPanel(
    snapshot,
    attentionItems,
    productionIntelligence,
  );
  const shift = computeShiftProgress(new Date(), tz);

  return (
    <div className="flex h-full flex-col overflow-hidden text-slate-200">
      <BoardHeader
        tz={tz}
        shiftMinutesElapsed={shift.minutesElapsed}
        shiftMinutesRemaining={shift.minutesRemaining}
        dayKey={snapshot.shiftDayKey}
      />

      <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3">
        <div className="space-y-3.5">
          <KpiDeck
            snapshot={snapshot}
            sevenDay={sevenDay}
            damage={damage}
            shiftMinutesElapsed={shift.minutesElapsed}
          />

          <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_320px] gap-3.5">
            <div className="space-y-3.5 min-w-0">
              <NowRunning snapshot={snapshot} />
              <LineLane
                line={CARD_PRODUCTION_LINE}
                accent="card"
                snapshot={snapshot}
              />
              <LineLane
                line={BOTTLE_PRODUCTION_LINE}
                accent="bottle"
                snapshot={snapshot}
                sharedStepKeys={["packaging"]}
              />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
                <SevenDayPulse sevenDay={sevenDay} />
                <FlavorBoard
                  flavor7d={flavor7d}
                  flavorToday={snapshot.flavorToday}
                />
                <RecentCompletions rows={snapshot.recentFinalized} />
              </div>
            </div>

            <ActNowRail items={actNowItems} dataGaps={snapshot.dataGaps} />
          </div>
        </div>
      </div>
    </div>
  );
}
