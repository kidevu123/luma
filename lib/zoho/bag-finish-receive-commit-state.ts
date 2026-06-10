// ZOHO-BAG-FINISH-RECEIVE — commit persistence rules (guard vs Zoho failure).

import type { AssemblyServiceCallResult } from "@/lib/zoho/assembly-service-client";

type FailedCommitResult = Extract<AssemblyServiceCallResult, { ok: false }>;

/** FAILED status is only for authorized attempts that reached Zoho and failed. */
export function shouldPersistBagFinishCommitFailure(
  result: FailedCommitResult,
): boolean {
  if (result.guardBlocked) return false;
  if (result.httpStatus === 403) return false;
  if (result.httpStatus == null) return false;
  return true;
}

export function bagFinishCommitBlockedReason(
  result: FailedCommitResult,
): string {
  if (result.guardBlocked) {
    return result.message;
  }
  if (result.httpStatus === 403) {
    return "Bag-finish receive commit is not authorized. Zoho live inventory writes are disabled.";
  }
  return result.message;
}
