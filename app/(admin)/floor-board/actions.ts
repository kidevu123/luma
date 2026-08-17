"use server";

// Act Now rail actions for the admin floor-board.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stationExceptionReports, workflowEvents } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import { raiseDowntimeEnded } from "@/lib/production/engine";

/**
 * Acknowledge an unacknowledged station_exception_reports row from the
 * Act Now rail.
 *
 * Only station_exception_reports rows are acknowledgeable this way.
 * Workflow-event exceptions (DOWNTIME_STARTED / QA_HOLD_STARTED)
 * resolve through their own flows — QA holds via Release hold on the
 * floor, downtime-end is a P6 flow. A generic ack button on those rows
 * would bypass the resolution accounting those flows maintain; they are
 * deliberately absent from this path.
 */
export async function acknowledgeStationReportAction(
  reportId: string,
): Promise<{ ok: true } | { error: string }> {
  const actor = await requireAdmin();

  if (!reportId || typeof reportId !== "string") {
    return { error: "Invalid report id." };
  }

  try {
    const now = new Date();

    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: stationExceptionReports.id,
          acknowledgedAt: stationExceptionReports.acknowledgedAt,
        })
        .from(stationExceptionReports)
        .where(eq(stationExceptionReports.id, reportId));

      if (!row) {
        throw new Error("REPORT_NOT_FOUND");
      }
      if (row.acknowledgedAt != null) {
        // Idempotent: already acknowledged is fine — return without
        // a second audit row. The rail will have dropped the item on
        // next render because acknowledged_at IS NULL filter excludes it.
        return;
      }

      await tx
        .update(stationExceptionReports)
        .set({
          acknowledgedAt: now,
          acknowledgedBy: actor.id,
        })
        .where(eq(stationExceptionReports.id, reportId));

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role as Parameters<typeof writeAudit>[0]["actorRole"],
          action: "STATION_REPORT_ACKNOWLEDGED",
          targetType: "StationExceptionReport",
          targetId: reportId,
          after: {
            acknowledged_at: now.toISOString(),
            acknowledged_by: actor.id,
          },
        },
        tx,
      );
    });

    revalidatePath("/floor-board");
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.message === "REPORT_NOT_FOUND") {
      return { error: "Report not found." };
    }
    return { error: "Acknowledge failed." };
  }
}

/**
 * Resolve a DOWNTIME_STARTED workflow event from the Act Now rail.
 *
 * Looks up the original event by id to recover stationId and workflowBagId,
 * then emits DOWNTIME_ENDED via the engine's raiseDowntimeEnded so the
 * resolution is recorded on the same bag and appears in the audit trail.
 * Admin-authed (requireAdmin). Mirrors acknowledgeStationReportAction's
 * pattern for station_report rows.
 *
 * The Act Now rail removes the row once a DOWNTIME_ENDED event is recorded
 * for the same bag (floor-command.ts's query filters by 4-hour recency and
 * event type — DOWNTIME_ENDED is not in that list, so the DOWNTIME_STARTED
 * row ages off naturally; the [ Resolved ] button simply records the fact).
 */
export async function resolveDowntimeAction(
  downtimeEventId: string,
): Promise<{ ok: true } | { error: string }> {
  const actor = await requireAdmin();

  if (!downtimeEventId || typeof downtimeEventId !== "string") {
    return { error: "Invalid event id." };
  }

  try {
    const [row] = await db
      .select({
        id: workflowEvents.id,
        stationId: workflowEvents.stationId,
        workflowBagId: workflowEvents.workflowBagId,
        eventType: workflowEvents.eventType,
      })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, downtimeEventId));

    if (!row) {
      return { error: "Downtime event not found." };
    }
    if (row.eventType !== "DOWNTIME_STARTED") {
      return { error: "Event is not a DOWNTIME_STARTED event." };
    }
    if (!row.stationId) {
      return { error: "Downtime event has no station — cannot resolve." };
    }

    const result = await raiseDowntimeEnded({
      stationId: row.stationId,
      workflowBagId: row.workflowBagId,
    });

    if (!result.ok) {
      return { error: result.blocker.supervisorDetail };
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role as Parameters<typeof writeAudit>[0]["actorRole"],
      action: "DOWNTIME_RESOLVED",
      targetType: "WorkflowEvent",
      targetId: downtimeEventId,
      after: {
        resolved_by: actor.id,
        downtime_event_id: downtimeEventId,
      },
    });

    revalidatePath("/floor-board");
    return { ok: true };
  } catch {
    return { error: "Resolve failed." };
  }
}
