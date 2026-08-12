import { describe, it, expect } from "vitest";
import { resolveRouteCodeForQueue } from "./bag-queue";

describe("resolveRouteCodeForQueue", () => {
  it("prefers the product kind when present", () => {
    expect(resolveRouteCodeForQueue({ productKind: "BOTTLE", stationKind: "BLISTER" })).toBe("BOTTLE");
    expect(resolveRouteCodeForQueue({ productKind: "CARD", stationKind: "BOTTLE_STICKER" })).toBe("CARD_BLISTER");
    expect(resolveRouteCodeForQueue({ productKind: "VARIETY", stationKind: null })).toBe("CARD_BLISTER");
  });

  it("falls back to the station family when the product is not chosen yet", () => {
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: "BOTTLE_HANDPACK" })).toBe("BOTTLE");
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: "HANDPACK_BLISTER" })).toBe("CARD_BLISTER");
  });

  it("returns null with nothing to go on", () => {
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: null })).toBeNull();
  });
});
