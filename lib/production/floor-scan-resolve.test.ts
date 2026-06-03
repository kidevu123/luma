import { describe, it, expect } from "vitest";
import {
  floorScanInputMatchesCard,
  pickBestFloorScanCard,
} from "./floor-scan-resolve";

describe("floorScanInputMatchesCard", () => {
  it("matches exact scanToken", () => {
    expect(
      floorScanInputMatchesCard("bag-card-104", {
        id: "uuid-1",
        label: "Bag Card 104",
        scanToken: "bag-card-104",
      }),
    ).toBe(true);
  });

  it("matches bag-card-N token to Bag Card N label via numeric suffix", () => {
    expect(
      floorScanInputMatchesCard("bag-card-104", {
        id: "uuid-assigned",
        label: "Bag Card 104",
        scanToken: "legacy-uuid-token",
      }),
    ).toBe(true);
  });

  it("matches legacy UUID input to card id", () => {
    const id = "00000000-0000-4000-8000-000000000104";
    expect(
      floorScanInputMatchesCard(id, {
        id,
        label: "Bag Card 104",
        scanToken: "bag-card-104",
      }),
    ).toBe(true);
  });

  it("does not match unrelated idle pool card with different suffix", () => {
    expect(
      floorScanInputMatchesCard("bag-card-104", {
        id: "uuid-idle",
        label: "bag-card-99",
        scanToken: "bag-card-99",
      }),
    ).toBe(false);
  });
});

describe("pickBestFloorScanCard", () => {
  const idlePool = {
    id: "idle-id",
    label: "bag-card-104",
    scanToken: "bag-card-104",
    cardType: "RAW_BAG",
    status: "IDLE",
    assignedWorkflowBagId: null,
  };

  const assignedPickup = {
    id: "assigned-id",
    label: "Bag Card 104",
    scanToken: "00000000-0000-4000-8000-000000000104",
    cardType: "RAW_BAG",
    status: "ASSIGNED",
    assignedWorkflowBagId: "bag-uuid",
  };

  it("prefers assigned workflow pickup over idle pool for bag-card-104", () => {
    const picked = pickBestFloorScanCard(
      [idlePool, assignedPickup],
      "bag-card-104",
      {
        pickupStages: ["BLISTERED"],
        pickupStageByBagId: new Map([["bag-uuid", "BLISTERED"]]),
      },
    );
    expect(picked?.id).toBe("assigned-id");
  });

  it("keeps idle pool when no assigned workflow match exists", () => {
    const intakeReserved = {
      id: "intake-id",
      label: "bag-card-2",
      scanToken: "bag-card-2",
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: null,
    };
    const picked = pickBestFloorScanCard([idlePool, intakeReserved], "bag-card-2");
    expect(picked?.id).toBe("intake-id");
  });
});
