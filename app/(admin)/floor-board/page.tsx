// Live floor board — read-only watch. Backed by read_bag_state +
// read_station_live, which are updated synchronously in the same
// transaction as every workflow_event. So queries are cheap and the
// view never lags the source of truth. SSE is still the next step
// (replaces the 10s meta refresh) but at this read latency the meta
// refresh feels live enough to ship.

import { Activity, Hourglass } from "lucide-react";
import { db } from "@/lib/db";
import { eq, isNull, desc, sql } from "drizzle-orm";
import {
  workflowBags,
  qrCards,
  stations,
  products,
  readBagState,
  readStationLive,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const STAGE_KIND: Record<string, "ok" | "warn" | "info" | "neutral"> = {
  STARTED: "neutral",
  BLISTERED: "info",
  SEALED: "info",
  PACKAGED: "ok",
  FINALIZED: "ok",
};

async function getActiveBags() {
  return db
    .select({
      bagId: workflowBags.id,
      startedAt: workflowBags.startedAt,
      product: products,
      stage: readBagState.stage,
      lastEventAt: readBagState.lastEventAt,
      isOnHold: readBagState.isOnHold,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(isNull(workflowBags.finalizedAt))
    .orderBy(desc(workflowBags.startedAt));
}

async function getLiveStations() {
  return db
    .select({
      stationId: stations.id,
      stationLabel: stations.label,
      stationKind: stations.kind,
      currentBagId: readStationLive.currentWorkflowBagId,
      lastEventType: readStationLive.lastEventType,
      lastEventAt: readStationLive.lastEventAt,
    })
    .from(stations)
    .leftJoin(readStationLive, eq(readStationLive.stationId, stations.id))
    .orderBy(stations.label);
}

export default async function FloorBoardPage() {
  await requireSession();
  const [rows, liveStations, idleCards] = await Promise.all([
    getActiveBags(),
    getLiveStations(),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(qrCards)
      .where(eq(qrCards.status, "IDLE")),
  ]);
  const busyStations = liveStations.filter((s) => s.currentBagId);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live floor"
        description="Bags currently in production. Backed by synchronous read models — never lags the source of truth."
        actions={
          <StatusPill kind="ok">
            <Activity className="h-3 w-3" /> {rows.length} active
          </StatusPill>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetaTile label="In flight" value={rows.length.toString()} />
        <MetaTile
          label="Stations busy"
          value={`${busyStations.length}/${liveStations.length}`}
        />
        <MetaTile label="Idle cards" value={(idleCards[0]?.n ?? 0).toString()} />
        <MetaTile label="Refresh" value="10s" />
      </div>

      {liveStations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Stations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/60">
              {liveStations.map((s) => (
                <li
                  key={s.stationId}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.stationLabel}</div>
                    <div className="text-[11px] text-text-subtle">{s.stationKind}</div>
                  </div>
                  <div className="text-right">
                    {s.currentBagId ? (
                      <>
                        <StatusPill kind="info">
                          {s.lastEventType ?? "ACTIVE"}
                        </StatusPill>
                        {s.lastEventAt && (
                          <div className="text-[10px] text-text-subtle mt-0.5 tabular-nums">
                            {new Date(s.lastEventAt as unknown as string).toLocaleTimeString()}
                          </div>
                        )}
                      </>
                    ) : (
                      <StatusPill kind="neutral">idle</StatusPill>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="No bags running"
          description="Open /floor/<station-token> on a tablet to start scanning."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Active bags</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/50 text-xs text-text-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Bag
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Product
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Stage
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Last event
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.bagId} className="border-t border-border/50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.bagId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      {r.product?.name ?? <span className="text-text-subtle">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill kind={STAGE_KIND[r.stage ?? "STARTED"] ?? "neutral"}>
                        {r.stage ?? "STARTED"}
                      </StatusPill>
                      {r.isOnHold && (
                        <StatusPill kind="warn">on hold</StatusPill>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs tabular-nums">
                      {r.lastEventAt
                        ? new Date(r.lastEventAt as unknown as string).toLocaleTimeString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {r.startedAt
                        ? new Date(r.startedAt as unknown as string).toLocaleTimeString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Auto-refresh — drop to 10s now that queries are read-model-cheap. */}
      <meta httpEquiv="refresh" content="10" />
    </div>
  );
}

function MetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-subtle">
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight mt-0.5">
        {value}
      </div>
    </div>
  );
}
