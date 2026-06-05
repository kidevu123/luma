// Downstream finished-lot / Zoho effects after submission correction.

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  finishedLots,
  readBagMetrics,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import type { db as Db } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { writeAudit } from "@/lib/db/audit";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function loadZohoOutputCommittedForWorkflowBag(
  tx: Tx,
  workflowBagId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT zpo.id
    FROM finished_lots fl
    JOIN zoho_production_output_ops zpo
      ON zpo.finished_lot_id = fl.id
    WHERE fl.workflow_bag_id = ${workflowBagId}::uuid
      AND zpo.status = 'COMMITTED'
      AND zpo.voided_at IS NULL
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export async function applySubmissionCorrectionDownstreamEffects(
  tx: Tx,
  args: {
    workflowBagId: string;
    actor: CurrentUser;
  },
): Promise<{ finishedLotId: string | null; markedOnHold: boolean }> {
  const [lot] = await tx
    .select({
      id: finishedLots.id,
      status: finishedLots.status,
    })
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, args.workflowBagId))
    .limit(1);
  if (!lot) return { finishedLotId: null, markedOnHold: false };

  const [metrics] = await tx
    .select({
      masterCases: readBagMetrics.masterCases,
      displaysMade: readBagMetrics.displaysMade,
      looseCards: readBagMetrics.looseCards,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(readBagMetrics)
    .where(eq(readBagMetrics.workflowBagId, args.workflowBagId));

  if (metrics) {
    await tx
      .update(finishedLots)
      .set({
        unitsProduced: metrics.unitsYielded,
        displaysProduced: metrics.displaysMade,
        casesProduced: metrics.masterCases,
      })
      .where(eq(finishedLots.id, lot.id));
  }

  let markedOnHold = false;
  if (lot.status === "RELEASED" || lot.status === "PENDING_QC") {
    await tx
      .update(finishedLots)
      .set({ status: "ON_HOLD" })
      .where(eq(finishedLots.id, lot.id));
    markedOnHold = true;
    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: args.actor.role,
        action: "finished_lot.correction_needs_review",
        targetType: "FinishedLot",
        targetId: lot.id,
        before: { status: lot.status },
        after: {
          status: "ON_HOLD",
          reason: "Submission corrected — review output and Zoho sync.",
        },
      },
      tx,
    );
  }

  const uncommittedOps = await tx
    .select({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.finishedLotId, lot.id),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    );

  for (const op of uncommittedOps) {
    if (op.status === "COMMITTED") continue;
    await tx
      .update(zohoProductionOutputOps)
      .set({
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: args.actor.id,
        voidReason: "Voided after submission correction — re-queue after review.",
        updatedAt: new Date(),
      })
      .where(eq(zohoProductionOutputOps.id, op.id));
  }

  return { finishedLotId: lot.id, markedOnHold };
}
