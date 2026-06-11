// P1-PARTIAL — Human-readable partial bag lifecycle states.
//
// Derived (not stored): the source of truth stays inventory_bags.status
// + raw_bag_allocation_sessions, per the locked design. This module
// names the states the workbench and floor display:
//   fresh                  — never used (AVAILABLE, no sessions).
//   in_use                 — OPEN session / IN_USE status.
//   partial_ready          — closed session with a trusted remaining qty.
//   partial_needs_closeout — partial use indicated, no reliable ending
//                            balance (or session still open at rest).
//   on_hold                — QUARANTINED; blocked until QA review.
//   depleted               — EMPTIED / zero remaining.
//   void_bad_linkage       — VOID record or unusable linkage.

import type { PartialBagSession } from "@/lib/production/partial-bags";
import {
  hasOpenAllocationSession,
  isAvailablePartialBag,
} from "@/lib/production/partial-bags";
import { canRestartAvailablePartialRawBag } from "@/lib/production/partial-bag-restart";

export const PARTIAL_BAG_LIFECYCLE_STATES = [
  "fresh",
  "in_use",
  "partial_ready",
  "partial_needs_closeout",
  "on_hold",
  "depleted",
  "void_bad_linkage",
] as const;
export type PartialBagLifecycleState =
  (typeof PARTIAL_BAG_LIFECYCLE_STATES)[number];

export const PARTIAL_BAG_LIFECYCLE_LABELS: Record<
  PartialBagLifecycleState,
  string
> = {
  fresh: "Fresh",
  in_use: "In use",
  partial_ready: "Partial — ready",
  partial_needs_closeout: "Partial — needs closeout",
  on_hold: "On hold / quarantined",
  depleted: "Depleted",
  void_bad_linkage: "Void / bad linkage",
};

export function derivePartialBagLifecycleState(args: {
  inventoryStatus: string;
  sessions: readonly PartialBagSession[];
}): PartialBagLifecycleState {
  const { inventoryStatus, sessions } = args;
  if (inventoryStatus === "VOID") return "void_bad_linkage";
  if (inventoryStatus === "QUARANTINED") return "on_hold";
  if (inventoryStatus === "EMPTIED") return "depleted";
  if (inventoryStatus === "IN_USE" || hasOpenAllocationSession(sessions)) {
    return "in_use";
  }
  // AVAILABLE from here on.
  if (!isAvailablePartialBag(sessions)) return "fresh";
  if (
    canRestartAvailablePartialRawBag({
      inventoryStatus,
      sessions,
    })
  ) {
    return "partial_ready";
  }
  return "partial_needs_closeout";
}

// Honest remaining-quantity display lives in the client-safe constants
// module (this file pulls in the DB via partial-bags and must stay out
// of client bundles). Re-exported here for server-side convenience.
export { formatRemainingEstimate } from "@/lib/production/partial-bag-resolution-constants";
