import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { runAutoCommitSweep } from "./auto-commit-sweep";
import type { ConsolidatedProductionOutputCommitResult } from "./auto-commit-sweep";
import { ZOHO_TERMINAL_STATUS_LIST } from "@/lib/production/po-closeout";
import type {
  ProductionOutputCommitCallable,
  SharedProductionOutputCommitResult,
} from "./shared-production-output-commit";
import type { SharedRawBagCommitResult } from "./shared-raw-bag-receive-commit";

// Valid user_role enum values accepted by Postgres. "CRON" is NOT a member
// and null is the correct cron sentinel for both id and role.
const VALID_USER_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "LEAD", "STAFF"]);

// Mock @/lib/db so the route-level loaders never touch a real DB even
// when a test forgets to inject loadRawBagEligible / loadProductionOutputEligible.
// execute is mocked to return an empty iterable so defaultLoadZohoClosedPoOpIds
// returns an empty Set (no POs are closed) in tests that don't inject loadZohoClosedPoOpIds.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
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
      loadProductionOutputEligible: async () => [{ id: "po-1", payloadKind: "preview" }],
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
      loadProductionOutputEligible: async () => [{ id: "po-1", payloadKind: "preview" }],
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
        { id: "po-needs-review", payloadKind: "preview" },
        { id: "po-committed", payloadKind: "preview" },
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
      loadProductionOutputEligible: async () => [{ id: "p", payloadKind: "preview" }],
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
      loadProductionOutputEligible: async () => [{ id: "p", payloadKind: "preview" }],
      productionOutputCallable: callable,
    });
    expect(callable).not.toHaveBeenCalled();
  });
});

describe("ZOHO_TERMINAL_STATUS_LIST — regression pin (sweep must match classifier)", () => {
  it("contains received, closed, billed, cancelled — and NOT partially_received", () => {
    expect(ZOHO_TERMINAL_STATUS_LIST).toContain("received");
    expect(ZOHO_TERMINAL_STATUS_LIST).toContain("closed");
    expect(ZOHO_TERMINAL_STATUS_LIST).toContain("billed");
    expect(ZOHO_TERMINAL_STATUS_LIST).toContain("cancelled");
    expect(ZOHO_TERMINAL_STATUS_LIST).not.toContain("partially_received");
  });
});

describe("SWEEP-DATE-PIN-1: default loaders — structural source pins (Date param safety)", () => {
  // These pins guard against the latent regression (v1.1.0–v1.29.1) where
  // defaultLoadProductionOutputEligible used a raw sql`` fragment
  //   sql`${zohoProductionOutputOps.autoCommitEligibleAt} <= ${now}`
  // which fails serialization in the production Postgres driver when `now` is
  // a Date.  Both default loaders must use the lte() builder.
  const sweepSrc = readFileSync(
    join(process.cwd(), "lib/zoho/auto-commit-sweep.ts"),
    "utf8",
  );

  it("defaultLoadRawBagEligible uses lte() with autoCommitEligibleAt", () => {
    expect(sweepSrc).toMatch(/lte\(zohoRawBagReceives\.autoCommitEligibleAt,\s*now\)/);
  });

  it("defaultLoadProductionOutputEligible uses lte() with autoCommitEligibleAt", () => {
    expect(sweepSrc).toMatch(/lte\(zohoProductionOutputOps\.autoCommitEligibleAt,\s*now\)/);
  });

  it("source contains NO raw sql`` fragment comparing autoCommitEligibleAt (regression absence pin)", () => {
    // The bug: sql`${zohoXxx.autoCommitEligibleAt} <= ${now}` passes a Date
    // into a raw template, which the production driver cannot serialize.
    expect(sweepSrc).not.toMatch(/sql`\$\{zoho\w+\.autoCommitEligibleAt\}/);
  });
});

describe("runAutoCommitSweep — Zoho-closed PO skip", () => {
  it("skips production-output ops whose PO is closed in Zoho, with outcome skipped_po_zoho_closed", async () => {
    const commitSpy = vi.fn(async (input: { opId: string }) => okPoCommit(input.opId));
    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "op-1", payloadKind: "preview" }, { id: "op-2", payloadKind: "preview" }],
      loadZohoClosedPoOpIds: async (ids) => new Set(ids.filter((i) => i === "op-1")),
      commitProductionOutput: commitSpy as never,
      productionOutputCallable: vi.fn() as never,
    });
    expect(summary.totals.skipped_po_zoho_closed).toBe(1);
    const skipped = summary.rows.find((r) => r.opId === "op-1");
    expect(skipped?.outcome).toBe("skipped_po_zoho_closed");
    expect(skipped?.detail).toBe("PO is closed in Zoho — output intentionally not pushed");
    // commit must be called ONLY for op-2
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy.mock.calls[0]![0].opId).toBe("op-2");
  });

  it("raw-bag surface is NOT affected by the Zoho-closed PO check", async () => {
    const commitRawBag = vi.fn(async (input: { opId: string }) => okRawBagCommit(input.opId));
    // loadZohoClosedPoOpIds is NOT injected — default would run but we mock loadRawBagEligible
    const summary = await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "rb-1" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: commitRawBag as never,
    });
    // raw-bag ops should still commit normally
    expect(commitRawBag).toHaveBeenCalledTimes(1);
    expect(summary.totals.committed).toBe(1);
    expect(summary.totals.skipped_po_zoho_closed).toBe(0);
  });
});

describe("CRON-ACTOR-PIN-1: cron never passes enum-invalid roles or fabricated UUIDs", () => {
  // Regression pin for the incident where CRON_ACTOR.role = "CRON" (not a
  // valid user_role enum member) caused `invalid input value for enum
  // user_role: "CRON"` on the first live auto-commit sweep pass. And
  // CRON_PRODUCTION_OUTPUT_ACTOR carried a fabricated UUID that would have
  // violated the audit_log.actor_id FK to users.id.

  it("raw-bag commit is called with actor.role = null (not a non-enum string)", async () => {
    const capturedActors: Array<{ id: unknown; role: unknown }> = [];
    const commitRawBag = vi.fn(async (input: { opId: string; actor: { id: unknown; role: unknown } }) => {
      capturedActors.push({ id: input.actor.id, role: input.actor.role });
      return okRawBagCommit(input.opId);
    });
    await runAutoCommitSweep({
      env: ENABLED_RAW_BAG_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [{ id: "rb-cron-pin" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: commitRawBag as never,
    });
    expect(capturedActors).toHaveLength(1);
    const actor = capturedActors[0]!;
    // id must be null (no fabricated UUID that would violate FK to users.id)
    expect(actor.id).toBeNull();
    // role must be null OR a valid enum member — never an invalid string like "CRON"
    expect(actor.role === null || VALID_USER_ROLES.has(actor.role as string)).toBe(true);
  });

  it("production-output commit is called with actor.id = null and actor.role = null", async () => {
    const capturedActors: Array<{ id: unknown; role: unknown }> = [];
    const commitPo = vi.fn(async (input: { opId: string; actor: { id: unknown; role: unknown } }) => {
      capturedActors.push({ id: input.actor.id, role: input.actor.role });
      return okPoCommit(input.opId);
    });
    await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "po-cron-pin", payloadKind: "preview" }],
      commitProductionOutput: commitPo as never,
    });
    expect(capturedActors).toHaveLength(1);
    const actor = capturedActors[0]!;
    // id must be null (zero-UUID "00000000-..." has no row in users.id → FK violation)
    expect(actor.id).toBeNull();
    // role must be null OR a valid enum member — never a non-member string
    expect(actor.role === null || VALID_USER_ROLES.has(actor.role as string)).toBe(true);
  });
});

describe("CONSOLIDATED-SWEEP-ROUTE-1: sweep routes consolidated ops via consolidated path, legacy via shared path", () => {
  // Regression pin for the incident where consolidated ops (payload_kind='consolidated',
  // status=QUEUED, no approvedRequestHash) were sent through sharedCommitProductionOutputOp
  // which demands status=APPROVED + approvedRequestHash matching requestHash → APPROVED_HASH_MISMATCH
  // forever. Consolidated ops must go through their own commit path.

  it("consolidated op: commitConsolidatedProductionOutput is invoked, NOT commitProductionOutput", async () => {
    const commitConsolidated = vi.fn(async (opId: string): Promise<ConsolidatedProductionOutputCommitResult> => ({
      ok: true,
      externalReferenceId: "EXT-consolidated-1",
    }));
    const commitLegacy = vi.fn(async (input: { opId: string }) => okPoCommit(input.opId));

    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "cons-op-1", payloadKind: "consolidated" }],
      commitConsolidatedProductionOutput: commitConsolidated,
      commitProductionOutput: commitLegacy as never,
    });

    expect(commitConsolidated).toHaveBeenCalledTimes(1);
    expect(commitConsolidated).toHaveBeenCalledWith("cons-op-1", expect.objectContaining({ id: null, role: null }));
    expect(commitLegacy).not.toHaveBeenCalled();
    expect(summary.totals.committed).toBe(1);
    expect(summary.rows[0]!.detail).toBe("EXT-consolidated-1");
  });

  it("legacy op (payload_kind='preview'): commitProductionOutput is invoked, NOT commitConsolidatedProductionOutput", async () => {
    const commitConsolidated = vi.fn(async (): Promise<ConsolidatedProductionOutputCommitResult> => ({
      ok: true,
      externalReferenceId: null,
    }));
    const commitLegacy = vi.fn(async (input: { opId: string }) => okPoCommit(input.opId));

    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "legacy-op-1", payloadKind: "preview" }],
      commitConsolidatedProductionOutput: commitConsolidated,
      commitProductionOutput: commitLegacy as never,
    });

    expect(commitLegacy).toHaveBeenCalledTimes(1);
    expect(commitConsolidated).not.toHaveBeenCalled();
    expect(summary.totals.committed).toBe(1);
  });

  it("mixed batch: consolidated op commits via consolidated path, legacy op via shared path, both committed", async () => {
    const commitConsolidated = vi.fn(async (opId: string): Promise<ConsolidatedProductionOutputCommitResult> => ({
      ok: true,
      externalReferenceId: `EXT-cons-${opId}`,
    }));
    const commitLegacy = vi.fn(async (input: { opId: string }) => okPoCommit(input.opId));

    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [
        { id: "cons-op-2", payloadKind: "consolidated" },
        { id: "legacy-op-2", payloadKind: "preview" },
      ],
      commitConsolidatedProductionOutput: commitConsolidated,
      commitProductionOutput: commitLegacy as never,
    });

    expect(commitConsolidated).toHaveBeenCalledTimes(1);
    expect(commitConsolidated.mock.calls[0]![0]).toBe("cons-op-2");
    expect(commitLegacy).toHaveBeenCalledTimes(1);
    expect(commitLegacy.mock.calls[0]![0].opId).toBe("legacy-op-2");
    expect(summary.totals.committed).toBe(2);
  });

  it("consolidated claim-phase failure maps to state_blocked (not permanent_failure)", async () => {
    const commitConsolidated = vi.fn(async (): Promise<ConsolidatedProductionOutputCommitResult> => ({
      ok: false,
      reason: "Op is in status COMMITTING; cannot claim.",
      phase: "claim",
    }));

    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "cons-op-3", payloadKind: "consolidated" }],
      commitConsolidatedProductionOutput: commitConsolidated,
    });

    expect(summary.totals.state_blocked).toBe(1);
    expect(summary.rows[0]!.outcome).toBe("state_blocked");
    expect(summary.rows[0]!.detail).toContain("COMMITTING");
  });

  it("consolidated gateway-phase failure maps to permanent_failure", async () => {
    const commitConsolidated = vi.fn(async (): Promise<ConsolidatedProductionOutputCommitResult> => ({
      ok: false,
      reason: "Zoho returned 422 Unknown item.",
      phase: "gateway",
    }));

    const summary = await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "cons-op-4", payloadKind: "consolidated" }],
      commitConsolidatedProductionOutput: commitConsolidated,
    });

    expect(summary.totals.permanent_failure).toBe(1);
    expect(summary.rows[0]!.outcome).toBe("permanent_failure");
  });

  it("CRON-ACTOR-PIN-1 applies to consolidated path: actor.id === null, actor.role === null", async () => {
    const capturedActors: Array<{ id: unknown; role: unknown }> = [];
    const commitConsolidated = vi.fn(async (_opId: string, actor: { id: unknown; role: unknown }): Promise<ConsolidatedProductionOutputCommitResult> => {
      capturedActors.push({ id: actor.id, role: actor.role });
      return { ok: true, externalReferenceId: null };
    });

    await runAutoCommitSweep({
      env: ENABLED_PO_ONLY,
      now: NOW,
      loadRawBagEligible: async () => [],
      loadProductionOutputEligible: async () => [{ id: "cons-actor-pin", payloadKind: "consolidated" }],
      commitConsolidatedProductionOutput: commitConsolidated as never,
    });

    expect(capturedActors).toHaveLength(1);
    const actor = capturedActors[0]!;
    expect(actor.id).toBeNull();
    expect(actor.role === null || VALID_USER_ROLES.has(actor.role as string)).toBe(true);
  });
});
