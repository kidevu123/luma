import { describe, it, expect } from "vitest";
import { classifyFloorScanCard } from "./floor-scan-eligibility";

describe("classifyFloorScanCard", () => {
  it("rejects VARIETY_PACK cards", () => {
    const result = classifyFloorScanCard({
      cardType: "VARIETY_PACK",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/not a bag QR/i);
    }
  });

  it("rejects WORKFLOW_TRAVELER cards", () => {
    const result = classifyFloorScanCard({
      cardType: "WORKFLOW_TRAVELER",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(false);
  });

  it("rejects UNKNOWN cards", () => {
    const result = classifyFloorScanCard({
      cardType: "UNKNOWN",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(false);
  });

  it("rejects RETIRED cards", () => {
    const result = classifyFloorScanCard({
      cardType: "RAW_BAG",
      status: "RETIRED",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/retired/i);
    }
  });

  it("rejects IDLE RAW_BAG cards (pool cards not yet received)", () => {
    const result = classifyFloorScanCard({
      cardType: "RAW_BAG",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/not been linked|receive/i);
    }
  });

  it("accepts intake-reserved cards and marks isIntakeReserved=true", () => {
    const result = classifyFloorScanCard({
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: null,
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.isIntakeReserved).toBe(true);
    }
  });

  it("accepts mid-production cards and marks isIntakeReserved=false", () => {
    const result = classifyFloorScanCard({
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: "some-uuid",
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.isIntakeReserved).toBe(false);
    }
  });
});
