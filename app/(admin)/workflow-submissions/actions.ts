"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  readBagState,
  stations,
  workflowEvents,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";

const missingBlisterCloseoutSchema = z.object({
  workflowBagId: z.string().uuid(),
  countTotal: z.preprocess((value) => {
    if (value == null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }, z.number().int().nonnegative()),
  notes: z.string().trim().min(10, "Enter a reason for the repair.").max(500),
});

type RepairResult = { ok?: true; error?: string };

async function resolveSingleBlisterStation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowBagId: string,
): Promise<{ id: string; label: string; kind: string }> {
  const rows = await tx
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
    })
    .from(workflowEvents)
    .innerJoin(stations, eq(stations.id, workflowEvents.stationId))
    .where(
      and(
        eq(workflowEvents.workflowBagId, workflowBagId),
        inArray(stations.kind, ["BLISTER"]),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt), desc(workflowEvents.id));

  const unique = new Map(rows.map((row) => [row.id, row]));
  if (unique.size === 0) {
    throw new Error(
      "No blister station lineage found for this bag. Use admin recovery, not a blind repair.",
    );
  }
  if (unique.size > 1) {
    throw new Error(
      "Multiple blister stations touched this bag. Admin recovery needs explicit station selection.",
    );
  }
  return [...unique.values()][0]!;
}

export async function adminBackfillMissingBlisterCloseoutAction(
  _prevState: RepairResult | null,
  formData: FormData,
): Promise<RepairResult> {
  const actor = await requireAdmin();
  const parsed = missingBlisterCloseoutSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    countTotal: formData.get("countTotal"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Invalid missing blister close-out repair.",
    };
  }

  try {
    await db.transaction(async (tx) => {
      const [state] = await tx
        .select({
          stage: readBagState.stage,
          isFinalized: readBagState.isFinalized,
          isPaused: readBagState.isPaused,
        })
        .from(readBagState)
        .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
      if (!state) {
        throw new Error("Bag state not found.");
      }
      if (state.isFinalized) {
        throw new Error("Finalized bags cannot be repaired from this tool.");
      }
      if (state.stage !== "STARTED") {
        throw new Error(
          `This repair only applies to STARTED bags (currently ${state.stage}).`,
        );
      }

      const existingSubmissions = await tx
        .select({ eventType: workflowEvents.eventType })
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.workflowBagId, parsed.data.workflowBagId),
            inArray(workflowEvents.eventType, [
              "BLISTER_COMPLETE",
              "HANDPACK_BLISTER_COMPLETE",
              "SEALING_COMPLETE",
              "PACKAGING_COMPLETE",
            ]),
          ),
        )
        .limit(1);
      if (existingSubmissions.length > 0) {
        throw new Error(
          "This bag already has a submission event. Use a specific correction workflow.",
        );
      }

      const blisterStation = await resolveSingleBlisterStation(
        tx,
        parsed.data.workflowBagId,
      );
      const repairPayload = {
        admin_repair: true,
        repair_kind: "MISSING_BLISTER_CLOSEOUT",
        repair_source: "workflow_submissions_admin",
        repair_note: parsed.data.notes,
      };
      const clientIdBase = `admin-missing-blister-closeout:${parsed.data.workflowBagId}`;

      if (state.isPaused) {
        await projectEvent(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: blisterStation.id,
          eventType: "BAG_RESUMED",
          payload: {
            ...repairPayload,
            resume_reason: "admin_missing_blister_closeout",
          },
          clientEventId: `${clientIdBase}:resume`,
          enteredByUserId: actor.id,
          accountabilitySource: "SUPERVISOR_OVERRIDE",
          accountableEmployeeNameSnapshot: actor.email,
        });
      }

      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: blisterStation.id,
        eventType: "BLISTER_COMPLETE",
        payload: {
          count_total: parsed.data.countTotal,
          ...repairPayload,
        },
        clientEventId: `${clientIdBase}:blister-complete`,
        enteredByUserId: actor.id,
        accountabilitySource: "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: actor.email,
      });

      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: blisterStation.id,
        eventType: "BAG_RELEASED",
        payload: {
          station_kind: blisterStation.kind,
          released_at_stage: "BLISTERED",
          ...repairPayload,
        },
        clientEventId: `${clientIdBase}:release`,
        enteredByUserId: actor.id,
        accountabilitySource: "SUPERVISOR_OVERRIDE",
        accountableEmployeeNameSnapshot: actor.email,
      });

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "workflow_submissions.missing_blister_closeout_repair",
          targetType: "WorkflowBag",
          targetId: parsed.data.workflowBagId,
          before: {
            stage: state.stage,
            is_paused: state.isPaused,
            station_id: blisterStation.id,
          },
          after: {
            stage: "BLISTERED",
            released_from_station: blisterStation.id,
            count_total: parsed.data.countTotal,
            notes: parsed.data.notes,
          },
        },
        tx,
      );
    });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : "Missing blister close-out repair failed.",
    };
  }

  revalidatePath("/workflow-submissions");
  revalidatePath("/floor-board");
  return { ok: true };
}
