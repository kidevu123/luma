// Live floor board — read-only watch. Auto-refreshes every 30s; will
// switch to SSE once the projector lands. Shows every active workflow
// bag grouped by station kind, with last-event timestamps.

import { Activity, Hourglass } from "lucide-react";
import { db } from "@/lib/db";
import { eq, isNull, desc, sql } from "drizzle-orm";
import {
  workflowBags,
  workflowEvents,
  qrCards,
  stations,
  products,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

async function getActiveBags() {
  const lastEventSubquery = sql<string>`(
    SELECT we.event_type FROM workflow_events we
    WHERE we.workflow_bag_id = ${workflowBags.id}
    ORDER BY we.occurred_at DESC LIMIT 1
  )`;
  const lastEventAt = sql<Date>`(
    SELECT we.occurred_at FROM workflow_events we
    WHERE we.workflow_bag_id = ${workflowBags.id}
    ORDER BY we.occurred_at DESC LIMIT 1
  )`;
  const lastStation = sql<string | null>`(
    SELECT s.label FROM workflow_events we
    LEFT JOIN stations s ON s.id = we.station_id
    WHERE we.workflow_bag_id = ${workflowBags.id}
      AND we.station_id IS NOT NULL
    ORDER BY we.occurred_at DESC LIMIT 1
  )`;
  return db
    .select({
      bag: workflowBags,
      product: products,
      lastEventType: lastEventSubquery,
      lastEventAt,
      lastStation,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .where(isNull(workflowBags.finalizedAt))
    .orderBy(desc(workflowBags.startedAt));
}

export default async function FloorBoardPage() {
  await requireSession();
  const rows = await getActiveBags();
  const idleCards = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(qrCards)
    .where(eq(qrCards.status, "IDLE"));
  const stationCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stations);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live floor"
        description="Bags currently in production. Auto-refreshes every 30s. Will swap to streaming SSE once the projector ships in Phase 4."
        actions={
          <StatusPill kind="ok">
            <Activity className="h-3 w-3" /> {rows.length} active
          </StatusPill>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetaTile label="In flight" value={rows.length.toString()} />
        <MetaTile label="Idle cards" value={(idleCards[0]?.n ?? 0).toString()} />
        <MetaTile label="Stations" value={(stationCount[0]?.n ?? 0).toString()} />
        <MetaTile label="Refresh" value="30s" />
      </div>

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
                    Last event
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    At station
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ bag, product, lastEventType, lastEventAt, lastStation }) => (
                  <tr key={bag.id} className="border-t border-border/50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {bag.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      {product?.name ?? <span className="text-text-subtle">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill kind="info">
                        {lastEventType ?? "STARTED"}
                      </StatusPill>
                      {lastEventAt && (
                        <span className="block text-[10px] text-text-subtle mt-0.5">
                          {new Date(lastEventAt as unknown as string).toLocaleTimeString()}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{lastStation ?? "—"}</td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {bag.startedAt
                        ? new Date(bag.startedAt as unknown as string).toLocaleTimeString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Auto-refresh every 30s. Replace with SSE in Phase 4. */}
      <meta httpEquiv="refresh" content="30" />
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
