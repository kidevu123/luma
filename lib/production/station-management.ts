/**
 * Station / machine admin management helpers — deactivate guards and
 * floor inactive messaging. No hard deletes.
 */

import { eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { db } from "@/lib/db";
import {
  readStationLive,
  stations,
} from "@/lib/db/schema";
import { getActiveStationSession } from "@/lib/production/station-operator-session";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export const STATION_INACTIVE_FLOOR_MESSAGE =
  "This station is inactive. Contact an admin." as const;

export function assertStationActiveForFloorActions(station: {
  isActive: boolean;
}): void {
  if (!station.isActive) {
    throw new Error(STATION_INACTIVE_FLOOR_MESSAGE);
  }
}

/** Block deactivate when a bag is pinned or an operator session is open. */
export async function getStationDeactivateBlockers(
  stationId: string,
  tx: Tx = db,
): Promise<string[]> {
  const blockers: string[] = [];
  const [live] = await tx
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, stationId));
  if (live?.currentWorkflowBagId) {
    blockers.push("Station has a bag currently picked up at this station.");
  }
  const session = await getActiveStationSession(tx, stationId);
  if (session) {
    blockers.push("Station has an open operator session.");
  }
  return blockers;
}

export async function getMachineDeactivateBlockers(
  machineId: string,
  tx: Tx = db,
): Promise<string[]> {
  type Row = { id: string; label: string };
  const linked = (await tx.execute<Row>(sql`
    SELECT id::text, label FROM stations WHERE machine_id = ${machineId}::uuid
  `)) as unknown as Row[];
  const blockers: string[] = [];
  for (const s of linked) {
    const stationBlockers = await getStationDeactivateBlockers(s.id, tx);
    for (const b of stationBlockers) {
      blockers.push(`${s.label}: ${b}`);
    }
  }
  return blockers;
}

/** True when historical production rows reference this station. */
export async function stationHasHistoricalUsage(
  stationId: string,
  tx: Tx = db,
): Promise<boolean> {
  type CountRow = { n: number };
  const [we] = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n FROM workflow_events WHERE station_id = ${stationId}::uuid
  `)) as unknown as CountRow[];
  if ((we?.n ?? 0) > 0) return true;
  const [me] = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n FROM material_inventory_events WHERE station_id = ${stationId}::uuid
  `)) as unknown as CountRow[];
  return (me?.n ?? 0) > 0;
}

/** Hard delete is never offered when history exists. */
export async function machineHasHistoricalUsage(
  machineId: string,
  tx: Tx = db,
): Promise<boolean> {
  type CountRow = { n: number };
  const [linked] = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n FROM stations WHERE machine_id = ${machineId}::uuid
  `)) as unknown as CountRow[];
  if ((linked?.n ?? 0) > 0) return true;
  const [me] = (await tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n FROM material_inventory_events WHERE machine_id = ${machineId}::uuid
  `)) as unknown as CountRow[];
  return (me?.n ?? 0) > 0;
}

export async function resolveFloorStationByToken(
  token: string,
  tx: Tx = db,
): Promise<(typeof stations.$inferSelect) | null> {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(token)) return null;
  const [row] = await tx.select().from(stations).where(eq(stations.scanToken, token));
  return row ?? null;
}
