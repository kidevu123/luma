import { describe, it, expect } from "vitest";
import {
  narrowProductsByTablet,
  decideScanStartAfterLookup,
  productConfigErrorMessage,
  shouldIgnoreDuplicateScan,
} from "./floor-scan-start-flow";

const cardA = { id: "p1", allowedTabletTypeIds: ["tt-001"] };
const cardB = { id: "p2", allowedTabletTypeIds: ["tt-001"] };
const bottle = { id: "p3", allowedTabletTypeIds: ["tt-002"] };
const unmapped = { id: "p4", allowedTabletTypeIds: [] };

describe("STATION-3B · narrowProductsByTablet", () => {
  it("returns all products when tablet type is unknown", () => {
    expect(narrowProductsByTablet([cardA, bottle], null)).toEqual([cardA, bottle]);
  });

  it("filters to compatible products when tablet type is known", () => {
    expect(narrowProductsByTablet([cardA, bottle], "tt-001")).toEqual([cardA]);
  });
});

describe("STATION-3B · decideScanStartAfterLookup", () => {
  it("auto-starts when first-op intake bag has exactly one compatible product", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: true,
      isIntakeReserved: true,
      tabletTypeId: "tt-001",
      allowedProducts: [cardA, bottle],
    });
    expect(d).toEqual({ kind: "auto-start", productId: "p1" });
  });

  it("requires product picker when multiple compatible products", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: true,
      isIntakeReserved: true,
      tabletTypeId: "tt-001",
      allowedProducts: [cardA, cardB],
    });
    expect(d).toEqual({ kind: "pick-product" });
  });

  it("returns config-error when zero compatible products for known tablet", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: true,
      isIntakeReserved: true,
      tabletTypeId: "tt-999",
      allowedProducts: [cardA, bottle],
    });
    expect(d.kind).toBe("config-error");
    if (d.kind === "config-error") {
      expect(d.message).toMatch(/tablet type/i);
    }
  });

  it("returns config-error when tablet unknown and no products at station", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: true,
      isIntakeReserved: true,
      tabletTypeId: null,
      allowedProducts: [],
    });
    expect(d.kind).toBe("config-error");
  });

  it("auto-starts pickup path for downstream station (not intake-reserved)", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: false,
      isIntakeReserved: false,
      tabletTypeId: "tt-002",
      allowedProducts: [],
    });
    expect(d).toEqual({ kind: "pickup-auto" });
  });

  it("auto-starts pickup when first-op station scans in-flight bag", () => {
    const d = decideScanStartAfterLookup({
      requireProductForFreshBag: true,
      isIntakeReserved: false,
      tabletTypeId: "tt-001",
      allowedProducts: [cardA],
    });
    expect(d).toEqual({ kind: "pickup-auto" });
  });
});

describe("STATION-3B · shouldIgnoreDuplicateScan", () => {
  it("ignores empty token", () => {
    expect(
      shouldIgnoreDuplicateScan({
        rawToken: "  ",
        inFlightToken: null,
        submitInFlight: false,
        scanPending: false,
      }),
    ).toBe(true);
  });

  it("ignores when scan or submit already in flight", () => {
    expect(
      shouldIgnoreDuplicateScan({
        rawToken: "abc",
        inFlightToken: null,
        submitInFlight: true,
        scanPending: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreDuplicateScan({
        rawToken: "abc",
        inFlightToken: null,
        submitInFlight: false,
        scanPending: true,
      }),
    ).toBe(true);
  });

  it("ignores duplicate token while same scan is in flight", () => {
    expect(
      shouldIgnoreDuplicateScan({
        rawToken: "abc",
        inFlightToken: "abc",
        submitInFlight: false,
        scanPending: false,
      }),
    ).toBe(true);
  });

  it("allows a new token after prior scan finished", () => {
    expect(
      shouldIgnoreDuplicateScan({
        rawToken: "new-token",
        inFlightToken: "old-token",
        submitInFlight: false,
        scanPending: false,
      }),
    ).toBe(false);
  });
});

describe("STATION-3B · productConfigErrorMessage", () => {
  it("mentions tablet type when known", () => {
    expect(productConfigErrorMessage("tt-001")).toMatch(/tablet type/i);
  });

  it("mentions station kind when tablet unknown", () => {
    expect(productConfigErrorMessage(null)).toMatch(/station kind/i);
  });
});
