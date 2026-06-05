// Project WORKFLOW_RECOVERY into read_bag_state flags.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  WORKFLOW_RECOVERY_STATUS,
  type WorkflowRecoveryPayload,
  type WorkflowRecoveryStatus,
} from "@/lib/production/workflow-recovery";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export function resolveRecoveryStatusFromPayload(
  payload: WorkflowRecoveryPayload,
): WorkflowRecoveryStatus {
  if (payload.zoho_output_action === "BLOCKED_COMMITTED") {
    return WORKFLOW_RECOVERY_STATUS.EXTERNAL_RECOVERY_REQUIRED;
  }
  if (payload.finished_lot_action === "EXTERNAL_RECOVERY_REQUIRED") {
    return WORKFLOW_RECOVERY_STATUS.EXTERNAL_RECOVERY_REQUIRED;
  }
  if (
    payload.finished_lot_existed ||
    payload.finished_lot_action === "ON_HOLD"
  ) {
    return WORKFLOW_RECOVERY_STATUS.VOIDED_FROM_OUTPUT;
  }
  return WORKFLOW_RECOVERY_STATUS.WRONG_ROUTE_RECOVERED;
}

export async function projectWorkflowRecoveryEvent(
  tx: Tx,
  args: {
    workflowBagId: string;
    payload: WorkflowRecoveryPayload;
  },
): Promise<void> {
  const recoveryStatus = resolveRecoveryStatusFromPayload(args.payload);
  await tx.execute(sql`
    UPDATE read_bag_state
    SET
      recovery_status = ${recoveryStatus},
      excluded_from_output = true,
      updated_at = now()
    WHERE workflow_bag_id = ${args.workflowBagId}::uuid
  `);
}
