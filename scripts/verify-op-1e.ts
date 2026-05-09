// OP-1E — staging verification.
//
// Confirms migration 0024 landed and that finalising a bag with
// accountability populates read_operator_daily.employee_id (non-null,
// HIGH-confidence row) without double-counting against operator_code.
// Cleans up after itself.
//
//   ALLOW_STAGING_QA_DATA=true npx tsx scripts/verify-op-1e.ts

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  employees,
  qrCards,
  readOperatorDaily,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import { stationOperatorSessions } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";

const ALLOW = process.env.ALLOW_STAGING_QA_DATA === "true";
if (!ALLOW) {
  console.error("[verify-op-1e] Refusing without ALLOW_STAGING_QA_DATA=true.");
  process.exit(2);
}

function logStep(n: string, msg: string) {
  process.stdout.write(`\n[${n}] ${msg}\n`);
}
function logOK(msg: string) {
  process.stdout.write(`     ok: ${msg}\n`);
}
function logFail(msg: string): never {
  process.stdout.write(`     FAIL: ${msg}\n`);
  process.exit(1);
}

const QA_PREFIX = "OP-1E-VERIFY";

async function main() {
  // 1. Confirm column + indexes exist (migration applied).
  logStep("1", "confirm read_operator_daily.employee_id column + indexes");
  const cols = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'read_operator_daily'
      AND column_name IN ('employee_id','operator_code')
  `)) as unknown as Array<{ column_name: string }>;
  const colNames = new Set(cols.map((c) => c.column_name));
  if (!colNames.has("employee_id")) {
    logFail("read_operator_daily.employee_id column missing");
  }
  if (!colNames.has("operator_code")) {
    logFail("read_operator_daily.operator_code column missing");
  }
  logOK(`columns present: ${[...colNames].sort().join(", ")}`);

  const idx = (await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE tablename = 'read_operator_daily'
  `)) as unknown as Array<{ indexname: string }>;
  const idxNames = new Set(idx.map((r) => r.indexname));
  if (!idxNames.has("read_operator_daily_day_employee_unique")) {
    logFail("missing read_operator_daily_day_employee_unique");
  }
  if (!idxNames.has("read_operator_daily_day_code_legacy_unique")) {
    logFail("missing read_operator_daily_day_code_legacy_unique");
  }
  logOK("partial unique indexes present (employee + legacy code)");

  const constraints = (await db.execute(sql`
    SELECT conname FROM pg_constraint WHERE conname = 'read_operator_daily_identity_chk'
  `)) as unknown as Array<{ conname: string }>;
  if (constraints.length === 0) {
    logFail("missing CHECK constraint read_operator_daily_identity_chk");
  }
  logOK("CHECK (employee_id OR operator_code) constraint present");

  // 2. Pick station + employee.
  const [station] = await db
    .select({ id: stations.id, label: stations.label, kind: stations.kind })
    .from(stations)
    .where(and(eq(stations.kind, "BLISTER"), eq(stations.isActive, true)))
    .limit(1);
  if (!station) logFail("no Blister station found");
  const [employee] = await db
    .select({ id: employees.id, fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.status, "ACTIVE"))
    .orderBy(employees.fullName)
    .limit(1);
  if (!employee) logFail("no active employee found");
  logOK(`picked station ${station.label}, employee ${employee.fullName}`);

  // 3. Snapshot current row counts so we can confirm clean increment.
  const today = new Date().toISOString().slice(0, 10);
  const [empBefore] = await db
    .select({ id: readOperatorDaily.id, bags: readOperatorDaily.bagsFinalized })
    .from(readOperatorDaily)
    .where(
      and(
        eq(readOperatorDaily.day, today),
        eq(readOperatorDaily.employeeId, employee.id),
      ),
    );
  const beforeBags = empBefore?.bags ?? 0;

  // 4. Open a station-operator session (so projectEvent + the
  //    projector accountability path latch onto a stable employee_id).
  await db
    .update(stationOperatorSessions)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(stationOperatorSessions.stationId, station.id),
        isNull(stationOperatorSessions.closedAt),
      ),
    );
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
  if (!opened) logFail("could not open session");
  const sessionId = opened.id;
  logOK(`opened operator session ${sessionId}`);

  // 5. Create QA bag + card and walk it to BAG_FINALIZED. The
  //    projector's per-(day, operator) rollup runs at finalize; this
  //    is what we're verifying.
  logStep("5", "drive a QA bag to BAG_FINALIZED with accountability");
  const [bag] = await db
    .insert(workflowBags)
    .values({})
    .returning({ id: workflowBags.id });
  if (!bag) logFail("could not insert bag");
  const bagId = bag.id;
  const [card] = await db
    .insert(qrCards)
    .values({
      label: `${QA_PREFIX}-${Date.now()}`,
      scanToken: crypto.randomUUID(),
      status: "ASSIGNED",
      assignedWorkflowBagId: bagId,
    })
    .returning({ id: qrCards.id });
  if (!card) logFail("could not insert card");

  await db.transaction(async (tx) => {
    const acc = await resolveStationAccountability(tx, {
      stationId: station.id,
    });
    const eventTypes: Array<{ t: "CARD_ASSIGNED" | "BLISTER_COMPLETE" | "SEALING_COMPLETE" | "PACKAGING_COMPLETE" | "BAG_FINALIZED"; payload?: Record<string, unknown> }> = [
      { t: "CARD_ASSIGNED", payload: { qr_card_id: card.id, station_kind: "BLISTER" } },
      { t: "BLISTER_COMPLETE", payload: { count_total: 100 } },
      { t: "SEALING_COMPLETE", payload: { count_total: 100 } },
      { t: "PACKAGING_COMPLETE", payload: { master_cases: 1, displays_made: 1, loose_cards: 0, damaged_packaging: 0, ripped_cards: 0 } },
      { t: "BAG_FINALIZED" },
    ];
    for (const e of eventTypes) {
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId: station.id,
        eventType: e.t,
        payload: e.payload ?? {},
        enteredByUserId: acc.enteredByUserId,
        accountableEmployeeId: acc.accountableEmployeeId,
        accountabilitySource: acc.accountabilitySource,
        accountableEmployeeNameSnapshot: acc.accountableEmployeeNameSnapshot,
      });
    }
  });
  logOK("walked CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED");

  // 6. Confirm read_operator_daily row keyed by (today, employee_id).
  logStep("6", "verify read_operator_daily row");
  const [empAfter] = await db
    .select({
      id: readOperatorDaily.id,
      employeeId: readOperatorDaily.employeeId,
      operatorCode: readOperatorDaily.operatorCode,
      bagsFinalized: readOperatorDaily.bagsFinalized,
    })
    .from(readOperatorDaily)
    .where(
      and(
        eq(readOperatorDaily.day, today),
        eq(readOperatorDaily.employeeId, employee.id),
      ),
    );
  if (!empAfter) logFail("no read_operator_daily row for (today, employee_id)");
  if (empAfter.employeeId !== employee.id) {
    logFail(`row employeeId mismatch: ${empAfter.employeeId} != ${employee.id}`);
  }
  if (empAfter.bagsFinalized !== beforeBags + 1) {
    logFail(
      `bags_finalized expected ${beforeBags + 1}, got ${empAfter.bagsFinalized}`,
    );
  }
  logOK(
    `row OK: employee_id=${empAfter.employeeId} bags_finalized=${empAfter.bagsFinalized} (was ${beforeBags})`,
  );

  // 7. Confirm no duplicate legacy code-only row was created for the
  //    same day. (operator_code on the bag's events was null because
  //    the modern flow uses the session, not a typed code.) The
  //    invariant: this finalize must NOT produce an employee_id-NULL
  //    legacy row whose updated_at landed in the last 5 seconds.
  logStep("7", "verify no duplicate legacy row");
  const recent = (await db.execute(sql`
    SELECT id, operator_code FROM read_operator_daily
    WHERE day = ${today}
      AND employee_id IS NULL
      AND updated_at >= now() - interval '5 seconds'
  `)) as unknown as Array<{ id: string; operator_code: string | null }>;
  if (recent.length > 0) {
    logFail(
      `found ${recent.length} legacy code-only row(s) updated in the last 5s — projector double-counted`,
    );
  }
  logOK("no double-counting (legacy row not created for this finalize)");

  // 8. Cleanup.
  logStep("99", "cleanup");
  await db.delete(workflowEvents).where(eq(workflowEvents.workflowBagId, bagId));
  await db.delete(qrCards).where(eq(qrCards.id, card.id));
  await db.delete(workflowBags).where(eq(workflowBags.id, bagId));
  await db
    .delete(stationOperatorSessions)
    .where(eq(stationOperatorSessions.id, sessionId));
  // Roll back the +1 we just made on the QA row so the leaderboard
  // isn't polluted by this test.
  if (empBefore) {
    await db
      .update(readOperatorDaily)
      .set({ bagsFinalized: beforeBags })
      .where(eq(readOperatorDaily.id, empBefore.id));
  } else {
    await db
      .delete(readOperatorDaily)
      .where(eq(readOperatorDaily.id, empAfter.id));
  }
  logOK("cleaned up bag, card, events, session, QA row delta");

  console.log("\n[verify-op-1e] all checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[verify-op-1e] failed:", err);
    process.exit(1);
  });
