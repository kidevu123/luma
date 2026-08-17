// P5-SUPERVISOR Task 2 — station supervisor session engine.
//
// One module owns unlock / lock / require-session for the 15-minute
// supervisor PIN sessions the tablet leans on to gate qc/rolls/bag-
// allocation/variety and RESOLVE_PARTIAL. Reuses lib/auth.ts's
// argon2id verify — the id-mode hash/verify pair added in the payroll
// bootstrap that lib/auth.ts:89-99 already fronts — so hashing
// parameters live in exactly one place and cannot drift.
//
// FAILURE-MODE UNIFICATION. openSupervisorSession collapses every
// unlock refusal into ONE blocker: SUPERVISOR_PIN_INVALID with the
// operator sentence "That code and PIN combination does not unlock
// this station." The specific cause (unknown code, wrong pin, not a
// supervisor, no pin set) lives in `supervisorDetail` only — the
// operator screen surfaces the sentence, the ? Help panel surfaces
// the detail once a supervisor has unlocked. This is the "no oracle"
// requirement in the plan: a caller poking codes cannot tell which
// leg of the check failed, which turns brute-forcing the population
// of supervisors into brute-forcing (code, PIN) pairs instead.
//
// TIMING-ORACLE HARDENING. If we returned early on "unknown code" or
// "no hash set", the argon2 verify — which is the expensive step —
// would only run on the wrong-PIN leg. That would make the missing-
// employee path measurably faster than the wrong-PIN path, and a
// remote caller could distinguish "code exists" from "code doesn't"
// by wall-clock timing. We defend by running verifyPassword against
// a cached dummy argon2id hash on those legs too, so every rejection
// path pays the same argon2 cost. See DUMMY_PIN_HASH below.
//
// PIN MATERIAL DISCIPLINE. The literal `pin` appears in this module
// ONLY as the input-type field and as the argument to
// verifyPassword. No payload, audit entry, or error string carries
// pin material; the source-scan test in supervisor-session.test.ts
// pins this by construction.
//
// RATE LIMITING. No rate limiting on unlock attempts today. Current
// mitigations: station scan-token boundary (unlock only reachable via
// authed station URL), LAN-only deployment, audit trail on every
// attempt path, and PIN length enforced admin-side. If floor tablets
// ever leave the LAN, add per-station throttle here. Revisit in P6.

import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  employees,
  stationSupervisorSessions,
  type StationSupervisorSession,
} from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { writeAudit } from "@/lib/db/audit";
import type { Blocker } from "./types";
import {
  SUPERVISOR_SESSION_TTL_MS,
  type SupervisorSessionSnapshot,
} from "./supervisor-session-remaining";

// Re-export the pure ticker surface so server callers keep importing
// the whole supervisor-session API from one module while the client
// barrel pulls the pure half from supervisor-session-remaining.ts.
export {
  SUPERVISOR_SESSION_TTL_MS,
  supervisorSessionRemainingSeconds,
} from "./supervisor-session-remaining";
export type { SupervisorSessionSnapshot } from "./supervisor-session-remaining";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OpenSupervisorSessionInput = {
  stationId: string;
  employeeCode: string;
  /** Cleartext supervisor PIN as typed on the sheet. Present ONLY as
   *  the argon2id-verify argument below — never persisted, logged,
   *  echoed, or included in any payload. */
  pin: string;
};

export type OpenSupervisorSessionResult =
  | { ok: true; session: SupervisorSessionSnapshot }
  | { ok: false; blocker: Blocker };

/** The single sentence every unlock refusal returns — the "no
 *  oracle" requirement in the P5 plan. Cause distinctions live in
 *  supervisorDetail on the blocker, never in this string. */
const UNLOCK_REFUSAL_SENTENCE =
  "That code and PIN combination does not unlock this station.";

/** P5-SUPERVISOR Task 4 — the one sentence every server-side gate
 *  returns when a mutation was attempted without an OPEN supervisor
 *  session. Shared across all surfaces so the operator sees the same
 *  copy regardless of which action refused: qc, roll, bag-allocation,
 *  variety, or hold-release. Every gated action wraps the sentence in
 *  its own return shape (`{ error, code? }`), no other string is used. */
export const SUPERVISOR_GATE_REFUSAL_SENTENCE =
  "Supervisor unlock required for this.";

/** P5-SUPERVISOR Task 4 — the stable error code every gated refusal
 *  carries. Screens do not string-match the sentence; they match
 *  this code when they need to decide "reopen the supervisor sheet"
 *  vs. "show a generic error toast". */
export const SUPERVISOR_GATE_REFUSAL_CODE = "SUPERVISOR_UNLOCK_REQUIRED";

function unlockRefusal(supervisorDetail: string): Blocker {
  return {
    code: "SUPERVISOR_PIN_INVALID",
    operatorSentence: UNLOCK_REFUSAL_SENTENCE,
    supervisorDetail,
    suggestedAction: "NONE",
  };
}

// A single dummy argon2id hash, computed lazily on first miss and
// then reused. Every rejection path (unknown code / not a supervisor
// / no PIN set) runs verifyPassword against this hash so the code
// paths that don't have a real employee hash still incur the argon2
// cost — closes the timing side-channel described in the header.
let dummyPinHashPromise: Promise<string> | null = null;
function getDummyPinHash(): Promise<string> {
  if (dummyPinHashPromise == null) {
    // Fixed sentinel string; the value is irrelevant because verify
    // will always fail against it — we only need SOMETHING with a
    // valid argon2id shape to feed the verifier.
    dummyPinHashPromise = hashPassword("__luma_supervisor_dummy_pin__");
  }
  return dummyPinHashPromise;
}

/** Open a supervisor session for a station. Runs one transaction:
 *   1. look up ACTIVE employee by code
 *   2. verify the PIN against the stored argon2id hash (or a dummy
 *      hash on any leg where a real hash isn't available, so the
 *      caller cannot time-attack the difference)
 *   3. close any existing OPEN session for the station
 *   4. insert the new session with expires_at = now() + TTL
 *   5. writeAudit SUPERVISOR_UNLOCK (no PIN material in payload)
 *  Total function: never throws for the four canonical refusal
 *  causes; the { ok:false, blocker } path carries a single generic
 *  operatorSentence with the specific cause in supervisorDetail. */
export async function openSupervisorSession(
  input: OpenSupervisorSessionInput,
): Promise<OpenSupervisorSessionResult> {
  const code = input.employeeCode.trim();
  if (code.length === 0) {
    // Symmetrical timing: still burn one argon2 verify so an empty
    // code isn't measurably faster than the "code missed" leg.
    await verifyPassword(input.pin, await getDummyPinHash());
    return { ok: false, blocker: unlockRefusal("Employee code was empty.") };
  }

  const [emp] = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      preferredName: employees.preferredName,
      isSupervisor: employees.isSupervisor,
      supervisorPinHash: employees.supervisorPinHash,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.employeeCode, code));

  // Two rejection legs where we deliberately still run verifyPassword
  // against the dummy hash before returning: the cost profile of a
  // successful lookup + failed verify is what we want every refusal to
  // match. Comment repeats the header rationale so a future editor
  // doesn't "optimise" the dummy verify away.
  if (!emp || emp.status !== "ACTIVE") {
    await verifyPassword(input.pin, await getDummyPinHash());
    return {
      ok: false,
      blocker: unlockRefusal(
        !emp
          ? "No employees row matched the supplied code."
          : "Employee is not ACTIVE.",
      ),
    };
  }
  if (!emp.isSupervisor) {
    await verifyPassword(input.pin, await getDummyPinHash());
    return {
      ok: false,
      blocker: unlockRefusal("Employee is not marked as a supervisor."),
    };
  }
  if (emp.supervisorPinHash == null) {
    await verifyPassword(input.pin, await getDummyPinHash());
    return {
      ok: false,
      blocker: unlockRefusal("Supervisor has no PIN set."),
    };
  }

  const pinOk = await verifyPassword(input.pin, emp.supervisorPinHash);
  if (!pinOk) {
    return {
      ok: false,
      blocker: unlockRefusal("Supplied PIN did not verify."),
    };
  }

  const displayName = (emp.preferredName?.trim() || emp.fullName).trim();

  let snapshot: SupervisorSessionSnapshot | null = null;
  await db.transaction(async (tx) => {
    // Close any existing OPEN session for this station before
    // inserting — the partial unique index enforces at-most-one open
    // row per station, and this update is what makes the invariant
    // safe to hold under a handoff.
    await tx
      .update(stationSupervisorSessions)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(stationSupervisorSessions.stationId, input.stationId),
          isNull(stationSupervisorSessions.closedAt),
        ),
      );

    const openedAt = new Date();
    const expiresAt = new Date(openedAt.getTime() + SUPERVISOR_SESSION_TTL_MS);
    const [inserted] = await tx
      .insert(stationSupervisorSessions)
      .values({
        stationId: input.stationId,
        employeeId: emp.id,
        openedAt,
        expiresAt,
      })
      .returning({
        id: stationSupervisorSessions.id,
        expiresAt: stationSupervisorSessions.expiresAt,
      });
    if (!inserted) {
      // Belt-and-braces: RETURNING on an insert we just wrote should
      // never produce zero rows, but a total-function contract has to
      // handle it. Throwing here rolls the tx and surfaces as a 500;
      // the caller's Report to Sentry path picks it up.
      throw new Error("SUPERVISOR_UNLOCK insert returned no row.");
    }
    snapshot = {
      id: inserted.id,
      employeeName: displayName,
      expiresAt: inserted.expiresAt,
    };

    await writeAudit(
      {
        // Floor unlocks are anonymous kiosk events (no logged-in
        // user), the same accountability shape operator-session
        // open/close audit rows use. The supervisor's identity lives
        // in `after.employee_id`, NOT actorId.
        actorId: null,
        actorRole: null,
        action: "SUPERVISOR_UNLOCK",
        targetType: "Station",
        targetId: input.stationId,
        after: {
          session_id: inserted.id,
          employee_id: emp.id,
          employee_name: displayName,
          expires_at: inserted.expiresAt.toISOString(),
        },
      },
      tx,
    );
  });

  // snapshot is populated inside the tx; the assignment above is
  // reached on every successful path. Narrow with an assertion so
  // TypeScript sees a non-null return.
  if (snapshot == null) {
    throw new Error("SUPERVISOR_UNLOCK transaction did not produce a snapshot.");
  }
  return { ok: true, session: snapshot };
}

/** Close whatever OPEN session the station has, if any. Writes a
 *  SUPERVISOR_LOCK audit row only when a session was actually closed
 *  — a click on Exit with no session already open is a no-op, not an
 *  audit trail entry. */
export async function closeSupervisorSession(
  stationId: string,
): Promise<{ closed: boolean }> {
  let closedSessionId: string | null = null;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: stationSupervisorSessions.id,
        employeeId: stationSupervisorSessions.employeeId,
      })
      .from(stationSupervisorSessions)
      .where(
        and(
          eq(stationSupervisorSessions.stationId, stationId),
          isNull(stationSupervisorSessions.closedAt),
        ),
      );
    if (!row) return;
    await tx
      .update(stationSupervisorSessions)
      .set({ closedAt: new Date() })
      .where(eq(stationSupervisorSessions.id, row.id));
    closedSessionId = row.id;
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "SUPERVISOR_LOCK",
        targetType: "Station",
        targetId: stationId,
        after: {
          session_id: row.id,
          employee_id: row.employeeId,
        },
      },
      tx,
    );
  });
  return { closed: closedSessionId !== null };
}

/** Return the OPEN, unexpired supervisor session row for a station,
 *  or null. Callers depend on "null means locked" — gating code
 *  chains `if (!session) throw` off this contract. Lazily closes
 *  expired rows so an unlock that was never explicitly exited stops
 *  gating the moment its TTL elapses. Pure-read fallback shape:
 *  when this runs inside a caller's own transaction we honour it;
 *  when called from a request path with no tx we use the default
 *  db handle. */
export async function requireSupervisorSession(
  tx: Tx,
  stationId: string,
): Promise<Pick<
  StationSupervisorSession,
  "id" | "employeeId" | "openedAt" | "expiresAt"
> | null> {
  const now = new Date();

  // First lazily close expired-but-open rows for this station. Doing
  // this inside the caller's tx keeps the read consistent — the SELECT
  // below sees the update from the same snapshot.
  await tx
    .update(stationSupervisorSessions)
    .set({ closedAt: now })
    .where(
      and(
        eq(stationSupervisorSessions.stationId, stationId),
        isNull(stationSupervisorSessions.closedAt),
        lt(stationSupervisorSessions.expiresAt, now),
      ),
    );

  const [row] = await tx
    .select({
      id: stationSupervisorSessions.id,
      employeeId: stationSupervisorSessions.employeeId,
      openedAt: stationSupervisorSessions.openedAt,
      expiresAt: stationSupervisorSessions.expiresAt,
    })
    .from(stationSupervisorSessions)
    .where(
      and(
        eq(stationSupervisorSessions.stationId, stationId),
        isNull(stationSupervisorSessions.closedAt),
      ),
    );
  return row ?? null;
}

