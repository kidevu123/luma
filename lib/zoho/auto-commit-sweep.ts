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
import { ZOHO_TERMINAL_STATUS_LIST } from "@/lib/production/po-closeout";
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
import { processConsolidatedProductionOutputCommit } from "@/lib/db/queries/zoho-production-output-consolidated";
import type { ProductionOutputPreviewPayload } from "@/lib/zoho/production-output-preview";
import type { CurrentUser } from "@/lib/auth";

// Per-pass cap so a misbehaving DB or runaway buffer can't blow the
// request budget. The cron fires every 5 minutes; if more than this
// many rows are eligible, they'll roll over to the next pass.
const PER_PASS_LIMIT = 25;

// Synthetic actor for cron-triggered audit rows. Both id and role are
// null: audit_log.actor_id has a FK to users.id (inserting a
// non-existent UUID would violate it) and actor_role is the user_role
// Postgres enum (OWNER/ADMIN/MANAGER/LEAD/STAFF — "CRON" is not a
// member). Cron provenance is already carried by the audit action
// strings and can be identified by a null actor_id at query time.
export const CRON_ACTOR: Pick<CurrentUser, "id" | "role"> = {
  id: null as any,
  role: null as any,
};

// Synthetic CurrentUser-shaped object for production-output (the
// existing primitives require a full CurrentUser). id and role are
// null for the same reasons as CRON_ACTOR above: the zero-UUID would
// violate the audit_log.actor_id FK (no such row in users), and any
// role string must be a valid user_role enum member. All
// FK-constrained columns on zoho_production_output_ops that carry a
// user id (approved_by_user_id, commit_requested_by_user_id, etc.)
// are set by the human operator at approve/queue time — the cron
// commit path does not write actor.id to any op column.
const CRON_PRODUCTION_OUTPUT_ACTOR = {
  id: null,
  role: null,
  email: null,
  employeeId: null,
} as unknown as CurrentUser;

export type SweepOutcome =
  | "committed"
  | "needs_review"
  | "needs_mapping"
  | "transport_retryable"
  | "permanent_failure"
  | "state_blocked"
  | "skipped_guard_blocked"
  | "skipped_master_off"
  | "skipped_po_zoho_closed";

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

/** Result shape returned by the consolidated commit callable (dep injection). */
export type ConsolidatedProductionOutputCommitResult =
  | { ok: true; externalReferenceId: string | null }
  | { ok: false; reason: string; phase: "claim" | "gateway" | "complete" };

/** Injectable callable wrapping processConsolidatedProductionOutputCommit. */
export type ConsolidatedProductionOutputCommitCallable = (
  opId: string,
  actor: CurrentUser,
) => Promise<ConsolidatedProductionOutputCommitResult>;

export type AutoCommitSweepDependencies = {
  /** Inject these for tests; defaults call the real DB / commit fns. */
  loadRawBagEligible?: (now: Date, limit: number) => Promise<Array<{ id: string }>>;
  /** Returns eligible production-output op ids WITH their payload_kind so the
   *  sweep can route consolidated ops to the consolidated commit path. */
  loadProductionOutputEligible?: (
    now: Date,
    limit: number,
  ) => Promise<Array<{ id: string; payloadKind: string }>>;
  /** Returns the subset of production-output op ids whose PO is in a Zoho
   *  terminal state (received/closed/billed/cancelled — see ZOHO_TERMINAL_STATUSES
   *  in lib/production/po-closeout.ts). Those ops are skipped — pushing output
   *  to a closed Zoho PO fails on Zoho's side. */
  loadZohoClosedPoOpIds?: (opIds: string[]) => Promise<Set<string>>;
  commitRawBag?: typeof sharedCommitRawBagReceive;
  /** Legacy (non-consolidated) production-output commit path. */
  commitProductionOutput?: typeof sharedCommitProductionOutputOp;
  /** Consolidated production-output commit path. Defaults to
   *  processConsolidatedProductionOutputCommit. */
  commitConsolidatedProductionOutput?: ConsolidatedProductionOutputCommitCallable;
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
    .select({
      id: zohoProductionOutputOps.id,
      payloadKind: zohoProductionOutputOps.payloadKind,
    })
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.status, "QUEUED"),
        lte(zohoProductionOutputOps.autoCommitEligibleAt, now),
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

/** Default consolidated commit callable — wraps processConsolidatedProductionOutputCommit
 *  and normalises its result into the sweep's ConsolidatedProductionOutputCommitResult shape. */
const defaultCommitConsolidatedProductionOutput: ConsolidatedProductionOutputCommitCallable =
  async (opId, actor) => {
    const result = await processConsolidatedProductionOutputCommit(opId, actor);
    if (result.ok) {
      return {
        ok: true,
        externalReferenceId: result.op.externalReferenceId ?? null,
      };
    }
    return { ok: false, reason: result.error, phase: result.phase };
  };

async function defaultLoadZohoClosedPoOpIds(opIds: string[]): Promise<Set<string>> {
  if (opIds.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT op.id
    FROM zoho_production_output_ops op
    JOIN finished_lots fl ON fl.id = op.finished_lot_id
    JOIN workflow_bags wb ON wb.id = fl.workflow_bag_id
    JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    JOIN small_boxes sb ON sb.id = ib.small_box_id
    JOIN receives r ON r.id = sb.receive_id
    JOIN purchase_orders po ON po.id = r.po_id
    WHERE op.id IN (${sql.join(
      opIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND LOWER(TRIM(po.zoho_status)) IN (${sql.join(
        ZOHO_TERMINAL_STATUS_LIST.map((s) => sql`${s}`),
        sql`, `,
      )})
  `);
  return new Set(Array.from(rows).map((r) => r.id));
}

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
    skipped_po_zoho_closed: 0,
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

/** Map a consolidated commit result (simpler shape — no review/mapping
 *  classification; those blockers surface as claim-phase state_blocked) into
 *  the sweep's SweepOutcome buckets. */
function classifyConsolidatedCommitResult(
  result: ConsolidatedProductionOutputCommitResult,
): { outcome: SweepOutcome; detail: string | null } {
  if (result.ok) {
    return { outcome: "committed", detail: result.externalReferenceId };
  }
  // claim-phase failures map to state_blocked (op not in the right state,
  // commit gate off, etc.).  gateway/complete failures are permanent_failure
  // — human needs to investigate the Zoho response.
  if (result.phase === "claim") {
    return { outcome: "state_blocked", detail: result.reason };
  }
  return { outcome: "permanent_failure", detail: result.reason };
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

  const zohoClosedOpIds = await (deps.loadZohoClosedPoOpIds ?? defaultLoadZohoClosedPoOpIds)(
    poEligible.map((o) => o.id),
  );

  for (const { id, payloadKind } of poEligible) {
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
    if (zohoClosedOpIds.has(id)) {
      rows.push({
        surface: "production_output",
        opId: id,
        outcome: "skipped_po_zoho_closed",
        detail: "PO is closed in Zoho — output intentionally not pushed",
      });
      totals.skipped_po_zoho_closed += 1;
      continue;
    }

    // CONSOLIDATED-SWEEP-ROUTE-1: route by payload_kind so consolidated ops
    // never hit the legacy approval validation (status=APPROVED +
    // approvedRequestHash match) that they can never satisfy. Consolidated
    // ops carry status=QUEUED and no approvedRequestHash — they use their
    // own claim/commit path.
    if (payloadKind === "consolidated") {
      const commitConsolidated =
        deps.commitConsolidatedProductionOutput ?? defaultCommitConsolidatedProductionOutput;
      const result = await commitConsolidated(id, CRON_PRODUCTION_OUTPUT_ACTOR);
      const { outcome, detail } = classifyConsolidatedCommitResult(result);
      rows.push({ surface: "production_output", opId: id, outcome, detail });
      totals[outcome] += 1;
    } else {
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
