"use server";

// Act Now rail actions for the admin floor-board.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stationExceptionReports } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";

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
