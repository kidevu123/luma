"use client";

// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — per-row action button.
//
// Renders the right CTA for the row's classified primary action. The
// "Push to Zoho" branch is a NAVIGATION link to the existing
// finished-lot detail surface where ZohoProductionOutputPreviewCard
// lives. This component never fires a Zoho commit directly. Live
// commit gates and the v1.3.0 warehouse resolver still own the actual
// preview/commit path on the destination page.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { repairAutoIssueFinishedLotAction } from "@/app/(admin)/finished-lots/actions";
import type {
  ProductionOutputRowAction,
  ZohoPushEligibility,
} from "@/lib/production/production-output-row-classifier";

type Props = {
  workflowBagId: string;
  finishedLotId: string | null;
  finishedLotNumber: string | null;
  zohoOpId: string | null;
  poId: string | null;
  primaryAction: ProductionOutputRowAction;
  zohoPush: ZohoPushEligibility;
  canMutate: boolean;
};

export function WorkbenchRowActions({
  workflowBagId,
  finishedLotId,
  zohoOpId,
  poId,
  primaryAction,
  zohoPush,
  canMutate,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const drilldowns: React.ReactNode[] = [];
  drilldowns.push(
    <Link
      key="workflow"
      href={`/workflow-submissions?bag=${encodeURIComponent(workflowBagId)}`}
      className="text-[10.5px] underline-offset-2 hover:underline text-text-muted"
    >
      Workflow
    </Link>,
  );
  if (finishedLotId) {
    drilldowns.push(
      <Link
        key="lot"
        href={`/finished-lots/${finishedLotId}`}
        className="text-[10.5px] underline-offset-2 hover:underline text-text-muted"
      >
        Lot
      </Link>,
    );
  }
  if (zohoOpId) {
    drilldowns.push(
      <Link
        key="zoho"
        href={`/zoho-production-operations/${zohoOpId}`}
        className="text-[10.5px] underline-offset-2 hover:underline text-text-muted"
      >
        Zoho op
      </Link>,
    );
  }
  if (poId) {
    drilldowns.push(
      <Link
        key="po"
        href={`/po-reconciliation/${poId}`}
        className="text-[10.5px] underline-offset-2 hover:underline text-text-muted"
      >
        PO
      </Link>,
    );
  }

  const drilldownsRow =
    drilldowns.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2 mt-1">{drilldowns}</div>
    ) : null;

  const primary = renderPrimary({
    primaryAction,
    workflowBagId,
    finishedLotId,
    zohoOpId,
    zohoPush,
    canMutate,
    pending,
    onAutoIssue: () => {
      setError(null);
      startTransition(async () => {
        const result = await repairAutoIssueFinishedLotAction(workflowBagId);
        if (result && "error" in result && result.error) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    },
  });

  return (
    <div className="space-y-1">
      {primary}
      {error ? <p className="text-[10px] text-red-700">{error}</p> : null}
      {drilldownsRow}
    </div>
  );
}

function renderPrimary({
  primaryAction,
  workflowBagId,
  finishedLotId,
  zohoOpId,
  zohoPush,
  canMutate,
  pending,
  onAutoIssue,
}: {
  primaryAction: ProductionOutputRowAction;
  workflowBagId: string;
  finishedLotId: string | null;
  zohoOpId: string | null;
  zohoPush: ZohoPushEligibility;
  canMutate: boolean;
  pending: boolean;
  onAutoIssue: () => void;
}): React.ReactNode {
  if (!canMutate) {
    return (
      <span className="text-[11px] text-text-subtle">View only</span>
    );
  }
  switch (primaryAction) {
    case "AUTO_ISSUE_NOW":
      return (
        <button
          type="button"
          disabled={pending}
          onClick={onAutoIssue}
          className="inline-flex items-center rounded-md border border-green-600/40 bg-green-50 px-2.5 py-1 text-[11.5px] font-medium text-green-800 hover:bg-green-100 disabled:opacity-60"
        >
          {pending ? "Issuing…" : "Auto-issue now"}
        </button>
      );
    case "REPAIR_ALLOCATION":
      return (
        <Link
          href={`/finished-lots/new?bagId=${encodeURIComponent(workflowBagId)}`}
          className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100"
        >
          Repair allocation
        </Link>
      );
    case "FIX_PRODUCT_SETUP":
      return (
        <Link
          href={`/workflow-submissions?bag=${encodeURIComponent(workflowBagId)}`}
          className="inline-flex items-center rounded-md border border-sky-500/40 bg-sky-50 px-2.5 py-1 text-[11.5px] font-medium text-sky-900 hover:bg-sky-100"
        >
          Fix setup
        </Link>
      );
    case "REVIEW_MANUALLY":
      return (
        <Link
          href={`/finished-lots/new?bagId=${encodeURIComponent(workflowBagId)}`}
          className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-strong hover:bg-surface"
        >
          Review manually
        </Link>
      );
    case "VIEW_FINISHED_LOT":
      return (
        <Link
          href={`/finished-lots/${finishedLotId}`}
          className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-strong hover:bg-surface"
        >
          View finished lot
        </Link>
      );
    case "PUSH_TO_ZOHO":
      // Enabled only when zohoPush.enabled === true. Even so, the
      // destination preview card still server-side gates on the
      // v1.3.0 warehouse resolver (and the future v1.4.0 capability
      // signal). This button never fires a Zoho commit by itself.
      if (zohoPush.enabled) {
        return (
          <Link
            href={`/finished-lots/${finishedLotId}#zoho-push`}
            className="inline-flex items-center rounded-md border border-violet-500/40 bg-violet-50 px-2.5 py-1 text-[11.5px] font-medium text-violet-900 hover:bg-violet-100"
            data-testid="push-to-zoho"
          >
            Push to Zoho
          </Link>
        );
      }
      return (
        <button
          type="button"
          disabled
          title={zohoPush.message}
          className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-subtle opacity-70 cursor-not-allowed"
          data-testid="push-to-zoho-blocked"
        >
          Push to Zoho · blocked
        </button>
      );
    case "VIEW_ZOHO_OP":
      return zohoOpId ? (
        <Link
          href={`/zoho-production-operations/${zohoOpId}`}
          className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-strong hover:bg-surface"
        >
          View Zoho op
        </Link>
      ) : (
        <span className="text-[11px] text-text-subtle">—</span>
      );
    case "AWAIT_FINALIZATION":
      return (
        <span className="text-[11px] text-text-subtle">
          Awaiting floor finalization
        </span>
      );
    case "NONE":
      return <span className="text-[11px] text-text-subtle">—</span>;
  }
}
