// ZOHO-STAGING-BUFFER-v1.1.0 — the cron sweep.
//
// Called by `app/api/cron/zoho-auto-commit/route.ts` (and by tests
// directly with mocked dependencies). The sweep:
//
//   1. Reads the env-driven write gates ONCE per pass.
//   2. Loads eligible raw-bag receive rows.
//   3. Loads eligible production-output rows.
//   4. For each row:
//        - If the surface's writes-gate is OFF → log
//          "skipped_guard_blocked". NO claim, NO state change. This is
//          the rule that keeps guard-blocked rows from burning retry
//          budget.
//        - Else → call the shared commit fn with source="auto".
//          The shared fn handles state machine + idempotency.
//   5. Returns a structured summary the cron route serializes to JSON
//      and writes to the audit log.
//
// Eligibility predicate (per surface):
//
//   raw_bag_receives:
//     status IN ('PENDING', 'PREVIEWED', 'FAILED')
//     AND auto_commit_eligible_at <= now()
//     AND held_at IS NULL
//     AND voided_at IS NULL
//     -- (status != HELD, VOIDED, COMMITTED, COMMITTING, NEEDS_MAPPING,
//     --  NEEDS_REVIEW — these never re-enter the cron)
//
//   production_output_ops:
//     status = 'QUEUED'
//     AND auto_commit_eligible_at <= now()
//     AND held_at IS NULL
//     AND voided_at IS NULL

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoProductionOutputOps, zohoRawBagReceives } from "@/lib/db/schema";
import { resolveAutoCommitWriteGates, type AutoCommitWriteGates } from "@/lib/zoho/auto-commit-write-gates";
import {
  sharedCommitRawBagReceive,
  type SharedRawBagCommitResult,
} from "@/lib/zoho/shared-raw-bag-receive-commit";
import {
  sharedCommitProductionOutputOp,
  type ProductionOutputCommitCallable,
  type SharedProductionOutputCommitResult,
} from "@/lib/zoho/shared-production-output-commit";
import { callProductionOutputCommit } from "@/lib/zoho/production-output-service-client";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import type { CurrentUser } from "@/lib/auth";

// Per-pass cap so a misbehaving DB or runaway buffer can't blow the
// request budget. The cron fires every 5 minutes; if more than this
// many rows are eligible, they'll roll over to the next pass.
const PER_PASS_LIMIT = 25;

// Synthetic actor for cron-triggered audit rows. The audit table
// expects a real user, but the cron isn't a real operator. The actor
// id is null so audit-log readers can distinguish operator action
// from cron action; the role string makes that distinction obvious
// in the timeline.
export const CRON_ACTOR: Pick<CurrentUser, "id" | "role"> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  role: "CRON" as any,
};

// Synthetic CurrentUser-shaped object for production-output (the
// existing primitives require a full CurrentUser).
const CRON_PRODUCTION_OUTPUT_ACTOR = {
  id: "00000000-0000-0000-0000-000000000000",
  role: "ADMIN" as const,
  email: "cron@luma.local",
  employeeId: null,
  name: "luma-zoho-auto-commit-cron",
} as unknown as CurrentUser;

export type SweepOutcome =
  | "committed"
  | "needs_review"
  | "needs_mapping"
  | "transport_retryable"
  | "permanent_failure"
  | "state_blocked"
  | "skipped_guard_blocked"
  | "skipped_master_off";

export type SweepRowResult = {
  surface: "raw_bag_receive" | "production_output";
  opId: string;
  outcome: SweepOutcome;
  detail: string | null;
};

export type SweepSummary = {
  gates: AutoCommitWriteGates;
  startedAt: string;
  finishedAt: string;
  rawBagEligibleConsidered: number;
  productionOutputEligibleConsidered: number;
  rows: SweepRowResult[];
  totals: Record<SweepOutcome, number>;
};

export type AutoCommitSweepDependencies = {
  /** Inject these for tests; defaults call the real DB / commit fns. */
  loadRawBagEligible?: (now: Date, limit: number) => Promise<Array<{ id: string }>>;
  loadProductionOutputEligible?: (
    now: Date,
    limit: number,
  ) => Promise<Array<{ id: string }>>;
  commitRawBag?: typeof sharedCommitRawBagReceive;
  commitProductionOutput?: typeof sharedCommitProductionOutputOp;
  productionOutputCallable?: ProductionOutputCommitCallable;
  env?: Record<string, string | undefined>;
  now?: Date;
};

const RAW_BAG_COMMITTABLE_STATUSES = ["PENDING", "PREVIEWED", "FAILED"] as const;

async function defaultLoadRawBagEligible(now: Date, limit: number) {
  return db
    .select({ id: zohoRawBagReceives.id })
    .from(zohoRawBagReceives)
    .where(
      and(
        inArray(zohoRawBagReceives.zohoReceiveStatus, [
          ...RAW_BAG_COMMITTABLE_STATUSES,
        ]),
        lte(zohoRawBagReceives.autoCommitEligibleAt, now),
        isNull(zohoRawBagReceives.heldAt),
        isNull(zohoRawBagReceives.voidedAt),
      ),
    )
    .limit(limit);
}

async function defaultLoadProductionOutputEligible(now: Date, limit: number) {
  return db
    .select({ id: zohoProductionOutputOps.id })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.status, "QUEUED"),
        sql`${zohoProductionOutputOps.autoCommitEligibleAt} <= ${now}`,
        isNull(zohoProductionOutputOps.heldAt),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    )
    .limit(limit);
}

const defaultProductionOutputCallable: ProductionOutputCommitCallable = async (input) => {
  const result = await callProductionOutputCommit({
    payload: input.requestPayload as unknown as ProductionOutputPreviewPayload,
    idempotencyKey: input.commitIdempotencyKey,
  });
  if (result.ok) {
    return {
      ok: true,
      body: result.body,
      externalReferenceId: result.externalReferenceId,
    };
  }
  return {
    ok: false,
    body: result.body,
    httpStatus: result.httpStatus,
    message: result.message,
  };
};

function emptyTotals(): Record<SweepOutcome, number> {
  return {
    committed: 0,
    needs_review: 0,
    needs_mapping: 0,
    transport_retryable: 0,
    permanent_failure: 0,
    state_blocked: 0,
    skipped_guard_blocked: 0,
    skipped_master_off: 0,
  };
}

function classifyRawBagResult(result: SharedRawBagCommitResult): {
  outcome: SweepOutcome;
  detail: string | null;
} {
  if (result.ok && result.kind === "COMMITTED") {
    return { outcome: "committed", detail: result.zohoPurchaseReceiveId };
  }
  if (!result.ok) {
    switch (result.kind) {
      case "STATE_BLOCKED":
        return { outcome: "state_blocked", detail: result.reason };
      case "GUARD_BLOCKED":
        return { outcome: "skipped_guard_blocked", detail: result.reason };
      case "NEEDS_REVIEW":
        return {
          outcome: "needs_review",
          detail: result.blockers.map((b) => b.code).join(","),
        };
      case "NEEDS_MAPPING":
        return {
          outcome: "needs_mapping",
          detail: result.blockers.map((b) => b.code).join(","),
        };
      case "TRANSPORT_RETRYABLE":
        return { outcome: "transport_retryable", detail: result.reason };
      case "PERMANENT_FAILURE":
        return { outcome: "permanent_failure", detail: result.reason };
    }
  }
  return { outcome: "permanent_failure", detail: "Unknown outcome" };
}

function classifyProductionOutputResult(
  result: SharedProductionOutputCommitResult,
): { outcome: SweepOutcome; detail: string | null } {
  if (result.ok && result.kind === "COMMITTED") {
    return { outcome: "committed", detail: result.externalReferenceId };
  }
  if (!result.ok) {
    switch (result.kind) {
      case "STATE_BLOCKED":
        return { outcome: "state_blocked", detail: result.reason };
      case "GUARD_BLOCKED":
        return { outcome: "skipped_guard_blocked", detail: result.reason };
      case "NEEDS_REVIEW":
        return {
          outcome: "needs_review",
          detail: result.blockers.map((b) => b.code).join(","),
        };
      case "NEEDS_MAPPING":
        return {
          outcome: "needs_mapping",
          detail: result.blockers.map((b) => b.code).join(","),
        };
      case "TRANSPORT_RETRYABLE":
        return { outcome: "transport_retryable", detail: result.reason };
      case "PERMANENT_FAILURE":
        return { outcome: "permanent_failure", detail: result.reason };
    }
  }
  return { outcome: "permanent_failure", detail: "Unknown outcome" };
}

export async function runAutoCommitSweep(
  deps: AutoCommitSweepDependencies = {},
): Promise<SweepSummary> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const startedAt = now.toISOString();

  const gates = resolveAutoCommitWriteGates(env);
  const totals = emptyTotals();
  const rows: SweepRowResult[] = [];

  // Master switch off: don't even query. Faster, and the audit row
  // is clear about why nothing happened.
  if (!gates.autoCommitEnabled) {
    return {
      gates,
      startedAt,
      finishedAt: new Date().toISOString(),
      rawBagEligibleConsidered: 0,
      productionOutputEligibleConsidered: 0,
      rows: [],
      totals: { ...totals, skipped_master_off: 0 },
    };
  }

  // ── Raw-bag pass ───────────────────────────────────────────────
  const rawBagEligible = await (
    deps.loadRawBagEligible ?? defaultLoadRawBagEligible
  )(now, PER_PASS_LIMIT);

  for (const { id } of rawBagEligible) {
    if (!gates.rawBagWritesAllowed) {
      // Don't claim — would burn an attempt budget for an env-flag
      // misconfiguration that's not the row's fault.
      rows.push({
        surface: "raw_bag_receive",
        opId: id,
        outcome: "skipped_guard_blocked",
        detail: gates.reasons.rawBag ?? null,
      });
      totals.skipped_guard_blocked += 1;
      continue;
    }
    const commit = deps.commitRawBag ?? sharedCommitRawBagReceive;
    const result = await commit({ opId: id, source: "auto", actor: CRON_ACTOR });
    const { outcome, detail } = classifyRawBagResult(result);
    rows.push({ surface: "raw_bag_receive", opId: id, outcome, detail });
    totals[outcome] += 1;
  }

  // ── Production-output pass ─────────────────────────────────────
  const poEligible = await (
    deps.loadProductionOutputEligible ?? defaultLoadProductionOutputEligible
  )(now, PER_PASS_LIMIT);

  for (const { id } of poEligible) {
    if (!gates.productionOutputWritesAllowed) {
      rows.push({
        surface: "production_output",
        opId: id,
        outcome: "skipped_guard_blocked",
        detail: gates.reasons.productionOutput ?? null,
      });
      totals.skipped_guard_blocked += 1;
      continue;
    }
    const commit = deps.commitProductionOutput ?? sharedCommitProductionOutputOp;
    const result = await commit({
      opId: id,
      source: "auto",
      actor: CRON_PRODUCTION_OUTPUT_ACTOR,
      callable: deps.productionOutputCallable ?? defaultProductionOutputCallable,
    });
    const { outcome, detail } = classifyProductionOutputResult(result);
    rows.push({ surface: "production_output", opId: id, outcome, detail });
    totals[outcome] += 1;
  }

  return {
    gates,
    startedAt,
    finishedAt: new Date().toISOString(),
    rawBagEligibleConsidered: rawBagEligible.length,
    productionOutputEligibleConsidered: poEligible.length,
    rows,
    totals,
  };
}
