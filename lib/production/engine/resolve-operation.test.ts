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

  describe("COMBINED-AT-PACKAGING-1 — opts.preferOperation", () => {
    const cardBlisterRoute = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
      op({ sequence: 6, operationCode: "PACKAGING", allowedStationKind: "PACKAGING" }),
    ];

    it("still resolves BLISTER for COMBINED with no preference", () => {
      expect(pickOperationForStationKind(cardBlisterRoute, "COMBINED")?.operationCode).toBe(
        "BLISTER",
      );
    });

    it("lets a COMBINED station take the preferred PACKAGING operation", () => {
      expect(
        pickOperationForStationKind(cardBlisterRoute, "COMBINED", {
          preferOperation: "PACKAGING",
        })?.operationCode,
      ).toBe("PACKAGING");
    });

    it("falls back to the blister alias when the route has no matching preferred op", () => {
      const noPackaging = [
        op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      ];
      expect(
        pickOperationForStationKind(noPackaging, "COMBINED", {
          preferOperation: "PACKAGING",
        })?.operationCode,
      ).toBe("BLISTER");
    });

    it("refuses the preference for a non-COMBINED station kind — foreign op stays out of reach", () => {
      // A plain PACKAGING station passing "PACKAGING" is a no-op (it
      // already resolves PACKAGING); the real guard is a station kind
      // that does NOT match the preferred op's allowedStationKind. A
      // plain SEALING station asking for "PACKAGING" must still get
      // its own HEAT_SEAL match, never PACKAGING.
      expect(
        pickOperationForStationKind(cardBlisterRoute, "SEALING", {
          preferOperation: "PACKAGING",
        })?.operationCode,
      ).toBe("HEAT_SEAL");
    });

    it("refuses the preference for HANDPACK_BLISTER — aliases onto BLISTER but is not COMBINED", () => {
      const handpackRoute = [
        op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
        op({ sequence: 6, operationCode: "PACKAGING", allowedStationKind: "PACKAGING" }),
      ];
      expect(
        pickOperationForStationKind(handpackRoute, "HANDPACK_BLISTER", {
          preferOperation: "PACKAGING",
        })?.operationCode,
      ).toBe("BLISTER");
    });
  });
});
