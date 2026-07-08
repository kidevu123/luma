"use client";

// CLOSEOUT-DRAWER-1 — embeds the EXISTING v1.23 Admin Correction Wizard
// (wrong product / wrong route / wrong QR / quarantine) for this bag's
// workflow. One implementation, reused — no forked correction logic.

import { WorkflowRecoveryForm } from "@/app/(admin)/workflow-submissions/_workflow-recovery-form";

export function CorrectionLauncher({
  workflowBagId,
  bagFinalized,
  hasFinishedLot,
}: {
  workflowBagId: string;
  bagFinalized: boolean;
  hasFinishedLot: boolean;
}) {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-text-strong">Admin correction</p>
      <p className="text-[10.5px] text-text-muted">
        Wrong product, wrong route, or wrong QR/receipt? The correction wizard
        previews every downstream impact before anything is applied.
      </p>
      <WorkflowRecoveryForm
        workflowBagId={workflowBagId}
        bagFinalized={bagFinalized}
        hasFinishedLot={hasFinishedLot}
      />
    </div>
  );
}
