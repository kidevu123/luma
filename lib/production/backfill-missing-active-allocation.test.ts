// Backfill missing active allocation — classification + apply contract tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const WF = "11111111-1111-4111-8111-111111111111";
const BAG = "22222222-2222-4222-8222-222222222222";
const OTHER_WF = "33333333-3333-4333-8333-333333333333";

let callIdx = 0;
const selectResults: unknown[][] = [];
let insertSpy: ReturnType<typeof vi.fn>;
let insertResults: unknown[] = [];

const mockTx = {
  select: () => ({
    from: () => ({
      where: () => {
        const idx = callIdx++;
        const rows = (selectResults[idx] ?? []) as unknown[];
        return {
          limit: async () => rows,
          orderBy: () => ({
            limit: async () => rows,
          }),
        };
      },
      innerJoin: () => ({
        where: () => ({
          limit: async () => (selectResults[callIdx++] ?? []) as unknown[],
        }),
      }),
      leftJoin: () => ({
        where: () => ({
          limit: async () => (selectResults[callIdx++] ?? []) as unknown[],
        }),
      }),
    }),
  }),
  execute: async () => [{ po_id: null }],
  insert: () => ({
    values: () => ({
      returning: async () => {
        insertSpy();
        return insertResults;
      },
      then: (resolve: (v: unknown) => void) => {
        insertSpy();
        resolve(undefined);
      },
    }),
  }),
  update: () => ({
    set: () => ({
      where: async () => undefined,
    }),
  }),
};

vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowBags: {},
  inventoryBags: {},
  rawBagAllocationSessions: {},
  rawBagAllocationEvents: {},
  readBagState: {},
  finishedLots: {},
  zohoProductionOutputOps: {},
  qrCards: {},
  readStationLive: {},
  stations: {},
}));

vi.mock("@/lib/production/partial-bags", () => ({
  loadActiveRunsMissingAllocation: vi.fn().mockResolvedValue([]),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  desc: (a: unknown) => ({ desc: a }),
  sql: (strings: TemplateStringsArray) => ({ sql: strings }),
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { writeAudit } from "@/lib/db/audit";
import {
  BACKFILL_ALLOCATION_NOTES,
  backfillMissingAllocationForActiveWorkflowBag,
  classifyActiveWorkflowBagBackfill,
  parseBackfillMissingActiveAllocationsCli,
  resolveBackfillStartingBalance,
  validateBackfillApplyGate,
} from "./backfill-missing-active-allocation";

describe("resolveBackfillStartingBalance", () => {
  it("prefers pill_count over ledger ending and declared", () => {
    const r = resolveBackfillStartingBalance({
      pillCount: 490,
      declaredPillCount: 500,
      lastClosedOrReturnedEndingBalanceQty: 480,
    });
    expect(r.startingBalanceQty).toBe(490);
    expect(r.startingBalanceSource).toBe("PILL_COUNT");
    expect(r.missingStartingBalance).toBe(false);
  });

  it("uses latest closed/returned ending when pill_count is absent", () => {
    const r = resolveBackfillStartingBalance({
      pillCount: null,
      declaredPillCount: 500,
      lastClosedOrReturnedEndingBalanceQty: 480,
    });
    expect(r.startingBalanceQty).toBe(480);
    expect(r.startingBalanceSource).toBe("LEDGER_DERIVED");
  });

  it("falls back to declared count when pill_count and ledger are absent", () => {
    const r = resolveBackfillStartingBalance({
      pillCount: null,
      declaredPillCount: 500,
      lastClosedOrReturnedEndingBalanceQty: null,
    });
    expect(r.startingBalanceQty).toBe(500);
    expect(r.startingBalanceSource).toBe("VENDOR_DECLARED");
  });

  it("allows null starting balance with missing marker", () => {
    const r = resolveBackfillStartingBalance({
      pillCount: null,
      declaredPillCount: null,
      lastClosedOrReturnedEndingBalanceQty: null,
    });
    expect(r.startingBalanceQty).toBeNull();
    expect(r.missingStartingBalance).toBe(true);
  });
});

describe("classifyActiveWorkflowBagBackfill", () => {
  const healthyStarting = resolveBackfillStartingBalance({
    pillCount: 500,
    declaredPillCount: 500,
    lastClosedOrReturnedEndingBalanceQty: null,
  });

  it("classifies deterministic missing active workflow as SAFE_OPEN_ALLOCATION", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: BAG,
      isFinalized: false,
      inventoryBagStatus: "AVAILABLE",
      hasAnyAllocationForWorkflow: false,
      hasOpenAllocationOnOtherWorkflow: false,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: healthyStarting,
    });
    expect(c.action).toBe("SAFE_OPEN_ALLOCATION");
  });

  it("skips finalized workflow", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: BAG,
      isFinalized: true,
      inventoryBagStatus: "AVAILABLE",
      hasAnyAllocationForWorkflow: false,
      hasOpenAllocationOnOtherWorkflow: false,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: healthyStarting,
    });
    expect(c.action).toBe("SKIP_FINALIZED");
  });

  it("skips missing inventory bag", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: null,
      isFinalized: false,
      inventoryBagStatus: null,
      hasAnyAllocationForWorkflow: false,
      hasOpenAllocationOnOtherWorkflow: false,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: healthyStarting,
    });
    expect(c.action).toBe("SKIP_NO_INVENTORY_BAG");
  });

  it("skips when allocation already linked to workflow", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: BAG,
      isFinalized: false,
      inventoryBagStatus: "AVAILABLE",
      hasAnyAllocationForWorkflow: true,
      hasOpenAllocationOnOtherWorkflow: false,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: healthyStarting,
    });
    expect(c.action).toBe("SKIP_ALREADY_LINKED");
  });

  it("skips when OPEN allocation exists on another workflow", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: BAG,
      isFinalized: false,
      inventoryBagStatus: "IN_USE",
      hasAnyAllocationForWorkflow: false,
      hasOpenAllocationOnOtherWorkflow: true,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: healthyStarting,
    });
    expect(c.action).toBe("SKIP_CONFLICTING_OPEN_SESSION");
  });

  it.each(["EMPTIED", "VOID", "QUARANTINED"] as const)(
    "requires review for %s inventory bag",
    (status) => {
      const c = classifyActiveWorkflowBagBackfill({
        workflowBagId: WF,
        inventoryBagId: BAG,
        isFinalized: false,
        inventoryBagStatus: status,
        hasAnyAllocationForWorkflow: false,
        hasOpenAllocationOnOtherWorkflow: false,
        finishedLotId: null,
        zohoOutputCommitted: false,
        startingBalance: healthyStarting,
      });
      expect(c.action).toBe("REVIEW_REQUIRED");
    },
  );

  it("requires review when starting balance is unknown", () => {
    const c = classifyActiveWorkflowBagBackfill({
      workflowBagId: WF,
      inventoryBagId: BAG,
      isFinalized: false,
      inventoryBagStatus: "AVAILABLE",
      hasAnyAllocationForWorkflow: false,
      hasOpenAllocationOnOtherWorkflow: false,
      finishedLotId: null,
      zohoOutputCommitted: false,
      startingBalance: resolveBackfillStartingBalance({
        pillCount: null,
        declaredPillCount: null,
        lastClosedOrReturnedEndingBalanceQty: null,
      }),
    });
    expect(c.action).toBe("REVIEW_REQUIRED");
  });
});

describe("backfill CLI", () => {
  it("defaults to dry-run without --apply", () => {
    const opts = parseBackfillMissingActiveAllocationsCli([
      "node",
      "script.ts",
    ]);
    expect(opts.apply).toBe(false);
    expect(opts.yes).toBe(false);
  });

  it("apply requires --yes", () => {
    expect(
      validateBackfillApplyGate(
        parseBackfillMissingActiveAllocationsCli(["node", "script.ts", "--apply"]),
      ).ok,
    ).toBe(false);
    expect(
      validateBackfillApplyGate(
        parseBackfillMissingActiveAllocationsCli([
          "node",
          "script.ts",
          "--apply",
          "--yes",
        ]),
      ).ok,
    ).toBe(true);
  });

  it("parses workflow bag id and limit", () => {
    const opts = parseBackfillMissingActiveAllocationsCli([
      "node",
      "script.ts",
      "--workflow-bag-id=" + WF,
      "--limit=5",
    ]);
    expect(opts.workflowBagId).toBe(WF);
    expect(opts.limit).toBe(5);
  });
});

describe("backfillMissingAllocationForActiveWorkflowBag (mocked tx)", () => {
  beforeEach(() => {
    callIdx = 0;
    selectResults.length = 0;
    insertResults = [{ id: "sess-new-0001" }];
    insertSpy = vi.fn();
    vi.mocked(writeAudit).mockClear();
  });

  it("creates one OPEN session and audit entry", async () => {
    selectResults.push(
      [
        {
          id: WF,
          inventoryBagId: BAG,
          productId: null,
          startedAt: new Date("2026-01-01T12:00:00Z"),
          isFinalized: false,
        },
      ],
      [{ status: "AVAILABLE", pillCount: 500, declaredPillCount: 500 }],
      [],
      [],
      [],
      [],
      [],
    );

    const result = await backfillMissingAllocationForActiveWorkflowBag(
      mockTx as never,
      WF,
      { actor: { id: "user-1", role: "LEAD" } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toBe("CREATED");
      expect(result.sessionId).toBe("sess-new-0001");
      expect(result.startingBalanceQty).toBe(500);
    }
    expect(insertSpy).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "raw_bag_allocation.backfill_opened",
        targetType: "RawBagAllocationSession",
      }),
      mockTx,
    );
  });

  it("apply is idempotent when session already linked", async () => {
    selectResults.push(
      [
        {
          id: WF,
          inventoryBagId: BAG,
          productId: null,
          startedAt: new Date(),
          isFinalized: false,
        },
      ],
      [{ status: "AVAILABLE", pillCount: 500, declaredPillCount: 500 }],
      [{ id: "existing-session" }],
    );

    const result = await backfillMissingAllocationForActiveWorkflowBag(
      mockTx as never,
      WF,
    );

    expect(result).toEqual({
      ok: true,
      code: "ALREADY_LINKED",
      sessionId: "existing-session",
      startingBalanceQty: null,
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("blocks conflicting OPEN session on another workflow", async () => {
    selectResults.push(
      [
        {
          id: WF,
          inventoryBagId: BAG,
          productId: null,
          startedAt: new Date(),
          isFinalized: false,
        },
      ],
      [{ status: "IN_USE", pillCount: 500, declaredPillCount: 500 }],
      [],
      [{ id: "open-other", workflowBagId: OTHER_WF }],
    );

    const result = await backfillMissingAllocationForActiveWorkflowBag(
      mockTx as never,
      WF,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SKIP_CONFLICTING_OPEN_SESSION");
    }
  });

  it("skips finalized workflow bags", async () => {
    selectResults.push(
      [
        {
          id: WF,
          inventoryBagId: BAG,
          productId: null,
          startedAt: new Date(),
          isFinalized: true,
        },
      ],
      [{ status: "AVAILABLE", pillCount: 500, declaredPillCount: 500 }],
      [],
      [],
    );

    const result = await backfillMissingAllocationForActiveWorkflowBag(
      mockTx as never,
      WF,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SKIP_FINALIZED");
  });
});

describe("script + UI contract pins", () => {
  const scriptSrc = readFileSync(
    join(__dirname, "../../scripts/backfill-missing-active-allocations.ts"),
    "utf8",
  );

  it("script defaults to dry-run and gates apply with --yes", () => {
    expect(scriptSrc).toMatch(/dry-run by default/i);
    expect(scriptSrc).toMatch(/validateBackfillApplyGate/);
    expect(scriptSrc).toMatch(/--apply/);
    expect(scriptSrc).toMatch(/--yes/);
  });

  it("uses canonical backfill notes", () => {
    expect(BACKFILL_ALLOCATION_NOTES).toMatch(/v0\.4\.109/);
  });
});
