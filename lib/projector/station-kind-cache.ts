// P4a Task 5 — in-process stationId -> kind cache.
//
// Every stationed notify should carry stationKind (P3 gap: non-flow
// events like BAG_PAUSED/BAG_RESUMED skipped the lookup entirely,
// see docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md
// "Known Phase 3 gaps"). Querying `stations` on every notify is
// wasteful: station kind is a floor-layout fact that changes only
// via a deliberate relabel, essentially never at runtime. So we
// memoize per process instead of per request. No invalidation path
// exists on purpose — a relabel takes effect on the next deploy
// (fresh process, fresh cache), which is an acceptable trade for
// skipping a query on the hot notify path.

import { eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { stations } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Injectable for tests; production callers omit it and get the
 *  DB-backed default below. */
export type StationKindLoader = (tx: Tx, stationId: string) => Promise<string | null>;

const defaultLoader: StationKindLoader = async (tx, stationId) => {
  const [row] = await tx
    .select({ kind: stations.kind })
    .from(stations)
    .where(eq(stations.id, stationId));
  return row?.kind ?? null;
};

const cache = new Map<string, string | null>();

/** Returns a station's kind, querying at most once per process per
 *  station id thereafter. */
export async function getStationKind(
  tx: Tx,
  stationId: string,
  loader: StationKindLoader = defaultLoader,
): Promise<string | null> {
  if (cache.has(stationId)) return cache.get(stationId) ?? null;
  const kind = await loader(tx, stationId);
  cache.set(stationId, kind);
  return kind;
}
