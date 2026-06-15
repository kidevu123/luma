// ZOHO-PUSH-GO-LIVE — PM-approved SKU allowlist (procedural; does not auto-enable commits).

import { FIX_RELAX_PRODUCT_ID, FIX_RELAX_PRODUCT_NAME } from "@/lib/zoho/v1206-fix-relax-pilot-contract";
import {
  SWEET_TRIP_PRODUCT_ID,
  SWEET_TRIP_PRODUCT_NAME,
} from "@/lib/zoho/v1206-sweet-trip-pilot-contract";

export const ZOHO_SKU_ROLLOUT_CHECKLIST_DOC =
  "docs/ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md";

export const ZOHO_PUSH_RUNBOOK_DOC =
  "docs/LUMA_ZOHO_BAG_RECEIVE_AND_PRODUCTION_OUTPUT_RUNBOOK.md";

export type PushToZohoApprovedSku = {
  productId: string;
  displayName: string;
  unitCompositeItemId: string;
  provenBagReceive: { receiveNumber: string; zohoEntityId: string };
  provenAssemblyBundleId: string;
};

/** Day-1 PM-approved live-commit allowlist. Preview-only for all other SKUs. */
export const PUSH_TO_ZOHO_APPROVED_SKUS: readonly PushToZohoApprovedSku[] = [
  {
    productId: FIX_RELAX_PRODUCT_ID,
    displayName: FIX_RELAX_PRODUCT_NAME,
    unitCompositeItemId: "5254962000001258190",
    provenBagReceive: {
      receiveNumber: "PR-00569",
      zohoEntityId: "5254962000006735004",
    },
    provenAssemblyBundleId: "5254962000006741002",
  },
  {
    productId: SWEET_TRIP_PRODUCT_ID,
    displayName: SWEET_TRIP_PRODUCT_NAME,
    unitCompositeItemId: "5254962000006219038",
    provenBagReceive: {
      receiveNumber: "PR-00575",
      zohoEntityId: "5254962000006775079",
    },
    provenAssemblyBundleId: "5254962000006782128",
  },
] as const;

export function isProductIdApprovedForLiveZohoCommit(productId: string): boolean {
  return PUSH_TO_ZOHO_APPROVED_SKUS.some((s) => s.productId === productId);
}

export function approvedSkuLabelForProductId(productId: string): string | null {
  return (
    PUSH_TO_ZOHO_APPROVED_SKUS.find((s) => s.productId === productId)?.displayName ??
    null
  );
}

export const PUSH_TO_ZOHO_GO_LIVE_OPERATOR_NOTICE =
  "Push to Zoho is preview-first. Live commit requires PM checklist sign-off, a written approval, and a single-action commit window (Luma gate + Zoho capability + ENABLE_LIVE_INVENTORY_WRITES). Only FIX Relax 1ct and Hyroxi MIT B - Sweet Trip are PM-approved for day-1 live commit; all other SKUs are preview-only until PM adds them to the allowlist.";
