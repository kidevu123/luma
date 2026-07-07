// Receipt 352176 bag 1 (MIT B Chocolate Brown, Hyroxi MIT B - Choco Drift)
// — the bag had TWO packaging sessions: 2026-05-19 (entered; paused end of
// shift) and the resumed 2026-05-20 morning session, which was never
// entered: +1 case, +1 display, +18 loose cards, +1 ripped card.
//
// The workflow (3117b05e) is an admin-entered summary run whose packaging
// counts were already corrected once (2026-07-02: 2 cases / 14 displays /
// 0 loose). This script issues the canonical SUBMISSION_CORRECTED field
// correction — the exact same path as the /workflow-submissions admin form
// (executeSubmissionFieldCorrection) — setting the totals to include the
// missed second session:
//
//   cases 2 -> 3, displays 14 -> 15, loose 0 -> 18, ripped 0 -> 1
//   units yielded (2x25+14)x20 = 1,280 -> (3x25+15)x20+18 = 1,818
//
// Canonical downstream effects (applySubmissionCorrectionDownstreamEffects):
//   - bag metrics reprojected by the projector
//   - finished lot CD-WALK-20260609-10 quantities updated and status set
//     ON_HOLD for review (re-release via admin UI after checking)
//   - uncommitted Zoho ops voided (this bag's only op is already VOIDED)
// Plus the metrics-sourced rollup rebuilds (daily throughput / SKU daily /
// station quality) so reports reflect the corrected units.
//
// Dry-run (default):
//   npx tsx scripts/correct-352176-second-packaging-session.ts
// Apply:
//   ALLOW_PRODUCTION_REPAIR=true npx tsx scripts/correct-352176-second-packaging-session.ts --apply

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import {
  validateQcPayload,
  type QCReasonCode,
  type SubmissionCorrectedPayload,
} from "@/lib/production/qc-events";
import {
  buildCorrectedValueFromFields,
  buildOriginalValueSnapshot,
  isCorrectableSubmissionEventType,
} from "@/lib/production/submission-correction-fields";
import { evaluateSubmissionCorrectionEligibility } from "@/lib/production/submission-correction-eligibility";
import {
  applySubmissionCorrectionDownstreamEffects,
  loadZohoOutputCommittedForWorkflowBag,
} from "@/lib/production/correction-downstream-effects";
import type { CurrentUser } from "@/lib/auth";
import { rebuildDailyThroughput } from "@/lib/projector/daily-throughput";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";

const SCRIPT_VERSION = "correct-352176-second-packaging-session-v1";

const WORKFLOW_BAG = "3117b05e-70ee-4d6b-b606-1430831af49a";
const PACKAGING_EVENT_ID = "f2f24f1a-4a55-471a-bf72-a57daaef3892";
// Fixed client event id — the partial unique index on
// (workflow_bag_id, event_type, client_event_id) makes re-runs no-ops.
const CLIENT_EVENT_ID = "a7d4c2f1-88b6-4f0e-9c31-352176aa0520";
const ADMIN_USER_ID = "d649b0cd-a43a-424d-bbcd-2ae59fe43066"; // sahilk@gmail.com (OWNER)

// Preserved from the PACKAGING_COMPLETE event (same values the 2026-07-02
// correction preserved).
const LINKED_ACCOUNTABILITY = {
  accountableEmployeeId: "089340c1-5192-45ab-8090-9af8eefaeefd",
  accountabilitySource: "STATION_OPERATOR_SESSION" as const,
  nameSnapshot: "System Administrator",
};

// New TOTALS = recorded first session (2/14/0/0) + missed second session
// (1 case, 1 display, 18 loose, 1 ripped).
const FIELD_VALUES: Record<string, number | null> = {
  master_cases: 3,
  displays_made: 15,
  loose_cards: 18,
  damaged_packaging: 0,
  ripped_cards: 1,
};

const NOTES =
  "Second packaging session was never entered: packaging paused end-of-shift " +
  "2026-05-19 (first session recorded: 2 cases / 14 displays), resumed morning " +
  "2026-05-20 yielding 1 case, 1 display, 18 loose cards, 1 ripped card. " +
  "Totals corrected to 3 cases / 15 displays / 18 loose / 1 ripped. " +
  `Admin-approved backfill (${SCRIPT_VERSION}).`;

function section(title: string, body: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  console.log(`[${SCRIPT_VERSION}] mode=${applyMode ? "APPLY" : "DRY-RUN"}`);
  if (applyMode && process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
    console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
    process.exit(1);
  }

  // ── Preflight ──
  const evRows = (await db.execute(sql`
    SELECT id::text, event_type::text, payload, workflow_bag_id::text
    FROM workflow_events WHERE id = ${PACKAGING_EVENT_ID}::uuid
  `)) as unknown as Array<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    workflow_bag_id: string;
  }>;
  const ev = evRows[0];
  if (!ev || ev.event_type !== "PACKAGING_COMPLETE" || ev.workflow_bag_id !== WORKFLOW_BAG) {
    console.error(`ABORT: packaging event not as expected: ${JSON.stringify(ev)}`);
    process.exit(1);
  }
  if (!isCorrectableSubmissionEventType(ev.event_type)) {
    console.error("ABORT: event type not correctable");
    process.exit(1);
  }

  const state = (await db.execute(sql`
    SELECT rbm.master_cases, rbm.displays_made, rbm.loose_cards, rbm.ripped_cards,
           rbm.units_yielded,
           (SELECT status FROM finished_lots WHERE workflow_bag_id = ${WORKFLOW_BAG}::uuid) AS lot_status,
           (SELECT COUNT(*)::int FROM workflow_events
             WHERE workflow_bag_id = ${WORKFLOW_BAG}::uuid AND event_type = 'SUBMISSION_CORRECTED') AS prior_corrections,
           (SELECT COUNT(*)::int FROM workflow_events
             WHERE workflow_bag_id = ${WORKFLOW_BAG}::uuid AND event_type = 'SUBMISSION_CORRECTED'
               AND client_event_id = ${CLIENT_EVENT_ID}) AS already_applied
    FROM read_bag_metrics rbm WHERE rbm.workflow_bag_id = ${WORKFLOW_BAG}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  const s = state[0];
  if (!s) {
    console.error("ABORT: bag metrics row missing");
    process.exit(1);
  }
  if (Number(s.already_applied) > 0) {
    console.log("Already applied (client event id present) — nothing to do.");
    process.exit(0);
  }
  if (
    Number(s.master_cases) !== 2 ||
    Number(s.displays_made) !== 14 ||
    Number(s.loose_cards) !== 0 ||
    Number(s.ripped_cards) !== 0 ||
    Number(s.prior_corrections) !== 1
  ) {
    console.error(`ABORT: current counts changed since review: ${JSON.stringify(s)}`);
    process.exit(1);
  }

  const zohoCommitted = await db.transaction(async (tx) =>
    loadZohoOutputCommittedForWorkflowBag(tx, WORKFLOW_BAG),
  );
  const eligibility = evaluateSubmissionCorrectionEligibility({
    eventType: ev.event_type,
    isCorrectableEventType: true,
    zohoOutputCommitted: zohoCommitted,
    hasFinishedLot: true,
  });
  if (!eligibility.eligible) {
    console.error(`ABORT: ${eligibility.blockers[0]?.message ?? "correction blocked"}`);
    process.exit(1);
  }

  const originalValue = buildOriginalValueSnapshot(ev.event_type, ev.payload);
  const correctedValue = buildCorrectedValueFromFields(
    ev.event_type,
    ev.payload,
    FIELD_VALUES,
  );

  section("PLAN", {
    current_effective_counts: {
      master_cases: 2,
      displays_made: 14,
      loose_cards: 0,
      ripped_cards: 0,
      units_yielded: Number(s.units_yielded),
    },
    corrected_value_to_record: correctedValue,
    expected_after: {
      master_cases: 3,
      displays_made: 15,
      loose_cards: 18,
      ripped_cards: 1,
      units_yielded: 1818,
    },
    eligibility_warnings: eligibility.warnings.map((w) => w.message),
    downstream:
      "finished lot CD-WALK-20260609-10 quantities -> 1818/15/3 and status RELEASED -> ON_HOLD (canonical needs-review); Zoho: only op already VOIDED; rollup rebuilds follow",
    lot_status_now: s.lot_status,
  });

  if (!applyMode) {
    console.log("\nDry-run complete — no mutations written.");
    process.exit(0);
  }

  const actor = { id: ADMIN_USER_ID, role: "OWNER" } as CurrentUser;
  let lotId: string | null = null;

  await db.transaction(async (tx) => {
    const payload: SubmissionCorrectedPayload = {
      client_event_id: CLIENT_EVENT_ID,
      corrected_event_id: PACKAGING_EVENT_ID,
      corrected_event_type: ev.event_type,
      original_value: originalValue,
      corrected_value: correctedValue,
      correction_reason: "SUPERVISOR_CORRECTION" as QCReasonCode,
      preserves_original_accountable_employee: true,
      notes: NOTES,
      accountable_employee_id: LINKED_ACCOUNTABILITY.accountableEmployeeId,
      accountability_source: LINKED_ACCOUNTABILITY.accountabilitySource,
      accountable_employee_name_snapshot: LINKED_ACCOUNTABILITY.nameSnapshot,
      entered_by_user_id: actor.id,
    };
    const v = validateQcPayload("SUBMISSION_CORRECTED", payload);
    if (!v.ok) throw new Error(v.issues[0]?.message ?? "Invalid correction payload.");

    await projectEvent(tx, {
      workflowBagId: WORKFLOW_BAG,
      eventType: "SUBMISSION_CORRECTED",
      payload,
      clientEventId: CLIENT_EVENT_ID,
      accountableEmployeeId: LINKED_ACCOUNTABILITY.accountableEmployeeId,
      accountabilitySource: LINKED_ACCOUNTABILITY.accountabilitySource,
      accountableEmployeeNameSnapshot: LINKED_ACCOUNTABILITY.nameSnapshot,
      enteredByUserId: actor.id,
    });

    const downstream = await applySubmissionCorrectionDownstreamEffects(tx, {
      workflowBagId: WORKFLOW_BAG,
      actor,
    });
    lotId = downstream.finishedLotId;

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "admin.submission_corrected",
        targetType: "WorkflowBag",
        targetId: WORKFLOW_BAG,
        after: {
          corrected_event_id: PACKAGING_EVENT_ID,
          corrected_event_type: ev.event_type,
          correction_reason: "SUPERVISOR_CORRECTION",
          corrected_value: correctedValue,
          preserved_accountable_employee_id:
            LINKED_ACCOUNTABILITY.accountableEmployeeId,
          entered_by_user_id: actor.id,
          notes: NOTES,
          script: SCRIPT_VERSION,
        },
      },
      tx,
    );

    await rebuildDailyThroughput(tx);
    await rebuildSkuDaily(tx);
    await rebuildStationQualityDaily(tx);
  });

  const after = (await db.execute(sql`
    SELECT rbm.master_cases, rbm.displays_made, rbm.loose_cards, rbm.ripped_cards,
           rbm.units_yielded,
           fl.finished_lot_number, fl.status AS lot_status, fl.units_produced,
           fl.displays_produced, fl.cases_produced
    FROM read_bag_metrics rbm
    LEFT JOIN finished_lots fl ON fl.workflow_bag_id = rbm.workflow_bag_id
    WHERE rbm.workflow_bag_id = ${WORKFLOW_BAG}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  section("POST-STATE", { ...after[0], finished_lot_id: lotId });
  console.log("\nApply complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
