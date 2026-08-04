import { describe, it, expect } from "vitest";
import { buildShipmentLabel } from "./shipments";

describe("buildShipmentLabel", () => {
  it("bare shipment", () => {
    expect(buildShipmentLabel({ index: 0, carrier: null, trackingNumber: null, receiveCount: 1 }))
      .toBe("Shipment 1 (1 receive)");
  });
  it("with carrier + tracking", () => {
    expect(buildShipmentLabel({ index: 1, carrier: "FedEx", trackingNumber: "771234", receiveCount: 3 }))
      .toBe("Shipment 2 — FedEx 771234 (3 receives)");
  });
});
