/** Client-safe constants and types for missed blister bag backfill. */

export const MISSED_BLISTER_BAG_CONFIRM_STRING =
  "APPLY_MISSED_BLISTER_BAG_BACKFILL" as const;

export type MissedBlisterBagProposal = {
  card: {
    id: string;
    label: string;
    scanToken: string;
    assignedWorkflowBagId: string | null;
  };
  inventoryBagId: string;
  receiptNumber: string | null;
  blisterStationId: string;
  blisterMachineId: string;
  workflowBagAction: "create_new" | "use_existing";
  workflowBagId: string | null;
  oldPvcLot: { id: string; rollNumber: string };
  newPvcLot: { id: string; rollNumber: string };
  foilLot: { id: string; rollNumber: string };
  timestamps: {
    startedAt: string;
    rollChangeAt: string;
    rollChangeEstimated: boolean;
    completedAt: string;
    releasedAt: string;
  };
  bagSegmentTotal: number;
  workflowEvents: Array<{
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
  materialEvents: Array<{
    eventType: string;
    rollNumber: string;
    lotId: string;
    segmentCount: number | null;
    segmentReason: string | null;
    occurredAt: string;
  }>;
  warnings: string[];
};
