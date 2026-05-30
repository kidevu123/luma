// OP-1C — station operator session helpers.
//
// Reads the active operator session for a station and turns it into the
// accountability fields projectEvent (OP-1B) consumes. Floor actions
// call resolveStationAccountability() once per submission; admin
// actions don't use this at all (they default from currentUser()).
//
// "Active session" = the row with closed_at IS NULL for the station.
// Migration 0023 enforces at-most-one-open via partial unique.

import { and, eq, isNull } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  stationOperatorSessions,
  type StationOperatorSession,
} from "@/lib/db/schema";

import {
  resolveAccountableEmployee,
  isEmployeeUuidShape,
  type AccountabilityInput,
  type AccountabilityResolution,
} from "@/lib/production/accountability";
import type { AccountabilitySource } from "@/lib/projector";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type ActiveStationSession = Pick<
  StationOperatorSession,
  | "id"
  | "stationId"
  | "employeeId"
  | "employeeNameSnapshot"
  | "accountabilitySource"
  | "openedAt"
>;

/** Station kinds where first-op count events require stable employee_id. */
export const FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS: ReadonlySet<string> =
  new Set(["BLISTER", "COMBINED", "BOTTLE_HANDPACK"]);

/** True when an open session row satisfies first-op count accountability. */
export function sessionSatisfiesFirstOpCount(session: {
  employeeId: string | null;
}): boolean {
  return session.employeeId != null;
}

/** Read the currently-open operator session for a station, or null if
 *  none. Pure read; safe to call from any context. */
export async function getActiveStationSession(
  tx: Tx,
  stationId: string,
): Promise<ActiveStationSession | null> {
  const [row] = await tx
    .select({
      id: stationOperatorSessions.id,
      stationId: stationOperatorSessions.stationId,
      employeeId: stationOperatorSessions.employeeId,
      employeeNameSnapshot: stationOperatorSessions.employeeNameSnapshot,
      accountabilitySource: stationOperatorSessions.accountabilitySource,
      openedAt: stationOperatorSessions.openedAt,
    })
    .from(stationOperatorSessions)
    .where(
      and(
        eq(stationOperatorSessions.stationId, stationId),
        isNull(stationOperatorSessions.closedAt),
      ),
    );
  return row ?? null;
}

/** Bag of accountability metadata projectEvent accepts. Mirrors the
 *  optional fields on EventInput but with non-null guarantees where
 *  the resolver was able to provide them. */
export type AccountabilityForEvent = {
  enteredByUserId: string | null;
  accountableEmployeeId: string | null;
  accountabilitySource: AccountabilitySource | null;
  accountableEmployeeNameSnapshot: string | null;
  /** True when the resolution came from a stable employees row.
   *  Useful for the "first-op refuses unstable" guard. */
  isStable: boolean;
};

export type StationAccountabilityInput = {
  stationId: string;
  /** Optional per-form override. When non-empty, the resolver tries
   *  this first (treating it as an EMPLOYEE_CODE) before falling back
   *  to the active session. Lets a supervisor submit a single count on
   *  behalf of someone else without ending the shift. */
  overrideEmployeeCode?: string | null;
  /** Optional free-text fallback. Only consulted when no session is
   *  open and no override resolves. Lands as LEGACY_TEXT / MANUAL_TEXT
   *  per the resolver's source-hint logic. */
  freeText?: string | null;
  /** Caller can pin the accountability_source label (e.g. tag the
   *  override path as SUPERVISOR_OVERRIDE explicitly). */
  sourceHint?: AccountabilitySource | null;
};

/** Resolve the accountability fields for a floor count submission.
 *  Precedence:
 *    1. per-form override (treated as an employee code)
 *    2. active station-operator-session
 *    3. free-text fallback (only when allowed)
 *    4. all-null (caller decides whether to refuse)
 *
 *  Always wraps the resolver source — when a session-driven resolution
 *  is used, the source is STATION_OPERATOR_SESSION (HIGH confidence).
 *  When the override path resolves, the source is the resolver's own
 *  classification (EMPLOYEE_CODE → MEDIUM) unless caller hinted
 *  otherwise (SUPERVISOR_OVERRIDE → HIGH). */
export async function resolveStationAccountability(
  tx: Tx,
  input: StationAccountabilityInput,
): Promise<AccountabilityForEvent> {
  // 1) Per-form override.
  const overrideCode = trimOrNull(input.overrideEmployeeCode);
  if (overrideCode) {
    const overrideInput: AccountabilityInput = isEmployeeUuidShape(overrideCode)
      ? { employeeId: overrideCode }
      : { employeeCode: overrideCode };
    const r = await resolveAccountableEmployee(tx, {
      ...overrideInput,
      sourceHint: input.sourceHint ?? "SUPERVISOR_OVERRIDE",
    });
    if (r) return resolutionToEvent(r);
  }

  // 2) Active station-operator-session.
  const session = await getActiveStationSession(tx, input.stationId);
  if (session) {
    const source =
      isAccountabilitySource(session.accountabilitySource)
        ? "STATION_OPERATOR_SESSION"
        : "STATION_OPERATOR_SESSION";
    return {
      enteredByUserId: null,
      accountableEmployeeId: session.employeeId,
      accountabilitySource: source,
      accountableEmployeeNameSnapshot: session.employeeNameSnapshot,
      isStable: session.employeeId !== null,
    };
  }

  // 3) Free-text fallback.
  const freeText = trimOrNull(input.freeText);
  if (freeText) {
    const r = await resolveAccountableEmployee(tx, {
      freeText,
      sourceHint: input.sourceHint ?? "LEGACY_TEXT",
    });
    if (r) return resolutionToEvent(r);
  }

  // 4) Nothing.
  return {
    enteredByUserId: null,
    accountableEmployeeId: null,
    accountabilitySource: null,
    accountableEmployeeNameSnapshot: null,
    isStable: false,
  };
}

function resolutionToEvent(
  r: AccountabilityResolution,
): AccountabilityForEvent {
  return {
    enteredByUserId: null,
    accountableEmployeeId: r.accountableEmployeeId,
    accountabilitySource: r.source,
    accountableEmployeeNameSnapshot: r.nameSnapshot,
    isStable: r.isStable,
  };
}

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

const VALID_SOURCES: ReadonlyArray<AccountabilitySource> = [
  "LOGGED_IN_USER",
  "EMPLOYEE_PICKER",
  "EMPLOYEE_CODE",
  "BADGE_SCAN",
  "SUPERVISOR_OVERRIDE",
  "STATION_OPERATOR_SESSION",
  "LEGACY_TEXT",
  "MANUAL_TEXT",
];

function isAccountabilitySource(s: string): s is AccountabilitySource {
  return (VALID_SOURCES as ReadonlyArray<string>).includes(s);
}

/** Build accountability for an admin-side action where the actor is
 *  the logged-in user. Defaults the accountable employee to the user's
 *  linked employees row; the form may override (supervisor-on-behalf
 *  path) by passing overrideEmployeeId, which the resolver looks up. */
export async function resolveAdminAccountability(
  tx: Tx,
  args: {
    actor: { id: string; employeeId: string | null };
    overrideEmployeeId?: string | null;
    overrideEmployeeCode?: string | null;
  },
): Promise<AccountabilityForEvent> {
  const { actor } = args;
  // Per-form override wins (SUPERVISOR_OVERRIDE).
  const overrideId = trimOrNull(args.overrideEmployeeId);
  const overrideCode = trimOrNull(args.overrideEmployeeCode);
  if (overrideId || overrideCode) {
    const r = await resolveAccountableEmployee(tx, {
      ...(overrideId ? { employeeId: overrideId } : {}),
      ...(overrideCode ? { employeeCode: overrideCode } : {}),
      sourceHint: "SUPERVISOR_OVERRIDE",
    });
    if (r) {
      return {
        enteredByUserId: actor.id,
        accountableEmployeeId: r.accountableEmployeeId,
        accountabilitySource: r.source,
        accountableEmployeeNameSnapshot: r.nameSnapshot,
        isStable: r.isStable,
      };
    }
  }
  // Default: admin acting as themselves. Resolve their linked employee
  // for the name snapshot; null is fine (system / bootstrap accounts).
  if (actor.employeeId) {
    const r = await resolveAccountableEmployee(tx, {
      employeeId: actor.employeeId,
      sourceHint: "LOGGED_IN_USER",
    });
    if (r) {
      return {
        enteredByUserId: actor.id,
        accountableEmployeeId: r.accountableEmployeeId,
        accountabilitySource: r.source,
        accountableEmployeeNameSnapshot: r.nameSnapshot,
        isStable: r.isStable,
      };
    }
  }
  // Admin user with no linked employee row — entered_by is the user,
  // accountable employee unknown. Source LOGGED_IN_USER + null id.
  return {
    enteredByUserId: actor.id,
    accountableEmployeeId: null,
    accountabilitySource: "LOGGED_IN_USER",
    accountableEmployeeNameSnapshot: null,
    isStable: false,
  };
}

/** Merge accountability fields into a material-event payload. Used by
 *  call sites that write directly to material_inventory_events (no
 *  workflow_events FK columns to populate, so the metadata rides
 *  inside the payload). Workflow-event call sites should use
 *  projectEvent's first-class fields instead. */
export function withAccountabilityPayload(
  payload: Record<string, unknown>,
  accountability: AccountabilityForEvent,
): Record<string, unknown> {
  const out = { ...payload };
  if (accountability.accountableEmployeeId) {
    out.accountable_employee_id = accountability.accountableEmployeeId;
  }
  if (accountability.accountabilitySource) {
    out.accountability_source = accountability.accountabilitySource;
  }
  if (accountability.accountableEmployeeNameSnapshot) {
    out.accountable_employee_name_snapshot =
      accountability.accountableEmployeeNameSnapshot;
  }
  return out;
}

/** Re-export for convenience so call sites only import one module. */
export { resolveAccountableEmployee, type AccountabilityInput };
