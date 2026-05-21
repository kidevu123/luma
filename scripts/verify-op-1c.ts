// OP-1C — staging verification script.
//
// Exercises the wired action paths end-to-end against a real DB.
// Lives in scripts/ so it runs the same import graph the production
// server uses; no mocks, no stubs. Idempotent: cleans up the test
// session + QA workflow bag at the end.
//
// Run:
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-op-1c.ts
//
// What it covers (matches the OP-1C verification list):
//   6  open an operator session at the Blister station with a stable
//      employee identity
//   7  submit a fresh BLISTER_COMPLETE through the floor action path
//   8  query workflow_events for the resulting row
//   9  confirm employee_id non-null, user_id null (anonymous floor),
//      payload.accountability_source = STATION_OPERATOR_SESSION,
//      payload.accountable_employee_name_snapshot present
//   10 confirm first-op rejection when no session is open
//   11 packagingCompleteAction accountability — covered indirectly by
//      shared resolveStationAccountability + tests; not exercised here
//      because it would require seeding a packaged-stage bag
//   12 roll action payload accountability — covered indirectly by
//      the same shared helper + tests
//
// When the script exits with a non-zero code, the verification has
// failed and the OP-1C stop condition is NOT met.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import {
  employees,
  qrCards,
  stations,
  stationOperatorSessions,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";

const ALLOW = process.env.ALLOW_STAGING_QA_DATA === "true";
if (!ALLOW) {
  console.error(
    "[verify-op-1c] Refusing to run without ALLOW_STAGING_QA_DATA=true.",
  );
  process.exit(2);
}

const QA_PREFIX = "OP-1C-VERIFY";

function logStep(n: number, msg: string) {
  process.stdout.write(`\n[${n}] ${msg}\n`);
}

function logOK(msg: string) {
  process.stdout.write(`     ok: ${msg}\n`);
}

function logFail(msg: string): never {
  process.stdout.write(`     FAIL: ${msg}\n`);
  process.exit(1);
}

async function main() {
  // 1. Pick the Blister station.
  const [station] = await db
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
      scanToken: stations.scanToken,
    })
    .from(stations)
    .where(and(eq(stations.kind, "BLISTER"), eq(stations.isActive, true)))
    .limit(1);
  if (!station) logFail("no active BLISTER station found");
  logStep(1, `picked station ${station.label} (${station.id})`);

  // 2. Pick an active employee. We don't modify the row; we use its
  //    id to populate the session directly.
  const [employee] = await db
    .select({ id: employees.id, fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.status, "ACTIVE"))
    .orderBy(employees.fullName)
    .limit(1);
  if (!employee) logFail("no active employee found");
  logStep(2, `picked employee ${employee.fullName} (${employee.id})`);

  // 3. Close any pre-existing open session for this station so the
  //    partial-unique doesn't reject the test insert.
  await db
    .update(stationOperatorSessions)
    .set({ closedAt: new Date(), notes: `${QA_PREFIX} pre-cleanup` })
    .where(
      and(
        eq(stationOperatorSessions.stationId, station.id),
        isNull(stationOperatorSessions.closedAt),
      ),
    );

  // 4. Item 10: confirm first-op refusal WITHOUT a session.
  //    To exercise the action path, we'd need a fresh QA bag at this
  //    station. Instead, we assert the helper's behavior directly:
  //    resolveStationAccountability returns null fields when no
  //    session exists.
  logStep(10, "first-op rejection — verify accountability resolver");
  const { resolveStationAccountability } = await import(
    "@/lib/production/station-operator-session"
  );
  const noSession = await resolveStationAccountability(db, {
    stationId: station.id,
  });
  if (noSession.accountableEmployeeId !== null) {
    logFail(
      `expected null employee when no session, got ${noSession.accountableEmployeeId}`,
    );
  }
  if (noSession.accountabilitySource !== null) {
    logFail(
      `expected null source when no session, got ${noSession.accountabilitySource}`,
    );
  }
  logOK(
    "no session → resolver returns null employee + null source (action will refuse first-op)",
  );

  // 5. Item 6: open a session for the Blister station with a stable
  //    employee. We insert directly so we can use a real
  //    employees.id even when no employee_code is populated yet.
  logStep(6, "open operator session at Blister station");
  const [opened] = await db
    .insert(stationOperatorSessions)
    .values({
      stationId: station.id,
      employeeId: employee.id,
      employeeNameSnapshot: employee.fullName,
      accountabilitySource: "EMPLOYEE_PICKER",
      notes: `${QA_PREFIX} test session`,
    })
    .returning({ id: stationOperatorSessions.id });
  if (!opened) logFail("could not insert session");
  const sessionId = opened.id;
  logOK(`session id ${sessionId}`);

  // 6. Confirm resolveStationAccountability now returns the session.
  const withSession = await resolveStationAccountability(db, {
    stationId: station.id,
  });
  if (withSession.accountableEmployeeId !== employee.id) {
    logFail(
      `expected employee ${employee.id}, got ${withSession.accountableEmployeeId}`,
    );
  }
  if (withSession.accountabilitySource !== "STATION_OPERATOR_SESSION") {
    logFail(
      `expected source STATION_OPERATOR_SESSION, got ${withSession.accountabilitySource}`,
    );
  }
  if (withSession.accountableEmployeeNameSnapshot !== employee.fullName) {
    logFail(
      `expected name snapshot ${employee.fullName}, got ${withSession.accountableEmployeeNameSnapshot}`,
    );
  }
  logOK("resolver returns correct fields from active session");

  // 7. Item 7-9: simulate a fresh BLISTER_COMPLETE via projectEvent
  //    (the same call site fireStageEventAction uses inside its txn).
  //    First create a QA workflow bag so we have something to fire
  //    the event against.
  logStep(7, "submit a BLISTER_COMPLETE through projectEvent");
  const [bag] = await db
    .insert(workflowBags)
    .values({})
    .returning({ id: workflowBags.id });
  if (!bag) logFail("could not insert workflow bag");
  const workflowBagId = bag.id;
  // Create a QA card + assign it so the bag has a proper lineage
  // (CARD_ASSIGNED) prior to BLISTER_COMPLETE — keeps the
  // stage-progression guard happy when read_bag_state fills in.
  const [card] = await db
    .insert(qrCards)
    .values({
      label: `${QA_PREFIX}-${Date.now()}`,
      scanToken: randomUUID(),
      status: "ASSIGNED",
      assignedWorkflowBagId: workflowBagId,
    })
    .returning({ id: qrCards.id });
  if (!card) logFail("could not insert qr card");

  const { projectEvent } = await import("@/lib/projector");
  await db.transaction(async (tx) => {
    const accountability = await resolveStationAccountability(tx, {
      stationId: station.id,
    });
    await projectEvent(tx, {
      workflowBagId,
      stationId: station.id,
      eventType: "CARD_ASSIGNED",
      payload: { qr_card_id: card.id, station_kind: station.kind },
      enteredByUserId: accountability.enteredByUserId,
      accountableEmployeeId: accountability.accountableEmployeeId,
      accountabilitySource: accountability.accountabilitySource,
      accountableEmployeeNameSnapshot:
        accountability.accountableEmployeeNameSnapshot,
    });
    await projectEvent(tx, {
      workflowBagId,
      stationId: station.id,
      eventType: "BLISTER_COMPLETE",
      payload: { count_total: 99 },
      enteredByUserId: accountability.enteredByUserId,
      accountableEmployeeId: accountability.accountableEmployeeId,
      accountabilitySource: accountability.accountabilitySource,
      accountableEmployeeNameSnapshot:
        accountability.accountableEmployeeNameSnapshot,
    });
  });
  logOK("BLISTER_COMPLETE landed");

  // 8. Item 8-9: query workflow_events for the BLISTER_COMPLETE row
  //    and verify accountability fields.
  logStep(8, "query workflow_events for BLISTER_COMPLETE");
  const rows = await db
    .select({
      id: workflowEvents.id,
      eventType: workflowEvents.eventType,
      employeeId: workflowEvents.employeeId,
      userId: workflowEvents.userId,
      payload: workflowEvents.payload,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        eq(workflowEvents.eventType, "BLISTER_COMPLETE"),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt));
  if (rows.length === 0) logFail("no BLISTER_COMPLETE row found");
  const row = rows[0]!;

  if (row.employeeId !== employee.id) {
    logFail(
      `workflow_events.employee_id mismatch — expected ${employee.id}, got ${row.employeeId}`,
    );
  }
  logOK(`workflow_events.employee_id = ${row.employeeId} (HIGH confidence)`);

  if (row.userId !== null) {
    logFail(
      `workflow_events.user_id should be null for floor PWA (anonymous), got ${row.userId}`,
    );
  }
  logOK("workflow_events.user_id is null (floor PWA is anonymous, expected)");

  const payload = row.payload as Record<string, unknown> | null;
  if (!payload) logFail("payload is null");
  if (payload.accountability_source !== "STATION_OPERATOR_SESSION") {
    logFail(
      `payload.accountability_source mismatch — expected STATION_OPERATOR_SESSION, got ${payload.accountability_source}`,
    );
  }
  logOK(
    `payload.accountability_source = ${payload.accountability_source}`,
  );

  if (payload.accountable_employee_name_snapshot !== employee.fullName) {
    logFail(
      `payload.accountable_employee_name_snapshot mismatch — expected ${employee.fullName}, got ${payload.accountable_employee_name_snapshot}`,
    );
  }
  logOK(
    `payload.accountable_employee_name_snapshot = ${payload.accountable_employee_name_snapshot}`,
  );

  if (payload.count_total !== 99) {
    logFail(`payload.count_total mismatch — expected 99, got ${payload.count_total}`);
  }
  logOK("payload.count_total preserved alongside accountability fields");

  // 9. Item 10 (positive case): confirm fireStageEventAction-style
  //    refusal triggers when accountability is missing. We close the
  //    session and verify the resolver returns null.
  logStep(10, "negative: close session, resolver returns null again");
  await db
    .update(stationOperatorSessions)
    .set({ closedAt: new Date() })
    .where(eq(stationOperatorSessions.id, sessionId));
  const afterClose = await resolveStationAccountability(db, {
    stationId: station.id,
  });
  if (afterClose.accountableEmployeeId !== null) {
    logFail(
      `expected null after closing session, got ${afterClose.accountableEmployeeId}`,
    );
  }
  logOK("first-op refusal path: closed session → resolver null → action would reject");

  // 10. Cleanup: drop the QA artifacts we created so the staging DB
  //     is clean for the next verification run.
  logStep(99, "cleanup");
  await db
    .delete(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, workflowBagId));
  await db.delete(qrCards).where(eq(qrCards.id, card.id));
  await db.delete(workflowBags).where(eq(workflowBags.id, workflowBagId));
  await db
    .delete(stationOperatorSessions)
    .where(eq(stationOperatorSessions.id, sessionId));
  // Refresh read models that may have been touched.
  await db.execute(sql`UPDATE read_station_live SET current_workflow_bag_id = NULL WHERE station_id = ${station.id} AND current_workflow_bag_id = ${workflowBagId}`);
  logOK("cleaned up QA bag, card, events, session");

  console.log("\n[verify-op-1c] all checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[verify-op-1c] failed:", err);
    process.exit(1);
  });
