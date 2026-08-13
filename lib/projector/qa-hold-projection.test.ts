// P4b Task 4 fix round 1 (MED 1) — QA_HOLD_STARTED / QA_HOLD_RELEASED
// must actually flip read_bag_state.is_on_hold, or the BAG_ON_HOLD
// blocker (resolve-exceptions.ts) and the floor-board chip that read
// that column stay dark even though raiseQaHoldStarted recorded the
// hold. Same tx-stub style as event-input-accountability.test.ts, but
// carried past the duplicate-detection early-exit (a non-empty
// `.returning()`) so the actual read_bag_state branch runs.
//
// QA_HOLD_STARTED/QA_HOLD_RELEASED are neither in STAGE_FOR_EVENT,
// THROUGHPUT_COLUMN, QUEUE_REFRESH_EVENTS, bag-queue.ts's FLOW_EVENTS,
// nor QC_EVENT_TYPES (verified by reading each set before writing this
// stub) — so every OTHER branch in projectEvent's ~470-line body is a
// no-op for this event type, and a permissive chainable stub that
// defaults every terminal await to `[]` is enough to reach the end of
// the function without a fixture-driven integration harness.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import { projectEvent } from "./index";
import { readBagState } from "@/lib/db/schema";

const WORKFLOW_BAG_ID = "11111111-1111-4111-8111-111111111111";
const STATION_ID = "22222222-2222-4222-8222-222222222222";

/** A chain link that is itself a resolved Promise (so an `await` at
 *  any point in the chain — `.where()`, `.onConflictDoUpdate()`,
 *  `.returning()`, or none of the above — just works) AND carries
 *  every builder method drizzle might call next, each returning
 *  another one of these. `.returning()` is the one terminal that
 *  needs a non-empty row (the workflow_events insert's duplicate
 *  check); everything else defaults to `[]`, which is always a safe
 *  destructuring target (`const [row] = await ...` → row undefined). */
function chainable(value: unknown = []): any {
  const p: any = Promise.resolve(value);
  for (const m of [
    "values",
    "from",
    "where",
    "onConflictDoNothing",
    "onConflictDoUpdate",
    "orderBy",
    "limit",
  ]) {
    p[m] = (..._args: unknown[]) => chainable(value);
  }
  p.returning = () => Promise.resolve([{ id: "evt-1" }]);
  return p;
}

function buildTxStub() {
  const readBagStateUpdates: Array<Record<string, unknown>> = [];
  const tx = {
    insert: (_table: unknown) => chainable([]),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        if (table === readBagState) readBagStateUpdates.push(vals);
        return chainable([]);
      },
    }),
    select: (_cols: unknown) => chainable([]),
    execute: (_query: unknown) => Promise.resolve([]),
  } as unknown as Parameters<typeof projectEvent>[0];
  return { tx, readBagStateUpdates };
}

describe("projectEvent — QA_HOLD_STARTED / QA_HOLD_RELEASED pin read_bag_state.is_on_hold", () => {
  it("QA_HOLD_STARTED sets is_on_hold true", async () => {
    const { tx, readBagStateUpdates } = buildTxStub();
    await projectEvent(tx, {
      workflowBagId: WORKFLOW_BAG_ID,
      stationId: STATION_ID,
      eventType: "QA_HOLD_STARTED",
      payload: { detail: "Suspect foil seal on this run." },
    });
    expect(readBagStateUpdates).toHaveLength(1);
    expect(readBagStateUpdates[0]).toMatchObject({ isOnHold: true });
  });

  it("QA_HOLD_RELEASED sets is_on_hold false", async () => {
    const { tx, readBagStateUpdates } = buildTxStub();
    await projectEvent(tx, {
      workflowBagId: WORKFLOW_BAG_ID,
      stationId: STATION_ID,
      eventType: "QA_HOLD_RELEASED",
      payload: {},
    });
    expect(readBagStateUpdates).toHaveLength(1);
    expect(readBagStateUpdates[0]).toMatchObject({ isOnHold: false });
  });

  // P4b Task 4 fix round 2 (N1) — the full lifecycle a real bag goes
  // through: raiseQaHoldStarted's QA_HOLD_STARTED blocks it (claim-
  // queued-bag's BAG_ON_HOLD, station-view's bagOnHold, finished-lot-
  // release-eligibility's isOnHold check all read this SAME column),
  // then qc-panel.tsx's [ Release hold ] fires QA_HOLD_RELEASED and
  // clears it. Before N1, nothing emitted the second event anywhere —
  // this pins that the round-trip is a round-trip, not a one-way latch.
  it("started -> blocked, released -> clear: two events against one bag pin true then false, in order", async () => {
    const { tx, readBagStateUpdates } = buildTxStub();

    await projectEvent(tx, {
      workflowBagId: WORKFLOW_BAG_ID,
      stationId: STATION_ID,
      eventType: "QA_HOLD_STARTED",
      payload: { detail: "Suspect foil seal on this run." },
    });
    await projectEvent(tx, {
      workflowBagId: WORKFLOW_BAG_ID,
      stationId: STATION_ID,
      eventType: "QA_HOLD_RELEASED",
      payload: { detail: "Re-inspected, seal is fine." },
    });

    expect(readBagStateUpdates).toHaveLength(2);
    expect(readBagStateUpdates[0]).toMatchObject({ isOnHold: true });
    expect(readBagStateUpdates[1]).toMatchObject({ isOnHold: false });
  });
});
