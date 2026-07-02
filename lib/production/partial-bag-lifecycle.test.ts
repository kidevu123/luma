// P1-PARTIAL — lifecycle states, honest display, reuse confirmation,
// and admin correction contracts.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

import {
  derivePartialBagLifecycleState,
  formatRemainingEstimate,
  PARTIAL_BAG_LIFECYCLE_LABELS,
} from "./partial-bag-lifecycle";
import type { PartialBagSession } from "./partial-bags";

const closed = (
  ending: number | null,
  extra: Partial<PartialBagSession> = {},
): PartialBagSession => ({
  allocationStatus: "CLOSED",
  endingBalanceQty: ending,
  closedAt: new Date("2026-06-01T12:00:00Z"),
  ...extra,
});

describe("derivePartialBagLifecycleState", () => {
  it("fresh: AVAILABLE with no sessions", () => {
    expect(
      derivePartialBagLifecycleState({ inventoryStatus: "AVAILABLE", sessions: [] }),
    ).toBe("fresh");
  });

  it("in_use: IN_USE status or an OPEN session", () => {
    expect(
      derivePartialBagLifecycleState({ inventoryStatus: "IN_USE", sessions: [] }),
    ).toBe("in_use");
    expect(
      derivePartialBagLifecycleState({
        inventoryStatus: "AVAILABLE",
        sessions: [
          { allocationStatus: "OPEN", endingBalanceQty: null, closedAt: null },
        ],
      }),
    ).toBe("in_use");
  });

  it("partial_ready: trusted remaining quantity", () => {
    expect(
      derivePartialBagLifecycleState({
        inventoryStatus: "AVAILABLE",
        sessions: [closed(1200)],
      }),
    ).toBe("partial_ready");
  });

  it("partial_needs_closeout: closed session with unknown remaining", () => {
    expect(
      derivePartialBagLifecycleState({
        inventoryStatus: "AVAILABLE",
        sessions: [closed(null)],
      }),
    ).toBe("partial_needs_closeout");
  });

  it("on_hold / depleted / void map from inventory status", () => {
    expect(
      derivePartialBagLifecycleState({ inventoryStatus: "QUARANTINED", sessions: [] }),
    ).toBe("on_hold");
    expect(
      derivePartialBagLifecycleState({ inventoryStatus: "EMPTIED", sessions: [] }),
    ).toBe("depleted");
    expect(
      derivePartialBagLifecycleState({ inventoryStatus: "VOID", sessions: [] }),
    ).toBe("void_bad_linkage");
  });

  it("labels exist for every state", () => {
    for (const label of Object.values(PARTIAL_BAG_LIFECYCLE_LABELS)) {
      expect(label.length).toBeGreaterThan(2);
    }
  });
});

describe("formatRemainingEstimate — no fake precision", () => {
  it("HIGH counted value is a plain number", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: 1220,
        confidence: "HIGH",
        source: "PHYSICAL_COUNT",
      }),
    ).toBe("1,220");
  });

  it("supervisor estimate is approximate with provenance", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: 1220,
        confidence: "MEDIUM",
        source: "SUPERVISOR_ESTIMATE",
      }),
    ).toBe("~1,220 (supervisor estimate)");
  });

  it("unknown remaining demands closeout instead of a fake integer", () => {
    expect(
      formatRemainingEstimate({
        remainingEstimate: null,
        confidence: null,
        source: null,
      }),
    ).toBe("Unknown — closeout required");
  });
});

// ── Source contracts ──────────────────────────────────────────────────

const floorActionsSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/actions.ts"),
  "utf8",
);
const correctionsSrc = readFileSync(
  join(__dirname, "partial-bag-admin-corrections.ts"),
  "utf8",
);
const workbenchSrc = readFileSync(
  join(__dirname, "../../app/(admin)/partial-bags/page.tsx"),
  "utf8",
);

describe("partial reuse is an explicit, confidence-gated flow", () => {
  it("every floor partial start path runs the confirmation gate", () => {
    const gates =
      floorActionsSrc.match(/enforcePartialReuseConfirmation\(tx?,?\s*\{/g) ??
      [];
    // Fresh-partial restart, ASSIGNED partial restart, finalized resume.
    expect(gates.length).toBeGreaterThanOrEqual(3);
  });

  it("LOW confidence requires a supervisor badge", () => {
    expect(floorActionsSrc).toMatch(/remainingConfidence === "LOW"/);
    expect(floorActionsSrc).toMatch(/supervisor badge code is required/i);
    expect(floorActionsSrc).toMatch(/SUPERVISOR_OVERRIDE/);
  });

  it("the confirmation response is structured, not an error", () => {
    expect(floorActionsSrc).toMatch(/partialReuseConfirmationRequired: true/);
    expect(floorActionsSrc).toMatch(/PartialReuseConfirmationRequiredError/);
  });
});

describe("admin corrections never edit the original ledger", () => {
  it("corrections append sessions/events and write before/after audits", () => {
    expect(correctionsSrc).toMatch(/insert\(rawBagAllocationSessions\)/);
    expect(correctionsSrc).toMatch(/insert\(rawBagAllocationEvents\)/);
    expect(correctionsSrc).toMatch(/before: \{ status: bag\.status/);
    expect(correctionsSrc).toMatch(/partial_bag\.correct_remaining/);
    expect(correctionsSrc).toMatch(/partial_bag\.mark_depleted/);
    expect(correctionsSrc).toMatch(/partial_bag\.hold/);
    expect(correctionsSrc).toMatch(/partial_bag\.return_to_stock/);
    expect(correctionsSrc).toMatch(/partial_bag\.void_record/);
  });

  it("no correction updates an existing closed session's quantities", () => {
    // The only session UPDATEs are status transitions of OPEN sessions
    // (deplete / void / SPLIT-BAG-2 manual closeout of an open session) —
    // never rewriting a CLOSED session's balances.
    const updates = correctionsSrc.match(/\.update\(rawBagAllocationSessions\)/g) ?? [];
    expect(updates.length).toBeLessThanOrEqual(3);
    // Each session update closes an OPEN session (guarded by an `if (open)`),
    // it never targets a CLOSED/DEPLETED row.
    expect(correctionsSrc).not.toMatch(/allocationStatus.*(IN|=).*CLOSED[\s\S]{0,80}\.update/);
  });
});

describe("Partial Bag Workbench sections", () => {
  it("splits rows into the required sections", () => {
    expect(workbenchSrc).toMatch(/Ready to reuse/);
    expect(workbenchSrc).toMatch(/Needs closeout/);
    expect(workbenchSrc).toMatch(/Missing linkage/);
    expect(workbenchSrc).toMatch(/On hold \/ quarantined/);
    expect(workbenchSrc).toMatch(/Recently depleted/);
  });

  it("needs-closeout rows never look like reusable inventory", () => {
    expect(workbenchSrc).toMatch(/NOT\s*\n?\s*reusable inventory/);
    // Start run renders only in the ready section variant.
    const startRunCount = (workbenchSrc.match(/Start run/g) ?? []).length;
    expect(startRunCount).toBe(1);
  });

  it("remaining quantities use the honest formatter", () => {
    expect(workbenchSrc).toMatch(/formatRemainingEstimate/);
  });
});
