"use client";

// CLOSEOUT-DRAWER-1 — dispatches the applicable action panels for one bag.
// Panels call the EXISTING server actions verbatim (no new mutation
// endpoints live under _drawer/). Fail closed: no applicable actions →
// nothing but the specialist-page links renders.

import type { BagCloseoutDetail } from "@/lib/db/queries/bag-closeout-detail";
import type { BagCloseoutRowFacts } from "@/lib/db/queries/bag-closeout-detail";
import {
  deriveApplicableBagActions,
  derivePrimaryBagAction,
} from "@/lib/production/bag-closeout-actions";
import { QrActions } from "./qr-actions";
import { LotActions } from "./lot-actions";
import { PartialActions } from "./partial-actions";
import { ZohoActions } from "./zoho-actions";
import { CorrectionLauncher } from "./correction-launcher";

export function ActionPanels({
  detail,
  row,
  inventoryBagId,
  poId,
  onDone,
  primaryOnly,
}: {
  detail: BagCloseoutDetail;
  row: BagCloseoutRowFacts;
  inventoryBagId: string;
  poId: string;
  onDone: () => void;
  /** SIMPLIFY-D — the guided wizard shows ONE action per step, not the
   *  buffet. Default false keeps the list-view drawer byte-identical. */
  primaryOnly?: boolean;
}) {
  // Derive applicable action keys from the CURRENT server-rendered row facts
  // on every render so that panels update immediately after an action
  // revalidates the page (before or alongside the drawer's detail refetch).
  // allocationOpen is the one fact that lives only in the fetched detail.
  const keys = deriveApplicableBagActions({
    rowStatus: row.status,
    rowAction: row.action,
    zoho: row.zoho,
    hasWorkflow: row.workflowBagId != null,
    hasFinishedLot: row.finishedLotId != null,
    lotStatus: row.lotStatus,
    allocationOpen: detail.summary?.allocation?.isOpen ?? false,
  });
  const effectiveKeys = primaryOnly
    ? (() => {
        const primary = derivePrimaryBagAction(keys);
        return primary ? [primary] : [];
      })()
    : keys;
  if (effectiveKeys.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
        Actions
      </p>
      <div className="grid gap-2 lg:grid-cols-2">
        {effectiveKeys.includes("REPAIR_QR") && row.receiveId ? (
          <QrActions receiveId={row.receiveId} inventoryBagId={inventoryBagId} onDone={onDone} />
        ) : null}
        {(effectiveKeys.includes("ISSUE_LOT") ||
          effectiveKeys.includes("RELEASE_LOT") ||
          effectiveKeys.includes("REVIEW_HOLD")) ? (
          <LotActions
            mode={
              effectiveKeys.includes("ISSUE_LOT")
                ? "ISSUE"
                : effectiveKeys.includes("RELEASE_LOT")
                  ? "RELEASE"
                  : "HOLD_REVIEW"
            }
            workflowBagId={row.workflowBagId}
            finishedLotId={row.finishedLotId}
            onDone={onDone}
          />
        ) : null}
        {effectiveKeys.includes("RESOLVE_PARTIAL") ? (
          <PartialActions inventoryBagId={inventoryBagId} onDone={onDone} />
        ) : null}
        {(effectiveKeys.includes("ZOHO_QUEUE") || effectiveKeys.includes("ZOHO_RETRY")) ? (
          <ZohoActions
            mode={effectiveKeys.includes("ZOHO_RETRY") ? "RETRY" : "QUEUE"}
            op={detail.zohoReadiness.op}
            setup={detail.zohoReadiness.setup}
            poId={poId}
            onDone={onDone}
          />
        ) : null}
        {effectiveKeys.includes("CORRECTION_WIZARD") && row.workflowBagId ? (
          <CorrectionLauncher
            workflowBagId={row.workflowBagId}
            bagFinalized={detail.summary?.workflow?.finalized ?? false}
            hasFinishedLot={row.finishedLotId != null}
          />
        ) : null}
      </div>
    </div>
  );
}
