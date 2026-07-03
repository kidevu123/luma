// INVENTORY-BAG-LIFECYCLE-LABEL-1 — display labels for inventory_bags.status.

import { describe, it, expect } from "vitest";
import { describeInventoryBagLifecycle } from "./inventory-bag-lifecycle";

describe("describeInventoryBagLifecycle", () => {
  it("IN_USE + finalized workflow + no lot = 'Finalized · awaiting lot' — NOT active on floor", () => {
    const d = describeInventoryBagLifecycle({
      bagStatus: "IN_USE",
      hasWorkflow: true,
      workflowFinalized: true,
      hasFinishedLot: false,
    });
    expect(d.phase).toBe("FINALIZED_AWAITING_LOT");
    expect(d.label).toBe("Finalized · awaiting lot");
    expect(d.activeOnFloor).toBe(false);
    expect(d.label).not.toMatch(/in use|on floor/i);
    expect(d.hint).toMatch(/not active on the floor/i);
  });

  it("IN_USE + finalized + finished lot = 'Finalized' (not active)", () => {
    const d = describeInventoryBagLifecycle({
      bagStatus: "IN_USE",
      hasWorkflow: true,
      workflowFinalized: true,
      hasFinishedLot: true,
    });
    expect(d.phase).toBe("FINALIZED_LOT_ISSUED");
    expect(d.activeOnFloor).toBe(false);
  });

  it("IN_USE + active (non-finalized) workflow = 'On floor' (activeOnFloor true)", () => {
    const d = describeInventoryBagLifecycle({
      bagStatus: "IN_USE",
      hasWorkflow: true,
      workflowFinalized: false,
      hasFinishedLot: false,
    });
    expect(d.phase).toBe("ON_FLOOR");
    expect(d.label).toBe("On floor");
    expect(d.activeOnFloor).toBe(true);
  });

  it("IN_USE + no workflow = 'In use' review; never active on floor", () => {
    const d = describeInventoryBagLifecycle({
      bagStatus: "IN_USE",
      hasWorkflow: false,
      workflowFinalized: false,
      hasFinishedLot: false,
    });
    expect(d.phase).toBe("IN_USE_NO_WORKFLOW");
    expect(d.activeOnFloor).toBe(false);
  });

  it("AVAILABLE / EMPTIED / QUARANTINED / VOID map to clear non-active labels", () => {
    const base = { hasWorkflow: false, workflowFinalized: false, hasFinishedLot: false };
    expect(describeInventoryBagLifecycle({ ...base, bagStatus: "AVAILABLE" }).label).toBe("Available");
    expect(describeInventoryBagLifecycle({ ...base, bagStatus: "EMPTIED" }).label).toBe("Depleted");
    expect(describeInventoryBagLifecycle({ ...base, bagStatus: "QUARANTINED" }).label).toBe("On hold");
    expect(describeInventoryBagLifecycle({ ...base, bagStatus: "VOID" }).label).toBe("Void");
    for (const s of ["AVAILABLE", "EMPTIED", "QUARANTINED", "VOID"]) {
      expect(describeInventoryBagLifecycle({ ...base, bagStatus: s }).activeOnFloor).toBe(false);
    }
  });
});
