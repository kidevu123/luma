import { describe, expect, it } from "vitest";
import {
  evaluateProductSetupReadiness,
  summarizeAutoIssueStatus,
  type ProductSetupReadinessInput,
} from "./product-setup-readiness";

const FULLY_READY: ProductSetupReadinessInput = {
  productId: "00000000-0000-0000-0000-000000000001",
  tabletsPerUnit: 30,
  unitsPerDisplay: 12,
  displaysPerCase: 4,
  defaultShelfLifeDays: 730,
  zohoItemIdUnit: "ZU-1",
  zohoItemIdDisplay: "ZD-1",
  zohoItemIdCase: "ZC-1",
};

describe("evaluateProductSetupReadiness", () => {
  it("returns no missing fields when everything is set", () => {
    const r = evaluateProductSetupReadiness(FULLY_READY);
    expect(r.missingFields).toEqual([]);
    expect(r.autoIssueBlockers).toEqual([]);
    expect(r.zohoReady).toBe(true);
    expect(r.unknown).toBe(false);
  });

  it("flags missing shelf life as an auto-issue blocker", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: null,
    });
    expect(r.autoIssueBlockers.map((b) => b.code)).toContain("MISSING_SHELF_LIFE");
    expect(r.zohoReady).toBe(true);
  });

  it("flags missing tablets per unit", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      tabletsPerUnit: null,
    });
    expect(r.autoIssueBlockers.map((b) => b.code)).toContain(
      "MISSING_TABLETS_PER_UNIT",
    );
  });

  it("flags missing packaging structure when units-per-display or displays-per-case is null", () => {
    expect(
      evaluateProductSetupReadiness({
        ...FULLY_READY,
        unitsPerDisplay: null,
      }).autoIssueBlockers.map((b) => b.code),
    ).toContain("MISSING_PACKAGING_STRUCTURE");
    expect(
      evaluateProductSetupReadiness({
        ...FULLY_READY,
        displaysPerCase: null,
      }).autoIssueBlockers.map((b) => b.code),
    ).toContain("MISSING_PACKAGING_STRUCTURE");
  });

  it("flags missing Zoho IDs but NOT as an auto-issue blocker", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      zohoItemIdDisplay: null,
    });
    expect(r.missingFields.map((b) => b.code)).toContain("MISSING_ZOHO_ITEM_IDS");
    expect(r.autoIssueBlockers.map((b) => b.code)).not.toContain(
      "MISSING_ZOHO_ITEM_IDS",
    );
    expect(r.zohoReady).toBe(false);
  });

  it("treats empty-string Zoho IDs as not-set", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      zohoItemIdUnit: "   ",
    });
    expect(r.zohoReady).toBe(false);
  });

  it("reports unknown when no product is mapped", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      productId: null,
    });
    expect(r.unknown).toBe(true);
    expect(r.missingFields).toEqual([]);
  });
});

describe("summarizeAutoIssueStatus", () => {
  it("returns 'Auto-issue ready' when no auto-issue blockers", () => {
    const r = evaluateProductSetupReadiness(FULLY_READY);
    expect(summarizeAutoIssueStatus(r).label).toBe("Auto-issue ready");
    expect(summarizeAutoIssueStatus(r).multi).toBe(false);
  });

  it("returns the single field label when exactly one auto-issue blocker", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: null,
    });
    expect(summarizeAutoIssueStatus(r).label).toBe(
      "Missing shelf life / expiry",
    );
    expect(summarizeAutoIssueStatus(r).multi).toBe(false);
  });

  it("collapses to 'Multiple fields missing' when more than one auto-issue blocker", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: null,
      tabletsPerUnit: null,
    });
    expect(summarizeAutoIssueStatus(r).label).toBe("Multiple fields missing");
    expect(summarizeAutoIssueStatus(r).multi).toBe(true);
  });

  it("Zoho-only gaps don't change the auto-issue summary", () => {
    const r = evaluateProductSetupReadiness({
      ...FULLY_READY,
      zohoItemIdCase: null,
    });
    expect(summarizeAutoIssueStatus(r).label).toBe("Auto-issue ready");
  });
});

describe("regression — fixing shelf life + Zoho IDs together exits the missing state", () => {
  // The reported bug: rows kept showing "Missing shelf life / expiry"
  // even after Zoho IDs were filled, because Zoho IDs were never the
  // actual auto-issue blocker. Fix the real blocker (shelf life) and
  // the auto-issue summary clears.
  it("transitions from blocker to ready once shelf life is set", () => {
    const before = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: null,
      zohoItemIdCase: null,
    });
    expect(summarizeAutoIssueStatus(before).label).toBe(
      "Missing shelf life / expiry",
    );
    expect(before.zohoReady).toBe(false);

    const afterShelf = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: 365,
      zohoItemIdCase: null,
    });
    expect(summarizeAutoIssueStatus(afterShelf).label).toBe("Auto-issue ready");
    expect(afterShelf.zohoReady).toBe(false);

    const afterAll = evaluateProductSetupReadiness({
      ...FULLY_READY,
      defaultShelfLifeDays: 365,
    });
    expect(summarizeAutoIssueStatus(afterAll).label).toBe("Auto-issue ready");
    expect(afterAll.zohoReady).toBe(true);
  });
});
