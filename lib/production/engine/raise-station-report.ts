// P5-SUPERVISOR Task 5(b) — bagless station exception reports.
//
// Report Problem's MACHINE and OTHER categories had no bagless recording
// path before P5: every existing exception write attached to
// workflow_events, whose workflow_bag_id column is NOT NULL by design
// (append-only, one bag per event). A stationed problem the operator
// notices BEFORE any bag is pinned — the machine won't start up, someone
// tripped over the cord, the compressor is leaking — had nowhere to
// land and stranded the operator on "Scan the bag this is about first."
// (report-problem.tsx's helper copy). This module is the P5 answer:
// a dedicated table, station_exception_reports (migration 0073, schema
// mirrored in lib/db/schema.ts), with an active-operator snapshot for
// audit readability and a nullable acknowledgement pair the Act Now
// admin sidebar sets when a supervisor triages the row.
//
// SCOPE: MACHINE and OTHER only. The bagged categories keep their
// existing event paths untouched (MACHINE-with-bag still emits
// DOWNTIME_STARTED alongside a pause; QUALITY still emits QA_HOLD_
// STARTED; BAG still pauses). Report Problem chooses this action for
// the two categories when no bag is pinned; the other four remain
// disabled without a bag.
//
// TOTAL FUNCTION: every failure returns a Blocker rather than throwing,
// matching raiseProductionException / raiseDowntimeStarted's shape so
// the floor action layer's translate-to-{error, code} handling stays
// uniform. Never rejects.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stationExceptionReports, stations } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { getActiveStationSession } from "@/lib/production/station-operator-session";
import { blockerFor } from "./resolve-exceptions";
import type { Blocker } from "./types";

/** The categories a bagless report can carry. Deliberately narrower
 *  than ProductionExceptionCategory — the other four (MATERIAL,
 *  PRODUCT, BAG, QUALITY) either need a bag by definition (BAG,
 *  QUALITY's QA_HOLD) or don't fit the machine-down / general-issue
 *  shape a bagless report captures. */
export const STATION_REPORT_CATEGORIES = ["MACHINE", "OTHER"] as const;
export type StationReportCategory = (typeof STATION_REPORT_CATEGORIES)[number];

/** Same 500-character cap raise-production-exception.ts's detail column
 *  uses. The floor helper (report-problem.tsx) enforces a lower UI cap
 *  (400) so the field never risks a validation-error dance either way. */
export const STATION_REPORT_DETAIL_MAX_LENGTH = 500;

export type RaiseStationReportInput = {
  stationId: string;
  category: StationReportCategory;
  detail: string;
};

export type RaiseStationReportResult =
  | { ok: true; reportId: string }
  | { ok: false; blocker: Blocker };

/** Insert a bagless station_exception_reports row. The active operator
 *  session (if any) is snapshotted onto the row so admin reads stay
 *  readable even after employees renames — same accountability-
 *  snapshot pattern operator-session-open uses.
 *
 *  PRECONDITION — the caller MUST have authenticated the station, the
 *  same guarantee every engine write documents. */
export async function raiseStationReport(
  input: RaiseStationReportInput,
): Promise<RaiseStationReportResult> {
  const detail = input.detail.trim();
  if (!detail) {
    return {
      ok: false,
      blocker: blockerFor("PRODUCTION_EXCEPTION_DETAIL_REQUIRED"),
    };
  }
  if (detail.length > STATION_REPORT_DETAIL_MAX_LENGTH) {
    return {
      ok: false,
      blocker: {
        code: "STATION_REPORT_DETAIL_TOO_LONG",
        operatorSentence: "That note is too long. Shorten it and try again.",
        supervisorDetail: `Detail exceeded STATION_REPORT_DETAIL_MAX_LENGTH (${STATION_REPORT_DETAIL_MAX_LENGTH}).`,
        suggestedAction: "NONE",
      },
    };
  }

  try {
    const [stationRow] = await db
      .select({ id: stations.id })
      .from(stations)
      .where(eq(stations.id, input.stationId));
    if (!stationRow) {
      return { ok: false, blocker: blockerFor("STATION_UNRESOLVED") };
    }

    let reportId = "";
    await db.transaction(async (tx) => {
      // Snapshot the active operator session's employee (if any) onto
      // the row so audit reads stay readable after later employee
      // renames. No session open is fine — the report is bagless by
      // definition, and predates any operator being on shift.
      const session = await getActiveStationSession(tx, input.stationId);
      const employeeId = session?.employeeId ?? null;
      const employeeName = session?.employeeNameSnapshot ?? null;

      const [inserted] = await tx
        .insert(stationExceptionReports)
        .values({
          stationId: input.stationId,
          category: input.category,
          detail,
          employeeId,
          employeeNameSnapshot: employeeName,
        })
        .returning({ id: stationExceptionReports.id });
      if (!inserted) {
        // RETURNING on an insert we just wrote should never produce
        // zero rows; a total-function contract still handles it.
        throw new Error("STATION_REPORT insert returned no row.");
      }
      reportId = inserted.id;

      await writeAudit(
        {
          // Floor reports are anonymous kiosk events — same shape as
          // operator-session and supervisor-session audit rows use.
          // The operator's identity, when there is one, lives in
          // `after.employee_id` (not actorId).
          actorId: null,
          actorRole: null,
          action: "STATION_REPORT_RAISED",
          targetType: "StationExceptionReport",
          targetId: inserted.id,
          after: {
            station_id: input.stationId,
            category: input.category,
            detail,
            employee_id: employeeId,
            employee_name: employeeName,
          },
        },
        tx,
      );
    });

    return { ok: true, reportId };
  } catch (err) {
    return {
      ok: false,
      blocker: {
        code: "STATION_REPORT_FAILED",
        operatorSentence:
          "Something went wrong recording this. Ask a supervisor.",
        supervisorDetail: err instanceof Error ? err.message : String(err),
        suggestedAction: "NOTIFY_SUPERVISOR",
      },
    };
  }
}
