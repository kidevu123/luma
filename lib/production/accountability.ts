// OP-1B — accountability resolver.
//
// Translates whatever identity the caller has (employee UUID, short
// employee code, badge subject, or free text) into a stable
// (employeeId | null) + a source label + a name snapshot. Used by
// admin- and floor-side count submissions so workflow_events.employee_id
// gets populated honestly with HIGH/MEDIUM/LOW confidence semantics
// downstream.
//
// Pure-ish: takes a Db / Tx for the code → id lookup, but the source
// classification logic is deterministic and tested on its own.

import { and, eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { employees, type Employee } from "@/lib/db/schema";

import type { AccountabilitySource } from "@/lib/projector";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

/** Ordered by precedence — when multiple identity inputs are provided
 *  the first one that resolves wins, and the source is recorded. */
export type AccountabilityInput = {
  /** Already-resolved employee ID (e.g. from a station-operator session
   *  or admin-side currentUser().employeeId). */
  employeeId?: string | null;
  /** Operator-friendly badge / login code (employees.employee_code). */
  employeeCode?: string | null;
  /** OIDC `sub` claim from a badge scanner integration. Reserved for
   *  future BADGE_SCAN flow; resolves the same as employeeCode for now. */
  badgeSubject?: string | null;
  /** Free text — typed name or arbitrary string. Last-resort fallback;
   *  always lands as LEGACY_TEXT / MANUAL_TEXT and never resolves to a
   *  stable id. */
  freeText?: string | null;
  /** Hint from the caller about how this identity was selected — only
   *  consulted when the resolver can't infer a more specific source.
   *  Lets the floor flag SUPERVISOR_OVERRIDE / EMPLOYEE_PICKER paths. */
  sourceHint?: AccountabilitySource | null;
};

export type AccountabilityResolution = {
  accountableEmployeeId: string | null;
  accountableEmployeeCode: string | null;
  nameSnapshot: string | null;
  source: AccountabilitySource;
  /** True when the resolver mapped to an actual employees row.
   *  False for LEGACY_TEXT / MANUAL_TEXT fallbacks. */
  isStable: boolean;
};

/** Strict mode rejects free-text fallback; non-strict (default) keeps it. */
export type ResolveOptions = {
  strict?: boolean;
};

const TRIM = (v: string | null | undefined): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
};

/** Resolve an accountable employee from any of the input identity
 *  shapes. Falls back to LEGACY_TEXT (or MANUAL_TEXT — the source hint
 *  selects between them) only when no stable lookup hits. Returns null
 *  in strict mode if nothing resolves. */
export async function resolveAccountableEmployee(
  tx: Tx,
  input: AccountabilityInput,
  opts: ResolveOptions = {},
): Promise<AccountabilityResolution | null> {
  const employeeId = TRIM(input.employeeId);
  const employeeCode = TRIM(input.employeeCode);
  const badgeSubject = TRIM(input.badgeSubject);
  const freeText = TRIM(input.freeText);

  // 1) Explicit employee id wins.
  if (employeeId) {
    const row = await loadEmployeeById(tx, employeeId);
    if (row) {
      return {
        accountableEmployeeId: row.id,
        accountableEmployeeCode: row.employeeCode ?? null,
        nameSnapshot: row.fullName,
        source: input.sourceHint ?? "LOGGED_IN_USER",
        isStable: true,
      };
    }
  }

  // 2) Active employee_code lookup (case-insensitive trim).
  //    UUID-shaped values MUST go through the ID path (loadEmployeeById)
  //    rather than the code path (loadActiveEmployeeByCode). The postgres
  //    driver sends UUID-formatted strings with the uuid OID; comparing
  //    that against the text employee_code column raises
  //    "operator does not exist: text = uuid" in PostgreSQL.
  if (employeeCode) {
    if (isUuid(employeeCode)) {
      const row = await loadEmployeeById(tx, employeeCode);
      if (row) {
        return {
          accountableEmployeeId: row.id,
          accountableEmployeeCode: row.employeeCode ?? null,
          nameSnapshot: row.fullName,
          source: input.sourceHint ?? "EMPLOYEE_CODE",
          isStable: true,
        };
      }
    } else {
      const row = await loadActiveEmployeeByCode(tx, employeeCode);
      if (row) {
        return {
          accountableEmployeeId: row.id,
          accountableEmployeeCode: row.employeeCode ?? null,
          nameSnapshot: row.fullName,
          source: input.sourceHint ?? "EMPLOYEE_CODE",
          isStable: true,
        };
      }
    }
  }

  // 3) Badge subject — wired the same as employee_code today; reserved
  //    for a real OIDC subject lookup once a hardware reader lands.
  if (badgeSubject) {
    const row = await loadActiveEmployeeByCode(tx, badgeSubject);
    if (row) {
      return {
        accountableEmployeeId: row.id,
        accountableEmployeeCode: row.employeeCode ?? null,
        nameSnapshot: row.fullName,
        source: "BADGE_SCAN",
        isStable: true,
      };
    }
  }

  // 4) Free-text fallback. In strict mode we refuse — caller decides.
  if (freeText) {
    if (opts.strict) return null;
    return {
      accountableEmployeeId: null,
      accountableEmployeeCode: null,
      nameSnapshot: freeText,
      source: input.sourceHint === "MANUAL_TEXT" ? "MANUAL_TEXT" : "LEGACY_TEXT",
      isStable: false,
    };
  }

  // 5) Nothing resolved.
  return null;
}

async function loadEmployeeById(
  tx: Tx,
  employeeId: string,
): Promise<Pick<Employee, "id" | "fullName" | "employeeCode" | "status"> | null> {
  if (!isUuid(employeeId)) return null;
  const [row] = await tx
    .select({
      id: employees.id,
      fullName: employees.fullName,
      employeeCode: employees.employeeCode,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.id, employeeId));
  return row ?? null;
}

async function loadActiveEmployeeByCode(
  tx: Tx,
  rawCode: string,
): Promise<Pick<Employee, "id" | "fullName" | "employeeCode" | "status"> | null> {
  // Codes are operator-typed; collapse case + whitespace at the
  // resolver boundary so "1042" / " 1042 " / "abc" / "ABC" all hit.
  const code = rawCode.trim();
  if (code.length === 0) return null;
  const [row] = await tx
    .select({
      id: employees.id,
      fullName: employees.fullName,
      employeeCode: employees.employeeCode,
      status: employees.status,
    })
    .from(employees)
    .where(
      and(
        sql`lower(${employees.employeeCode}) = lower(${code})`,
        eq(employees.status, "ACTIVE"),
      ),
    );
  return row ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string is a canonical employees.id UUID shape. Exported so
 *  floor call sites can route identity to employeeId vs employeeCode. */
export function isEmployeeUuidShape(s: string): boolean {
  return UUID_RE.test(s);
}

function isUuid(s: string): boolean {
  return isEmployeeUuidShape(s);
}

/** Pure helper: classify accountability confidence from the resolver
 *  source. HIGH = stable id from a logged-in user / picker / scan;
 *  MEDIUM = stable id from a typed code (typo risk); LOW = free text.
 *
 *  Used by metrics surfaces to band confidence consistently with the
 *  existing HIGH/MEDIUM/LOW/MISSING ladder. */
export function accountabilityConfidence(
  source: AccountabilitySource | null,
  isStable: boolean,
): "HIGH" | "MEDIUM" | "LOW" | "MISSING" {
  if (!source) return "MISSING";
  if (!isStable) return "LOW";
  switch (source) {
    case "LOGGED_IN_USER":
    case "EMPLOYEE_PICKER":
    case "BADGE_SCAN":
    case "SUPERVISOR_OVERRIDE":
    case "STATION_OPERATOR_SESSION":
      return "HIGH";
    case "EMPLOYEE_CODE":
      return "MEDIUM";
    case "LEGACY_TEXT":
    case "MANUAL_TEXT":
      return "LOW";
    default:
      return "MISSING";
  }
}
