import type { AutoLotBacklogBlockerCode } from "@/lib/production/auto-lot-backlog-eligibility";

const TONE: Record<
  AutoLotBacklogBlockerCode,
  "ready" | "repair" | "block" | "neutral"
> = {
  READY_TO_AUTO_ISSUE: "ready",
  MISSING_ALLOCATION_SESSION: "repair",
  MISSING_STARTING_BALANCE: "repair",
  MISSING_TABLETS_PER_UNIT: "block",
  MISSING_OUTPUT_QUANTITY: "block",
  MISSING_PRODUCT: "block",
  MISSING_RECEIPT_NUMBER: "block",
  MISSING_SHELF_LIFE: "block",
  MISSING_PACKAGING_STRUCTURE: "block",
  MISSING_INVENTORY_BAG: "block",
  NEGATIVE_ENDING_BALANCE: "block",
  MULTIPLE_SOURCE_BAGS_NEED_REVIEW: "block",
  OPEN_ALLOCATION_ON_OTHER_WORKFLOW: "block",
  FINISHED_LOT_EXISTS: "neutral",
  ZOHO_OUTPUT_COMMITTED: "block",
  LOT_NUMBER_CONFLICT: "block",
  WORKFLOW_BAG_NOT_FINALIZED: "neutral",
  MANUAL_REVIEW_REQUIRED: "neutral",
};

const CLASS: Record<typeof TONE[keyof typeof TONE], string> = {
  ready: "border-green-300/60 bg-green-50 text-green-800",
  repair: "border-amber-300/60 bg-amber-50 text-amber-900",
  block: "border-red-300/50 bg-red-50 text-red-800",
  neutral: "border-border bg-surface-2 text-text-muted",
};

export function BacklogStatusChip({
  label,
  code,
}: {
  label: string;
  code: AutoLotBacklogBlockerCode;
}) {
  const tone = TONE[code];
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
