# Production Engine — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Production Engine's public contract — `getStationView()` and `advanceBag()` — behind the existing floor UI, with zero visible change and all existing tests green, so every later phase has a stable surface to build on.

**Architecture:** A new `lib/production/engine/` package resolves every floor decision from `route_operations` (seeded by migration `0013_route_operation_compat.sql`), falling back to today's hardcoded tables in `lib/production/stage-progression.ts` when route data is absent. The 131 existing `lib/production` modules become the engine's implementation, not the UI's vocabulary. Phase 1 adds the engine and proves parity; it does **not** change queues, auto-advance, screens, or auth — those are Phases 2-6.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Next.js 15 App Router, Drizzle + Postgres 16, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md`

## Global Constraints

- No emoji anywhere in code, tests, comments, or CHANGELOG.
- TypeScript strict — `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` must pass.
- Test files are colocated with source (`lib/production/engine/foo.test.ts` next to `foo.ts`).
- Money/qty as integers. Times are `timestamptz`. Soft-delete only.
- `workflow_events` is the source of truth; folds-on-read are forbidden outside the projector.
- Every mutation writes `audit_log`.
- Never bypass `zoho-integration-service` for Zoho calls.
- `npm run typecheck && npm run lint` clean before every commit.
- `npx vitest run lib/production/engine` clean before every commit.
- **Phase 1 ships zero visual change.** If a floor screen looks different, the task is wrong.
- Version: bump `package.json` from `1.29.10` through the task sequence; add one CHANGELOG entry at Task 8.
- Do NOT push to remote — the controller pushes.

## Critical context the implementer must know

**There are two stage vocabularies and no bridge between them.**

- `read_bag_state.stage` — `STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED` (see `lib/db/schema.ts:2822`, written by `STAGE_FOR_EVENT` in `lib/projector/index.ts:132`).
- `route_operations.stage_key` — `RECEIVING_QUEUE | BLISTER_QUEUE | POST_BLISTER_STAGING | SEALING_QUEUE | POST_SEAL_STAGING | PACKAGING_QUEUE | FINISHED_GOODS_QUEUE` (seeded in `drizzle/0013_route_operation_compat.sql:168`).

Because of this, `getOperationForStage(routeId, stageKey)` in `lib/production/routes.ts:198` **cannot** be called with a bag's stage. The engine resolves operations by `(route, stationKind)` instead. Task 1 builds the explicit bridge.

---

### Task 1: Stage lexicon bridge and engine types

Pure functions and types only. No DB access, so this task is fast and fully unit-testable.

**Files:**
- Create: `lib/production/engine/stage-lexicon.ts`
- Create: `lib/production/engine/stage-lexicon.test.ts`
- Create: `lib/production/engine/types.ts`

**Interfaces:**
- Produces: `bagStageToQueueStageKey(stage, routeCode)`, `queueStageKeyToBagStage(queueStageKey)`, and the type surface `StationView`, `NextAction`, `Blocker`, `CompletionInput`, `CurrentWork`, `UpNextBag`, `AdvanceInput`, `AdvanceResult`.
- Consumed by: every other task in this plan.

- [ ] **Step 1: Write the failing test**

Create `lib/production/engine/stage-lexicon.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  bagStageToQueueStageKey,
  queueStageKeyToBagStage,
} from "./stage-lexicon";

describe("bagStageToQueueStageKey", () => {
  it("maps a card bag at STARTED to the blister queue", () => {
    expect(bagStageToQueueStageKey("STARTED", "CARD_BLISTER")).toBe("BLISTER_QUEUE");
  });

  it("maps a card bag at BLISTERED to the sealing queue", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "CARD_BLISTER")).toBe("SEALING_QUEUE");
  });

  it("maps a card bag at SEALED to the packaging queue", () => {
    expect(bagStageToQueueStageKey("SEALED", "CARD_BLISTER")).toBe("PACKAGING_QUEUE");
  });

  it("maps a bottle bag at BLISTERED to the sticker queue", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "BOTTLE")).toBe("BOTTLE_STICKER_QUEUE");
  });

  it("returns null for an unknown route code rather than guessing", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "NOT_A_ROUTE")).toBeNull();
  });

  it("returns null for a finalized bag — it is in no queue", () => {
    expect(bagStageToQueueStageKey("FINALIZED", "CARD_BLISTER")).toBeNull();
  });
});

describe("queueStageKeyToBagStage", () => {
  it("maps the sealing queue back to the bag stage that enters it", () => {
    expect(queueStageKeyToBagStage("SEALING_QUEUE")).toBe("BLISTERED");
  });

  it("maps the finished-goods queue to FINALIZED", () => {
    expect(queueStageKeyToBagStage("FINISHED_GOODS_QUEUE")).toBe("FINALIZED");
  });

  it("returns null for staging keys that have no bag-stage equivalent", () => {
    expect(queueStageKeyToBagStage("POST_BLISTER_STAGING")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/stage-lexicon.test.ts`
Expected: FAIL — `Failed to resolve import "./stage-lexicon"`

- [ ] **Step 3: Write the implementation**

Create `lib/production/engine/stage-lexicon.ts`:

```ts
// Bridge between the two stage vocabularies in Luma.
//
//   read_bag_state.stage   — STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED
//                            (written by STAGE_FOR_EVENT, lib/projector/index.ts)
//   route_operations.stage_key
//                          — *_QUEUE / *_STAGING keys seeded by
//                            drizzle/0013_route_operation_compat.sql
//
// Nothing else in the codebase translates between them. Every engine
// module that needs to cross the boundary goes through here so the
// mapping lives in exactly one place.

/** Bag stage → the queue a bag at that stage is waiting in, per route. */
const QUEUE_FOR_BAG_STAGE: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  CARD_BLISTER: {
    STARTED: "BLISTER_QUEUE",
    BLISTERED: "SEALING_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
  BOTTLE: {
    STARTED: "BOTTLE_FILL_QUEUE",
    // BOTTLE-ORDER-FLEX-1: cap-seal and sticker run in either order.
    // A filled bag is eligible for whichever finishing station is free;
    // the sticker queue is the canonical entry point and
    // resolve-operation.ts treats the two as interchangeable.
    BLISTERED: "BOTTLE_STICKER_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
  STICKER_ONLY: {
    STARTED: "BOTTLE_STICKER_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
};

/** Queue stage key → the bag stage that puts a bag into it. Staging
 *  keys (POST_*_STAGING) have no bag-stage equivalent and return null. */
const BAG_STAGE_FOR_QUEUE: Readonly<Record<string, string>> = {
  RECEIVING_QUEUE: "STARTED",
  BLISTER_QUEUE: "STARTED",
  SEALING_QUEUE: "BLISTERED",
  BOTTLE_FILL_QUEUE: "STARTED",
  BOTTLE_STICKER_QUEUE: "BLISTERED",
  BOTTLE_INDUCTION_QUEUE: "BLISTERED",
  PACKAGING_QUEUE: "SEALED",
  FINISHED_GOODS_QUEUE: "FINALIZED",
};

export function bagStageToQueueStageKey(
  bagStage: string | null | undefined,
  routeCode: string | null | undefined,
): string | null {
  if (!bagStage || !routeCode) return null;
  const table = QUEUE_FOR_BAG_STAGE[routeCode];
  if (!table) return null;
  return table[bagStage] ?? null;
}

export function queueStageKeyToBagStage(
  queueStageKey: string | null | undefined,
): string | null {
  if (!queueStageKey) return null;
  return BAG_STAGE_FOR_QUEUE[queueStageKey] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/stage-lexicon.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Write the engine type surface**

Create `lib/production/engine/types.ts`:

```ts
// The engine's public contract. Code under app/(floor)/ imports from
// lib/production/engine and nowhere else in lib/production — see the
// ESLint boundary added in Task 5.

export type Blocker = {
  /** Stable, greppable identifier. Never shown to operators. */
  code: string;
  /** Plain language, no jargon, no stage names. Shown on the tablet. */
  operatorSentence: string;
  /** The real reason, shown only under supervisor unlock. */
  supervisorDetail: string;
  suggestedAction:
    | "SCAN_AGAIN"
    | "NOTIFY_SUPERVISOR"
    | "WAIT_UPSTREAM"
    | "ENTER_QUANTITY"
    | "NONE";
};

/** One physical input the operator must supply to complete this
 *  operation. Derived from route_operations, never from a station-kind
 *  switch statement. */
export type CompletionInput = {
  key: "counter" | "damaged" | "cases" | "displays" | "loose";
  label: string;
  unit: string | null;
  required: boolean;
};

export type CurrentWork = {
  workflowBagId: string;
  bagLabel: string;
  productName: string | null;
  /** Operator-facing status, e.g. "Ready to seal". Never a stage name. */
  statusLine: string;
  progress: { done: number; expected: number; unit: string } | null;
};

export type UpNextBag = {
  workflowBagId: string;
  bagLabel: string;
  productName: string | null;
  readyState: "READY" | "UPSTREAM_RUNNING";
  etaMinutes: number | null;
};

export type NextAction =
  | { kind: "OPEN_SHIFT" }
  | { kind: "SCAN_TO_CLAIM"; expected: UpNextBag | null }
  | { kind: "START"; label: string }
  | { kind: "COMPLETE"; label: string; inputs: CompletionInput[] }
  | { kind: "CONFIRM_BAG_EMPTY" }
  | { kind: "RESOLVE_PARTIAL"; estimate: number | null; needsEntry: boolean }
  | { kind: "BLOCKED"; blockers: Blocker[] };

export type StationView = {
  station: {
    id: string;
    label: string;
    kind: string;
    machineName: string | null;
  };
  operator: { sessionId: string; name: string } | null;
  supervisor: { employeeName: string; expiresAt: string } | null;
  current: CurrentWork | null;
  upNext: UpNextBag[];
  nextAction: NextAction;
  capabilities: { canPause: boolean; canReportProblem: boolean };
};

export type AdvanceIntent =
  | "CLAIM"
  | "COMPLETE"
  | "CONFIRM_BAG_EMPTY"
  | "RESOLVE_PARTIAL";

export type AdvanceInput = {
  stationId: string;
  workflowBagId: string;
  operatorSessionId: string;
  intent: AdvanceIntent;
  inputs: {
    counter?: number;
    damaged?: number;
    cases?: number;
    displays?: number;
    loose?: number;
    physicalQty?: number;
  };
  /** Idempotency key — see lib/production/client-event-id-rule.test.ts. */
  clientEventId: string;
};

export type AdvanceResult =
  | { ok: true; view: StationView }
  | { ok: false; blocker: Blocker };
```

- [ ] **Step 6: Verify types compile**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add lib/production/engine/stage-lexicon.ts \
        lib/production/engine/stage-lexicon.test.ts \
        lib/production/engine/types.ts
git commit -m "feat(engine): stage lexicon bridge and engine type contract"
```

---

### Task 2: Resolve the route operation for a station

The engine's single most important lookup. Given a bag and a station, which `route_operations` row governs what happens here?

**Files:**
- Create: `lib/production/engine/resolve-operation.ts`
- Create: `lib/production/engine/resolve-operation.test.ts`

**Interfaces:**
- Consumes: `RouteOperationView`, `getRouteForProduct`, `getRouteOperations` from `lib/production/routes.ts`.
- Produces: `resolveOperation(input): Promise<ResolvedOperation | null>` and the pure helper `pickOperationForStationKind(ops, stationKind)`.

```ts
export type ResolvedOperation = {
  routeCode: string;
  operation: RouteOperationView;
  /** ROUTE_DATA when route_operations governed the decision;
   *  LEGACY_FALLBACK when the hardcoded tables did. Phase 6 deletes
   *  the legacy path once this is never LEGACY_FALLBACK in practice. */
  source: "ROUTE_DATA" | "LEGACY_FALLBACK";
};
```

- [ ] **Step 1: Write the failing test for the pure picker**

Create `lib/production/engine/resolve-operation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickOperationForStationKind } from "./resolve-operation";
import type { RouteOperationView } from "@/lib/production/routes";

function op(over: Partial<RouteOperationView>): RouteOperationView {
  return {
    routeCode: "CARD_BLISTER",
    routeName: "Card blister",
    sequence: 1,
    operationCode: "BLISTER",
    operationName: "Blister",
    stageKey: "BLISTER_QUEUE",
    nextStageKey: "POST_BLISTER_STAGING",
    reworkStageKey: null,
    allowedStationKind: "BLISTER",
    allowedMachineKind: "BLISTER",
    requiresScan: true,
    requiresCounter: true,
    requiresTimer: true,
    outputUnit: "cards",
    ...over,
  };
}

describe("pickOperationForStationKind", () => {
  it("selects the operation whose allowedStationKind matches", () => {
    const ops = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "SEALING")?.operationCode).toBe("HEAT_SEAL");
  });

  it("ignores staging operations that have no station kind", () => {
    const ops = [
      op({ sequence: 3, operationCode: "POST_BLISTER_STAGING", allowedStationKind: null }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "SEALING")?.operationCode).toBe("HEAT_SEAL");
  });

  it("returns null when no operation accepts this station kind", () => {
    const ops = [op({ allowedStationKind: "BLISTER" })];
    expect(pickOperationForStationKind(ops, "PACKAGING")).toBeNull();
  });

  it("maps COMBINED stations to the blister operation", () => {
    const ops = [
      op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" }),
      op({ sequence: 4, operationCode: "HEAT_SEAL", allowedStationKind: "SEALING" }),
    ];
    expect(pickOperationForStationKind(ops, "COMBINED")?.operationCode).toBe("BLISTER");
  });

  it("maps HANDPACK_BLISTER stations to the blister operation", () => {
    const ops = [op({ sequence: 2, operationCode: "BLISTER", allowedStationKind: "BLISTER" })];
    expect(pickOperationForStationKind(ops, "HANDPACK_BLISTER")?.operationCode).toBe("BLISTER");
  });

  it("picks the lowest sequence when two operations accept the kind", () => {
    const ops = [
      op({ sequence: 4, operationCode: "STICKERING", allowedStationKind: "BOTTLE_STICKER" }),
      op({ sequence: 3, operationCode: "STICKERING", allowedStationKind: "BOTTLE_STICKER" }),
    ];
    expect(pickOperationForStationKind(ops, "BOTTLE_STICKER")?.sequence).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/resolve-operation.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve-operation"`

- [ ] **Step 3: Write the implementation**

Create `lib/production/engine/resolve-operation.ts`:

```ts
// (bag, station) -> the route_operations row that governs this station.
//
// Resolving by station kind rather than by stage is deliberate: the two
// stage vocabularies do not line up (see stage-lexicon.ts), so
// getOperationForStage() in lib/production/routes.ts cannot be called
// with a bag's read_bag_state.stage.

import {
  getRouteForProduct,
  getRouteOperations,
  type RouteOperationView,
} from "@/lib/production/routes";

export type ResolvedOperation = {
  routeCode: string;
  operation: RouteOperationView;
  source: "ROUTE_DATA" | "LEGACY_FALLBACK";
};

/** Station kinds that are not themselves route operations but behave
 *  as another kind. COMBINED and HANDPACK_BLISTER both perform the
 *  blister operation; see LEGACY_MACHINE_KIND_TO_OPERATION in
 *  lib/production/routes.ts, which makes the same choice. */
const STATION_KIND_ALIAS: Readonly<Record<string, string>> = {
  COMBINED: "BLISTER",
  HANDPACK_BLISTER: "BLISTER",
};

/** Pure: choose the operation a station of this kind performs. */
export function pickOperationForStationKind(
  ops: readonly RouteOperationView[],
  stationKind: string,
): RouteOperationView | null {
  const effective = STATION_KIND_ALIAS[stationKind] ?? stationKind;
  const matches = ops
    .filter((o) => o.allowedStationKind === effective)
    .sort((a, b) => a.sequence - b.sequence);
  return matches[0] ?? null;
}

export async function resolveOperation(input: {
  productId: string | null;
  stationKind: string;
}): Promise<ResolvedOperation | null> {
  if (!input.productId) return null;

  const route = await getRouteForProduct(input.productId);
  if (!route || !route.routeId) return null;

  const ops = await getRouteOperations(route.routeId);
  const operation = pickOperationForStationKind(ops, input.stationKind);
  if (!operation) return null;

  return {
    routeCode: route.routeCode,
    operation,
    source: route.source === "ASSIGNMENT" ? "ROUTE_DATA" : "LEGACY_FALLBACK",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/resolve-operation.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/production/engine/resolve-operation.ts \
        lib/production/engine/resolve-operation.test.ts
git commit -m "feat(engine): resolve route operation by station kind"
```

---

### Task 3: Derive completion inputs from the operation

This is what deletes the station-kind `switch` from the UI. What the operator must type is a property of the route operation, not of a hardcoded station table.

**Files:**
- Create: `lib/production/engine/resolve-completion.ts`
- Create: `lib/production/engine/resolve-completion.test.ts`

**Interfaces:**
- Consumes: `RouteOperationView` (Task 2), `CompletionInput` (Task 1).
- Produces: `resolveCompletionInputs(op: RouteOperationView): CompletionInput[]`.

- [ ] **Step 1: Write the failing test**

Create `lib/production/engine/resolve-completion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCompletionInputs } from "./resolve-completion";
import type { RouteOperationView } from "@/lib/production/routes";

function op(over: Partial<RouteOperationView>): RouteOperationView {
  return {
    routeCode: "CARD_BLISTER",
    routeName: "Card blister",
    sequence: 2,
    operationCode: "BLISTER",
    operationName: "Blister",
    stageKey: "BLISTER_QUEUE",
    nextStageKey: "POST_BLISTER_STAGING",
    reworkStageKey: null,
    allowedStationKind: "BLISTER",
    allowedMachineKind: "BLISTER",
    requiresScan: true,
    requiresCounter: true,
    requiresTimer: true,
    outputUnit: "cards",
    ...over,
  };
}

describe("resolveCompletionInputs", () => {
  it("asks for a counter when the operation requires one", () => {
    const inputs = resolveCompletionInputs(op({ requiresCounter: true }));
    const counter = inputs.find((i) => i.key === "counter");
    expect(counter).toBeDefined();
    expect(counter?.required).toBe(true);
    expect(counter?.unit).toBe("cards");
  });

  it("asks for nothing countable when the operation requires no counter", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "POST_BLISTER_STAGING", requiresCounter: false, outputUnit: null }),
    );
    expect(inputs.find((i) => i.key === "counter")).toBeUndefined();
  });

  it("asks packaging for cases, displays and loose units", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "PACKAGING", allowedStationKind: "PACKAGING", outputUnit: "cases" }),
    );
    expect(inputs.map((i) => i.key)).toEqual(
      expect.arrayContaining(["cases", "displays", "loose"]),
    );
  });

  it("always offers an optional damaged count", () => {
    const damaged = resolveCompletionInputs(op({})).find((i) => i.key === "damaged");
    expect(damaged).toBeDefined();
    expect(damaged?.required).toBe(false);
  });

  it("labels inputs in plain language with no stage or event names", () => {
    for (const input of resolveCompletionInputs(op({}))) {
      expect(input.label).not.toMatch(/_COMPLETE|QUEUE|STAGE/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/resolve-completion.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve-completion"`

- [ ] **Step 3: Write the implementation**

Create `lib/production/engine/resolve-completion.ts`:

```ts
// What must the operator physically supply to complete this operation?
//
// Driven entirely by route_operations columns (requires_counter,
// output_unit, operation code). No station-kind switch — that is the
// pattern this engine exists to delete.

import type { RouteOperationView } from "@/lib/production/routes";
import type { CompletionInput } from "./types";

/** Operations whose output is a packed case count rather than a single
 *  machine counter reading. Packaging reports three physical numbers. */
const PACKAGING_OPERATIONS: ReadonlySet<string> = new Set(["PACKAGING"]);

export function resolveCompletionInputs(
  op: RouteOperationView,
): CompletionInput[] {
  const inputs: CompletionInput[] = [];

  if (PACKAGING_OPERATIONS.has(op.operationCode)) {
    inputs.push(
      { key: "cases", label: "Cases", unit: "cases", required: true },
      { key: "displays", label: "Displays", unit: "displays", required: false },
      { key: "loose", label: "Loose units", unit: "units", required: false },
    );
  } else if (op.requiresCounter) {
    inputs.push({
      key: "counter",
      label: "Counter",
      unit: op.outputUnit,
      required: true,
    });
  }

  // Physical damage is a human observation at every operation that
  // produces output, and is always optional.
  if (inputs.length > 0) {
    inputs.push({ key: "damaged", label: "Damaged", unit: op.outputUnit, required: false });
  }

  return inputs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/resolve-completion.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/production/engine/resolve-completion.ts \
        lib/production/engine/resolve-completion.test.ts
git commit -m "feat(engine): derive completion inputs from route operation"
```

---

### Task 4: Blockers and the diagnosis checklist

One function produces both the `BLOCKED` action and the `? Help` screen, so the two can never disagree. Phase 1 builds the pure evaluator; Phase 4 renders it.

**Files:**
- Create: `lib/production/engine/resolve-exceptions.ts`
- Create: `lib/production/engine/resolve-exceptions.test.ts`

**Interfaces:**
- Consumes: `Blocker` (Task 1).
- Produces: `evaluateChecks(facts: EngineFacts): CheckResult[]` and `blockersFromChecks(checks: CheckResult[]): Blocker[]`.

```ts
export type EngineFacts = {
  bagRecognized: boolean;
  productResolved: boolean;
  operationResolved: boolean;
  materialsAvailable: boolean;
  upstreamStageComplete: boolean;
  bagPaused: boolean;
  bagFinalized: boolean;
  bagOnHold: boolean;
  /** Where the bag is actually waiting, for the WAIT_UPSTREAM message. */
  waitingForLabel: string | null;
};

export type CheckResult = {
  id: string;
  label: string;
  passed: boolean;
  blocker: Blocker | null;
};
```

- [ ] **Step 1: Write the failing test**

Create `lib/production/engine/resolve-exceptions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  evaluateChecks,
  blockersFromChecks,
  type EngineFacts,
} from "./resolve-exceptions";

function facts(over: Partial<EngineFacts> = {}): EngineFacts {
  return {
    bagRecognized: true,
    productResolved: true,
    operationResolved: true,
    materialsAvailable: true,
    upstreamStageComplete: true,
    bagPaused: false,
    bagFinalized: false,
    bagOnHold: false,
    waitingForLabel: null,
    ...over,
  };
}

describe("evaluateChecks", () => {
  it("passes every check when nothing is wrong", () => {
    const checks = evaluateChecks(facts());
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(blockersFromChecks(checks)).toEqual([]);
  });

  it("reports the checks in a stable diagnostic order", () => {
    expect(evaluateChecks(facts()).map((c) => c.id)).toEqual([
      "bag",
      "product",
      "operation",
      "materials",
      "upstream",
      "hold",
      "paused",
      "finalized",
    ]);
  });

  it("fails the upstream check and names where the bag is waiting", () => {
    const checks = evaluateChecks(
      facts({ upstreamStageComplete: false, waitingForLabel: "Sealing at Station 3" }),
    );
    const upstream = checks.find((c) => c.id === "upstream");
    expect(upstream?.passed).toBe(false);
    expect(upstream?.blocker?.operatorSentence).toContain("Sealing at Station 3");
    expect(upstream?.blocker?.suggestedAction).toBe("WAIT_UPSTREAM");
  });

  it("tells the operator to ask a supervisor when product mapping is missing", () => {
    const blockers = blockersFromChecks(evaluateChecks(facts({ productResolved: false })));
    expect(blockers[0]?.code).toBe("PRODUCT_UNRESOLVED");
    expect(blockers[0]?.suggestedAction).toBe("NOTIFY_SUPERVISOR");
  });

  it("keeps stage names and event names out of operator sentences", () => {
    const blockers = blockersFromChecks(
      evaluateChecks(
        facts({
          productResolved: false,
          materialsAvailable: false,
          upstreamStageComplete: false,
          waitingForLabel: "Sealing at Station 3",
        }),
      ),
    );
    expect(blockers.length).toBeGreaterThan(0);
    for (const b of blockers) {
      expect(b.operatorSentence).not.toMatch(/BLISTERED|SEALED|_COMPLETE|QUEUE/);
    }
  });

  it("still exposes the real reason to supervisors", () => {
    const blockers = blockersFromChecks(evaluateChecks(facts({ operationResolved: false })));
    expect(blockers[0]?.supervisorDetail).toContain("route");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/resolve-exceptions.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve-exceptions"`

- [ ] **Step 3: Write the implementation**

Create `lib/production/engine/resolve-exceptions.ts`:

```ts
// The single source of "why can't I continue?".
//
// evaluateChecks() produces the ordered checklist the ? Help screen
// renders. blockersFromChecks() reduces the same result to the
// Blocker[] carried by NextAction.BLOCKED. Because both come from one
// evaluation, the help screen can never disagree with the button state.

import type { Blocker } from "./types";

export type EngineFacts = {
  bagRecognized: boolean;
  productResolved: boolean;
  operationResolved: boolean;
  materialsAvailable: boolean;
  upstreamStageComplete: boolean;
  bagPaused: boolean;
  bagFinalized: boolean;
  bagOnHold: boolean;
  waitingForLabel: string | null;
};

export type CheckResult = {
  id: string;
  label: string;
  passed: boolean;
  blocker: Blocker | null;
};

function check(
  id: string,
  label: string,
  passed: boolean,
  blocker: Blocker,
): CheckResult {
  return { id, label, passed, blocker: passed ? null : blocker };
}

export function evaluateChecks(facts: EngineFacts): CheckResult[] {
  return [
    check("bag", "Bag recognized", facts.bagRecognized, {
      code: "BAG_UNRECOGNIZED",
      operatorSentence: "This code was not recognized. Try scanning again.",
      supervisorDetail: "No qr_card matched the scanned token.",
      suggestedAction: "SCAN_AGAIN",
    }),
    check("product", "Product recognized", facts.productResolved, {
      code: "PRODUCT_UNRESOLVED",
      operatorSentence:
        "Luma cannot tell which product this bag makes. Ask a supervisor.",
      supervisorDetail:
        "No product mapping for this workflow bag; product_allowed_tablets or the first-op product selection is missing.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("operation", "Station correct", facts.operationResolved, {
      code: "OPERATION_UNRESOLVED",
      operatorSentence: "This bag does not belong at this station.",
      supervisorDetail:
        "No route operation matched this station kind for the bag's route.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("materials", "Materials available", facts.materialsAvailable, {
      code: "MATERIALS_UNAVAILABLE",
      operatorSentence: "Materials for this bag are not loaded.",
      supervisorDetail:
        "Required packaging materials or roll lots are not issued to this station.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("upstream", "Previous step complete", facts.upstreamStageComplete, {
      code: "UPSTREAM_INCOMPLETE",
      operatorSentence: facts.waitingForLabel
        ? `This bag is still being worked on at ${facts.waitingForLabel}.`
        : "This bag is still being worked on at an earlier step.",
      supervisorDetail:
        "The bag has not reached the stage this operation requires.",
      suggestedAction: "WAIT_UPSTREAM",
    }),
    check("hold", "Not on hold", !facts.bagOnHold, {
      code: "BAG_ON_HOLD",
      operatorSentence: "This bag is on hold. Ask a supervisor.",
      supervisorDetail: "read_bag_state.is_on_hold is true.",
      suggestedAction: "NOTIFY_SUPERVISOR",
    }),
    check("paused", "Not paused", !facts.bagPaused, {
      code: "BAG_PAUSED",
      operatorSentence: "This bag is paused. Resume it to continue.",
      supervisorDetail: "read_bag_state.is_paused is true.",
      suggestedAction: "NONE",
    }),
    check("finalized", "Not finished", !facts.bagFinalized, {
      code: "BAG_FINALIZED",
      operatorSentence: "This bag is already finished.",
      supervisorDetail: "read_bag_state.is_finalized is true.",
      suggestedAction: "NONE",
    }),
  ];
}

export function blockersFromChecks(checks: readonly CheckResult[]): Blocker[] {
  return checks.filter((c) => !c.passed && c.blocker).map((c) => c.blocker as Blocker);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/resolve-exceptions.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/production/engine/resolve-exceptions.ts \
        lib/production/engine/resolve-exceptions.test.ts
git commit -m "feat(engine): unified blocker and diagnosis evaluation"
```

---

### Task 5: Enforce the import boundary

Without this, the leak reopens the first time someone needs one more field.

**Files:**
- Modify: `eslint.config.mjs`
- Create: `lib/production/engine/index.ts`
- Create: `lib/production/engine/boundary.test.ts`

**Interfaces:**
- Produces: `lib/production/engine/index.ts` re-exporting the public surface — this is the only path `app/(floor)/` may import.

- [ ] **Step 1: Write the barrel export**

Create `lib/production/engine/index.ts`:

```ts
// The only module app/(floor)/ may import from lib/production.
// Enforced by the no-restricted-imports rule in eslint.config.mjs.

export type {
  AdvanceInput,
  AdvanceIntent,
  AdvanceResult,
  Blocker,
  CompletionInput,
  CurrentWork,
  NextAction,
  StationView,
  UpNextBag,
} from "./types";

export { evaluateChecks, blockersFromChecks } from "./resolve-exceptions";
export type { CheckResult, EngineFacts } from "./resolve-exceptions";
export { resolveCompletionInputs } from "./resolve-completion";
export { resolveOperation, pickOperationForStationKind } from "./resolve-operation";
export type { ResolvedOperation } from "./resolve-operation";
export { bagStageToQueueStageKey, queueStageKeyToBagStage } from "./stage-lexicon";
```

- [ ] **Step 2: Write the failing boundary test**

Create `lib/production/engine/boundary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("floor import boundary", () => {
  it("is declared in the eslint config", () => {
    const config = readFileSync(join(process.cwd(), "eslint.config.mjs"), "utf8");
    expect(config).toContain("lib/production/engine");
    expect(config).toContain("no-restricted-imports");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/boundary.test.ts`
Expected: FAIL — the config does not yet mention `no-restricted-imports`

- [ ] **Step 4: Add the ESLint rule**

Append a new config object to the exported array in `eslint.config.mjs`. Read the file first to match its existing export shape (flat config array).

```js
{
  files: ["app/(floor)/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@/lib/production/*", "!@/lib/production/engine"],
            message:
              "Floor code must go through lib/production/engine. See docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md",
          },
        ],
      },
    ],
  },
},
```

- [ ] **Step 5: Run the boundary test and lint**

Run: `npx vitest run lib/production/engine/boundary.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: **many errors in `app/(floor)/floor/[token]/`** — this is correct. The existing floor code violates the boundary by design; Task 8 is what brings it into compliance. Record the violation count in the commit message so Task 8 can verify it reaches zero.

- [ ] **Step 6: Downgrade to a warning until Task 8 lands**

Change `"error"` to `"warn"` in the rule added in Step 4, so `npm run lint` stays clean for Tasks 6 and 7. Task 8 restores it to `"error"`.

Run: `npm run lint`
Expected: clean, with warnings

- [ ] **Step 7: Commit**

```bash
git add eslint.config.mjs lib/production/engine/index.ts lib/production/engine/boundary.test.ts
git commit -m "feat(engine): public barrel and floor import boundary (warn until rewire)"
```

---

### Task 6: `getStationView()` — the single read

Assembles the whole tablet payload. Phase 1 keeps `upNext` empty — the queue read model arrives in Phase 2 — and derives everything else from today's tables.

**Files:**
- Create: `lib/production/engine/station-view.ts`
- Create: `lib/production/engine/station-view.test.ts`
- Modify: `lib/production/engine/index.ts` — export `getStationView`

**Interfaces:**
- Consumes: `resolveOperation` (Task 2), `resolveCompletionInputs` (Task 3), `evaluateChecks`/`blockersFromChecks` (Task 4), `bagStageToQueueStageKey` (Task 1).
- Produces: `getStationView(stationId: string): Promise<StationView>` and the pure `buildNextAction(input: NextActionInput): NextAction`.

```ts
export type NextActionInput = {
  hasOperatorSession: boolean;
  current: CurrentWork | null;
  operation: RouteOperationView | null;
  checks: CheckResult[];
  bagStage: string | null;
  expected: UpNextBag | null;
};
```

**Before writing the DB half:** read `app/(floor)/floor/[token]/page.tsx:92-156`. That query — `read_station_live` joined to `workflow_bags`, `qr_cards`, `read_bag_state`, `products`, `inventory_bags`, `tablet_types`, `purchase_orders` — is exactly the current-work read, and `buildCurrentBagDisplayLabel` from `lib/production/current-bag-display-label.ts` produces `bagLabel`. Move that query verbatim; do not reinvent it.

- [ ] **Step 1: Write the failing test for the pure action builder**

Create `lib/production/engine/station-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildNextAction } from "./station-view";
import { evaluateChecks } from "./resolve-exceptions";
import type { RouteOperationView } from "@/lib/production/routes";
import type { CurrentWork } from "./types";

const OP: RouteOperationView = {
  routeCode: "CARD_BLISTER",
  routeName: "Card blister",
  sequence: 4,
  operationCode: "HEAT_SEAL",
  operationName: "Heat seal",
  stageKey: "SEALING_QUEUE",
  nextStageKey: "POST_SEAL_STAGING",
  reworkStageKey: null,
  allowedStationKind: "SEALING",
  allowedMachineKind: "SEALING",
  requiresScan: true,
  requiresCounter: true,
  requiresTimer: true,
  outputUnit: "cards",
};

const CURRENT: CurrentWork = {
  workflowBagId: "bag-1",
  bagLabel: "1042",
  productName: "Chocolate Brown",
  statusLine: "Ready to seal",
  progress: null,
};

const ALL_PASS = evaluateChecks({
  bagRecognized: true,
  productResolved: true,
  operationResolved: true,
  materialsAvailable: true,
  upstreamStageComplete: true,
  bagPaused: false,
  bagFinalized: false,
  bagOnHold: false,
  waitingForLabel: null,
});

describe("buildNextAction", () => {
  it("asks for a shift before anything else", () => {
    const action = buildNextAction({
      hasOperatorSession: false,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    expect(action.kind).toBe("OPEN_SHIFT");
  });

  it("asks the operator to scan when no bag is at the station", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: null,
      operation: null,
      checks: ALL_PASS,
      bagStage: null,
      expected: null,
    });
    expect(action.kind).toBe("SCAN_TO_CLAIM");
  });

  it("blocks when a check fails, even with a bag present", () => {
    const checks = evaluateChecks({
      bagRecognized: true,
      productResolved: true,
      operationResolved: true,
      materialsAvailable: true,
      upstreamStageComplete: false,
      bagPaused: false,
      bagFinalized: false,
      bagOnHold: false,
      waitingForLabel: "Blister 1",
    });
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks,
      bagStage: "STARTED",
      expected: null,
    });
    expect(action.kind).toBe("BLOCKED");
    if (action.kind === "BLOCKED") {
      expect(action.blockers[0]?.code).toBe("UPSTREAM_INCOMPLETE");
    }
  });

  it("offers COMPLETE with counter input when the bag is ready to work", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    expect(action.kind).toBe("COMPLETE");
    if (action.kind === "COMPLETE") {
      expect(action.inputs.map((i) => i.key)).toContain("counter");
      expect(action.label).not.toMatch(/_COMPLETE/);
    }
  });

  it("never leaks an event or stage name into an action label", () => {
    const action = buildNextAction({
      hasOperatorSession: true,
      current: CURRENT,
      operation: OP,
      checks: ALL_PASS,
      bagStage: "BLISTERED",
      expected: null,
    });
    if (action.kind === "COMPLETE" || action.kind === "START") {
      expect(action.label).not.toMatch(/BLISTERED|SEALED|QUEUE|_COMPLETE/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/station-view.test.ts`
Expected: FAIL — `Failed to resolve import "./station-view"`

- [ ] **Step 3: Write the pure action builder**

Create `lib/production/engine/station-view.ts` with the pure half first:

```ts
import type { RouteOperationView } from "@/lib/production/routes";
import { resolveCompletionInputs } from "./resolve-completion";
import { blockersFromChecks, type CheckResult } from "./resolve-exceptions";
import type { CurrentWork, NextAction, UpNextBag } from "./types";

export type NextActionInput = {
  hasOperatorSession: boolean;
  current: CurrentWork | null;
  operation: RouteOperationView | null;
  checks: CheckResult[];
  bagStage: string | null;
  expected: UpNextBag | null;
};

/** Operator-facing verb for an operation. Never an event name. */
const OPERATION_VERB: Readonly<Record<string, string>> = {
  BLISTER: "Blistering",
  HEAT_SEAL: "Sealing",
  PACKAGING: "Packaging",
  BOTTLE_FILL: "Filling",
  STICKERING: "Stickering",
  INDUCTION_SEAL: "Sealing",
};

export function operationVerb(operationCode: string): string {
  return OPERATION_VERB[operationCode] ?? "Work";
}

export function buildNextAction(input: NextActionInput): NextAction {
  if (!input.hasOperatorSession) return { kind: "OPEN_SHIFT" };

  if (!input.current) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  const blockers = blockersFromChecks(input.checks);
  if (blockers.length > 0) return { kind: "BLOCKED", blockers };

  if (!input.operation) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  return {
    kind: "COMPLETE",
    label: `${operationVerb(input.operation.operationCode)} complete`,
    inputs: resolveCompletionInputs(input.operation),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/station-view.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Add the DB-backed `getStationView`**

Append to `lib/production/engine/station-view.ts`. Move the current-work query from `app/(floor)/floor/[token]/page.tsx:92-156` verbatim, reuse `getActiveStationSession` from `lib/production/station-operator-session.ts` and `buildCurrentBagDisplayLabel` from `lib/production/current-bag-display-label.ts`, then assemble:

```ts
export async function getStationView(stationId: string): Promise<StationView> {
  // 1. station row + machine (stations join machines on stations.machineId)
  // 2. active operator session  -> getActiveStationSession(db, stationId)
  // 3. current bag at station   -> the read_station_live query from page.tsx:125-145
  // 4. operation                -> resolveOperation({ productId, stationKind })
  // 5. facts                    -> from read_bag_state (isPaused, isFinalized,
  //                                isOnHold) plus resolveOperation's result
  // 6. checks                   -> evaluateChecks(facts)
  // 7. nextAction               -> buildNextAction({...})
  //
  // upNext is [] in Phase 1. read_bag_queue arrives in Phase 2.
}
```

Fill in each numbered step with the real query. Every value is available from the sources named above; add no new tables.

- [ ] **Step 6: Write an integration test for `getStationView`**

Add to `lib/production/engine/station-view.test.ts`, following the DB-test setup used by `lib/production/bag-allocation.test.ts` (read it first for the harness pattern):

```ts
describe("getStationView", () => {
  it("returns OPEN_SHIFT for an active station with no operator session", async () => {
    const view = await getStationView(seededStationId);
    expect(view.nextAction.kind).toBe("OPEN_SHIFT");
    expect(view.station.kind).toBe("SEALING");
    expect(view.upNext).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the suite and typecheck**

Run: `npx vitest run lib/production/engine && npm run typecheck && npm run lint`
Expected: all clean

- [ ] **Step 8: Export and commit**

Add `export { getStationView, buildNextAction, operationVerb } from "./station-view";` to `lib/production/engine/index.ts`.

```bash
git add lib/production/engine/station-view.ts \
        lib/production/engine/station-view.test.ts \
        lib/production/engine/index.ts
git commit -m "feat(engine): getStationView assembles the single tablet read"
```

---

### Task 7: `advanceBag()` — the single write

Phase 1 delegates to the existing action internals rather than reimplementing them. The value here is the *contract*, not new production logic.

**Files:**
- Create: `lib/production/engine/advance.ts`
- Create: `lib/production/engine/advance.test.ts`
- Modify: `lib/production/engine/index.ts` — export `advanceBag`

**Interfaces:**
- Consumes: `AdvanceInput`, `AdvanceResult`, `Blocker` (Task 1); `getStationView` (Task 6); `resolveOperation` (Task 2).
- Produces: `advanceBag(input: AdvanceInput): Promise<AdvanceResult>` and the pure `intentToEventType(intent, operationCode)`.

**Before writing:** read `app/(floor)/floor/[token]/actions.ts:1553-1990` (`fireStageEventAction`). Its guard sequence — `authStation`, `ALLOWED_EVENTS_BY_KIND`, paused/finalized check, `checkStageProgression`, bottle-finishing duplicate check, `resolveStationAccountability`, `projectEvent`, `writeAudit` — is the behavior `advanceBag` must preserve exactly. Phase 1 calls the same helpers in the same order.

- [ ] **Step 1: Write the failing test for the pure intent mapper**

Create `lib/production/engine/advance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { intentToEventType } from "./advance";

describe("intentToEventType", () => {
  it("maps COMPLETE at blister to BLISTER_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BLISTER")).toBe("BLISTER_COMPLETE");
  });

  it("maps COMPLETE at heat seal to a segment, not a bag close", () => {
    expect(intentToEventType("COMPLETE", "HEAT_SEAL")).toBe("SEALING_SEGMENT_COMPLETE");
  });

  it("maps CONFIRM_BAG_EMPTY at heat seal to the bag-level close", () => {
    expect(intentToEventType("CONFIRM_BAG_EMPTY", "HEAT_SEAL")).toBe("SEALING_COMPLETE");
  });

  it("maps COMPLETE at packaging to PACKAGING_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "PACKAGING")).toBe("PACKAGING_COMPLETE");
  });

  it("maps COMPLETE at bottle fill to BOTTLE_HANDPACK_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BOTTLE_FILL")).toBe("BOTTLE_HANDPACK_COMPLETE");
  });

  it("maps CLAIM to BAG_PICKED_UP regardless of operation", () => {
    expect(intentToEventType("CLAIM", "HEAT_SEAL")).toBe("BAG_PICKED_UP");
    expect(intentToEventType("CLAIM", "PACKAGING")).toBe("BAG_PICKED_UP");
  });

  it("returns null for an operation with no event mapping", () => {
    expect(intentToEventType("COMPLETE", "POST_BLISTER_STAGING")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/engine/advance.test.ts`
Expected: FAIL — `Failed to resolve import "./advance"`

- [ ] **Step 3: Write the pure intent mapper**

Create `lib/production/engine/advance.ts`:

```ts
// The single conceptual write. One operator gesture -> one call.
//
// Phase 1 deliberately delegates to the existing helpers used by
// fireStageEventAction so behaviour is bit-identical and the parity
// harness (Task 8) can prove it. Later phases move logic in here.

import { SEALING_SEGMENT_EVENT } from "@/lib/production/sealing-segments";
import type { AdvanceIntent } from "./types";

/** Operation code -> the completion event it fires. Mirrors
 *  LEGACY_EVENT_TYPE_TO_OPERATION in lib/production/routes.ts, inverted. */
const COMPLETE_EVENT_FOR_OPERATION: Readonly<Record<string, string>> = {
  BLISTER: "BLISTER_COMPLETE",
  HEAT_SEAL: SEALING_SEGMENT_EVENT,
  PACKAGING: "PACKAGING_COMPLETE",
  BOTTLE_FILL: "BOTTLE_HANDPACK_COMPLETE",
  STICKERING: "BOTTLE_STICKER_COMPLETE",
  INDUCTION_SEAL: "BOTTLE_CAP_SEAL_COMPLETE",
};

/** Operations where a separate bag-level close exists. Sealing is the
 *  only one today: each station closes its lane with a segment, and the
 *  bag closes once when the operator confirms it is empty. */
const BAG_CLOSE_EVENT_FOR_OPERATION: Readonly<Record<string, string>> = {
  HEAT_SEAL: "SEALING_COMPLETE",
};

export function intentToEventType(
  intent: AdvanceIntent,
  operationCode: string,
): string | null {
  if (intent === "CLAIM") return "BAG_PICKED_UP";
  if (intent === "CONFIRM_BAG_EMPTY") {
    return BAG_CLOSE_EVENT_FOR_OPERATION[operationCode] ?? null;
  }
  if (intent === "COMPLETE") {
    return COMPLETE_EVENT_FOR_OPERATION[operationCode] ?? null;
  }
  // RESOLVE_PARTIAL does not fire a workflow event; it records an
  // allocation resolution handled by the partial-bag modules.
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/production/engine/advance.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Add the transactional `advanceBag`**

Append to `lib/production/engine/advance.ts`. Reproduce the guard order from `fireStageEventAction`, converting each early `return { error }` into a `Blocker` rather than a string:

```ts
export async function advanceBag(input: AdvanceInput): Promise<AdvanceResult> {
  // 1. load station + assertStationActiveForFloorActions
  // 2. resolveOperation({ productId, stationKind }) -> operation
  //    -> no operation: Blocker OPERATION_UNRESOLVED
  // 3. intentToEventType(intent, operation.operationCode)
  //    -> null: Blocker OPERATION_UNRESOLVED
  // 4. read_bag_state guards: isPaused / isFinalized / isOnHold
  // 5. checkStageProgression({ eventType, currentStage, isPaused, isFinalized })
  //    -> not allowed: Blocker UPSTREAM_INCOMPLETE, supervisorDetail = reason
  // 6. bottle finishing duplicate guard:
  //    isBottleFinishingEvent + bottleFinishingAlreadyFired
  // 7. db.transaction:
  //      resolveStationAccountability(tx, { stationId, ... })
  //      projectEvent(tx, { ...event, clientEventId })
  //      writeAudit(tx, ...)
  // 8. return { ok: true, view: await getStationView(input.stationId) }
  //
  // Every failure path returns { ok: false, blocker } — never throws to
  // the caller, and never returns a raw error string.
}
```

Idempotency comes from passing `input.clientEventId` through to `projectEvent`; confirm the convention in `lib/production/client-event-id-rule.test.ts` before wiring it.

- [ ] **Step 6: Write the transaction tests**

Add to `lib/production/engine/advance.test.ts`:

```ts
describe("advanceBag", () => {
  it("is idempotent under a repeated clientEventId", async () => {
    const input = { /* seeded bag at BLISTERED, SEALING station */ };
    const first = await advanceBag(input);
    const second = await advanceBag(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const events = await countWorkflowEvents(input.workflowBagId, "SEALING_SEGMENT_COMPLETE");
    expect(events).toBe(1);
  });

  it("returns a blocker instead of throwing when the bag is paused", async () => {
    const result = await advanceBag({ /* paused bag */ });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("BAG_PAUSED");
      expect(result.blocker.operatorSentence).not.toMatch(/read_bag_state/);
    }
  });

  it("returns a blocker when a second station claims an already-claimed bag", async () => {
    await advanceBag({ /* station A, intent CLAIM */ });
    const result = await advanceBag({ /* station B, same bag, intent CLAIM */ });
    expect(result.ok).toBe(false);
  });

  it("returns the refreshed station view on success", async () => {
    const result = await advanceBag({ /* valid complete */ });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.view.station.id).toBeDefined();
  });
});
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run lib/production/engine && npm run typecheck && npm run lint`
Expected: all clean

- [ ] **Step 8: Export and commit**

Add `export { advanceBag, intentToEventType } from "./advance";` to `lib/production/engine/index.ts`.

```bash
git add lib/production/engine/advance.ts \
        lib/production/engine/advance.test.ts \
        lib/production/engine/index.ts
git commit -m "feat(engine): advanceBag single write with blocker results"
```

---

### Task 8: Parity harness, rewire, and enforce the boundary

The phase gate. Prove the engine decides what the legacy path decides, then route the floor through it without changing a pixel.

**Files:**
- Create: `lib/production/engine/parity.test.ts`
- Modify: `app/(floor)/floor/[token]/actions.ts:1553` — `fireStageEventAction` becomes a wrapper
- Modify: `app/(floor)/floor/[token]/page.tsx:92-156` — read via `getStationView`
- Modify: `eslint.config.mjs` — restore `"error"`
- Modify: `package.json` — version `1.29.10` to `1.30.0`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports. `fireStageEventAction` keeps its exact current signature `(formData: FormData) => Promise<{ error?: string; ok?: true } | void>` so no caller changes.

- [ ] **Step 1: Write the parity test**

Create `lib/production/engine/parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickOperationForStationKind } from "./resolve-operation";
import { intentToEventType } from "./advance";
import { getRouteOperations, getRouteForProduct } from "@/lib/production/routes";
import { EVENT_STAGE_PREREQ } from "@/lib/production/stage-progression";

// Every station kind the legacy tables know about, with the event it
// fires. If the engine and the legacy tables ever disagree, this fails.
const LEGACY_STATION_EVENT: ReadonlyArray<[string, string]> = [
  ["BLISTER", "BLISTER_COMPLETE"],
  ["SEALING", "SEALING_SEGMENT_COMPLETE"],
  ["PACKAGING", "PACKAGING_COMPLETE"],
  ["BOTTLE_HANDPACK", "BOTTLE_HANDPACK_COMPLETE"],
  ["BOTTLE_STICKER", "BOTTLE_STICKER_COMPLETE"],
  ["BOTTLE_CAP_SEAL", "BOTTLE_CAP_SEAL_COMPLETE"],
];

describe("engine/legacy parity", () => {
  it.each(LEGACY_STATION_EVENT)(
    "engine fires the legacy event for a %s station",
    async (stationKind, expectedEvent) => {
      const routeCode = stationKind.startsWith("BOTTLE") ? "BOTTLE" : "CARD_BLISTER";
      const route = await getRouteForProduct(seededProductIdForRoute(routeCode));
      const ops = await getRouteOperations(route!.routeId);
      const op = pickOperationForStationKind(ops, stationKind);
      expect(op).not.toBeNull();
      expect(intentToEventType("COMPLETE", op!.operationCode)).toBe(expectedEvent);
    },
  );

  it("every event the engine can fire is known to the legacy prereq table", async () => {
    for (const [stationKind] of LEGACY_STATION_EVENT) {
      const routeCode = stationKind.startsWith("BOTTLE") ? "BOTTLE" : "CARD_BLISTER";
      const route = await getRouteForProduct(seededProductIdForRoute(routeCode));
      const ops = await getRouteOperations(route!.routeId);
      const op = pickOperationForStationKind(ops, stationKind);
      const event = intentToEventType("COMPLETE", op!.operationCode);
      expect(Object.keys(EVENT_STAGE_PREREQ)).toContain(event);
    }
  });
});
```

Define `seededProductIdForRoute` in the test file using the DB-test harness pattern from `lib/production/bag-allocation.test.ts`.

- [ ] **Step 2: Run the parity test**

Run: `npx vitest run lib/production/engine/parity.test.ts`
Expected: **This may legitimately fail on the BOTTLE route.** The spec records that `0013_route_operation_compat.sql` seeds `STICKERING` before `INDUCTION_SEAL`, while `BOTTLE-ORDER-FLEX-1` treats them as order-independent. If it fails only on bottle ordering, that is the known data conflict — do not paper over it. Stop and report; resolving it is a Phase 2 decision recorded in the spec's "Data reconciliation" section.

- [ ] **Step 3: Rewire `fireStageEventAction` as a wrapper**

In `app/(floor)/floor/[token]/actions.ts:1553`, keep the `zod` parse and `authStation` call, then delegate. `authStation` returns the station row, not a session — get the session separately via `getActiveStationSession` from `lib/production/station-operator-session.ts`, which is already imported in this file via `resolveStationAccountability`:

```ts
const session = await getActiveStationSession(db, stationId);
if (!session) return { error: "Open a shift before recording production." };

const result = await advanceBag({
  stationId,
  workflowBagId,
  operatorSessionId: session.id,
  intent: eventType === "SEALING_COMPLETE" ? "CONFIRM_BAG_EMPTY" : "COMPLETE",
  inputs: { counter: countTotal, damaged: 0 },
  clientEventId,
});
if (!result.ok) return { error: result.blocker.operatorSentence };
revalidatePath(`/floor/${token}`);
return { ok: true };
```

The signature and return shape are unchanged, so `stage-action-buttons.tsx` needs no edit.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all 5,000+ tests pass. Any failure here means the wrapper is not behaviour-identical — fix the engine, not the test.

- [ ] **Step 5: Rewire `page.tsx` reads**

Replace the current-work query at `app/(floor)/floor/[token]/page.tsx:92-156` with `const view = await getStationView(station.station.id);` and feed the existing JSX from `view`. Leave every other resolution in `page.tsx` alone — those move in Phase 4.

- [ ] **Step 6: Verify zero visual change**

Run: `npm run build && npm run dev`
Open a station URL. The screen must be pixel-identical to before this task. If anything moved, the rewire is wrong.

- [ ] **Step 7: Restore the boundary to error**

In `eslint.config.mjs`, change the `no-restricted-imports` severity from `"warn"` back to `"error"`.

Run: `npm run lint`
Expected: clean. If violations remain, they are floor imports Phase 1 did not remove — list them in the commit body as Phase 4 work rather than suppressing them.

- [ ] **Step 8: Version and CHANGELOG**

Bump `package.json` to `1.30.0`. Prepend to `CHANGELOG.md`:

```markdown
## 1.30.0

- Production Engine phase 1: `getStationView()` and `advanceBag()` land behind the existing floor UI. Route decisions now resolve from `route_operations` with legacy fallback. No operator-visible change.
```

- [ ] **Step 9: Commit**

```bash
git add lib/production/engine app/\(floor\)/floor/\[token\]/actions.ts \
        app/\(floor\)/floor/\[token\]/page.tsx eslint.config.mjs \
        package.json CHANGELOG.md
git commit -m "feat(engine): route floor through advanceBag and getStationView (v1.30.0)"
```

---

## Phase 1 exit criteria

- [ ] `npx vitest run` — all 5,000+ tests green
- [ ] `npm run typecheck && npm run lint` — clean, boundary rule at `"error"`
- [ ] A station page is pixel-identical to pre-Phase-1
- [ ] `fireStageEventAction` delegates to `advanceBag`
- [ ] The bottle route-ordering conflict is either resolved or explicitly recorded as a Phase 2 blocker

## Deferred to later phases

| Phase | Work |
|---|---|
| P2 | `read_bag_queue`, auto-advance, auto-finalize, bottle order reconciliation, `upNext` population |
| P3 | `/floor/api/stream/[token]` SSE, `pg_notify` payload extension |
| P4 | Operator screen rewrite; remaining `page.tsx` resolutions move into the engine |
| P5 | Supervisor PIN, `station_supervisor_sessions`, panel moves to `/admin` |
| P6 | Delete legacy tables listed in the spec, remove `LEGACY_FALLBACK` paths |
