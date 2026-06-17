// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — pure classifier tests.

import { describe, expect, it } from "vitest";
import {
  classifyProductionOutputRow,
  statusFilterMatches,
  type ProductionOutputClassifierInput,
} from "./production-output-row-classifier";

const BASE: ProductionOutputClassifierInput = {
  finalizedAt: new Date("2026-05-15T12:00:00Z"),
  startedAt: new Date("2026-05-15T08:00:00Z"),
  stage: "FINALIZED",
  excludedFromOutput: false,
  backlogActionCode: null,
  backlogActionLabel: null,
  finishedLotId: null,
  finishedLotNumber: null,
  finishedLotStatus: null,
  genealogyLinkCount: 0,
  productZohoItemIdUnit: null,
  productZohoItemIdDisplay: null,
  productZohoItemIdCase: null,
  productTabletsPerUnit: null,
  casesProduced: 0,
  displaysProduced: 0,
  zohoOpId: null,
  zohoOpStatus: null,
  zohoOpCommittedAt: null,
};

describe("classifyProductionOutputRow — excluded short-circuit", () => {
  it("EXCLUDED dominates even when a finished lot exists", () => {
    const r = classifyProductionOutputRow({
      ...BASE,
      excludedFromOutput: true,
      finishedLotId: "lot-1",
      finishedLotNumber: "FL-1",
    });
    expect(r.status).toBe("EXCLUDED");
    expect(r.zohoPush.enabled).toBe(false);
  });
});

describe("classifyProductionOutputRow — Zoho lifecycle", () => {
  it("ZOHO_COMMITTED when committed_at is set", () => {
    const r = classifyProductionOutputRow({
      ...BASE,
      finishedLotId: "lot-1",
      zohoOpId: "op-1",
      zohoOpStatus: "COMMITTED",
      zohoOpCommittedAt: new Date(),
    });
    expect(r.status).toBe("ZOHO_COMMITTED");
    expect(r.primaryAction).toBe("VIEW_ZOHO_OP");
    expect(r.zohoPush.enabled).toBe(false);
    if (!r.zohoPush.enabled) {
      expect(r.zohoPush.blocker).toBe("ZOHO_ALREADY_COMMITTED");
    }
  });

  it("ZOHO_FAILED when status is NEEDS_MAPPING / NEEDS_REVIEW / FAILED", () => {
    for (const s of ["FAILED", "NEEDS_MAPPING", "NEEDS_REVIEW"]) {
      const r = classifyProductionOutputRow({
        ...BASE,
        finishedLotId: "lot-1",
        zohoOpId: "op-1",
        zohoOpStatus: s,
        zohoOpCommittedAt: null,
      });
      expect(r.status).toBe("ZOHO_FAILED");
    }
  });

  it("ZOHO_PENDING when status is DRAFT/PREVIEWED/APPROVED/QUEUED/PENDING/COMMITTING", () => {
    for (const s of [
      "DRAFT",
      "PREVIEWED",
      "APPROVED",
      "QUEUED",
      "PENDING",
      "COMMITTING",
    ]) {
      const r = classifyProductionOutputRow({
        ...BASE,
        finishedLotId: "lot-1",
        zohoOpId: "op-1",
        zohoOpStatus: s,
        zohoOpCommittedAt: null,
      });
      expect(r.status).toBe("ZOHO_PENDING");
      expect(r.zohoPush.enabled).toBe(false);
    }
  });
});

describe("classifyProductionOutputRow — issued lot, no Zoho op", () => {
  const ISSUED: ProductionOutputClassifierInput = {
    ...BASE,
    finishedLotId: "lot-1",
    finishedLotNumber: "FL-1",
    finishedLotStatus: "RELEASED",
    genealogyLinkCount: 2,
    productTabletsPerUnit: 30,
    productZohoItemIdUnit: "ZOHO-U-1",
  };

  it("ISSUED_LOT + push enabled when product Zoho IDs + genealogy + tablets_per_unit are all present", () => {
    const r = classifyProductionOutputRow(ISSUED);
    expect(r.status).toBe("ISSUED_LOT");
    expect(r.primaryAction).toBe("PUSH_TO_ZOHO");
    expect(r.zohoPush.enabled).toBe(true);
  });

  it("falls back to VIEW_FINISHED_LOT when push is blocked", () => {
    const r = classifyProductionOutputRow({ ...ISSUED, genealogyLinkCount: 0 });
    expect(r.status).toBe("ISSUED_LOT");
    expect(r.primaryAction).toBe("VIEW_FINISHED_LOT");
    expect(r.zohoPush.enabled).toBe(false);
    if (!r.zohoPush.enabled) {
      expect(r.zohoPush.blocker).toBe("MISSING_ALLOCATION");
    }
  });

  it("blocks push when tabletsPerUnit is missing", () => {
    const r = classifyProductionOutputRow({
      ...ISSUED,
      productTabletsPerUnit: null,
    });
    expect(r.zohoPush.enabled).toBe(false);
    if (!r.zohoPush.enabled) {
      expect(r.zohoPush.blocker).toBe("MISSING_TABLETS_PER_UNIT");
    }
  });

  it("blocks push when unit Zoho composite ID is missing", () => {
    const r = classifyProductionOutputRow({
      ...ISSUED,
      productZohoItemIdUnit: null,
    });
    expect(r.zohoPush.enabled).toBe(false);
    if (!r.zohoPush.enabled) {
      expect(r.zohoPush.blocker).toBe("MISSING_PRODUCT_ZOHO_IDS");
    }
  });

  it("blocks push when displays were made but display composite ID is missing", () => {
    const r = classifyProductionOutputRow({
      ...ISSUED,
      displaysProduced: 6,
      productZohoItemIdDisplay: null,
    });
    expect(r.zohoPush.enabled).toBe(false);
  });

  it("blocks push when cases were made but case composite ID is missing", () => {
    const r = classifyProductionOutputRow({
      ...ISSUED,
      casesProduced: 1,
      productZohoItemIdCase: null,
    });
    expect(r.zohoPush.enabled).toBe(false);
  });

  it("does not require display ID when displaysProduced is zero", () => {
    const r = classifyProductionOutputRow({
      ...ISSUED,
      displaysProduced: 0,
      productZohoItemIdDisplay: null,
    });
    expect(r.zohoPush.enabled).toBe(true);
  });
});

describe("classifyProductionOutputRow — backlog rows (no lot, finalized)", () => {
  it("READY_TO_AUTO_ISSUE when backlog code is OK / AUTO_ISSUE_NOW", () => {
    expect(
      classifyProductionOutputRow({ ...BASE, backlogActionCode: "OK" })
        .status,
    ).toBe("READY_TO_AUTO_ISSUE");
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "AUTO_ISSUE_NOW",
      }).status,
    ).toBe("READY_TO_AUTO_ISSUE");
  });

  it("MISSING_ALLOCATION when backlog code is in the allocation set", () => {
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "MISSING_ALLOCATION",
      }).status,
    ).toBe("MISSING_ALLOCATION");
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "OPEN_ALLOCATION_ELSEWHERE",
      }).status,
    ).toBe("MISSING_ALLOCATION");
  });

  it("BLOCKED when backlog code is in the setup-issue set", () => {
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "MISSING_PRODUCT_SETUP",
      }).status,
    ).toBe("BLOCKED");
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "MISSING_ZOHO_MAPPING",
      }).status,
    ).toBe("BLOCKED");
  });

  it("AWAITING_LOT when code is unknown / null", () => {
    expect(
      classifyProductionOutputRow({ ...BASE, backlogActionCode: null }).status,
    ).toBe("AWAITING_LOT");
    expect(
      classifyProductionOutputRow({
        ...BASE,
        backlogActionCode: "UNKNOWN_CODE",
      }).status,
    ).toBe("AWAITING_LOT");
  });
});

describe("classifyProductionOutputRow — packaged not finalized", () => {
  it("PACKAGED_NOT_FINALIZED when stage=PACKAGED and finalizedAt is null", () => {
    const r = classifyProductionOutputRow({
      ...BASE,
      finalizedAt: null,
      stage: "PACKAGED",
    });
    expect(r.status).toBe("PACKAGED_NOT_FINALIZED");
    expect(r.primaryAction).toBe("AWAIT_FINALIZATION");
    expect(r.zohoPush.enabled).toBe(false);
  });

  it("AWAITING_LOT when finalizedAt is null but stage is not PACKAGED (e.g. surfaced via search)", () => {
    const r = classifyProductionOutputRow({
      ...BASE,
      finalizedAt: null,
      stage: "BLISTER",
    });
    expect(r.status).toBe("AWAITING_LOT");
  });
});

describe("statusFilterMatches", () => {
  it("null filter matches every status", () => {
    expect(statusFilterMatches(null, "AWAITING_LOT")).toBe(true);
    expect(statusFilterMatches(null, "ZOHO_COMMITTED")).toBe(true);
  });

  it("all matches every status", () => {
    expect(statusFilterMatches("all", "PACKAGED_NOT_FINALIZED")).toBe(true);
  });

  it("awaiting_lot matches the four no-lot statuses", () => {
    expect(statusFilterMatches("awaiting_lot", "AWAITING_LOT")).toBe(true);
    expect(statusFilterMatches("awaiting_lot", "READY_TO_AUTO_ISSUE")).toBe(
      true,
    );
    expect(statusFilterMatches("awaiting_lot", "MISSING_ALLOCATION")).toBe(
      true,
    );
    expect(statusFilterMatches("awaiting_lot", "BLOCKED")).toBe(true);
    expect(statusFilterMatches("awaiting_lot", "ISSUED_LOT")).toBe(false);
  });

  it("issued_lot includes both ISSUED_LOT and Zoho lifecycle", () => {
    expect(statusFilterMatches("issued_lot", "ISSUED_LOT")).toBe(true);
    expect(statusFilterMatches("issued_lot", "ZOHO_PENDING")).toBe(true);
    expect(statusFilterMatches("issued_lot", "ZOHO_COMMITTED")).toBe(true);
    expect(statusFilterMatches("issued_lot", "AWAITING_LOT")).toBe(false);
  });

  it("zoho_committed only matches ZOHO_COMMITTED", () => {
    expect(statusFilterMatches("zoho_committed", "ZOHO_COMMITTED")).toBe(true);
    expect(statusFilterMatches("zoho_committed", "ZOHO_PENDING")).toBe(false);
    expect(statusFilterMatches("zoho_committed", "ISSUED_LOT")).toBe(false);
  });

  it("packaged_not_finalized only matches its status", () => {
    expect(
      statusFilterMatches("packaged_not_finalized", "PACKAGED_NOT_FINALIZED"),
    ).toBe(true);
    expect(statusFilterMatches("packaged_not_finalized", "AWAITING_LOT")).toBe(
      false,
    );
  });
});
