import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import {
  PUSH_TO_ZOHO_APPROVED_SKUS,
  PUSH_TO_ZOHO_GO_LIVE_OPERATOR_NOTICE,
  ZOHO_PUSH_RUNBOOK_DOC,
  ZOHO_SKU_ROLLOUT_CHECKLIST_DOC,
} from "@/lib/zoho/push-to-zoho-go-live-allowlist";

export function PushToZohoGoLiveBanner({
  context = "general",
}: {
  context?: "bag_receive" | "production_output" | "general";
}) {
  const contextLine =
    context === "bag_receive"
      ? "Bag receive: preview is always available when configured. Live purchase receive commit stays blocked until PM opens the bag-finish gate and Zoho raw_intake.commit capability."
      : context === "production_output"
        ? "Production output: preview is always available when configured. Live assembly commit stays blocked until PM opens the production-output gate and Zoho production_output.commit capability."
        : null;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-[12px] text-sky-950 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-sky-800" />
        <div className="space-y-2">
          <p className="font-semibold">Push to Zoho — gated go-live (PM-approved SKUs only)</p>
          <p>{PUSH_TO_ZOHO_GO_LIVE_OPERATOR_NOTICE}</p>
          {contextLine ? <p>{contextLine}</p> : null}
          <p>
            <span className="font-medium">Day-1 live-commit allowlist:</span>{" "}
            {PUSH_TO_ZOHO_APPROVED_SKUS.map((s) => s.displayName).join(" · ")}
          </p>
          <p className="text-[11px] text-sky-900/90">
            Hard exclusions: Choco Drift, receipt 352176, Bag B, XL 7OH pending/unconfirmed
            bags, unapproved SKUs, WAREHOUSE_REQUIRED blockers, ambiguous receive rows without
            PM review.
          </p>
          <p className="text-[11px]">
            Checklist:{" "}
            <code className="font-mono">{ZOHO_SKU_ROLLOUT_CHECKLIST_DOC}</code>
            {" · "}
            Runbook:{" "}
            <code className="font-mono">{ZOHO_PUSH_RUNBOOK_DOC}</code>
            {" · "}
            <Link href="/zoho-production-operations" className="underline font-medium">
              Production output ops
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
