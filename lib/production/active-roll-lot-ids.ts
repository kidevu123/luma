import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";
import { getActiveRollsForMachine } from "@/lib/production/active-rolls";

/** Packaging lot ids for rolls mounted on the station's machine (0–2). */
export async function getActiveRollLotIdsForStation(
  stationId: string,
): Promise<string[]> {
  const [station] = await db
    .select({ machineId: stations.machineId })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!station?.machineId) return [];
  const rolls = await getActiveRollsForMachine(station.machineId);
  return rolls.map((r) => r.packagingLotId);
}
