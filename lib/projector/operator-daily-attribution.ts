// OP-1E — pure helper for operator productivity attribution.
//
// Given the events of a finalized bag, returns the set of distinct
// accountable employees (preferred) plus the set of free-text
// operator codes that appeared in payloads but did NOT come with a
// resolved employee_id. The projector's per-(day, operator) rollup
// upserts one row per accountable employee, plus one row per
// code-only operator (for legacy bags before OP-1B / OP-1C).
//
// Honest data rule: when an event has BOTH employee_id and a payload
// operator_code, the event is attributed to the employee — its code
// goes onto the employee row as a tag, not as a separate identity.
// That avoids double-counting the same bag under two different
// row-keys.

export type AttributionEvent = {
  /** workflow_events.employee_id when accountability resolved at the
   *  time the event landed; null otherwise. */
  employeeId: string | null;
  /** Payload operator_code if the operator typed one. May be null. */
  operatorCode: string | null;
};

export type OperatorAttribution = {
  /** Employee ids attributed to the bag. One row per id will be
   *  upserted on the (day, employee_id) partial-unique. */
  employees: Map<string, { operatorCode: string | null }>;
  /** Free-text codes attributed to the bag because no employee_id
   *  ever resolved for those events. One row per code will be upserted
   *  on the (day, operator_code) WHERE employee_id IS NULL legacy
   *  partial-unique. */
  codeOnly: Set<string>;
};

const TRIM = (v: string | null | undefined): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
};

/** Compute the per-bag attribution shape. The projector calls this
 *  once with the bag's full event list and then issues at most:
 *    - N upserts on (day, employee_id) — one per distinct employee
 *    - M upserts on (day, operator_code) — one per code that never
 *      came with an employee_id
 *
 *  An event whose employee_id is set anchors that bag's entire claim
 *  on its operator_code (if any) — the code goes on the employee row
 *  rather than producing a phantom legacy row alongside.
 */
export function attributeFinalizedBag(
  events: ReadonlyArray<AttributionEvent>,
): OperatorAttribution {
  const employees = new Map<string, { operatorCode: string | null }>();
  // Codes that travelled WITH an employee_id — these get tagged onto
  // the employee row, not promoted to a legacy code row.
  const codesClaimedByEmployees = new Set<string>();

  for (const ev of events) {
    const employeeId = TRIM(ev.employeeId);
    const code = TRIM(ev.operatorCode);
    if (employeeId) {
      const existing = employees.get(employeeId);
      // Prefer a non-null code over a null one for the row tag, but
      // never overwrite an already-set code with a different one —
      // the first code attached to an employee on this bag wins.
      if (existing) {
        if (existing.operatorCode == null && code != null) {
          existing.operatorCode = code;
        }
      } else {
        employees.set(employeeId, { operatorCode: code });
      }
      if (code) codesClaimedByEmployees.add(code);
    }
  }

  const codeOnly = new Set<string>();
  for (const ev of events) {
    const employeeId = TRIM(ev.employeeId);
    const code = TRIM(ev.operatorCode);
    if (employeeId) continue;
    if (code && !codesClaimedByEmployees.has(code)) {
      codeOnly.add(code);
    }
  }

  return { employees, codeOnly };
}
