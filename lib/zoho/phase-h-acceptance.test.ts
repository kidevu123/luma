// ZOHO-STAGING-BUFFER-v1.1.0 — Phase H acceptance tests.
//
// One file pinning the 7 acceptance areas the spec calls out:
//
//   1. Cron auth                  → covered by route.test.ts
//   2. First-deploy safety        → here
//   3. Queue/state behavior       → here (loader query source contract)
//   4. Admin actions integration  → here (reason validation, no-claim
//                                   shortcuts)
//   5. Frozen payloads & notes    → covered by zoho-commit-notes.test.ts
//                                   plus a re-freeze contract check here
//   6. Overs/extras               → here (the cumulative "not claimable"
//                                   contract)
//   7. Idempotency                → here
//
// Tests that touch the DB use source-level assertions (read the
// implementation as text and pin the predicates). That's the same
// pattern used by sidebar.test.ts and persistent-headers.test.ts —
// fast, deterministic, no fixtures.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

/** Pull the body of a top-level function or arrow declaration so we
 *  can assert on what it CONTAINS / EXCLUDES without picking up
 *  imports or sibling declarations elsewhere in the file. Tracks
 *  brace depth to find the matching close. */
function extractFunctionBody(src: string, declarationStart: string): string {
  const startIdx = src.indexOf(declarationStart);
  if (startIdx < 0) {
    throw new Error(`extractFunctionBody: declaration not found: ${declarationStart}`);
  }
  // Find the first `{` after the declaration start.
  const openIdx = src.indexOf("{", startIdx);
  if (openIdx < 0) {
    throw new Error(
      `extractFunctionBody: no opening brace after ${declarationStart}`,
    );
  }
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return src.slice(openIdx, i);
}

// ─── 2. First-deploy safety ───────────────────────────────────────

describe("first-deploy safety — manual commit-now refuses without claim", () => {
  it("sharedCommitRawBagReceive does its env-gate check BEFORE the claim", async () => {
    // Pinned in code: the resolveAutoCommitWriteGates() call must
    // precede claimForCommit(). Re-ordering would burn retry budget.
    const src = read("lib/zoho/shared-raw-bag-receive-commit.ts");
    const gateIdx = src.indexOf("resolveAutoCommitWriteGates()");
    const claimIdx = src.indexOf("claimForCommit(input.opId)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(claimIdx);
  });

  it("sharedCommitProductionOutputOp does its env-gate check BEFORE claim/gateway", async () => {
    // The import of `claimZohoProductionOutputOpForCommit` lives at
    // the top of the file, so we anchor on the actual CALL site
    // (with its argument) to make the ordering check meaningful.
    const src = read("lib/zoho/shared-production-output-commit.ts");
    const gateIdx = src.indexOf("resolveAutoCommitWriteGates()");
    const claimCallIdx = src.indexOf(
      "claimZohoProductionOutputOpForCommit(input.opId, input.actor)",
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(claimCallIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(claimCallIdx);
  });

  it("GUARD_BLOCKED is a distinct result kind on both wrappers (not aliased to STATE_BLOCKED or RETRYABLE)", async () => {
    const rawBag = read("lib/zoho/shared-raw-bag-receive-commit.ts");
    const po = read("lib/zoho/shared-production-output-commit.ts");
    expect(rawBag).toMatch(/kind:\s*"GUARD_BLOCKED"/);
    expect(po).toMatch(/kind:\s*"GUARD_BLOCKED"/);
  });

  it("manual server actions surface GUARD_BLOCKED with operator-readable copy", () => {
    const rawBagAction = read(
      "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-actions.ts",
    );
    const poAction = read(
      "app/(admin)/zoho-production-operations/staging-actions.ts",
    );
    expect(rawBagAction).toMatch(/result\.kind === "GUARD_BLOCKED"/);
    expect(rawBagAction).toMatch(/Live commit disabled/);
    expect(poAction).toMatch(/result\.kind === "GUARD_BLOCKED"/);
    expect(poAction).toMatch(/Live commit disabled/);
  });

  it("sharedCommit fns short-circuit at GUARD_BLOCKED with a `return` (no fall-through)", () => {
    // If we don't explicitly return after detecting GUARD_BLOCKED,
    // execution falls through to claimForCommit and burns budget.
    const rawBag = read("lib/zoho/shared-raw-bag-receive-commit.ts");
    expect(rawBag).toMatch(
      /if\s*\(!gates\.rawBagWritesAllowed\)\s*\{[\s\S]+?return\s*\{[\s\S]+?kind:\s*"GUARD_BLOCKED"/,
    );
    const po = read("lib/zoho/shared-production-output-commit.ts");
    expect(po).toMatch(
      /if\s*\(!writeGates\.productionOutputWritesAllowed\)\s*\{[\s\S]+?return\s*\{[\s\S]+?kind:\s*"GUARD_BLOCKED"/,
    );
  });
});

// ─── 3. Queue/state behavior ──────────────────────────────────────

describe("queue/state behavior — loader query filters", () => {
  const sweep = read("lib/zoho/auto-commit-sweep.ts");

  it("raw-bag loader filters on (status IN committable) AND (auto_commit_eligible_at <= now) AND held_at IS NULL AND voided_at IS NULL", () => {
    // All four predicates must be present in the same query
    // (defaultLoadRawBagEligible).
    const loaderSlice = sweep.slice(sweep.indexOf("defaultLoadRawBagEligible"));
    expect(loaderSlice).toMatch(/inArray\(zohoRawBagReceives\.zohoReceiveStatus/);
    expect(loaderSlice).toMatch(
      /lte\(zohoRawBagReceives\.autoCommitEligibleAt,\s*now\)/,
    );
    expect(loaderSlice).toMatch(/isNull\(zohoRawBagReceives\.heldAt\)/);
    expect(loaderSlice).toMatch(/isNull\(zohoRawBagReceives\.voidedAt\)/);
  });

  it("raw-bag committable set is exactly PENDING / PREVIEWED / FAILED (no HELD, VOIDED, NEEDS_*, COMMITTED, COMMITTING)", () => {
    const m = sweep.match(/RAW_BAG_COMMITTABLE_STATUSES\s*=\s*\[([\s\S]+?)\]/);
    expect(m).toBeTruthy();
    const list = m![1];
    expect(list).toMatch(/"PENDING"/);
    expect(list).toMatch(/"PREVIEWED"/);
    expect(list).toMatch(/"FAILED"/);
    for (const forbidden of [
      "HELD",
      "VOIDED",
      "NEEDS_MAPPING",
      "NEEDS_REVIEW",
      "COMMITTED",
      "COMMITTING",
    ]) {
      expect(list).not.toContain(`"${forbidden}"`);
    }
  });

  it("production-output loader requires status = QUEUED AND eligible AND not held AND not voided", () => {
    const loaderSlice = sweep.slice(
      sweep.indexOf("defaultLoadProductionOutputEligible"),
    );
    expect(loaderSlice).toMatch(
      /eq\(zohoProductionOutputOps\.status,\s*"QUEUED"\)/,
    );
    expect(loaderSlice).toMatch(/autoCommitEligibleAt[\s\S]*<=\s*\$\{now\}/);
    expect(loaderSlice).toMatch(/isNull\(zohoProductionOutputOps\.heldAt\)/);
    expect(loaderSlice).toMatch(/isNull\(zohoProductionOutputOps\.voidedAt\)/);
  });

  it("sharedCommitRawBagReceive treats NEEDS_REVIEW as STATE_BLOCKED at claim time (operator-only unlock)", () => {
    const src = read("lib/zoho/shared-raw-bag-receive-commit.ts");
    expect(src).toMatch(
      /row\.status\s*===\s*"NEEDS_REVIEW"[\s\S]+?Resolve before commit/,
    );
  });
});

// ─── 4. Admin actions integration ────────────────────────────────

describe("admin actions — reason validation + state-machine safety", () => {
  const rawBagActions = read(
    "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-actions.ts",
  );
  const poActions = read(
    "app/(admin)/zoho-production-operations/staging-actions.ts",
  );

  it("raw-bag Hold rejects empty reason and ≤ 500 chars", () => {
    expect(rawBagActions).toMatch(/Provide a reason for the hold/);
    expect(rawBagActions).toMatch(/500/);
  });

  it("raw-bag Void rejects empty reason and is terminal (status VOIDED, voidedAt set)", () => {
    expect(rawBagActions).toMatch(/Provide a reason for the void/);
    expect(rawBagActions).toMatch(/zohoReceiveStatus:\s*"VOIDED"/);
    expect(rawBagActions).toMatch(/voidedAt:\s*now/);
  });

  it("raw-bag Unhold re-stamps auto_commit_eligible_at from current env (not the held timestamp)", () => {
    expect(rawBagActions).toMatch(
      /unholdRawBagReceiveOp[\s\S]+?resolveZohoAutoCommitBufferConfig\(\)[\s\S]+?deriveAutoCommitEligibleAt/,
    );
  });

  it("production-output Hold rejects empty reason ≤ 500 chars", () => {
    expect(poActions).toMatch(/Provide a reason for the hold/);
    expect(poActions).toMatch(/500/);
  });

  it("production-output 'Approve for auto-commit' queues but does NOT call sharedCommitProductionOutputOp", () => {
    // Pinned: the auto-commit-approve action goes Approve → Queue and
    // stops. The shared commit fn is only invoked by the
    // commit-now variant. We extract the function's exact body so a
    // sibling const definition between the two functions can't leak
    // into the assertion.
    const body = extractFunctionBody(
      poActions,
      "export async function approveProductionOutputForAutoCommit(",
    );
    expect(body).toMatch(/approveZohoProductionOutputOp/);
    expect(body).toMatch(/queueZohoProductionOutputOpForFutureCommit/);
    expect(body).not.toMatch(/sharedCommitProductionOutputOp/);
  });

  it("production-output 'Approve & commit now' goes Approve → Queue → sharedCommitProductionOutputOp(source: 'manual')", () => {
    const body = extractFunctionBody(
      poActions,
      "export async function approveAndCommitProductionOutputNow(",
    );
    expect(body).toMatch(/approveZohoProductionOutputOp/);
    expect(body).toMatch(/queueZohoProductionOutputOpForFutureCommit/);
    expect(body).toMatch(
      /sharedCommitProductionOutputOp\([\s\S]+?source:\s*"manual"/,
    );
  });

  it("raw-bag commit-now uses sharedCommitRawBagReceive(source: 'manual') — same fn as the cron", () => {
    expect(rawBagActions).toMatch(
      /sharedCommitRawBagReceive\([\s\S]+?source:\s*"manual"/,
    );
  });

  it("both surfaces revalidate the affected pages after any action", () => {
    expect(rawBagActions).toMatch(/revalidatePath/);
    expect(poActions).toMatch(/revalidatePath/);
  });
});

// ─── 5. Frozen payloads & notes ──────────────────────────────────

describe("frozen payloads — re-freeze on edit / regenerate", () => {
  const freeze = read("lib/zoho/freeze-raw-bag-receive-payload.ts");

  it("re-freeze clears mappingBlockers + commitError so the new attempt isn't dragged by stale state", () => {
    expect(freeze).toMatch(/mappingBlockers:\s*null/);
    expect(freeze).toMatch(/commitError:\s*null/);
  });

  it("re-freeze re-stamps auto_commit_eligible_at from env (operator edit resets the buffer)", () => {
    expect(freeze).toMatch(/autoCommitEligibleAt,/);
    expect(freeze).toMatch(/deriveAutoCommitEligibleAt/);
  });

  it("re-freeze computes a fresh commit_idempotency_key from the payload-defining fields", () => {
    expect(freeze).toMatch(/buildRawBagCommitIdempotencyKey/);
    // Set into the row via ES2015 shorthand: `commitIdempotencyKey,`
    // (the local const name matches the column key). Accept either
    // shorthand or explicit form so future refactors don't trip the
    // test if they switch.
    expect(freeze).toMatch(/commitIdempotencyKey[,:]/);
  });

  it("the regenerate entry point exists alongside the seed entry point (same impl, different audit label)", () => {
    expect(freeze).toMatch(/freezeRawBagReceivePayloadAtSeed/);
    expect(freeze).toMatch(/regenerateFrozenRawBagReceivePayload/);
  });
});

// ─── 6. Overs / extras (cumulative contract) ────────────────────

describe("overs / extras — cumulative no-retry, no-commit contract", () => {
  const sharedRawBag = read("lib/zoho/shared-raw-bag-receive-commit.ts");
  const sweep = read("lib/zoho/auto-commit-sweep.ts");
  const buttons = read(
    "app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-buttons.tsx",
  );

  it("OVER_RECEIVE_EXCEEDS_PO_REMAINING is in NEEDS_REVIEW_BLOCKER_CODES (routes to review, not mapping)", () => {
    expect(sharedRawBag).toMatch(
      /NEEDS_REVIEW_BLOCKER_CODES[\s\S]+?"OVER_RECEIVE_EXCEEDS_PO_REMAINING"/,
    );
  });

  it("classifyBlockers separates needsReview from needsMapping (NOT routed together)", () => {
    expect(sharedRawBag).toMatch(/needsReview:\s*CommitMappingBlocker\[\]/);
    expect(sharedRawBag).toMatch(/needsMapping:\s*CommitMappingBlocker\[\]/);
  });

  it("NEEDS_REVIEW status is rejected at claim time — manual commit-now refuses to claim it", () => {
    expect(sharedRawBag).toMatch(
      /row\.status\s*===\s*"NEEDS_REVIEW"[\s\S]+?reason:[\s\S]+?business decision/,
    );
  });

  it("cron loader excludes NEEDS_REVIEW (not in COMMITTABLE_STATUSES) — no auto-retry", () => {
    const list = sweep.match(/RAW_BAG_COMMITTABLE_STATUSES\s*=\s*\[([\s\S]+?)\]/)![1];
    expect(list).not.toContain("NEEDS_REVIEW");
  });

  it("UI shows the overs decision copy for NEEDS_REVIEW + OVER_RECEIVE_EXCEEDS_PO_REMAINING", () => {
    expect(buttons).toMatch(/OVER_RECEIVE_EXCEEDS_PO_REMAINING/);
    expect(buttons).toMatch(/exceeds the remaining Zoho PO line quantity/);
    expect(buttons).toMatch(/create an overs PO\s+later/);
  });

  it("Commit-now button is hidden when status=NEEDS_REVIEW (no opt-out path through the operator UI)", () => {
    // The button only renders inside `{isCommittable ? ...}` and
    // NEEDS_REVIEW is not in the committable set. We extract the
    // exact array contents to assert membership; the previous regex
    // tripped over the trailing comma after "FAILED" between the
    // last entry and the closing bracket.
    const m = buttons.match(
      /COMMITTABLE_STATUSES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).not.toBeNull();
    const items = m![1];
    expect(items).toContain('"PENDING"');
    expect(items).toContain('"PREVIEWED"');
    expect(items).toContain('"FAILED"');
    expect(items).not.toContain("NEEDS_REVIEW");
    expect(items).not.toContain("NEEDS_MAPPING");
    expect(items).not.toContain("HELD");
    expect(items).not.toContain("VOIDED");
  });
});

// ─── 7. Idempotency invariants ────────────────────────────────────

describe("idempotency — same key, no double-write; different payload, fresh key", () => {
  const sharedRawBag = read("lib/zoho/shared-raw-bag-receive-commit.ts");
  const sharedPo = read("lib/zoho/shared-production-output-commit.ts");
  const freeze = read("lib/zoho/freeze-raw-bag-receive-payload.ts");

  it("raw-bag commit idempotency key is derived from opId + the 4 payload-defining fields", () => {
    expect(sharedRawBag).toMatch(
      /buildRawBagCommitIdempotencyKey[\s\S]+?opId[\s\S]+?zohoPoId[\s\S]+?zohoLineItemId[\s\S]+?receivedQuantity[\s\S]+?receiveDate/,
    );
  });

  it("raw-bag claim transitions PENDING→COMMITTING atomically (single conditional UPDATE)", () => {
    // Conditional UPDATE: WHERE id = X AND status IN committable AND
    // held_at IS NULL AND voided_at IS NULL. Two concurrent workers
    // can race the UPDATE; exactly one wins because Postgres
    // serializes the UPDATE.
    const claimSlice = sharedRawBag.slice(sharedRawBag.indexOf("function claimForCommit"));
    expect(claimSlice).toMatch(/\.update\(zohoRawBagReceives\)/);
    expect(claimSlice).toMatch(/zohoReceiveStatus:\s*"COMMITTING"/);
    expect(claimSlice).toMatch(
      /commitAttemptCount:\s*sql`\$\{zohoRawBagReceives\.commitAttemptCount\}\s*\+\s*1`/,
    );
    expect(claimSlice).toMatch(/inArray\(\s*zohoRawBagReceives\.zohoReceiveStatus/);
  });

  it("raw-bag commit reuses the stored commit_idempotency_key on retry (replay-safe at the gateway)", () => {
    expect(sharedRawBag).toMatch(
      /idempotencyKey\s*=\s*claim\.commitIdempotencyKey\s*\|\|/,
    );
  });

  it("production-output commit reuses op.commitIdempotencyKey on retry", () => {
    expect(sharedPo).toMatch(
      /idempotencyKey\s*=\s*op\.commitIdempotencyKey\s*\?\?/,
    );
  });

  it("transport-retry reverts COMMITTING → PENDING but does NOT mint a new idempotency key", () => {
    // The shared fn writes commit_started_at = null on retry so the
    // next attempt starts fresh, but commit_idempotency_key is
    // preserved across attempts. The gateway treats retries as
    // replays. We extract the function body so subsequent calls to
    // transitionToRetryable don't leak unrelated assignments into
    // the "no fresh key" assertion.
    const body = extractFunctionBody(sharedRawBag, "async function transitionToRetryable(");
    expect(body).toMatch(/zohoReceiveStatus:\s*"PENDING"/);
    expect(body).toMatch(/commitStartedAt:\s*null/);
    // The transition body itself never sets commit_idempotency_key —
    // the column carries through from the prior claim. (Allow the
    // ASSIGNMENT-style suffix `: ` only; the key name appearing
    // inside a longer identifier like `commitIdempotencyKeyHash`
    // would be a different thing and shouldn't happen here.)
    expect(body).not.toMatch(/\bcommitIdempotencyKey\s*:/);
  });

  it("payload edit regenerates BOTH the commit_idempotency_key AND auto_commit_eligible_at", () => {
    // Editing the bag → fresh key (deliberate new operation) AND
    // fresh buffer (so the operator gets the full review window
    // again on the changed payload). Both invariants are pinned by
    // checking the freeze fn updates BOTH columns inside the SAME
    // `.set({...})` call. ES2015 shorthand on the column name is
    // accepted (the local const matches the column).
    const setSlice = freeze.slice(
      freeze.indexOf(".set({"),
      freeze.indexOf("})", freeze.indexOf(".set({")),
    );
    expect(setSlice).toMatch(/commitIdempotencyKey[,:]/);
    expect(setSlice).toMatch(/autoCommitEligibleAt[,:]/);
  });
});

// ─── 1. Cron auth (cumulative pointer — fully covered in route.test.ts) ─

describe("cron auth — cumulative pointer", () => {
  it("auth tests live alongside the route file (route.test.ts) — verify file exists", () => {
    expect(() => read("app/api/cron/zoho-auto-commit/route.test.ts")).not.toThrow();
  });
});

// ─── Functional integration: sweep + GUARD_BLOCKED outcome ─────

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/db/audit", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { runAutoCommitSweep } from "./auto-commit-sweep";
import type {
  SharedRawBagCommitResult,
} from "./shared-raw-bag-receive-commit";

const FIRST_DEPLOY_ENV: Record<string, string | undefined> = {
  // Persist + preview ON so the queue populates and operators can
  // preview, COMMIT off so no writes happen, AUTO_COMMIT off so the
  // cron is a no-op too.
  ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED: "true",
  ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED: "false",
  ZOHO_DRY_RUN_WRITES_ENABLED: "false",
  ZOHO_AUTO_COMMIT_ENABLED: "false",
};

describe("first-deploy env posture — end-to-end behaviour", () => {
  it("with the recommended first-deploy env, the cron is a no-op (master switch off)", async () => {
    const result = await runAutoCommitSweep({
      env: FIRST_DEPLOY_ENV,
      now: new Date("2026-06-15T12:00:00Z"),
      loadRawBagEligible: async () => [{ id: "ignored" }],
      loadProductionOutputEligible: async () => [{ id: "ignored" }],
    });
    expect(result.gates.autoCommitEnabled).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it("if an operator flips ZOHO_AUTO_COMMIT_ENABLED=true but live gates stay off, cron logs guard-blocked and never commits", async () => {
    const commitRawBag = vi.fn();
    const commitPo = vi.fn();
    const result = await runAutoCommitSweep({
      env: { ...FIRST_DEPLOY_ENV, ZOHO_AUTO_COMMIT_ENABLED: "true" },
      now: new Date("2026-06-15T12:00:00Z"),
      loadRawBagEligible: async () => [{ id: "rb-1" }, { id: "rb-2" }],
      loadProductionOutputEligible: async () => [{ id: "po-1" }],
      commitRawBag: commitRawBag as never,
      commitProductionOutput: commitPo as never,
    });
    expect(commitRawBag).not.toHaveBeenCalled();
    expect(commitPo).not.toHaveBeenCalled();
    expect(result.totals.skipped_guard_blocked).toBe(3);
    expect(result.totals.committed).toBe(0);
  });

  it("GUARD_BLOCKED result from sharedCommit also classifies as skipped_guard_blocked", async () => {
    // Defensive: even if the sweep's pre-check is bypassed (e.g.
    // tests inject a permissive env into the sweep but the shared
    // commit sees the real off env), the sharedCommit's own pre-
    // flight catches it and the sweep classifies it correctly.
    const result = await runAutoCommitSweep({
      env: {
        ZOHO_AUTO_COMMIT_ENABLED: "true",
        ZOHO_DRY_RUN_WRITES_ENABLED: "true",
      },
      now: new Date("2026-06-15T12:00:00Z"),
      loadRawBagEligible: async () => [{ id: "rb-1" }],
      loadProductionOutputEligible: async () => [],
      commitRawBag: (async () =>
        ({
          ok: false,
          kind: "GUARD_BLOCKED",
          opId: "rb-1",
          reason: "test-injected guard",
        }) satisfies SharedRawBagCommitResult) as never,
    });
    expect(result.totals.skipped_guard_blocked).toBe(1);
    expect(result.totals.committed).toBe(0);
  });
});
