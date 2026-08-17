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

  it("maps HANDPACK_BLISTER stations to the HANDPACK_BLISTER operation (migration 0074)", () => {
    // Migration 0074 adds a real route_operations row with
    // allowed_station_kind = 'HANDPACK_BLISTER'. The old STATION_KIND_ALIAS
    // (HANDPACK_BLISTER -> BLISTER) is gone; the station now resolves its
    // own operation directly without aliasing.
    const ops = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 8, operationCode: "HANDPACK_BLISTER", allowedStationKind: "HANDPACK_BLISTER" }),
    ];
    expect(pickOperationForStationKind(ops, "HANDPACK_BLISTER")?.operationCode).toBe(
      "HANDPACK_BLISTER",
    );
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

    it("refuses the preference for HANDPACK_BLISTER — has its own real op, is not COMBINED", () => {
      // Migration 0074: HANDPACK_BLISTER no longer aliases onto BLISTER.
      // It has its own route_operations row, so pickOperationForStationKind
      // resolves it directly by allowedStationKind match. The preferOperation
      // gate is COMBINED-only (the raw stationKind guard in
      // pickOperationForStationKind), so a HANDPACK_BLISTER station asking
      // for PACKAGING must still get its own HANDPACK_BLISTER match,
      // never PACKAGING.
      const handpackRoute = [
        op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
        op({ sequence: 6, operationCode: "PACKAGING", allowedStationKind: "PACKAGING" }),
        op({ sequence: 8, operationCode: "HANDPACK_BLISTER", allowedStationKind: "HANDPACK_BLISTER" }),
      ];
      expect(
        pickOperationForStationKind(handpackRoute, "HANDPACK_BLISTER", {
          preferOperation: "PACKAGING",
        })?.operationCode,
      ).toBe("HANDPACK_BLISTER");
    });
  });
});
