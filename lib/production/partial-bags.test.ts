import { describe, expect, it } from "vitest";
import {
  classifyPartialBagInventoryEligibility,
  deriveRemainingEstimate,
  deriveRemainingProvenance,
  hasOpenAllocationSession,
  hasPartialClosePackagingWorkflowEvidence,
  isAvailablePartialBag,
} from "./partial-bags";
import { buildPartialSealingClosePayload } from "./sealing-partial-closeout";

type AllocationStatus = "OPEN" | "CLOSED" | "RETURNED_TO_STOCK" | "DEPLETED" | "VOIDED";

const closed = (endingBalanceQty: number | null, closedAt?: Date) => ({
  allocationStatus: "CLOSED" as AllocationStatus,
  endingBalanceQty,
  closedAt: closedAt ?? new Date("2026-01-01T00:00:00Z"),
});
const returned = (endingBalanceQty: number | null, closedAt?: Date) => ({
  allocationStatus: "RETURNED_TO_STOCK" as AllocationStatus,
  endingBalanceQty,
  closedAt: closedAt ?? new Date("2026-01-02T00:00:00Z"),
});
const open_ = () => ({
  allocationStatus: "OPEN" as AllocationStatus,
  endingBalanceQty: null,
  closedAt: null,
});
const depleted_ = () => ({
  allocationStatus: "DEPLETED" as AllocationStatus,
  endingBalanceQty: 0,
  closedAt: new Date("2026-01-01T00:00:00Z"),
});

// ─── isAvailablePartialBag ────────────────────────────────────────

describe("isAvailablePartialBag", () => {
  it("returns false for fresh bag with no sessions", () => {
    expect(isAvailablePartialBag([])).toBe(false);
  });

  it("returns false when only session is OPEN", () => {
    expect(isAvailablePartialBag([open_()])).toBe(false);
  });

  it("returns false when only session is DEPLETED", () => {
    expect(isAvailablePartialBag([depleted_()])).toBe(false);
  });

  it("returns true when has CLOSED session with positive endingBalanceQty", () => {
    expect(isAvailablePartialBag([closed(50)])).toBe(true);
  });

  it("returns true when has RETURNED_TO_STOCK session", () => {
    expect(isAvailablePartialBag([returned(100)])).toBe(true);
  });

  it("returns true when has CLOSED session with null endingBalanceQty (unknown remaining)", () => {
    expect(isAvailablePartialBag([closed(null)])).toBe(true);
  });

  it("returns true when mix: DEPLETED then later CLOSED session", () => {
    expect(isAvailablePartialBag([depleted_(), closed(30)])).toBe(true);
  });
});

// ─── hasOpenAllocationSession ─────────────────────────────────────

describe("hasOpenAllocationSession", () => {
  it("returns false for empty sessions", () => {
    expect(hasOpenAllocationSession([])).toBe(false);
  });

  it("returns false when all sessions are closed/depleted", () => {
    expect(hasOpenAllocationSession([closed(20), depleted_()])).toBe(false);
  });

  it("returns true when any session is OPEN", () => {
    expect(hasOpenAllocationSession([closed(20), open_()])).toBe(true);
  });

  it("returns true for single OPEN session", () => {
    expect(hasOpenAllocationSession([open_()])).toBe(true);
  });
});

// ─── deriveRemainingEstimate ──────────────────────────────────────

describe("deriveRemainingEstimate", () => {
  it("returns null for empty sessions", () => {
    expect(deriveRemainingEstimate([])).toBeNull();
  });

  it("returns null when only OPEN sessions present", () => {
    expect(deriveRemainingEstimate([open_()])).toBeNull();
  });

  it("returns null when only DEPLETED sessions present", () => {
    expect(deriveRemainingEstimate([depleted_()])).toBeNull();
  });

  it("returns endingBalanceQty from single CLOSED session", () => {
    expect(deriveRemainingEstimate([closed(75)])).toBe(75);
  });

  it("returns null when CLOSED session has null endingBalanceQty", () => {
    expect(deriveRemainingEstimate([closed(null)])).toBeNull();
  });

  it("returns most-recent CLOSED session qty when multiple sessions by closedAt", () => {
    const older = closed(100, new Date("2026-01-01T00:00:00Z"));
    const newer = closed(40, new Date("2026-01-10T00:00:00Z"));
    expect(deriveRemainingEstimate([older, newer])).toBe(40);
  });

  it("prefers CLOSED over RETURNED_TO_STOCK if CLOSED is more recent", () => {
    const ret = returned(80, new Date("2026-01-05T00:00:00Z"));
    const clos = closed(30, new Date("2026-01-15T00:00:00Z"));
    expect(deriveRemainingEstimate([ret, clos])).toBe(30);
  });

  it("returns RETURNED_TO_STOCK qty if it is more recent than CLOSED", () => {
    const clos = closed(30, new Date("2026-01-05T00:00:00Z"));
    const ret = returned(80, new Date("2026-01-15T00:00:00Z"));
    expect(deriveRemainingEstimate([clos, ret])).toBe(80);
  });

  it("skips session with null endingBalanceQty and returns next best", () => {
    const newerNull = closed(null, new Date("2026-01-20T00:00:00Z"));
    const olderKnown = closed(55, new Date("2026-01-01T00:00:00Z"));
    expect(deriveRemainingEstimate([olderKnown, newerNull])).toBe(55);
  });
});

describe("deriveRemainingProvenance", () => {
  it("returns confidence and source from latest session with ending balance", () => {
    const older = {
      ...closed(100, new Date("2026-01-01T00:00:00Z")),
      confidence: "MEDIUM",
      endingBalanceSource: "PHYSICAL_COUNT",
    };
    const newer = {
      ...returned(5000, new Date("2026-01-15T00:00:00Z")),
      confidence: "LOW",
      endingBalanceSource: "SUPERVISOR_ESTIMATE",
    };
    expect(deriveRemainingProvenance([older, newer])).toEqual({
      confidence: "LOW",
      source: "SUPERVISOR_ESTIMATE",
    });
  });
});

describe("classifyPartialBagInventoryEligibility", () => {
  it("flags missing linkage when no allocation sessions exist", () => {
    const r = classifyPartialBagInventoryEligibility({
      inventoryStatus: "IN_USE",
      sessions: [],
      hasPartialPackagingWorkflow: true,
    });
    expect(r.eligibility).toBe("missing_linkage");
    expect(r.note).toMatch(/no raw-bag allocation session/i);
  });

  it("flags needs_allocation_closeout when OPEN session remains", () => {
    const r = classifyPartialBagInventoryEligibility({
      inventoryStatus: "IN_USE",
      sessions: [open_(), closed(100)],
      hasPartialPackagingWorkflow: true,
    });
    expect(r.eligibility).toBe("needs_allocation_closeout");
  });

  it("marks ready when AVAILABLE with closed returned session", () => {
    const r = classifyPartialBagInventoryEligibility({
      inventoryStatus: "AVAILABLE",
      sessions: [returned(8_000)],
      hasPartialPackagingWorkflow: true,
    });
    expect(r.eligibility).toBe("ready");
  });
});

describe("hasPartialClosePackagingWorkflowEvidence", () => {
  it("detects legacy partial close + PACKAGING_COMPLETE without partial_packaging flag", () => {
    expect(
      hasPartialClosePackagingWorkflowEvidence([
        {
          eventType: "SEALING_COMPLETE",
          payload: buildPartialSealingClosePayload({
            sealedPartialCount: 100,
            reason: "END_OF_SHIFT",
          }),
        },
        { eventType: "PACKAGING_COMPLETE", payload: { master_cases: 1 } },
        { eventType: "BAG_FINALIZED", payload: {} },
      ]),
    ).toBe(true);
  });

  it("returns false for whole-bag sealing lane close", () => {
    expect(
      hasPartialClosePackagingWorkflowEvidence([
        { eventType: "SEALING_COMPLETE", payload: { lane_close: true } },
        { eventType: "PACKAGING_COMPLETE", payload: { master_cases: 1 } },
      ]),
    ).toBe(false);
  });
});
