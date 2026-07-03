// INVENTORY-BAG-LIFECYCLE-LABEL-1 — human-facing labels for inventory_bags.status.
//
// The raw enum (AVAILABLE / IN_USE / EMPTIED / QUARANTINED / VOID) tracks the
// ALLOCATION lifecycle: a bag is IN_USE while it has an open allocation session,
// and only leaves IN_USE when that session is closed at finished-lot issue
// (→ AVAILABLE if a partial remains, EMPTIED if depleted). So "IN_USE" spans two
// very different real-world situations that this helper separates for display:
//   - a bag actively being worked on the floor, and
//   - a bag whose production is FINALIZED and is now just awaiting finished-lot
//     issuance (its QR was already released). The latter must not read as
//     "active on floor". This is display-only — it never changes stored status.

export type InventoryBagLifecyclePhase =
  | "AVAILABLE"
  | "ON_FLOOR"
  | "FINALIZED_AWAITING_LOT"
  | "FINALIZED_LOT_ISSUED"
  | "IN_USE_NO_WORKFLOW"
  | "DEPLETED"
  | "ON_HOLD"
  | "VOID";

export type InventoryBagLifecycleTone = "ok" | "info" | "neutral" | "warn" | "danger";

export type InventoryBagLifecycleDescriptor = {
  phase: InventoryBagLifecyclePhase;
  /** Short chip label. */
  label: string;
  tone: InventoryBagLifecycleTone;
  /** Longer hint for tooltips / detail rows. */
  hint: string;
  /** True only when the bag is genuinely being worked on the floor right now. */
  activeOnFloor: boolean;
};

export type InventoryBagLifecycleInput = {
  bagStatus: string;
  hasWorkflow: boolean;
  workflowFinalized: boolean;
  hasFinishedLot: boolean;
};

export function describeInventoryBagLifecycle(
  input: InventoryBagLifecycleInput,
): InventoryBagLifecycleDescriptor {
  switch (input.bagStatus) {
    case "VOID":
      return { phase: "VOID", label: "Void", tone: "danger", hint: "Bag voided.", activeOnFloor: false };
    case "QUARANTINED":
      return { phase: "ON_HOLD", label: "On hold", tone: "warn", hint: "Bag quarantined / on hold.", activeOnFloor: false };
    case "EMPTIED":
      return { phase: "DEPLETED", label: "Depleted", tone: "neutral", hint: "Bag fully consumed; QR released. Finished history.", activeOnFloor: false };
    case "AVAILABLE":
      return { phase: "AVAILABLE", label: "Available", tone: "ok", hint: "Ready for floor start.", activeOnFloor: false };
    case "IN_USE": {
      if (input.hasWorkflow && input.workflowFinalized) {
        if (!input.hasFinishedLot) {
          return {
            phase: "FINALIZED_AWAITING_LOT",
            label: "Finalized · awaiting lot",
            tone: "info",
            hint: "Production finished and QR released. Awaiting finished-lot issuance in Production Output — not active on the floor.",
            activeOnFloor: false,
          };
        }
        return {
          phase: "FINALIZED_LOT_ISSUED",
          label: "Finalized",
          tone: "info",
          hint: "Production finished; finished lot exists (issued or on hold). Not active on the floor.",
          activeOnFloor: false,
        };
      }
      if (input.hasWorkflow) {
        return {
          phase: "ON_FLOOR",
          label: "On floor",
          tone: "info",
          hint: "Active production run in progress.",
          activeOnFloor: true,
        };
      }
      return {
        phase: "IN_USE_NO_WORKFLOW",
        label: "In use",
        tone: "info",
        hint: "Allocation open with no workflow bag — review.",
        activeOnFloor: false,
      };
    }
    default:
      return { phase: "IN_USE_NO_WORKFLOW", label: input.bagStatus, tone: "neutral", hint: "", activeOnFloor: false };
  }
}
