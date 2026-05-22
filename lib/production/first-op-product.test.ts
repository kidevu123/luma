import { describe, it, expect } from "vitest";
import {
  FIRST_OP_STATION_KINDS,
  STATION_KIND_TO_PRODUCT_KINDS,
  checkFirstOpProductSelection,
} from "./first-op-product";

const ACTIVE_CARD = {
  id: "p-card",
  sku: "QA_TEST_CARD_A",
  name: "Card A",
  kind: "CARD",
  isActive: true,
};

const ACTIVE_BOTTLE = {
  id: "p-bottle",
  sku: "BOT_A",
  name: "Bottle A",
  kind: "BOTTLE",
  isActive: true,
};

const ACTIVE_VARIETY = {
  id: "p-var",
  sku: "VAR_3PK",
  name: "Variety 3pk",
  kind: "VARIETY",
  isActive: true,
};

describe("first-op product selection — Blister station", () => {
  it("requires productId for IDLE card at BLISTER", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pick a product/);
  });

  it("rejects when picked product not found", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: "ghost",
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/);
  });

  it("rejects inactive products", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_CARD.id,
      product: { ...ACTIVE_CARD, isActive: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inactive/);
  });

  it("rejects bottle products at the BLISTER station", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_BOTTLE.id,
      product: ACTIVE_BOTTLE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot start at a BLISTER station/);
  });

  it("accepts CARD products at BLISTER", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_CARD.id,
      product: ACTIVE_CARD,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_CARD.id);
  });

  it("accepts VARIETY products at BLISTER (variety packs assemble through card route)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_VARIETY.id,
      product: ACTIVE_VARIETY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_VARIETY.id);
  });
});

describe("first-op product selection — pickup of an ASSIGNED card", () => {
  it("does NOT require pickedProductId (server fetches from existing bag)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "SEALING",
      cardStatus: "ASSIGNED",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBeNull();
  });

  it("does NOT require pickedProductId at BLISTER pickup either", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BLISTER",
      cardStatus: "ASSIGNED",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("first-op product selection — non-first-op stations", () => {
  it("does NOT gate sealing for IDLE card scans (rare path)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "SEALING",
      cardStatus: "IDLE",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
  });

  it("does NOT gate packaging for IDLE card scans", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "PACKAGING",
      cardStatus: "IDLE",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("first-op product selection — registry sanity", () => {
  it("BLISTER and COMBINED are first-op kinds", () => {
    expect(FIRST_OP_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FIRST_OP_STATION_KINDS.has("COMBINED")).toBe(true);
  });

  it("SEALING / PACKAGING / pickup-only kinds are NOT first-op", () => {
    expect(FIRST_OP_STATION_KINDS.has("SEALING")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("PACKAGING")).toBe(false);
  });

  it("STATION_KIND_TO_PRODUCT_KINDS allows VARIETY at both BLISTER and BOTTLE_HANDPACK", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS.BLISTER).toContain("VARIETY");
    expect(STATION_KIND_TO_PRODUCT_KINDS.BOTTLE_HANDPACK).toContain("VARIETY");
  });

  it("BOTTLE_HANDPACK is a first-op station kind", () => {
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(true);
  });

  it("downstream-only kinds are NOT first-op", () => {
    expect(FIRST_OP_STATION_KINDS.has("SEALING")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_CAP_SEAL")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_STICKER")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("PACKAGING")).toBe(false);
  });
});

describe("first-op product selection — BOTTLE_HANDPACK station", () => {
  it("requires productId for IDLE card at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pick a product/);
  });

  it("accepts BOTTLE product at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_BOTTLE.id,
      product: ACTIVE_BOTTLE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_BOTTLE.id);
  });

  it("accepts VARIETY product at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_VARIETY.id,
      product: ACTIVE_VARIETY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_VARIETY.id);
  });

  it("rejects CARD product at BOTTLE_HANDPACK (wrong kind)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_CARD.id,
      product: ACTIVE_CARD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot start at a BOTTLE_HANDPACK station/);
  });

  it("does not require product for ASSIGNED card at BOTTLE_HANDPACK (pickup path)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "ASSIGNED",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBeNull();
  });
});

describe("STATION_KIND_TO_PRODUCT_KINDS — product kind mapping per station", () => {
  it("BLISTER allows CARD and VARIETY only", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS["BLISTER"]).toEqual(
      expect.arrayContaining(["CARD", "VARIETY"]),
    );
    expect(STATION_KIND_TO_PRODUCT_KINDS["BLISTER"]).not.toContain("BOTTLE");
  });

  it("HANDPACK_BLISTER allows CARD and VARIETY only", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS["HANDPACK_BLISTER"]).toEqual(
      expect.arrayContaining(["CARD", "VARIETY"]),
    );
    expect(STATION_KIND_TO_PRODUCT_KINDS["HANDPACK_BLISTER"]).not.toContain("BOTTLE");
  });

  it("COMBINED allows CARD and VARIETY only", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS["COMBINED"]).toEqual(
      expect.arrayContaining(["CARD", "VARIETY"]),
    );
    expect(STATION_KIND_TO_PRODUCT_KINDS["COMBINED"]).not.toContain("BOTTLE");
  });

  it("BOTTLE_HANDPACK allows BOTTLE and VARIETY only", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS["BOTTLE_HANDPACK"]).toEqual(
      expect.arrayContaining(["BOTTLE", "VARIETY"]),
    );
    expect(STATION_KIND_TO_PRODUCT_KINDS["BOTTLE_HANDPACK"]).not.toContain("CARD");
  });

  it("downstream stations (SEALING, PACKAGING) have no entry — empty array fallback", () => {
    expect(STATION_KIND_TO_PRODUCT_KINDS["SEALING"] ?? []).toHaveLength(0);
    expect(STATION_KIND_TO_PRODUCT_KINDS["PACKAGING"] ?? []).toHaveLength(0);
  });
});
