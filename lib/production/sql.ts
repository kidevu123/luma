// SQL composition helpers shared across metric functions. Drizzle's
// `sql` template tag is the foundation; we keep a few patterns in
// one place to avoid copy-paste around the metric module.

import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Route } from "./types";

/** Lane filter — returns a SQL fragment selecting machine kinds for
 *  the given route. Use as `where(or(... , inArray(...))) etc.`,
 *  composed by callers, not applied here. */
export const ROUTE_TO_MACHINE_KINDS: Record<Route, ReadonlyArray<string>> = {
  CARD: ["BLISTER", "SEALING", "PACKAGING"],
  BOTTLE: ["BOTTLE_HANDPACK", "BOTTLE_CAP_SEAL", "BOTTLE_STICKER"],
};

/** Half-open time-window predicate: `col >= from AND col < to`.
 *  Renders timestamps with explicit ::timestamptz casts so
 *  postgres-js doesn't choke on bare Date interpolation (the
 *  metrics-loader bug we fixed earlier).
 *
 *  Accepts either a Drizzle column reference, an aliased SQL
 *  fragment, or a hand-rolled `sql\`...\`` expression. */
export function timeWindow(
  col: AnyColumn | SQL | SQL.Aliased,
  from: Date,
  to: Date,
): SQL {
  return sql`${col} >= ${from.toISOString()}::timestamptz AND ${col} < ${to.toISOString()}::timestamptz`;
}

/** "IN (a, b, c)" with proper text casting — avoids the
 *  ANY(::enum[]) array-bind crash in postgres-js. */
export function inText(values: ReadonlyArray<string>): SQL {
  if (values.length === 0) return sql`FALSE`;
  return sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}
