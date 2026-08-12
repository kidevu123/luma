# Production Engine — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bags flow forward without operator release/finalize taps: a per-bag queue read model tells every station what is coming, auto-release covers all six station kinds, the bottle-route data conflict is resolved, and `advanceBag` becomes usable on every station kind.

**Architecture:** A new `read_bag_queue` read model (one row per active bag, maintained by the projector — folds-on-read stay forbidden outside the projector) describes each bag's next destination and readiness. A pure `queue-transitions` module decides row mutations per event; the projector applies them. Auto-release extends to bottle stations and the release/finalize buttons come off the floor UI — **this is Phase 2's operator-visible change.** `route_operations` gains `order_independent_group` to express BOTTLE-ORDER-FLEX-1 in data, closing the divergence pinned in `station-event-mapping.test.ts`.

**Tech Stack:** TypeScript strict, Next.js 15, Drizzle + Postgres 16, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md`
**P1 outcomes (read first):** `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md`

## Global Constraints

- No emoji anywhere in code, tests, comments, or CHANGELOG.
- TypeScript strict — `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` must pass.
- Test files colocated with source.
- **No database in the test suite** (`vitest.config.ts` excludes it by design). Every decision lives in a pure function with full coverage; thin DB wrappers are untested in-repo and verified by the staging smoke checklist. Do not mock `@/lib/db`.
- `workflow_events` is the source of truth; every mutation writes through `projectEvent`; money/qty as integers; soft-delete only.
- ~36 tests read source files as TEXT. Scanner assertions may change ONLY where behaviour intentionally changes in this plan (the button removals in Task 5); every scanner edit must be listed in the task report.
- The full suite currently passes 5346/0. It must stay at 0 failures after every task.
- `npm run typecheck && npm run lint` clean (lint: 0 errors; 80 boundary warnings are the pinned baseline — the ratchet test in `lib/production/engine/boundary.test.ts` must keep passing).
- Version: bump `package.json` `1.30.0` → `1.31.0` in Task 8 only; CHANGELOG header format is `## [1.31.0] — <YYYY-MM-DD>` (bracketed — `lib/version.contract.test.ts:117` enforces it).
- Do NOT push to remote — the controller pushes.

## Facts the implementer must know (verified against the repo)

- **Auto-release already exists** for BLISTER / HANDPACK_BLISTER / SEALING: `AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS` at `lib/production/engine/record-stage-event.ts:545`, applied by `maybeAutoReleaseAfterComplete` (guards: bag at the release stage, bag still pinned to this station; emits `BAG_RELEASED` with a `-auto-release` clientEventId suffix).
- **Packaging already auto-finalizes** when the bag is still pinned: `app/(floor)/floor/[token]/actions.ts:2746-2805` (`-auto-finalize` suffix). The manual finalize button is a fallback for the not-pinned edge.
- `read_queue_state` (`lib/projector/queue-state.ts`) is a per-STAGE aggregate for the floor board. It is NOT the per-bag queue this plan builds; do not modify it. Its header documents the ambiguity (`SEALING_QUEUE` vs `POST_BLISTER_STAGING`) that `read_bag_queue`'s claim tracking resolves.
- The projector's station-live handling: `BAG_RELEASED` clears the station slot, `BAG_PICKED_UP` (like any other stationed event) upserts it (`lib/projector/index.ts:400-440`). `BAG_FINALIZED` clears every slot.
- `pg_notify` payload today is `{eventType, workflowBagId, stationId, occurredAt}` (`lib/projector/index.ts:743-751`). Extending it is Phase 3 — do not touch it here.
- Next migration: file `0071_*.sql`, journal entry `{"idx": 70, "version": "7", "when": 1785000000000, "tag": "0071_<name>", "breakpoints": true}`. The journal's `idx` and `when` must both be strictly increasing (a previous defect here was fixed in `f455256`).
- `route_operations` has `UNIQUE(route_id, sequence)` (`drizzle/0013_route_operation_compat.sql:62`), so order-independence CANNOT be expressed by sharing a sequence number. Hence the new column.
- `rebuildQueueState` etc. are called from `scripts/rebuild-read-models.ts`; each read model has a `rebuild*` module under `lib/projector/`.

---

### Task 1: Migration 0071 — `read_bag_queue` + `order_independent_group`

**Files:**
- Create: `drizzle/0071_read_bag_queue_and_bottle_flex.sql`
- Modify: `drizzle/meta/_journal.json` — append the entry given below
- Modify: `lib/db/schema.ts` — add the table + column (anchor: after `readStationLive` ends at line 2813; column on the `routeOperations` table definition)

**Interfaces:**
- Produces: `readBagQueue` and `routeOperations.orderIndependentGroup` in `lib/db/schema.ts`, consumed by every later task.

- [ ] **Step 1: Write the migration**

Create `drizzle/0071_read_bag_queue_and_bottle_flex.sql`:

```sql
-- P2-QUEUE-1 — per-bag queue read model. One row per active workflow
-- bag describing its NEXT destination and whether it is ready to move.
-- Maintained exclusively by the projector (lib/projector/bag-queue.ts);
-- rebuilt by scripts/rebuild-read-models.ts. Complements (does not
-- replace) read_queue_state, which is a per-stage aggregate.
CREATE TABLE IF NOT EXISTS "read_bag_queue" (
  "workflow_bag_id" uuid PRIMARY KEY
    REFERENCES "workflow_bags"("id") ON DELETE CASCADE,
  -- Where the bag goes next: SEALING_QUEUE, PACKAGING_QUEUE,
  -- BOTTLE_STICKER_QUEUE, BOTTLE_INDUCTION_QUEUE, FINISHED_GOODS_QUEUE.
  "queue_stage_key" text NOT NULL,
  -- Station kinds that may claim it there. Usually one; both bottle
  -- finishing kinds while neither finishing step has run (BOTTLE-ORDER-FLEX-1).
  "eligible_station_kinds" text[] NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "product_name" text,
  "bag_label" text NOT NULL,
  -- READY: prerequisite stage reached, bag can be worked on arrival.
  -- UPSTREAM_RUNNING: visible for overlap scanning; Complete stays gated.
  "ready_state" text NOT NULL,
  -- The station currently holding the bag (mirrors read_station_live);
  -- NULL once released and waiting in the queue.
  "claimed_by_station_id" uuid REFERENCES "stations"("id") ON DELETE SET NULL,
  "ready_at" timestamptz,
  -- When work started at the upstream station — ETA math input.
  "upstream_started_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "read_bag_queue_stage_idx"
  ON "read_bag_queue" ("queue_stage_key", "ready_state");
CREATE INDEX IF NOT EXISTS "read_bag_queue_claimed_idx"
  ON "read_bag_queue" ("claimed_by_station_id")
  WHERE "claimed_by_station_id" IS NOT NULL;

-- P2-BOTTLE-FLEX-1 — express BOTTLE-ORDER-FLEX-1 in route data.
-- STICKERING (seq 3) and INDUCTION_SEAL (seq 4) on the BOTTLE route run
-- in either order after fill; sequence alone cannot say so because of
-- route_operations_seq_unique. Operations sharing a non-null group are
-- order-independent among themselves.
ALTER TABLE "route_operations"
  ADD COLUMN IF NOT EXISTS "order_independent_group" text;

UPDATE "route_operations" ro
SET "order_independent_group" = 'BOTTLE_FINISHING'
FROM "production_routes" r, "operation_types" o
WHERE ro."route_id" = r."id"
  AND ro."operation_type_id" = o."id"
  AND r."code" = 'BOTTLE'
  AND o."code" IN ('STICKERING', 'INDUCTION_SEAL');
```

- [ ] **Step 2: Append the journal entry**

In `drizzle/meta/_journal.json`, append after the idx-69 entry (comma-separate; keep valid JSON):

```json
{
  "idx": 70,
  "version": "7",
  "when": 1785000000000,
  "tag": "0071_read_bag_queue_and_bottle_flex",
  "breakpoints": true
}
```

- [ ] **Step 3: Add the Drizzle schema**

In `lib/db/schema.ts`, immediately after the `readStationLive` table (ends line 2813):

```ts
/** P2-QUEUE-1 — per-bag queue. One row per active workflow bag: where
 *  it goes next and whether it is ready. Maintained exclusively by the
 *  projector (lib/projector/bag-queue.ts). Not to be confused with
 *  read_queue_state, the per-stage aggregate. */
export const readBagQueue = pgTable(
  "read_bag_queue",
  {
    workflowBagId: uuid("workflow_bag_id")
      .primaryKey()
      .references(() => workflowBags.id, { onDelete: "cascade" }),
    queueStageKey: text("queue_stage_key").notNull(),
    eligibleStationKinds: text("eligible_station_kinds").array().notNull(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    productName: text("product_name"),
    bagLabel: text("bag_label").notNull(),
    readyState: text("ready_state").notNull(), // READY | UPSTREAM_RUNNING
    claimedByStationId: uuid("claimed_by_station_id").references(
      () => stations.id,
      { onDelete: "set null" },
    ),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    upstreamStartedAt: timestamp("upstream_started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("read_bag_queue_stage_idx").on(t.queueStageKey, t.readyState),
    index("read_bag_queue_claimed_idx")
      .on(t.claimedByStationId)
      .where(sql`claimed_by_station_id IS NOT NULL`),
  ],
);
```

And on the existing `routeOperations` table definition (search `export const routeOperations = pgTable`), add alongside its other columns:

```ts
    /** P2-BOTTLE-FLEX-1 — operations sharing a non-null group run in any
     *  order among themselves (BOTTLE_FINISHING: stickering + induction
     *  seal). Sequence remains the display/default order. */
    orderIndependentGroup: text("order_independent_group"),
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run lib/production/engine`
Expected: clean; 60+ engine tests still green. Note: `station-event-mapping.test.ts`'s divergence block asserts the migration-text of `0013` — migration `0071` does not edit `0013`, so those tests still pass; Task 6 retires them.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0071_read_bag_queue_and_bottle_flex.sql drizzle/meta/_journal.json lib/db/schema.ts
git commit -m "feat(queue): read_bag_queue read model and order_independent_group (migration 0071)"
```

---

### Task 2: Pure queue transitions

The heart of Phase 2. One pure function decides, for every workflow event, how the bag's queue row changes. The projector applies the decision; nothing else writes the table.

**Files:**
- Create: `lib/production/engine/queue-transitions.ts`
- Create: `lib/production/engine/queue-transitions.test.ts`
- Modify: `lib/production/engine/index.ts` — export `deriveQueueTransition`, `queueAfterWorkAt`, and the types below

**Interfaces:**
- Consumes: `bothBottleFinishingDone` from `@/lib/production/stage-progression`.
- Produces:

```ts
export type QueueDestination = {
  queueStageKey: string;
  eligibleStationKinds: string[];
};

export type QueueTransition =
  | { kind: "WORKING"; destination: QueueDestination; claimedByStationId: string }
  | { kind: "READY"; destination: QueueDestination }
  | { kind: "UNCLAIM" }
  | { kind: "REMOVE" }
  | { kind: "NONE" };

export function queueAfterWorkAt(args: {
  routeCode: string;               // CARD_BLISTER | BOTTLE | STICKER_ONLY
  stationKind: string;
  priorEventTypes: readonly string[]; // includes the current event when called on a completion
}): QueueDestination | null;

export function deriveQueueTransition(args: {
  eventType: string;
  stationId: string | null;
  stationKind: string | null;
  routeCode: string | null;
  priorEventTypes: readonly string[];
}): QueueTransition;
```

- [ ] **Step 1: Write the failing tests**

Create `lib/production/engine/queue-transitions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveQueueTransition, queueAfterWorkAt } from "./queue-transitions";

const CARD = { routeCode: "CARD_BLISTER" } as const;

describe("queueAfterWorkAt", () => {
  it("routes a card bag being blistered toward the sealing queue", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "BLISTER", priorEventTypes: [] }),
    ).toEqual({ queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] });
  });

  it("treats handpack-blister and combined as card first ops", () => {
    for (const stationKind of ["HANDPACK_BLISTER", "COMBINED"]) {
      const dest = queueAfterWorkAt({ ...CARD, stationKind, priorEventTypes: [] });
      // COMBINED finalizes in place, so its bag has no next queue.
      if (stationKind === "COMBINED") expect(dest).toBeNull();
      else expect(dest?.queueStageKey).toBe("SEALING_QUEUE");
    }
  });

  it("routes sealing work toward packaging", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "SEALING", priorEventTypes: [] })
        ?.queueStageKey,
    ).toBe("PACKAGING_QUEUE");
  });

  it("routes packaging work toward finished goods", () => {
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "PACKAGING", priorEventTypes: [] }),
    ).toEqual({
      queueStageKey: "FINISHED_GOODS_QUEUE",
      eligibleStationKinds: [],
    });
  });

  it("offers BOTH finishing kinds after bottle fill when neither has run", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_HANDPACK",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"],
    });
  });

  it("narrows to the remaining finishing kind after the first has run", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_CAP_SEAL",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_STICKER_QUEUE",
      eligibleStationKinds: ["BOTTLE_STICKER"],
    });
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_STICKER",
        priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_STICKER_COMPLETE"],
      }),
    ).toEqual({
      queueStageKey: "BOTTLE_INDUCTION_QUEUE",
      eligibleStationKinds: ["BOTTLE_CAP_SEAL"],
    });
  });

  it("routes to packaging once both finishing steps are done", () => {
    expect(
      queueAfterWorkAt({
        routeCode: "BOTTLE",
        stationKind: "BOTTLE_STICKER",
        priorEventTypes: [
          "BOTTLE_HANDPACK_COMPLETE",
          "BOTTLE_CAP_SEAL_COMPLETE",
          "BOTTLE_STICKER_COMPLETE",
        ],
      })?.queueStageKey,
    ).toBe("PACKAGING_QUEUE");
  });

  it("returns null for an unknown route or station kind", () => {
    expect(
      queueAfterWorkAt({ routeCode: "NOT_A_ROUTE", stationKind: "SEALING", priorEventTypes: [] }),
    ).toBeNull();
    expect(
      queueAfterWorkAt({ ...CARD, stationKind: "NOT_A_KIND", priorEventTypes: [] }),
    ).toBeNull();
  });
});

describe("deriveQueueTransition", () => {
  const base = {
    stationId: "st-1",
    stationKind: "BLISTER",
    routeCode: "CARD_BLISTER",
    priorEventTypes: [] as string[],
  };

  it("starts tracking when a bag is claimed at a first-op station", () => {
    for (const eventType of ["CARD_ASSIGNED", "BAG_CLAIMED"]) {
      const t = deriveQueueTransition({ ...base, eventType });
      expect(t).toEqual({
        kind: "WORKING",
        destination: { queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] },
        claimedByStationId: "st-1",
      });
    }
  });

  it("marks the bag READY when the stage completes", () => {
    const t = deriveQueueTransition({ ...base, eventType: "BLISTER_COMPLETE" });
    expect(t.kind).toBe("READY");
    if (t.kind === "READY") {
      expect(t.destination.queueStageKey).toBe("SEALING_QUEUE");
    }
  });

  it("advances the destination when the next station picks the bag up", () => {
    const t = deriveQueueTransition({
      ...base,
      stationKind: "SEALING",
      eventType: "BAG_PICKED_UP",
      priorEventTypes: ["CARD_ASSIGNED", "BLISTER_COMPLETE", "BAG_RELEASED"],
    });
    expect(t).toEqual({
      kind: "WORKING",
      destination: { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] },
      claimedByStationId: "st-1",
    });
  });

  it("unclaims on release and removes on finalize", () => {
    expect(deriveQueueTransition({ ...base, eventType: "BAG_RELEASED" })).toEqual({
      kind: "UNCLAIM",
    });
    expect(deriveQueueTransition({ ...base, eventType: "BAG_FINALIZED" })).toEqual({
      kind: "REMOVE",
    });
  });

  it("does nothing for non-flow events", () => {
    for (const eventType of ["BAG_PAUSED", "BAG_RESUMED", "OPERATOR_CHANGE", "MATERIAL_CONSUMED"]) {
      expect(deriveQueueTransition({ ...base, eventType })).toEqual({ kind: "NONE" });
    }
  });

  it("does nothing without a station or route where one is required", () => {
    expect(
      deriveQueueTransition({ ...base, stationId: null, eventType: "BAG_CLAIMED" }),
    ).toEqual({ kind: "NONE" });
    expect(
      deriveQueueTransition({ ...base, routeCode: null, eventType: "BLISTER_COMPLETE" }),
    ).toEqual({ kind: "NONE" });
  });

  it("keeps a bottle bag out of packaging until both finishing steps ran", () => {
    const afterFirst = deriveQueueTransition({
      stationId: "st-9",
      stationKind: "BOTTLE_CAP_SEAL",
      routeCode: "BOTTLE",
      eventType: "BOTTLE_CAP_SEAL_COMPLETE",
      priorEventTypes: ["BOTTLE_HANDPACK_COMPLETE", "BOTTLE_CAP_SEAL_COMPLETE"],
    });
    expect(afterFirst.kind).toBe("READY");
    if (afterFirst.kind === "READY") {
      expect(afterFirst.destination.queueStageKey).toBe("BOTTLE_STICKER_QUEUE");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/engine/queue-transitions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/production/engine/queue-transitions.ts`:

```ts
// P2-QUEUE-1 — pure queue-row decisions. The read_bag_queue row always
// describes a bag's NEXT destination; this module decides how each
// workflow event mutates it. The projector (lib/projector/bag-queue.ts)
// is the only writer.
//
// Route knowledge is a hardcoded table for the three seeded routes,
// mirroring drizzle/0013 + 0071. Phase 6 replaces it with a
// route_operations lookup once the data-driven path is universal.

import { bothBottleFinishingDone } from "@/lib/production/stage-progression";

export type QueueDestination = {
  queueStageKey: string;
  eligibleStationKinds: string[];
};

export type QueueTransition =
  | { kind: "WORKING"; destination: QueueDestination; claimedByStationId: string }
  | { kind: "READY"; destination: QueueDestination }
  | { kind: "UNCLAIM" }
  | { kind: "REMOVE" }
  | { kind: "NONE" };

/** Station kinds that begin tracking on CARD_ASSIGNED / BAG_CLAIMED. */
const START_EVENTS = new Set(["CARD_ASSIGNED", "BAG_CLAIMED"]);

/** Stage completions that flip the queue row to READY. */
const COMPLETION_EVENTS = new Set([
  "BLISTER_COMPLETE",
  "HANDPACK_BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
]);

const BOTTLE_FINISHING_KINDS = ["BOTTLE_STICKER", "BOTTLE_CAP_SEAL"] as const;

function bottleFinishingDestination(
  priorEventTypes: readonly string[],
): QueueDestination {
  const stickerDone = priorEventTypes.includes("BOTTLE_STICKER_COMPLETE");
  const capSealDone = priorEventTypes.includes("BOTTLE_CAP_SEAL_COMPLETE");
  if (bothBottleFinishingDone(priorEventTypes)) {
    return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
  }
  if (capSealDone) {
    return { queueStageKey: "BOTTLE_STICKER_QUEUE", eligibleStationKinds: ["BOTTLE_STICKER"] };
  }
  if (stickerDone) {
    return { queueStageKey: "BOTTLE_INDUCTION_QUEUE", eligibleStationKinds: ["BOTTLE_CAP_SEAL"] };
  }
  return {
    queueStageKey: "BOTTLE_STICKER_QUEUE",
    eligibleStationKinds: [...BOTTLE_FINISHING_KINDS],
  };
}

/** Where does a bag being worked at this station go next? Null when the
 *  station finalizes in place (no next queue) or inputs are unknown. */
export function queueAfterWorkAt(args: {
  routeCode: string;
  stationKind: string;
  priorEventTypes: readonly string[];
}): QueueDestination | null {
  const { routeCode, stationKind } = args;
  if (routeCode === "CARD_BLISTER") {
    if (stationKind === "BLISTER" || stationKind === "HANDPACK_BLISTER") {
      return { queueStageKey: "SEALING_QUEUE", eligibleStationKinds: ["SEALING"] };
    }
    if (stationKind === "SEALING") {
      return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    // COMBINED finalizes in place — no next queue.
    return null;
  }
  if (routeCode === "BOTTLE") {
    if (stationKind === "BOTTLE_HANDPACK") {
      return bottleFinishingDestination(args.priorEventTypes);
    }
    if (stationKind === "BOTTLE_STICKER" || stationKind === "BOTTLE_CAP_SEAL") {
      return bottleFinishingDestination(args.priorEventTypes);
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    return null;
  }
  if (routeCode === "STICKER_ONLY") {
    if (stationKind === "BOTTLE_STICKER") {
      return { queueStageKey: "PACKAGING_QUEUE", eligibleStationKinds: ["PACKAGING"] };
    }
    if (stationKind === "PACKAGING") {
      return { queueStageKey: "FINISHED_GOODS_QUEUE", eligibleStationKinds: [] };
    }
    return null;
  }
  return null;
}

export function deriveQueueTransition(args: {
  eventType: string;
  stationId: string | null;
  stationKind: string | null;
  routeCode: string | null;
  priorEventTypes: readonly string[];
}): QueueTransition {
  const { eventType } = args;

  if (eventType === "BAG_FINALIZED") return { kind: "REMOVE" };
  if (eventType === "BAG_RELEASED") return { kind: "UNCLAIM" };

  if (START_EVENTS.has(eventType) || eventType === "BAG_PICKED_UP") {
    if (!args.stationId || !args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt({
      routeCode: args.routeCode,
      stationKind: args.stationKind,
      priorEventTypes: args.priorEventTypes,
    });
    if (!destination) return { kind: "NONE" };
    return { kind: "WORKING", destination, claimedByStationId: args.stationId };
  }

  if (COMPLETION_EVENTS.has(eventType)) {
    if (!args.stationKind || !args.routeCode) return { kind: "NONE" };
    const destination = queueAfterWorkAt({
      routeCode: args.routeCode,
      stationKind: args.stationKind,
      priorEventTypes: args.priorEventTypes,
    });
    if (!destination) return { kind: "NONE" };
    return { kind: "READY", destination };
  }

  return { kind: "NONE" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/engine/queue-transitions.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Export, verify the suite, commit**

Add to `lib/production/engine/index.ts`:

```ts
export { deriveQueueTransition, queueAfterWorkAt } from "./queue-transitions";
export type { QueueDestination, QueueTransition } from "./queue-transitions";
```

Run: `npx vitest run lib/production/engine && npm run typecheck && npm run lint`

```bash
git add lib/production/engine/queue-transitions.ts lib/production/engine/queue-transitions.test.ts lib/production/engine/index.ts
git commit -m "feat(queue): pure queue transition decisions"
```

---

### Task 3: Projector applies queue transitions

**Files:**
- Create: `lib/projector/bag-queue.ts`
- Create: `lib/projector/bag-queue.test.ts` (pure helpers only)
- Modify: `lib/projector/index.ts` — call `applyBagQueueTransition` inside `projectEvent`, immediately BEFORE the pg_notify block at line ~738
- Modify: `scripts/rebuild-read-models.ts` — add `rebuildBagQueue`

**Interfaces:**
- Consumes: `deriveQueueTransition` (Task 2), `readBagQueue` (Task 1), `legacyProductKindToRoute` from `@/lib/production/routes`, `buildCurrentBagDisplayLabel` from `@/lib/production/current-bag-display-label`.
- Produces: `applyBagQueueTransition(tx, ev, occurredAt): Promise<void>` and `rebuildBagQueue(tx): Promise<{ rows: number }>`.

**Before writing:** read `lib/projector/index.ts:308-455` (the `projectEvent` body and station-live handling) and one existing rebuild module (`lib/projector/daily-throughput.ts`) for the established shapes. Match them.

- [ ] **Step 1: Write the DB module**

Create `lib/projector/bag-queue.ts`. The pure decision comes from the engine; this module only gathers inputs and applies the row mutation:

```ts
// P2-QUEUE-1 — read_bag_queue maintenance. The ONLY writer of the
// table. Decision logic is pure (lib/production/engine/queue-transitions);
// this module fetches the inputs and applies the mutation.

import { eq, sql } from "drizzle-orm";
import {
  inventoryBags,
  products,
  purchaseOrders,
  qrCards,
  readBagQueue,
  receives,
  smallBoxes,
  stations,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { deriveQueueTransition } from "@/lib/production/engine/queue-transitions";
import { legacyProductKindToRoute } from "@/lib/production/routes";
import { buildCurrentBagDisplayLabel } from "@/lib/production/current-bag-display-label";
import type { Tx } from "./types"; // match the Tx alias projector modules use — read a sibling module for the exact import

/** Bottle-ish station kinds imply the BOTTLE route when the bag has no
 *  product yet (handpack picks the product later in some flows). */
const BOTTLE_STATION_KINDS = new Set([
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
]);

export function resolveRouteCodeForQueue(args: {
  productKind: string | null;
  stationKind: string | null;
}): string | null {
  const fromProduct = legacyProductKindToRoute(args.productKind);
  if (fromProduct) return fromProduct;
  if (args.stationKind && BOTTLE_STATION_KINDS.has(args.stationKind)) return "BOTTLE";
  if (args.stationKind) return "CARD_BLISTER";
  return null;
}

export async function applyBagQueueTransition(
  tx: Tx,
  ev: {
    workflowBagId: string;
    stationId?: string | null;
    eventType: string;
  },
  occurredAt: Date,
): Promise<void> {
  // Cheap pre-filter: only flow events matter. deriveQueueTransition
  // re-checks; this just avoids the queries for the common case.
  const FLOW_EVENTS = new Set([
    "CARD_ASSIGNED", "BAG_CLAIMED", "BAG_PICKED_UP", "BAG_RELEASED",
    "BAG_FINALIZED", "BLISTER_COMPLETE", "HANDPACK_BLISTER_COMPLETE",
    "SEALING_COMPLETE", "BOTTLE_HANDPACK_COMPLETE",
    "BOTTLE_CAP_SEAL_COMPLETE", "BOTTLE_STICKER_COMPLETE",
  ]);
  if (!FLOW_EVENTS.has(ev.eventType)) return;

  const stationKind = ev.stationId
    ? (
        await tx
          .select({ kind: stations.kind })
          .from(stations)
          .where(eq(stations.id, ev.stationId))
      )[0]?.kind ?? null
    : null;

  const [bagRow] = await tx
    .select({
      productId: workflowBags.productId,
      productKind: products.kind,
      productName: products.name,
      bagNumber: workflowBags.bagNumber,
      cardLabel: qrCards.label,
      inventoryBagNumber: inventoryBags.bagNumber,
      tabletTypeName: tabletTypes.name,
      poNumber: purchaseOrders.poNumber,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .where(eq(workflowBags.id, ev.workflowBagId));
  if (!bagRow) return;

  const priorEventTypes = (
    await tx
      .select({ eventType: workflowEvents.eventType })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, ev.workflowBagId))
  ).map((r) => r.eventType);

  const transition = deriveQueueTransition({
    eventType: ev.eventType,
    stationId: ev.stationId ?? null,
    stationKind,
    routeCode: resolveRouteCodeForQueue({
      productKind: bagRow.productKind ?? null,
      stationKind,
    }),
    priorEventTypes,
  });

  if (transition.kind === "NONE") return;
  if (transition.kind === "REMOVE") {
    await tx.delete(readBagQueue).where(eq(readBagQueue.workflowBagId, ev.workflowBagId));
    return;
  }
  if (transition.kind === "UNCLAIM") {
    await tx
      .update(readBagQueue)
      .set({ claimedByStationId: null, updatedAt: occurredAt })
      .where(eq(readBagQueue.workflowBagId, ev.workflowBagId));
    return;
  }

  const label = buildCurrentBagDisplayLabel({
    cardLabel: bagRow.cardLabel ?? null,
    poNumber: bagRow.poNumber ?? null,
    tabletTypeName: bagRow.tabletTypeName ?? null,
    productName: bagRow.productName ?? null,
    inventoryBagNumber: bagRow.inventoryBagNumber ?? null,
    workflowBagNumber: bagRow.bagNumber ?? null,
  });

  const common = {
    queueStageKey: transition.destination.queueStageKey,
    eligibleStationKinds: transition.destination.eligibleStationKinds,
    productId: bagRow.productId ?? null,
    productName: bagRow.productName ?? null,
    bagLabel: label.primary,
    updatedAt: occurredAt,
  };

  if (transition.kind === "WORKING") {
    await tx
      .insert(readBagQueue)
      .values({
        workflowBagId: ev.workflowBagId,
        ...common,
        readyState: "UPSTREAM_RUNNING",
        claimedByStationId: transition.claimedByStationId,
        readyAt: null,
        upstreamStartedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: readBagQueue.workflowBagId,
        set: {
          ...common,
          readyState: "UPSTREAM_RUNNING",
          claimedByStationId: transition.claimedByStationId,
          readyAt: null,
          upstreamStartedAt: occurredAt,
        },
      });
    return;
  }

  // READY
  await tx
    .insert(readBagQueue)
    .values({
      workflowBagId: ev.workflowBagId,
      ...common,
      readyState: "READY",
      claimedByStationId: null,
      readyAt: occurredAt,
      upstreamStartedAt: null,
    })
    .onConflictDoUpdate({
      target: readBagQueue.workflowBagId,
      set: {
        ...common,
        readyState: "READY",
        readyAt: occurredAt,
        // Completion does not unclaim — release does. Keep claimed_by.
        // Keep upstream_started_at for cycle-time math.
      },
    });
}

/** Full rebuild: wipe and replay every non-finalized bag's events in
 *  order through the same transition logic. */
export async function rebuildBagQueue(tx: Tx): Promise<{ rows: number }> {
  await tx.execute(sql`DELETE FROM read_bag_queue;`);
  const events = await tx
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      stationId: workflowEvents.stationId,
      eventType: workflowEvents.eventType,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .orderBy(workflowEvents.occurredAt);
  for (const ev of events) {
    await applyBagQueueTransition(tx, ev, ev.occurredAt);
  }
  const [count] = (await tx.execute(
    sql`SELECT count(*)::int AS n FROM read_bag_queue;`,
  )) as unknown as { n: number }[];
  return { rows: count?.n ?? 0 };
}
```

NOTE on the `Tx` type: projector modules each declare or import a transaction type — read `lib/projector/queue-state.ts:30` (`type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0]`) and use the same pattern. Do not invent a new one. NOTE on `priorEventTypes`: `applyBagQueueTransition` runs inside `projectEvent` AFTER the event row is inserted, so the query already includes the current event — which is exactly what `queueAfterWorkAt` expects on completions.

- [ ] **Step 2: Write pure tests for `resolveRouteCodeForQueue`**

Create `lib/projector/bag-queue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveRouteCodeForQueue } from "./bag-queue";

describe("resolveRouteCodeForQueue", () => {
  it("prefers the product kind when present", () => {
    expect(resolveRouteCodeForQueue({ productKind: "BOTTLE", stationKind: "BLISTER" })).toBe("BOTTLE");
    expect(resolveRouteCodeForQueue({ productKind: "CARD", stationKind: "BOTTLE_STICKER" })).toBe("CARD_BLISTER");
    expect(resolveRouteCodeForQueue({ productKind: "VARIETY", stationKind: null })).toBe("CARD_BLISTER");
  });

  it("falls back to the station family when the product is not chosen yet", () => {
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: "BOTTLE_HANDPACK" })).toBe("BOTTLE");
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: "HANDPACK_BLISTER" })).toBe("CARD_BLISTER");
  });

  it("returns null with nothing to go on", () => {
    expect(resolveRouteCodeForQueue({ productKind: null, stationKind: null })).toBeNull();
  });
});
```

Run: `npx vitest run lib/projector/bag-queue.test.ts` — expect FAIL before the module exists, PASS after.

- [ ] **Step 3: Wire into `projectEvent`**

In `lib/projector/index.ts`, immediately BEFORE the `// 4. pg_notify` comment block (line ~738):

```ts
  // P2-QUEUE-1 — maintain the per-bag queue row. Must run before
  // pg_notify so SSE subscribers re-reading the queue see fresh rows.
  await applyBagQueueTransition(tx, ev, occurredAt);
```

Add the import at the top with the other projector imports. CAUTION: `projectEvent` has source-text scanner tests (`op-1-invariant-scanner`); adding a call is fine, but run the full suite and report any scanner that reacts.

- [ ] **Step 4: Wire into the rebuild script**

In `scripts/rebuild-read-models.ts`, following the existing pattern of the other `rebuild*` calls (read the file; each prints a one-line summary):

```ts
const bagQueueResult = await rebuildBagQueue(tx);
console.log(`[rebuild-read-models]   read_bag_queue rows=${bagQueueResult.rows}`);
```

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: full suite 0 failures.

```bash
git add lib/projector/bag-queue.ts lib/projector/bag-queue.test.ts lib/projector/index.ts scripts/rebuild-read-models.ts
git commit -m "feat(queue): projector maintains read_bag_queue; rebuild support"
```

---

### Task 4: Auto-release for bottle stations

**Files:**
- Modify: `lib/production/engine/record-stage-event.ts:545-549` — extend the set
- Modify: `app/(floor)/floor/[token]/actions.test.ts` / `stage-action-buttons.test.ts` — ONLY if a scanner reacts (list every edit)

**Interfaces:**
- Consumes: `STATION_RELEASE_FROM_STAGE` (already imported there).
- Produces: no new exports — behaviour: every completion at every station kind auto-releases when the bag reached its release stage.

- [ ] **Step 1: Extend the set**

In `lib/production/engine/record-stage-event.ts:545`:

```ts
/** Stations that auto-release on complete — no second operator tap.
 *  P2-QUEUE-1 completes the set: bottle fill and both finishing
 *  stations now release automatically too. STATION_RELEASE_FROM_STAGE
 *  supplies the stage each kind releases at, and the stage guard in
 *  maybeAutoReleaseAfterComplete keeps a first finishing step from
 *  releasing before the bag actually reached SEALED. */
const AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
]);
```

- [ ] **Step 2: Extend the dispatch condition**

The `else if` at `record-stage-event.ts:495-499` gates which events even attempt auto-release. Extend it to the bottle completions:

```ts
      } else if (
        eventType === "HANDPACK_BLISTER_COMPLETE" ||
        (eventType === "BLISTER_COMPLETE" && station.kind === "BLISTER") ||
        (isSealingFinal && station.kind === "SEALING") ||
        eventType === "BOTTLE_HANDPACK_COMPLETE" ||
        eventType === "BOTTLE_CAP_SEAL_COMPLETE" ||
        eventType === "BOTTLE_STICKER_COMPLETE"
      ) {
```

The stage guard inside `maybeAutoReleaseAfterComplete` (`afterComplete.stage !== releaseAtStage`) makes the first bottle finishing step release at SEALED (bag travels to the other finishing station) and bottle fill release at BLISTERED — both correct destinations per `STATION_PICKUP_FROM_STAGE`.

- [ ] **Step 3: Verify against the whole suite**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: 0 failures. `actions.test.ts` scanners splice `record-stage-event.ts` into their scanned text — if any ordering probe reacts, the fix is to the probe's source-loading only, never an assertion; list every touched scanner in the report.

- [ ] **Step 4: Commit**

```bash
git add lib/production/engine/record-stage-event.ts
git commit -m "feat(queue): auto-release covers bottle fill and finishing stations"
```

---

### Task 5: Remove the release and finalize buttons (the visible change)

**Files:**
- Modify: `app/(floor)/floor/[token]/stage-action-buttons.tsx` (release button ~line 455, finalize ~line 443, sealing handoff stays)
- Modify: `app/(floor)/floor/[token]/stage-action-buttons.test.ts` — scanner assertions that legitimately pinned the removed buttons
- Modify: `app/(floor)/floor/[token]/page.test.ts` / `actions.test.ts` — only if scanners react

**Interfaces:** none new. `releaseBagAction`, `releaseSealingHandoffAction`, `finalizeBagAction` REMAIN exported from `actions.ts` (P2-PARTIAL-KEEP manual fallback and Phase 5 supervisor tools still reference the logic; Phase 4/6 retire them).

**What goes and what stays:**
- REMOVE the generic "Release to next stage" button — auto-release now covers all six kinds.
- REMOVE the "Finalize" button from the normal flow EXCEPT the not-pinned fallback: keep rendering it ONLY when `stage === "PACKAGED"` and the bag is NOT current at this station's `read_station_live` (the case auto-finalize cannot reach, per `actions.ts:2746-2751`). Read the existing render conditions first and preserve that narrow case with a comment.
- KEEP the sealing handoff button (`releaseSealingHandoffAction`) — moving a partially-sealed bag to another sealer is a physical operator decision the system cannot infer (MULTI-SEALING-SAME-BAG-1).

- [ ] **Step 1: Read the render sites**

Read `app/(floor)/floor/[token]/stage-action-buttons.tsx:430-480` and locate every render path that shows Release / Finalize. Map which conditions render them before editing — the component is 2,010 lines and the buttons appear in per-kind sections.

- [ ] **Step 2: Remove / narrow the buttons**

Delete the generic release button JSX and its handler wiring. Narrow finalize per above. Remove now-unused imports (`releaseBagAction` import goes if no render path remains; keep `finalizeBagAction` for the fallback).

- [ ] **Step 3: Update the legitimately-affected scanners**

Run: `npx vitest run "app/(floor)"`
Scanners that asserted "release button renders after stage event" now fail FOR THE RIGHT REASON — the behaviour intentionally changed. Update those assertions to pin the new behaviour (button absent; auto-release text if any). Any scanner failing for a DIFFERENT reason is a bug in your edit — fix the edit, not the scanner. List every assertion change in the report with a one-line justification each.

- [ ] **Step 4: Verify everything**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run build`
Expected: 0 failures, build green.

- [ ] **Step 5: Commit**

```bash
git add "app/(floor)/floor/[token]/stage-action-buttons.tsx" "app/(floor)/floor/[token]/stage-action-buttons.test.ts"
git commit -m "feat(floor): remove release and finalize buttons; auto-advance covers the flow"
```

(Include any other scanner files actually touched.)

---

### Task 6: Resolve the bottle divergence in the engine

**Files:**
- Modify: `lib/production/routes.ts` — `RouteOperationView` gains `orderIndependentGroup`
- Modify: `lib/production/engine/station-event-mapping.test.ts` — DELETE the two divergence-pin tests (their own comment says to delete them when Phase 2 resolves the conflict) and replace with a group-aware assertion
- Modify: `lib/production/engine/resolve-operation.ts` — no behaviour change needed (station-kind lookup is order-agnostic), but extend the header comment to state that ordering questions must consult `orderIndependentGroup`

**Interfaces:**
- Produces: `RouteOperationView.orderIndependentGroup: string | null` — selected in `getRouteOperations`.

- [ ] **Step 1: Extend the view type and query**

In `lib/production/routes.ts`, add to `RouteOperationView` (line ~95):

```ts
  /** P2-BOTTLE-FLEX-1 — operations sharing a non-null group run in any
   *  order among themselves. Null for strictly-sequenced operations. */
  orderIndependentGroup: string | null;
```

And add to the `getRouteOperations` select (line ~166): `orderIndependentGroup: routeOperations.orderIndependentGroup,`.

- [ ] **Step 2: Replace the divergence pin**

In `lib/production/engine/station-event-mapping.test.ts`, delete the two tests in the divergence block (they instruct their own deletion) and add:

```ts
describe("bottle finishing order-independence (P2-BOTTLE-FLEX-1)", () => {
  it("the seeded BOTTLE route marks stickering and induction seal as one group", () => {
    // Migration 0071 sets order_independent_group = 'BOTTLE_FINISHING'
    // on exactly these two operations. The fixture mirrors the seed;
    // the migration-text guard below keeps the mirror honest.
    const sql = readFileSync(
      join(process.cwd(), "drizzle", "0071_read_bag_queue_and_bottle_flex.sql"),
      "utf8",
    );
    expect(sql).toContain("'BOTTLE_FINISHING'");
    expect(sql).toMatch(/'STICKERING',\s*'INDUCTION_SEAL'/);
  });

  it("code and data now agree: both finishing stations accept both entry stages", () => {
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_CAP_SEAL).toEqual(["BLISTERED", "SEALED"]);
    expect(STATION_PICKUP_FROM_STAGE.BOTTLE_STICKER).toEqual(["BLISTERED", "SEALED"]);
  });
});
```

(Import `STATION_PICKUP_FROM_STAGE` from `@/lib/production/stage-progression`; `readFileSync`/`join` are already imported in this file.)

Also update the file's header comment: the "known divergence" paragraph becomes a short note that the conflict was resolved by migration 0071 and where the group lives. Update any `RouteOperationView` fixture literals in engine tests (`resolve-operation.test.ts`, `resolve-completion.test.ts`, `station-view.test.ts`, `station-event-mapping.test.ts`) to include `orderIndependentGroup: null` so the type stays satisfied.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run lib/production && npm run typecheck && npm run lint`

```bash
git add lib/production/routes.ts lib/production/engine/station-event-mapping.test.ts \
        lib/production/engine/resolve-operation.ts lib/production/engine/resolve-operation.test.ts \
        lib/production/engine/resolve-completion.test.ts lib/production/engine/station-view.test.ts
git commit -m "feat(routes): order_independent_group resolves the bottle divergence"
```

---

### Task 7: `advanceBag` preconditions + `upNext` with ETA

Closes every item in the outcomes doc's "advanceBag cannot succeed" list, and populates `StationView.upNext` from the queue.

**Files:**
- Modify: `lib/production/engine/types.ts` — `AdvanceInput.inputs` gains `counterPresses?: number`
- Modify: `lib/production/engine/advance.ts` — `intentToEventType` gains a `stationKind` parameter; `buildRecordStageEventInput` passes `counterPresses`; `CLAIM` intent routes to `claimQueuedBag`; the Phase-2-preconditions block comment shrinks to what remains
- Create: `lib/production/engine/claim-queued-bag.ts` + colocated test (pure guard separated from the DB write)
- Create: `lib/production/engine/eta.ts` + colocated test
- Modify: `lib/production/engine/station-view.ts` — `getStationView` loads queue rows + ETA; `assembleStationView` maps them into `UpNextBag[]` and `SCAN_TO_CLAIM.expected`
- Modify: `lib/production/engine/advance.test.ts`, `station-view.test.ts`, `station-event-mapping.test.ts` — signature updates + new cases
- Modify: `lib/production/engine/index.ts` — new exports

**Interfaces:**
- Produces:

```ts
// advance.ts
export function intentToEventType(
  intent: AdvanceIntent,
  operationCode: string,
  stationKind: string,
): string | null;
// HANDPACK_BLISTER + COMPLETE -> "HANDPACK_BLISTER_COMPLETE" (the alias fix)

// claim-queued-bag.ts
export type ClaimGuardInput = {
  stationKind: string;
  queueRow: {
    eligibleStationKinds: readonly string[];
    claimedByStationId: string | null;
    readyState: string;
  } | null;
  bagStage: string | null;
  isPaused: boolean;
  isFinalized: boolean;
};
export function checkClaimGuards(input: ClaimGuardInput): Blocker | null;
export async function claimQueuedBag(input: {
  stationId: string;
  workflowBagId: string;
  clientEventId: string;
}): Promise<{ ok: true } | { ok: false; blocker: Blocker }>;

// eta.ts
export function medianCycleMinutes(samples: readonly number[]): number | null; // null under 5 samples
export function etaMinutes(args: {
  medianMinutes: number | null;
  upstreamStartedAt: Date | null;
  now: Date;
}): number | null; // max(0, median - elapsed); null when either input missing
```

- [ ] **Step 1: Failing tests for the pure parts**

Add to `lib/production/engine/advance.test.ts` (updating every existing `intentToEventType` call to the three-arg form; existing behaviour must not change for the six original kinds):

```ts
it("maps COMPLETE at a handpack-blister station to its own event, not the alias's", () => {
  expect(intentToEventType("COMPLETE", "BLISTER", "HANDPACK_BLISTER")).toBe(
    "HANDPACK_BLISTER_COMPLETE",
  );
});

it("carries counterPresses through to the record input", () => {
  const out = buildRecordStageEventInput({
    station: STATION,
    workflowBagId: "bag-1",
    eventType: "SEALING_SEGMENT_COMPLETE",
    inputs: { counterPresses: 8 },
    clientEventId: "cid-1",
  });
  expect(out.counterPresses).toBe(8);
});
```

Create `lib/production/engine/claim-queued-bag.test.ts` covering `checkClaimGuards`:

```ts
import { describe, it, expect } from "vitest";
import { checkClaimGuards } from "./claim-queued-bag";

const ROW = {
  eligibleStationKinds: ["SEALING"],
  claimedByStationId: null,
  readyState: "READY",
};

describe("checkClaimGuards", () => {
  it("allows an eligible unclaimed READY bag", () => {
    expect(
      checkClaimGuards({
        stationKind: "SEALING",
        queueRow: ROW,
        bagStage: "BLISTERED",
        isPaused: false,
        isFinalized: false,
      }),
    ).toBeNull();
  });

  it("allows the overlap claim while upstream still runs, per pickup rules", () => {
    expect(
      checkClaimGuards({
        stationKind: "SEALING",
        queueRow: { ...ROW, readyState: "UPSTREAM_RUNNING" },
        bagStage: "STARTED", // STATION_PICKUP_FROM_STAGE.SEALING includes STARTED
        isPaused: false,
        isFinalized: false,
      }),
    ).toBeNull();
  });

  it("rejects a station kind the queue row does not list", () => {
    const b = checkClaimGuards({
      stationKind: "PACKAGING",
      queueRow: ROW,
      bagStage: "BLISTERED",
      isPaused: false,
      isFinalized: false,
    });
    expect(b?.code).toBe("OPERATION_UNRESOLVED");
  });

  it("rejects a bag already claimed by another station", () => {
    const b = checkClaimGuards({
      stationKind: "SEALING",
      queueRow: { ...ROW, claimedByStationId: "other-station" },
      bagStage: "BLISTERED",
      isPaused: false,
      isFinalized: false,
    });
    expect(b).not.toBeNull();
    expect(b?.operatorSentence).not.toMatch(/BLISTERED|QUEUE|_COMPLETE/);
  });

  it("rejects a stage the pickup table does not allow", () => {
    const b = checkClaimGuards({
      stationKind: "PACKAGING",
      queueRow: { ...ROW, eligibleStationKinds: ["PACKAGING"] },
      bagStage: "STARTED", // packaging picks up at BLISTERED or SEALED only
      isPaused: false,
      isFinalized: false,
    });
    expect(b?.code).toBe("UPSTREAM_INCOMPLETE");
  });

  it("rejects paused, finalized, and unknown bags with the catalogue blockers", () => {
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED", isPaused: true, isFinalized: false })?.code,
    ).toBe("BAG_PAUSED");
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: ROW, bagStage: "BLISTERED", isPaused: false, isFinalized: true })?.code,
    ).toBe("BAG_FINALIZED");
    expect(
      checkClaimGuards({ stationKind: "SEALING", queueRow: null, bagStage: null, isPaused: false, isFinalized: false })?.code,
    ).toBe("BAG_UNRECOGNIZED");
  });
});
```

Create `lib/production/engine/eta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { medianCycleMinutes, etaMinutes } from "./eta";

describe("medianCycleMinutes", () => {
  it("returns the median of enough samples", () => {
    expect(medianCycleMinutes([10, 4, 6, 8, 12])).toBe(8);
  });
  it("averages the middle pair for even counts", () => {
    expect(medianCycleMinutes([4, 6, 8, 10, 12, 14])).toBe(9);
  });
  it("refuses to guess from fewer than five samples", () => {
    expect(medianCycleMinutes([5, 5, 5, 5])).toBeNull();
    expect(medianCycleMinutes([])).toBeNull();
  });
});

describe("etaMinutes", () => {
  const now = new Date("2026-08-12T12:10:00Z");
  it("subtracts elapsed upstream time from the median", () => {
    expect(
      etaMinutes({ medianMinutes: 14, upstreamStartedAt: new Date("2026-08-12T12:00:00Z"), now }),
    ).toBe(4);
  });
  it("clamps at zero when the median is already exceeded", () => {
    expect(
      etaMinutes({ medianMinutes: 5, upstreamStartedAt: new Date("2026-08-12T12:00:00Z"), now }),
    ).toBe(0);
  });
  it("returns null when either input is missing", () => {
    expect(etaMinutes({ medianMinutes: null, upstreamStartedAt: new Date(), now })).toBeNull();
    expect(etaMinutes({ medianMinutes: 10, upstreamStartedAt: null, now })).toBeNull();
  });
});
```

Run all three new/updated test files — expect failures for the right reasons.

- [ ] **Step 2: Implement**

`eta.ts`:

```ts
// P2-QUEUE-1 — honest ETA. Median of recent same-product same-kind
// cycle times minus elapsed upstream time. Under five samples we say
// nothing rather than guessing (UpNextBag.etaMinutes stays null and the
// UI omits the line).

export function medianCycleMinutes(samples: readonly number[]): number | null {
  if (samples.length < 5) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return median ?? null;
}

export function etaMinutes(args: {
  medianMinutes: number | null;
  upstreamStartedAt: Date | null;
  now: Date;
}): number | null {
  if (args.medianMinutes == null || args.upstreamStartedAt == null) return null;
  const elapsedMin = (args.now.getTime() - args.upstreamStartedAt.getTime()) / 60_000;
  return Math.max(0, Math.round(args.medianMinutes - elapsedMin));
}
```

`claim-queued-bag.ts` — `checkClaimGuards` is pure and uses `STATION_PICKUP_FROM_STAGE` + `blockerFor` from `resolve-exceptions.ts` (BAG_UNRECOGNIZED / OPERATION_UNRESOLVED / BAG_PAUSED / BAG_FINALIZED / UPSTREAM_INCOMPLETE); the already-claimed case needs a new literal blocker (`code: "BAG_ALREADY_CLAIMED"`, operator sentence "Another station is already working on this bag." — follow the `NON_CHECKLIST_BLOCKERS` pattern in `resolve-exceptions.ts:107`). `claimQueuedBag` is the thin DB half: load queue row + `read_bag_state` + station kind, run `checkClaimGuards`, then inside `db.transaction` resolve accountability (`resolveStationAccountability`) and `projectEvent` a `BAG_PICKED_UP` with the given `clientEventId`. The projector (Task 3) claims the queue row as a side effect — do not write `read_bag_queue` here. Untested in-repo by convention; add both smoke items in Task 8.

`advance.ts` — `intentToEventType(intent, operationCode, stationKind)`: inside the `COMPLETE` branch, before the operation-code table, `if (stationKind === "HANDPACK_BLISTER") return "HANDPACK_BLISTER_COMPLETE";`. In `advanceBagInner`, the `CLAIM` intent short-circuits to `claimQueuedBag` before `recordStageEvent` (return its blocker or the refreshed view). `buildRecordStageEventInput` adds `...(args.inputs.counterPresses != null ? { counterPresses: args.inputs.counterPresses } : {})`. Shrink the preconditions block comment to what genuinely remains (packaging three-way counts and damaged; the dropped partial-close fields — Phase 4).

`station-view.ts` — `getStationView` additionally loads, for the station's kind:

```ts
  const queueRows = await db
    .select()
    .from(readBagQueue)
    .where(
      and(
        sql`${stationRow.station.kind} = ANY(${readBagQueue.eligibleStationKinds})`,
        isNull(readBagQueue.claimedByStationId),
      ),
    )
    .orderBy(sql`${readBagQueue.readyState} = 'READY' DESC`, readBagQueue.readyAt)
    .limit(5);
```

plus a median-cycle loader: recent completed cycles for (productId, stationKind) measured as `occurredAt(*_COMPLETE) - occurredAt(BAG_PICKED_UP | CARD_ASSIGNED | BAG_CLAIMED)` per bag over the last 20 bags — write it as one SQL statement, and keep every decision (ordering, null ETA, mapping to `UpNextBag`) in a new pure `mapQueueRowsToUpNext(rows, medianByProduct, now)` that `assembleStationView` consumes via a widened `StationViewRows.upNext` input. Test the pure mapper in `station-view.test.ts` (READY sorts before UPSTREAM_RUNNING; ETA only on UPSTREAM_RUNNING rows with data; `expected` = first row for `SCAN_TO_CLAIM`).

- [ ] **Step 3: Update the mapping-pin tests**

`station-event-mapping.test.ts` uses two-arg `intentToEventType` — update calls to pass the station kind, and ADD the two rows the file's own review noted missing now that the alias is fixed:

```ts
["HANDPACK_BLISTER", "CARD_BLISTER", "HANDPACK_BLISTER_COMPLETE"],
["COMBINED", "CARD_BLISTER", "BLISTER_COMPLETE"],
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: 0 failures.

```bash
git add lib/production/engine
git commit -m "feat(engine): claimable queue, counterPresses, handpack alias fix, upNext with honest ETA"
```

---

### Task 8: Version, CHANGELOG, smoke checklist, outcomes update

**Files:**
- Modify: `package.json` — `1.30.0` → `1.31.0`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-08-11-production-engine-p1-staging-smoke.md` — add the P2 section below
- Modify: `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md` — mark resolved preconditions

- [ ] **Step 1: CHANGELOG**

Prepend (bracketed format is enforced by `lib/version.contract.test.ts`):

```markdown
## [1.31.0] — <today's date>

- Phase 2 of the production engine: per-bag queue read model (read_bag_queue), auto-release extended to bottle stations, release/finalize buttons removed from the floor (auto-advance covers the flow; sealing handoff and the not-pinned finalize fallback remain), bottle finishing order-independence expressed in route data (order_independent_group), advanceBag usable on all station kinds, and stations now see what is coming (upNext with median-based ETA).
```

- [ ] **Step 2: Staging smoke additions**

Append to the smoke checklist:

```markdown
## Phase 2 (v1.31.0) — queue and auto-advance

- [ ] Complete a blister bag: NO release button appears; the bag shows on a
      sealing tablet's queue as READY without any operator action.
- [ ] Scan-claim while upstream still runs (overlap): sealing can claim a
      STARTED bag; Complete stays blocked until blister finishes.
- [ ] Bottle fill complete: bag auto-releases; BOTH finishing stations see it
      queued. After one finishing step, only the other station sees it.
- [ ] Packaging complete on a pinned bag: finalizes with no button; the
      queue row disappears.
- [ ] The not-pinned finalize fallback still renders for a PACKAGED bag that
      is no longer current at the station.
- [ ] Sealing handoff button still present mid-bag (multi-sealer flow).
- [ ] `npm run rebuild:read-models` repopulates read_bag_queue to the same
      rows (spot-check one bag before/after).
- [ ] claimQueuedBag double-tap: same clientEventId twice -> one BAG_PICKED_UP.
- [ ] Two stations claim the same queued bag: one wins, the loser gets
      "Another station is already working on this bag."
```

- [ ] **Step 3: Outcomes doc**

In the P1 outcomes doc's "Phase 2 preconditions" section, annotate each of the three `advanceBag` blockers and the bottle conflict as resolved-in-P2 with the commit reference; leave the packaging-counts and partial-close-fields limitations listed as Phase 4 work.

- [ ] **Step 4: Full verification**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run build`
Expected: 0 failures; boundary ratchet still ≤ 80.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md docs/superpowers/plans/
git commit -m "chore(release): v1.31.0 production engine phase 2"
```

---

## Phase 2 exit criteria

- [ ] Full suite 0 failures; typecheck/lint/build clean; boundary ratchet ≤ 80.
- [ ] `read_bag_queue` maintained by the projector only; rebuild script covers it.
- [ ] All six station kinds auto-release; release button gone; finalize narrowed to the not-pinned fallback; sealing handoff intact.
- [ ] Bottle divergence resolved in data; the pin tests replaced per their own instructions.
- [ ] `advanceBag` has no remaining precondition on SEALING / COMBINED / HANDPACK_BLISTER / CLAIM.
- [ ] `StationView.upNext` populated with honest ETA (null under 5 samples).
- [ ] Staging smoke checklist extended; outcomes doc updated.

## What Phase 2 does NOT verify (CI)

Queue-row SQL, claim race under concurrency, and claim idempotency are database behaviours — staging smoke items, per house convention. The pure transition logic, guards, and ETA math carry the CI coverage.

## Deferred

- P3: station SSE (`/floor/api/stream/[token]`) + pg_notify payload extension.
- P4: operator screen rewrite; packaging multi-count + damaged through `advanceBag`; partial-close fields; scanner-test modernization.
- P5: supervisor PIN + panel moves.
- P6: data-driven `queueAfterWorkAt` from `route_operations`; delete legacy tables.
