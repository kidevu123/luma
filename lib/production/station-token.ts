// Station scan-token resolution — the floor's auth primitive. Extracted
// from the duplicated copies in actions.ts / qc-actions.ts so the SSE
// stream route (P3) shares one definition.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";

const STATION_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStationTokenShape(token: string): boolean {
  return STATION_TOKEN_RE.test(token);
}

export async function resolveStationByToken(token: string) {
  if (!isStationTokenShape(token)) return null;
  const [row] = await db.select().from(stations).where(eq(stations.scanToken, token));
  return row ?? null;
}
