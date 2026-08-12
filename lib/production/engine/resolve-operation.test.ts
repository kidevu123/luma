import { describe, it, expect } from "vitest";
import { pickOperationForStationKind } from "./resolve-operation";
import type { RouteOperationView } from "@/lib/production/routes";

function op(over: Partial<RouteOperationView>): RouteOperationView {
  return {
    routeCode: "CARD_BLISTER",
    routeName: "Card blister",
    sequence: 1,
    operationCode: "BLISTER",
    operationName: "Blister",
    stageKey: "BLISTER_QUEUE",
    nextStageKey: "POST_BLISTER_STAGING",
    reworkStageKey: null,
    allowedStationKind: "BLISTER",
    allowedMachineKind: "BLISTER",
    requiresScan: true,
    requiresCounter: true,
    requiresTimer: true,
    outputUnit: "cards",
    orderIndependentGroup: null,
    ...over,
  };
}

describe("pickOperationForStationKind", () => {
  it("selects the operation whose allowedStationKind matches", () => {
    const ops = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "SEALING")?.operationCode).toBe("HEAT_SEAL");
  });

  it("ignores staging operations that have no station kind", () => {
    const ops = [
      op({ sequence: 3, operationCode: "POST_BLISTER_STAGING", allowedStationKind: null }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "SEALING")?.operationCode).toBe("HEAT_SEAL");
  });

  it("returns null when no operation accepts this station kind", () => {
    const ops = [op({ allowedStationKind: "BLISTER" })];
    expect(pickOperationForStationKind(ops, "PACKAGING")).toBeNull();
  });

  it("maps COMBINED stations to the blister operation", () => {
    const ops = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "COMBINED")?.operationCode).toBe("BLISTER");
  });

  it("maps HANDPACK_BLISTER stations to the blister operation", () => {
    const ops = [op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" })];
    expect(pickOperationForStationKind(ops, "HANDPACK_BLISTER")?.operationCode).toBe("BLISTER");
  });

  it("picks the lowest sequence when two operations accept the kind", () => {
    const ops = [
      op({ sequence: 4, operationCode: "STICKERING", allowedStationKind: "BOTTLE_STICKER" }),
      op({ sequence: 3, operationCode: "STICKERING", allowedStationKind: "BOTTLE_STICKER" }),
    ];
    expect(pickOperationForStationKind(ops, "BOTTLE_STICKER")?.sequence).toBe(3);
  });
});
