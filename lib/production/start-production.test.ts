import { describe, it, expect } from "vitest";
import {
  resolveStartProductionProduct,
  validateRawBagQrForStart,
  type CandidateProduct,
} from "./start-production";

const card1: CandidateProduct = {
  id: "c1",
  name: "Choco Drift 4ct Card",
  sku: "CD-4CT",
  kind: "CARD",
};
const card2: CandidateProduct = {
  id: "c2",
  name: "Choco Drift 8ct Card",
  sku: "CD-8CT",
  kind: "CARD",
};
const bottle1: CandidateProduct = {
  id: "b1",
  name: "Choco Drift 60ct Bottle",
  sku: "CD-60B",
  kind: "BOTTLE",
};
const variety1: CandidateProduct = {
  id: "v1",
  name: "Variety Pack",
  sku: "VP-001",
  kind: "VARIETY",
};

describe("resolveStartProductionProduct", () => {
  // --- empty candidates ---

  it("config_error when no candidates regardless of station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [],
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.fallback).toEqual([]);
  });

  // --- single candidate ---

  it("auto-selects sole candidate at card station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [card1],
    });
    expect(r).toEqual({ kind: "auto", product: card1 });
  });

  it("auto-selects sole candidate at bottle station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BOTTLE_HANDPACK",
      candidateProducts: [bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: bottle1 });
  });

  it("auto-selects sole candidate when stationKind is null", () => {
    const r = resolveStartProductionProduct({
      stationKind: null,
      candidateProducts: [card1],
    });
    expect(r).toEqual({ kind: "auto", product: card1 });
  });

  // --- card station filtering ---

  it("auto-selects sole CARD product at BLISTER station (bottle filtered out)", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: card1 });
  });

  it("auto-selects sole CARD product at SEALING station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "SEALING",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: card1 });
  });

  it("auto-selects sole CARD product at PACKAGING station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "PACKAGING",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: card1 });
  });

  it("choose among multiple CARD products at BLISTER station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [card1, card2, bottle1],
    });
    expect(r).toEqual({ kind: "choose", candidates: [card1, card2] });
  });

  // --- bottle station filtering ---

  it("auto-selects sole BOTTLE product at BOTTLE_HANDPACK station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BOTTLE_HANDPACK",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: bottle1 });
  });

  it("auto-selects sole BOTTLE product at BOTTLE_CAP_SEAL station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BOTTLE_CAP_SEAL",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: bottle1 });
  });

  it("auto-selects sole BOTTLE product at BOTTLE_STICKER station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BOTTLE_STICKER",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "auto", product: bottle1 });
  });

  // --- config_error: station/product kind mismatch ---

  it("config_error with fallback when BLISTER station has multiple BOTTLE products (no CARD)", () => {
    const bottle2: CandidateProduct = { id: "b2", name: "Other Bottle", sku: "OB-1", kind: "BOTTLE" };
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [bottle1, bottle2],
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") {
      expect(r.fallback).toEqual([bottle1, bottle2]);
      expect(r.message).toContain("CARD");
    }
  });

  it("config_error with fallback when BOTTLE_HANDPACK station has multiple CARD products (no BOTTLE)", () => {
    const r = resolveStartProductionProduct({
      stationKind: "BOTTLE_HANDPACK",
      candidateProducts: [card1, card2],
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") {
      expect(r.fallback).toEqual([card1, card2]);
      expect(r.message).toContain("BOTTLE");
    }
  });

  it("auto-selects sole VARIETY product even at BLISTER station (single candidate always wins)", () => {
    // Single candidate → auto regardless of station; config_error only applies when multiple candidates all mismatch.
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [variety1],
    });
    expect(r).toEqual({ kind: "auto", product: variety1 });
  });

  it("config_error when BLISTER station has multiple VARIETY products (no CARD)", () => {
    const variety2: CandidateProduct = { id: "v2", name: "Variety Pack B", sku: "VP-002", kind: "VARIETY" };
    const r = resolveStartProductionProduct({
      stationKind: "BLISTER",
      candidateProducts: [variety1, variety2],
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.message).toContain("CARD");
  });

  // --- COMBINED / unknown station ---

  it("choose among all candidates at COMBINED station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "COMBINED",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "choose", candidates: [card1, bottle1] });
  });

  it("choose among all candidates when stationKind is null", () => {
    const r = resolveStartProductionProduct({
      stationKind: null,
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "choose", candidates: [card1, bottle1] });
  });

  it("choose among all candidates when stationKind is an unrecognised future value", () => {
    const r = resolveStartProductionProduct({
      stationKind: "FUTURE_KIND",
      candidateProducts: [card1, bottle1],
    });
    expect(r).toEqual({ kind: "choose", candidates: [card1, bottle1] });
  });

  it("VARIETY product included in choose at COMBINED station", () => {
    const r = resolveStartProductionProduct({
      stationKind: "COMBINED",
      candidateProducts: [card1, variety1],
    });
    expect(r).toEqual({ kind: "choose", candidates: [card1, variety1] });
  });
});

describe("validateRawBagQrForStart", () => {
  const baseCard = { status: "ASSIGNED", cardType: "RAW_BAG", assignedWorkflowBagId: null };

  // --- no QR on bag ---
  it("ok:false when bagQrCode is null", () => {
    expect(validateRawBagQrForStart(null, null).ok).toBe(false);
  });

  it("error message mentions 'receiving' when bagQrCode is null", () => {
    const r = validateRawBagQrForStart(null, null);
    if (!r.ok) expect(r.error).toMatch(/receiving/i);
  });

  // --- card not found ---
  it("ok:false when card is null and bagQrCode is set", () => {
    const r = validateRawBagQrForStart(null, "BAG-abc123");
    expect(r.ok).toBe(false);
  });

  // --- wrong card type ---
  it("ok:false for VARIETY_PACK cardType", () => {
    expect(validateRawBagQrForStart({ ...baseCard, cardType: "VARIETY_PACK" }, "tok").ok).toBe(false);
  });

  it("ok:false for WORKFLOW_TRAVELER cardType", () => {
    expect(validateRawBagQrForStart({ ...baseCard, cardType: "WORKFLOW_TRAVELER" }, "tok").ok).toBe(false);
  });

  it("ok:false for UNKNOWN cardType", () => {
    expect(validateRawBagQrForStart({ ...baseCard, cardType: "UNKNOWN" }, "tok").ok).toBe(false);
  });

  // --- retired card ---
  it("ok:false when card is RETIRED", () => {
    expect(validateRawBagQrForStart({ ...baseCard, status: "RETIRED" }, "tok").ok).toBe(false);
  });

  // --- already in production ---
  it("ok:false when card is ASSIGNED with non-null assignedWorkflowBagId (already in production)", () => {
    const r = validateRawBagQrForStart(
      { status: "ASSIGNED", cardType: "RAW_BAG", assignedWorkflowBagId: "wf-uuid-123" },
      "tok",
    );
    expect(r.ok).toBe(false);
  });

  // --- unknown future status ---
  it("ok:false for unrecognised status value (future-proofing)", () => {
    expect(validateRawBagQrForStart({ ...baseCard, status: "LOST" }, "tok").ok).toBe(false);
  });

  // --- valid cases ---
  it("ok:true for IDLE RAW_BAG card (fresh card, no prior assignment)", () => {
    expect(
      validateRawBagQrForStart({ status: "IDLE", cardType: "RAW_BAG", assignedWorkflowBagId: null }, "tok").ok,
    ).toBe(true);
  });

  it("ok:true for ASSIGNED RAW_BAG card with null assignedWorkflowBagId (intake-reserved)", () => {
    expect(validateRawBagQrForStart(baseCard, "tok").ok).toBe(true);
  });
});
