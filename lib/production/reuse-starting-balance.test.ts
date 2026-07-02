// REUSE-STARTING-BALANCE-1 — a reused partial bag must open its next allocation
// session from the latest prior TERMINAL session's ending balance, not the
// original declared count. Pure tests for the shared resolver.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  resolveNewSessionStartingBalance,
  type PriorTerminalAllocationSession,
} from "./bag-allocation";

function prior(
  over: Partial<PriorTerminalAllocationSession> & { allocationStatus: string },
): PriorTerminalAllocationSession {
  return {
    id: "prior-1",
    endingBalanceQty: null,
    startingBalanceQty: null,
    consumedQty: null,
    endingBalanceSource: null,
    ...over,
  };
}

describe("resolveNewSessionStartingBalance — brand-new full bag", () => {
  it("uses the on-hand pill count when there is no prior terminal session", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: null,
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(7197);
    expect(r.source).toBe("VENDOR_DECLARED");
    expect(r.priorSessionId).toBeNull();
  });

  it("falls back to declared count when pill count is unknown", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: null,
      pillCount: null,
      declaredPillCount: 5000,
    });
    expect(r.startingBalance).toBe(5000);
    expect(r.source).toBe("VENDOR_DECLARED");
  });
});

describe("resolveNewSessionStartingBalance — reused partial bag", () => {
  it("bag-card-104: declared 7,197, prior RETURNED_TO_STOCK ended 3,598 → starts at 3,598 (not 7,197)", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: prior({
        id: "721cfe58",
        allocationStatus: "RETURNED_TO_STOCK",
        endingBalanceQty: 3598,
        endingBalanceSource: "SUPERVISOR_ESTIMATE",
      }),
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(3598);
    expect(r.source).toBe("PRIOR_RETURNED_BALANCE");
    expect(r.priorSessionId).toBe("721cfe58");
    expect(r.priorEndingBalance).toBe(3598);
    expect(r.priorEndingBalanceSource).toBe("SUPERVISOR_ESTIMATE");
    expect(r.priorStatus).toBe("RETURNED_TO_STOCK");
    expect(r.originalDeclaredCount).toBe(7197);
  });

  it("CLOSED prior with a remaining balance → LEDGER_DERIVED from ending balance", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: prior({
        allocationStatus: "CLOSED",
        endingBalanceQty: 2100,
      }),
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(2100);
    expect(r.source).toBe("LEDGER_DERIVED");
  });

  it("DEPLETED prior (ended 0) → starts at 0 with PRIOR_DEPLETED_BALANCE (fails closed on use)", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: prior({ allocationStatus: "DEPLETED", endingBalanceQty: 0 }),
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(0);
    expect(r.source).toBe("PRIOR_DEPLETED_BALANCE");
  });

  it("derives from starting − consumed when the prior ending balance is null", () => {
    const r = resolveNewSessionStartingBalance({
      priorTerminal: prior({
        allocationStatus: "CLOSED",
        endingBalanceQty: null,
        startingBalanceQty: 7197,
        consumedQty: 3599,
      }),
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(3598); // 7197 − 3599
    expect(r.source).toBe("LEDGER_DERIVED");
  });
});

describe("resolveNewSessionStartingBalance — manual override wins", () => {
  it("uses the caller-supplied balance and keeps prior context for the audit", () => {
    const r = resolveNewSessionStartingBalance({
      manualStartingBalance: 4000,
      priorTerminal: prior({ allocationStatus: "RETURNED_TO_STOCK", endingBalanceQty: 3598 }),
      pillCount: 7197,
      declaredPillCount: 7197,
    });
    expect(r.startingBalance).toBe(4000);
    expect(r.source).toBe("MANUAL_ENTRY");
    expect(r.priorEndingBalance).toBe(3598); // provenance preserved
  });
});

describe("REUSE-STARTING-BALANCE-1 — every open path uses the shared logic", () => {
  const read = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8");
  const lifecycle = read("lib/production/raw-bag-allocation-lifecycle.ts");
  const autoOpen = read("lib/production/bag-allocation-auto-open.ts");
  const floorActions = read("app/(floor)/floor/[token]/bag-allocation-actions.ts");

  it("the terminal-session lookup includes RETURNED_TO_STOCK and DEPLETED (not CLOSED-only)", () => {
    // The shared helper.
    expect(lifecycle).toMatch(/export async function loadLatestTerminalAllocationSession/);
    for (const src of [lifecycle, autoOpen, floorActions]) {
      const terminalList = src.match(/inArray\(\s*rawBagAllocationSessions\.allocationStatus,\s*\[([\s\S]*?)\]/);
      expect(terminalList).not.toBeNull();
      expect(terminalList![1]).toMatch(/CLOSED/);
      expect(terminalList![1]).toMatch(/RETURNED_TO_STOCK/);
      expect(terminalList![1]).toMatch(/DEPLETED/);
    }
  });

  it("openAllocationSessionInTx derives the balance via the shared resolver + records provenance", () => {
    expect(lifecycle).toMatch(/resolveNewSessionStartingBalance\(\{/);
    expect(lifecycle).toMatch(/priorTerminal,/);
    expect(lifecycle).toMatch(/prior_session_id: balance\.priorSessionId/);
    expect(lifecycle).toMatch(/starting_balance_source: startingSource/);
    // No stale CLOSED-only reopen lookup remains.
    expect(lifecycle).not.toMatch(/eq\(rawBagAllocationSessions\.allocationStatus, "CLOSED"\)[\s\S]{0,120}orderBy\(desc\(rawBagAllocationSessions\.closedAt/);
  });

  it("auto-open and floor manual-open both use resolveNewSessionStartingBalance with provenance", () => {
    for (const src of [autoOpen, floorActions]) {
      expect(src).toMatch(/resolveNewSessionStartingBalance\(\{/);
      expect(src).toMatch(/prior_session_id: balance\.priorSessionId/);
    }
  });
});
