// P0-ALLOC-REPAIR — source allocation classification + lead repair pins.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { classifySourceAllocation } from "./source-allocation-status";

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("classifySourceAllocation", () => {
  it("healthy when an OPEN session is linked to this run", () => {
    const s = classifySourceAllocation({
      workflowBagId: RUN,
      hasInventoryLink: true,
      sessions: [{ id: "a", allocationStatus: "OPEN", workflowBagId: RUN }],
      cardAssignedHadAllocationId: true,
    });
    expect(s.kind).toBe("healthy");
    expect(s.repairable).toBe(false);
  });

  it("closed when this run's session was already closed (repairable: reopen)", () => {
    const s = classifySourceAllocation({
      workflowBagId: RUN,
      hasInventoryLink: true,
      sessions: [{ id: "a", allocationStatus: "CLOSED", workflowBagId: RUN }],
      cardAssignedHadAllocationId: true,
    });
    expect(s.kind).toBe("closed");
    expect(s.repairable).toBe(true);
  });

  it("missing_legacy when run predates auto-open (no allocation id on CARD_ASSIGNED)", () => {
    const s = classifySourceAllocation({
      workflowBagId: RUN,
      hasInventoryLink: true,
      sessions: [{ id: "b", allocationStatus: "CLOSED", workflowBagId: OTHER }],
      cardAssignedHadAllocationId: false,
    });
    expect(s.kind).toBe("missing_legacy");
    expect(s.message).toMatch(/before allocation tracking/i);
    expect(s.repairable).toBe(true);
  });

  it("missing_bug when the run claimed a session that no longer exists", () => {
    const s = classifySourceAllocation({
      workflowBagId: RUN,
      hasInventoryLink: true,
      sessions: [],
      cardAssignedHadAllocationId: true,
    });
    expect(s.kind).toBe("missing_bug");
    expect(s.message).toMatch(/report the issue/i);
    expect(s.repairable).toBe(true);
  });

  it("no_inventory_link is not repairable from the panel", () => {
    const s = classifySourceAllocation({
      workflowBagId: RUN,
      hasInventoryLink: false,
      sessions: [],
      cardAssignedHadAllocationId: false,
    });
    expect(s.kind).toBe("no_inventory_link");
    expect(s.repairable).toBe(false);
  });
});

describe("lead repair action contract", () => {
  const src = readFileSync(
    join(__dirname, "../../app/(floor)/floor/[token]/bag-allocation-actions.ts"),
    "utf8",
  );

  it("repairSourceAllocationAction requires a lead badge and uses the shared open helper", () => {
    expect(src).toMatch(/export async function repairSourceAllocationAction/);
    expect(src).toMatch(/leadCode/);
    expect(src).toMatch(/Lead badge code not recognized/);
    expect(src).toMatch(/source: "LEAD_REPAIR"/);
    expect(src).toMatch(/openAllocationSessionForBagStart\(/);
    expect(src).toMatch(/raw_bag\.allocation_repaired/);
  });
});
