// PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1 — restart eligibility for
// available partial raw bags (new workflow run + fresh product choice).

import { isPartialBagResume } from "@/lib/production/bag-allocation";
import {
  hasOpenAllocationSession,
  isAvailablePartialBag,
  type PartialBagSession,
} from "@/lib/production/partial-bags";

export type { PartialBagSession };

/** True when inventory is AVAILABLE, no OPEN session, and the bag has
 *  prior closed/returned allocation history (partial reuse). */
export function canRestartAvailablePartialRawBag(args: {
  inventoryStatus: string;
  sessions: readonly PartialBagSession[];
}): boolean {
  if (args.inventoryStatus !== "AVAILABLE") return false;
  if (hasOpenAllocationSession(args.sessions)) return false;
  if (!isAvailablePartialBag(args.sessions)) return false;
  return isPartialBagResume(latestResumeCandidateSession(args.sessions));
}

function latestResumeCandidateSession(
  sessions: readonly PartialBagSession[],
): PartialBagSession | null {
  const relevant = sessions
    .filter(
      (s) =>
        s.allocationStatus === "CLOSED" ||
        s.allocationStatus === "RETURNED_TO_STOCK",
    )
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  return relevant[0] ?? null;
}

/** After a workflow bag is finalized, the same physical QR may start a
 *  new run when tablets remain. Covers AVAILABLE partial bags and the
 *  brief window before inventory status flips to AVAILABLE. */
export function canResumeFinalizedWorkflowOnInventoryBag(args: {
  inventoryStatus: string;
  sessions: readonly PartialBagSession[];
}): boolean {
  if (hasOpenAllocationSession(args.sessions)) return false;
  if (canRestartAvailablePartialRawBag(args)) return true;
  return isPartialBagResume(latestResumeCandidateSession(args.sessions));
}
