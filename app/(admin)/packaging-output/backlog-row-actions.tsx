"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { repairAutoIssueFinishedLotAction } from "@/app/(admin)/finished-lots/actions";
import type { AutoLotBacklogEvaluation } from "@/lib/production/auto-lot-backlog-eligibility";

type BacklogRowActionsProps = {
  workflowBagId: string;
  evaluation: AutoLotBacklogEvaluation;
  canMutate: boolean;
};

export function BacklogRowActions({
  workflowBagId,
  evaluation,
  canMutate,
}: BacklogRowActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canMutate) {
    return (
      <span className="text-[11px] text-text-subtle">{evaluation.nextStep}</span>
    );
  }

  if (evaluation.action === "AUTO_ISSUE_NOW") {
    return (
      <div className="space-y-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await repairAutoIssueFinishedLotAction(workflowBagId);
              if (result && "error" in result && result.error) {
                setError(result.error);
                return;
              }
              router.refresh();
            });
          }}
          className="inline-flex items-center rounded-md border border-green-600/40 bg-green-50 px-2.5 py-1 text-[11.5px] font-medium text-green-800 hover:bg-green-100 transition-colors disabled:opacity-60"
        >
          {pending ? "Issuing…" : "Auto-issue now"}
        </button>
        {error ? <p className="text-[10px] text-red-700">{error}</p> : null}
      </div>
    );
  }

  if (evaluation.action === "REPAIR_ALLOCATION") {
    return (
      <Link
        href={`/finished-lots/new?bagId=${encodeURIComponent(workflowBagId)}`}
        className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100 transition-colors"
      >
        Repair allocation
      </Link>
    );
  }

  if (evaluation.action === "FIX_PRODUCT_SETUP" && evaluation.productId) {
    return (
      <Link
        href={`/products/${evaluation.productId}`}
        className="inline-flex items-center rounded-md border border-sky-500/40 bg-sky-50 px-2.5 py-1 text-[11.5px] font-medium text-sky-900 hover:bg-sky-100 transition-colors"
      >
        Fix product setup
      </Link>
    );
  }

  return (
    <Link
      href={`/finished-lots/new?bagId=${encodeURIComponent(workflowBagId)}`}
      className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-strong hover:bg-surface transition-colors"
    >
      Review manually
    </Link>
  );
}
