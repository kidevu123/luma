import type { AutoLotBacklogBlockerCode } from "@/lib/production/auto-lot-backlog-eligibility";
import type { ProductSetupReadiness } from "@/lib/production/product-setup-readiness";

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

// Auto-issue blocker codes that are really "product setup gaps" the
// operator can fix from the product detail page. When more than one
// is present we collapse the chip text to "Multiple fields missing"
// and the setupReadiness tooltip lists them all.
const PRODUCT_SETUP_CODES = new Set<AutoLotBacklogBlockerCode>([
  "MISSING_SHELF_LIFE",
  "MISSING_TABLETS_PER_UNIT",
  "MISSING_PACKAGING_STRUCTURE",
]);

export function BacklogStatusChip({
  label,
  code,
  setupReadiness,
}: {
  label: string;
  code: AutoLotBacklogBlockerCode;
  setupReadiness?: ProductSetupReadiness;
}) {
  const tone = TONE[code];
  const blockers = setupReadiness?.autoIssueBlockers ?? [];
  const isProductSetupCode = PRODUCT_SETUP_CODES.has(code);
  const collapseToMulti = isProductSetupCode && blockers.length > 1;
  const displayLabel = collapseToMulti ? "Multiple fields missing" : label;
  const tooltipParts = collapseToMulti
    ? blockers.map((b) => b.label)
    : isProductSetupCode && blockers.length === 1
      ? [blockers[0]!.label]
      : null;

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${CLASS[tone]}`}
      title={tooltipParts ? tooltipParts.join(" · ") : undefined}
    >
      {displayLabel}
    </span>
  );
}

/** Standalone Zoho-readiness chip — informational, never blocks
 *  auto-issue. Lives next to the auto-issue chip so the operator can
 *  see both finished-lot eligibility and Zoho-push eligibility at a
 *  glance and won't keep filling Zoho IDs hoping the shelf-life
 *  blocker disappears. */
export function ZohoReadyChip({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        ready
          ? "border-green-300/60 bg-green-50 text-green-800"
          : "border-amber-300/60 bg-amber-50 text-amber-900"
      }`}
      title={
        ready
          ? "All Zoho item IDs (single unit, display, master case) are set."
          : "Zoho item IDs missing — finished lot can still be issued, but the Zoho push will not run."
      }
    >
      {ready ? "Zoho ready" : "Zoho IDs missing"}
    </span>
  );
}
