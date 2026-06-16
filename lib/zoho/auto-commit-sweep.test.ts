import { describe, expect, it, vi } from "vitest";
import { runAutoCommitSweep } from "./auto-commit-sweep";
import type {
  ProductionOutputCommitCallable,
  SharedProductionOutputCommitResult,
} from "./shared-production-output-commit";
import type { SharedRawBagCommitResult } from "./shared-raw-bag-receive-commit";

// Mock @/lib/db so the route-level loaders never touch a real DB even
// when a test forgets to inject loadRawBagEligible / loadProductionOutputEligible.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// Mock the audit module since the sweep calls writeAudit transitively
// (it doesn't in the sweep itself, but the per-row shared commits do).
// Tests inject mocked commits, so this is belt-and-suspenders.
vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

const SAFE_FIRST_DEPLOY_ENV: Record<string, string | undefined> = {
  ZOHO_AUTO_COMMIT_ENABLED: "false",
  ZOHO_DRY_RUN_WRITES_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "false",
};

const ENABLED_RAW_BAG_ONLY: Record<string, string | undefined> = {
  ZOHO_AUTO_COMMIT_ENABLED: "true",
  ZOHO_DRY_RUN_WRITES_ENABLED: "true",
};

const ENABLED_PO_ONLY: Record<string, string | undefined> = {
  ZOHO_AUTO_COMMIT_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "true",
};

const ENABLED_ALL: Record<string, string | undefined> = {
  ...ENABLED_PO_ONLY,
  ZOHO_DRY_RUN_WRITES_ENABLED: "true",
};

const NOW = new Date("2026-06-15T12:00:00Z");

function okRawBagCommit(opId: string): SharedRawBagCommitResult {
  return {
    ok: true,
    kind: "COMMITTED",
    opId,
    zohoPurchaseReceiveId: "PR-mock-1",
    attemptCount: 1,
  };
}

function okPoCommit(opId: string): SharedProductionOutputCommitResult {
  return {
    ok: true,
    kind: "COMMITTED",
    opId,
    externalReferenceId: "EXT-mock-1",
  };
}

describe("runAutoCommitSweep — master switch", () => {
  it("when ZOHO_AUTO_COMMIT_ENABLED is not 'true', sweep is a no-op (no DB queries, no commits)", async () => {
    // Belt-and-suspenders: even if the loaders WERE called, they'd
    // return rows the commits would refuse. But the master-off branch
    // exits before any of that runs.
    const loadRawBag = vi.fn();
    const loadPo = vi.fn();
    const commitRawBag = vi.fn();
    const commitPo = vi.fn();
    const result = await runAutoCommitSweep({
      env: SAFE_FIRST_DEPLOY_ENV,
      now: NOW,
      loadRawBagEligible: loadRawBag,
      loadProductionOutputEligible: loadPo,
      commitRawBag: commitRawBag as never,
      commitProductionOutput: commitPo as never,
    });
    expect(loadRawBag).not.toHaveBeenCalled();
    expect(loadPo).not.toHaveBeenCalled();
    expect(commitRawBag).not.toHaveBeenCalled();
    expect(commitPo).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.gates.autoCommitEnabled).toBe(false);
  });
});

describe("runAutoCommitSweep — guard-blocked: no claim, no retry-budget burn", () => {
  it("raw-bag rows are skipped without calling the commit fn when ZOHO_DRY_RUN_WRITES_ENABLED is off", async () => {
    const commitRawBag = vi.fn();
    const result = await runAutoCommitSweep({
      // Master switch ON so the sweep proceeds, but raw-bag writes
      // are off — exactly the v1.1.0 first-deploy "exercise claim
      // logic without writes" posture.
      env: {
        ZOHO_AUTO_COMMIT_ENABLED: "true",
        ZOHO_DRY_RUN_WRITES_ENABLED: "false",
      },
      now: NOW,
      loadRawBagEligible: async () => [{ id: "row-1" }, { id: "row-2" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: commitRawBag as never,
    });
    // No commit calls — the row stays at PENDING with its
    // commit_attempt_count untouched.
    expect(commitRawBag).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(2);
    for (const r of result.rows) {
      expect(r.outcome).toBe("skipped_guard_blocked");
      expect(r.surface).toBe("raw_bag_receive");
    }
    expect(result.totals.skipped_guard_blocked).toBe(2);
    expect(result.totals.committed).toBe(0);
  });

  it("production-output rows are skipped without calling the commit fn when the commit env chain is incomplete", async () => {
    const commitPo = vi.fn();
    const result = await runAutoCommitSweep({
      env: {
        ZOHO_AUTO_COMMIT_ENABLED: "true",
        // Persist/preview/commit chain is incomplete:
        ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
        ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "false",
        ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
      },
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "po-1" }],
      commitProductionOutput: commitPo as never,
    });
    expect(commitPo).not.toHaveBeenCalled();
    expect(result.totals.skipped_guard_blocked).toBe(1);
  });
});

describe("runAutoCommitSweep — claims eligible rows", () => {
  it("raw-bag: when writes are allowed, the shared commit is called with source='auto' and the cron actor", async () => {
    const commitRawBag = vi.fn(async (input) => okRawBagCommit(input.opId));
    const result = await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "row-1" }, { id: "row-2" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: commitRawBag as never,
    });
    expect(commitRawBag).toHaveBeenCalledTimes(2);
    for (const call of commitRawBag.mock.calls) {
      expect(call[0].source).toBe("auto");
    }
    expect(result.totals.committed).toBe(2);
  });

  it("production-output: when writes are allowed, the shared commit is called with source='auto' and the injected callable", async () => {
    const commitPo = vi.fn(async (input) => okPoCommit(input.opId));
    const result = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "po-1" }],
      commitProductionOutput: commitPo as never,
    });
    expect(commitPo).toHaveBeenCalledTimes(1);
    expect(commitPo.mock.calls[0]![0].source).toBe("auto");
    expect(commitPo.mock.calls[0]![0].callable).toBeDefined();
    expect(result.totals.committed).toBe(1);
  });

  it("eligible loaders receive the cron's 'now' and a per-pass limit", async () => {
    const loadRawBag = vi.fn(async () => []);
    const loadPo = vi.fn(async () => []);
    await runAutoCommitSweep({
      env: ENABLED_ALL,
      now: NOW,
      loadRawBagEligible: loadRawBag,
      loadProductionOutputEligible: loadPo,
    });
    expect(loadRawBag).toHaveBeenCalledWith(NOW, 25);
    expect(loadPo).toHaveBeenCalledWith(NOW, 25);
  });
});

describe("runAutoCommitSweep — outcome classification", () => {
  it("raw-bag: NEEDS_REVIEW result lands in needs_review tally (not retry budget)", async () => {
    const result = await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "row-overs" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: async () =>
        ({
          ok: false,
          kind: "NEEDS_REVIEW",
          opId: "row-overs",
          blockers: [
            { code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING", message: "qty > remaining" },
          ],
          attemptCount: 1,
        }) satisfies SharedRawBagCommitResult,
    });
    expect(result.totals.needs_review).toBe(1);
    expect(result.totals.transport_retryable).toBe(0);
    expect(result.rows[0]!.detail).toContain("OVER_RECEIVE_EXCEEDS_PO_REMAINING");
  });

  it("raw-bag: NEEDS_MAPPING result lands in needs_mapping (separate from review)", async () => {
    const result = await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "row-no-po" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: async () =>
        ({
          ok: false,
          kind: "NEEDS_MAPPING",
          opId: "row-no-po",
          blockers: [{ code: "PO_NOT_FOUND", message: "PO not found" }],
          attemptCount: 1,
        }) satisfies SharedRawBagCommitResult,
    });
    expect(result.totals.needs_mapping).toBe(1);
    expect(result.totals.needs_review).toBe(0);
  });

  it("raw-bag: TRANSPORT_RETRYABLE result lands in transport_retryable", async () => {
    const result = await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "row-flaky" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: async () =>
        ({
          ok: false,
          kind: "TRANSPORT_RETRYABLE",
          opId: "row-flaky",
          reason: "Gateway 503",
          attemptCount: 1,
        }) satisfies SharedRawBagCommitResult,
    });
    expect(result.totals.transport_retryable).toBe(1);
  });

  it("production-output: outcomes route to the same tally buckets", async () => {
    const result = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [
        { id: "po-needs-review" },
        { id: "po-committed" },
      ],
      commitProductionOutput: async (input) => {
        if (input.opId === "po-needs-review") {
          return {
            ok: false,
            kind: "NEEDS_REVIEW",
            opId: input.opId,
            blockers: [
              { code: "OVER_RECEIVE_EXCEEDS_PO_REMAINING", message: "ov" },
            ],
          } satisfies SharedProductionOutputCommitResult;
        }
        return okPoCommit(input.opId);
      },
    });
    expect(result.totals.needs_review).toBe(1);
    expect(result.totals.committed).toBe(1);
  });
});

describe("runAutoCommitSweep — idempotency invariants", () => {
  it("the cron always calls source='auto' (so commit-trigger suffix accurately reflects the trigger)", async () => {
    // Cumulative test: if anyone changes the sweep to pass "manual",
    // the Zoho-side accounting note would lie about who pushed.
    const commitRawBag = vi.fn(async (input) => okRawBagCommit(input.opId));
    const commitPo = vi.fn(async (input) => okPoCommit(input.opId));
    await runAutoCommitSweep({
      env: ENABLED_ALL,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "r" }],
      loadProductionOutputEligible: async () => [{ id: "p" }],
      commitRawBag: commitRawBag as never,
      commitProductionOutput: commitPo as never,
    });
    expect(commitRawBag.mock.calls[0]![0].source).toBe("auto");
    expect(commitPo.mock.calls[0]![0].source).toBe("auto");
  });

  it("the cron NEVER passes a custom commit idempotency key — it relies on the shared fn", async () => {
    // The shared commit fns derive the key from frozen-payload fields.
    // If the cron tried to inject one, replays would not be
    // idempotent.
    const commitRawBag = vi.fn(async (input) => okRawBagCommit(input.opId));
    await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "r" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: commitRawBag as never,
    });
    const callArg = commitRawBag.mock.calls[0]![0];
    expect(callArg).not.toHaveProperty("commitIdempotencyKey");
    expect(callArg).not.toHaveProperty("idempotencyKey");
  });
});

describe("runAutoCommitSweep — gates-off → no live gateway call", () => {
  it("the production-output callable is NEVER invoked when production-output writes are gated off", async () => {
    const callable: ProductionOutputCommitCallable = vi.fn();
    await runAutoCommitSweep({
      env: {
        ZOHO_AUTO_COMMIT_ENABLED: "true",
        // production-output commit not enabled
      },
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "p" }],
      productionOutputCallable: callable,
    });
    expect(callable).not.toHaveBeenCalled();
  });
});
