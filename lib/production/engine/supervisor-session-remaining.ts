// P5-SUPERVISOR Task 2 — pure remaining-seconds ticker.
//
// Split out from supervisor-session.ts so the client barrel can
// re-export the ticker (and the snapshot type) into the browser
// bundle. supervisor-session.ts pulls in @/lib/db + @/lib/db/audit
// for the unlock/lock/require code paths; the tablet banner only
// needs this arithmetic and the shape it operates on.
//
// KEEP THIS FILE PURE. Any @/lib/db (or drizzle-orm subpath, or
// postgres driver) import here would break client.test.ts's import-
// graph walk and drag the Postgres driver into a browser bundle.

/** 15-minute session TTL — spec-locked ("Operator / supervisor
 *  separation" section). Encoded here in ms so both the insert
 *  (expiresAt = openedAt + TTL, in supervisor-session.ts) and this
 *  ticker read from a single constant. */
export const SUPERVISOR_SESSION_TTL_MS = 15 * 60 * 1000;

/** Structural shape returned to the floor. Deliberately omits the
 *  session's employeeId — the floor only needs the display name and
 *  the expiry countdown; leaking the id would put a stable employee
 *  identifier into a client bundle for no reader. */
export type SupervisorSessionSnapshot = {
  id: string;
  employeeName: string;
  expiresAt: Date;
};

/** Pure — how many whole seconds until the session expires, clamped
 *  to zero. The floor banner ticks off this every second; tests pin
 *  the positive, zero, and past-expiry cases. Never negative: a UI
 *  ticker that saw negative seconds would render as "-3s" until the
 *  next re-fetch, which is one bit of information the operator can't
 *  do anything with. */
export function supervisorSessionRemainingSeconds(
  expiresAt: Date,
  now: Date,
): number {
  const diffMs = expiresAt.getTime() - now.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 1000);
}
