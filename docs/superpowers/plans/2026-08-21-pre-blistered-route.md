# Pre-Blistered Product Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support a new product line whose tablets arrive pre-blistered (formed, filled, foil-sealed) and therefore skip the blister operation: route RECEIVING -> SEALING -> PACKAGING, blister-count intake, product-form route assignment.

**Architecture:** New seeded `PRE_BLISTERED_CARD` route in the existing data-driven route tables (mirroring the `STICKER_ONLY` precedent). Products stay `kind=CARD` and get the route via `product_route_assignments` (first write path, from the product dialog). Queue-projector route resolution becomes assignment-aware. Targeted per-route entries in the hardcoded stage tables (sealing prereq, stage lexicon, queue defs). Intake gains blister-count denomination on `tablet_types` / `inventory_bags`.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Drizzle + Postgres 16, vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-pre-blistered-route-design.md`

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index access yields `T | undefined`; do not assign `undefined` to optional props explicitly.
- Migrations additive-only; mirror every DDL change in `lib/db/schema.ts`; never edit shipped migrations (`luma-drizzle-migration`).
- Money/qty as integers. Times as timestamptz. Soft-delete only (`is_active=false`, never DELETE).
- Every mutation writes `audit_log` (copy the pattern of the nearest existing mutation in the same query file).
- No emoji anywhere in UI — Lucide icons + colored chips + text.
- UI copy follows `luma-data-honesty`: derived values labeled derived, entered values labeled as entered; missing is never shown as zero.
- Never push to `main` without `npm run typecheck` + `npm run lint` clean and the vitest suite green.
- Test commands: `npx vitest run <file>` for one file; `npx vitest run` for the suite; `npm run typecheck`.
- Workflow-event semantics: `workflow_events` is append-only source of truth; only projector modules fold events.
- The route vocabulary: existing routes `CARD_BLISTER`, `BOTTLE`, `STICKER_ONLY`; this plan adds `PRE_BLISTERED_CARD`. Bag stages: `STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED` (unchanged).

---

### Task 1: Migration 0075 — schema columns + route seed

**Files:**
- Create: `drizzle/0075_pre_blistered_route.sql`
- Modify: `drizzle/meta/_journal.json` (append entry)
- Modify: `lib/db/schema.ts` (tabletTypes ~line 398, inventoryBags ~line 751)

**Interfaces:**
- Consumes: existing tables `production_routes`, `operation_types`, `route_operations` (created in `drizzle/0013_route_operation_compat.sql`).
- Produces: columns `tablet_types.is_pre_blistered` (boolean NOT NULL default false), `tablet_types.tablets_per_blister` (integer nullable), `inventory_bags.blister_count` (integer nullable); seeded route `PRE_BLISTERED_CARD` with 5 route_operations. Drizzle mirrors: `tabletTypes.isPreBlistered`, `tabletTypes.tabletsPerBlister`, `inventoryBags.blisterCount`.

- [ ] **Step 1: Write the migration SQL**

Create `drizzle/0075_pre_blistered_route.sql`:

```sql
-- PRE-BLISTERED-1 — Pre-blistered product route.
--
-- New product line arrives with tablets already formed, filled, and
-- foil-sealed in blister strips. The floor heat-seals them onto printed
-- cards and packages; the BLISTER operation never runs. Additive only:
-- two tablet_types columns, one inventory_bags column, one seeded route
-- (mirrors the STICKER_ONLY skip-upstream precedent in 0013).

ALTER TABLE "tablet_types"
  ADD COLUMN IF NOT EXISTS "is_pre_blistered" boolean NOT NULL DEFAULT false;
ALTER TABLE "tablet_types"
  ADD COLUMN IF NOT EXISTS "tablets_per_blister" integer;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; guard for idempotency.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tablet_types_pre_blistered_count_check'
  ) THEN
    ALTER TABLE "tablet_types"
      ADD CONSTRAINT "tablet_types_pre_blistered_count_check"
      CHECK (NOT "is_pre_blistered"
             OR ("tablets_per_blister" IS NOT NULL AND "tablets_per_blister" > 0));
  END IF;
END $$;

ALTER TABLE "inventory_bags"
  ADD COLUMN IF NOT EXISTS "blister_count" integer;

INSERT INTO "production_routes" ("code","name","description") VALUES
  ('PRE_BLISTERED_CARD', 'Pre-blistered card',
   'Blisters arrive filled and foil-sealed from the supplier; floor heat-seals onto card and packages. No blister operation.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "route_operations"
  ("route_id","operation_type_id","sequence","stage_key","next_stage_key","allowed_station_kind","allowed_machine_kind","requires_scan","requires_counter","requires_timer","output_unit")
SELECT r.id, o.id, d.seq, d.stage_key, d.next_stage_key, d.station_kind, d.machine_kind, d.requires_scan, d.requires_counter, d.requires_timer, d.output_unit
FROM "production_routes" r
CROSS JOIN LATERAL (VALUES
  (1, 'RECEIVING',         'RECEIVING_QUEUE',       'SEALING_QUEUE',         NULL,        NULL,        true,  false, false, NULL::text),
  (2, 'HEAT_SEAL',         'SEALING_QUEUE',         'POST_SEAL_STAGING',     'SEALING',   'SEALING',   true,  true,  true,  'cards'),
  (3, 'POST_SEAL_STAGING', 'POST_SEAL_STAGING',     'PACKAGING_QUEUE',       NULL,        NULL,        false, false, false, NULL::text),
  (4, 'PACKAGING',         'PACKAGING_QUEUE',       'FINISHED_GOODS_QUEUE',  'PACKAGING', 'PACKAGING', true,  true,  true,  'cases'),
  (5, 'FINISHED_GOODS',    'FINISHED_GOODS_QUEUE',  NULL,                     NULL,        NULL,        false, false, false, 'lots')
) AS d(seq, op_code, stage_key, next_stage_key, station_kind, machine_kind, requires_scan, requires_counter, requires_timer, output_unit)
JOIN "operation_types" o ON o.code = d.op_code
WHERE r.code = 'PRE_BLISTERED_CARD'
ON CONFLICT ("route_id","sequence") DO NOTHING;
```

- [ ] **Step 2: Append the journal entry**

In `drizzle/meta/_journal.json`, append after the `0074_handpack_route_operation` entry (idx 73):

```json
{ "idx": 74, "version": "7", "when": 1787616000000, "tag": "0075_pre_blistered_route", "breakpoints": true }
```

- [ ] **Step 3: Mirror in lib/db/schema.ts**

In `tabletTypes` (after `zohoBatchTracked`, before `isActive`):

```ts
    /** PRE-BLISTERED-1 — this tablet type only ever arrives as filled,
     *  foil-sealed blister strips. Bags of it are denominated in
     *  blisters; the blister operation never runs. Fixed per type —
     *  the same tablet never arrives both loose and pre-blistered. */
    isPreBlistered: boolean("is_pre_blistered").notNull().default(false),
    /** Tablets per blister strip. Required (>0, DB check) when
     *  isPreBlistered. Intake derives pillCount = blisters × this. */
    tabletsPerBlister: integer("tablets_per_blister"),
```

In `inventoryBags` (after `declaredPillCount`):

```ts
    /** PRE-BLISTERED-1 — blister strips counted at intake. Only set for
     *  pre-blistered tablet types; pillCount stays the tablet-denominated
     *  working count (derived blisters × tabletsPerBlister, or the
     *  receiver's entered override). */
    blisterCount: integer("blister_count"),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Apply to the dev database if one is configured**

Run: `npm run db:migrate` (or the repo's equivalent script — check `package.json` scripts for the drizzle migration runner; if only staging/prod run migrations via deploy, skip and note it in the commit body).
Expected: migration applies idempotently; re-running it is a no-op.

- [ ] **Step 6: Commit**

```bash
git add drizzle/0075_pre_blistered_route.sql drizzle/meta/_journal.json lib/db/schema.ts
git commit -m "feat(db): pre-blistered tablet columns + PRE_BLISTERED_CARD route seed"
```

---

### Task 2: Stage lexicon + route graph coverage

**Files:**
- Modify: `lib/production/engine/stage-lexicon.ts:33-38` (add route block)
- Test: `lib/production/engine/stage-lexicon.test.ts` (extend; create if absent)
- Test: extend the existing route-graph tests in `lib/production/engine/route-data.test.ts` (fixture-based; follow the file's existing fixture helpers for STICKER_ONLY/CARD_BLISTER)

**Interfaces:**
- Consumes: `bagStageToQueueStageKey(bagStage, routeCode)`, `queueStageKeyToBagStage(queueStageKey, routeCode)` (existing exports, unchanged signatures).
- Produces: both functions answer for `routeCode === "PRE_BLISTERED_CARD"`; `buildRouteGraph` covered by a test proving the new route's walk.

- [ ] **Step 1: Write failing lexicon tests**

In `lib/production/engine/stage-lexicon.test.ts` add:

```ts
describe("PRE_BLISTERED_CARD", () => {
  it("maps bag stages to queues with no blister queue", () => {
    expect(bagStageToQueueStageKey("STARTED", "PRE_BLISTERED_CARD")).toBe("SEALING_QUEUE");
    expect(bagStageToQueueStageKey("SEALED", "PRE_BLISTERED_CARD")).toBe("PACKAGING_QUEUE");
    expect(bagStageToQueueStageKey("PACKAGED", "PRE_BLISTERED_CARD")).toBe("FINISHED_GOODS_QUEUE");
    // BLISTERED never occurs on this route — the lexicon must not invent one.
    expect(bagStageToQueueStageKey("BLISTERED", "PRE_BLISTERED_CARD")).toBeNull();
  });
  it("inverts back to bag stages", () => {
    expect(queueStageKeyToBagStage("SEALING_QUEUE", "PRE_BLISTERED_CARD")).toBe("STARTED");
    expect(queueStageKeyToBagStage("PACKAGING_QUEUE", "PRE_BLISTERED_CARD")).toBe("SEALED");
    expect(queueStageKeyToBagStage("FINISHED_GOODS_QUEUE", "PRE_BLISTERED_CARD")).toBe("FINALIZED");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/engine/stage-lexicon.test.ts`
Expected: FAIL (new route returns null).

- [ ] **Step 3: Add the route block**

In `QUEUE_FOR_BAG_STAGE` after the `STICKER_ONLY` block:

```ts
  // PRE-BLISTERED-1: blisters arrive filled+sealed; first stationed op is
  // heat-seal, so STARTED enters the sealing queue directly. BLISTERED
  // never occurs on this route.
  PRE_BLISTERED_CARD: {
    STARTED: "SEALING_QUEUE",
    SEALED: "PACKAGING_QUEUE",
    PACKAGED: "FINISHED_GOODS_QUEUE",
  },
```

- [ ] **Step 4: Extend route-data tests**

In `lib/production/engine/route-data.test.ts`, using the file's existing row-fixture style (copy how STICKER_ONLY rows are built), add a fixture for `PRE_BLISTERED_CARD` with the 5 ops from Task 1's seed and assert:

```ts
// queue walk skips staging ops (allowed_station_kind IS NULL)
expect(queueAfterWorkAtFromGraph(graph, "PRE_BLISTERED_CARD", "SEALING_QUEUE")).toBe("PACKAGING_QUEUE");
// SEALING is the first stationed op's kind
// (use the graph helper the file already tests for first/entry ops —
// if none exists, assert via queueKeysForStationKindFromGraph:)
expect(queueKeysForStationKindFromGraph(graph, "SEALING")).toContain("SEALING_QUEUE");
```

Adapt names to the actual exports in `lib/production/engine/route-data.ts` (`queueAfterWorkAtFromGraph` at ~line 329, `queueKeysForStationKindFromGraph` at ~line 511).

- [ ] **Step 5: Run both test files**

Run: `npx vitest run lib/production/engine/stage-lexicon.test.ts lib/production/engine/route-data.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/production/engine/stage-lexicon.ts lib/production/engine/*.test.ts
git commit -m "feat(engine): PRE_BLISTERED_CARD stage lexicon + route graph coverage"
```

---

### Task 3: Route-parameterized sealing prereqs

**Files:**
- Modify: `lib/production/stage-progression.ts:12-28,173-215`
- Modify callers that gate sealing events: `lib/production/engine/record-stage-event.ts:176`, `lib/production/engine/station-view.ts:296`, `lib/production/flow-overlap-readiness.ts:177,273,282`
- Test: `lib/production/stage-progression.test.ts` (extend)

**Interfaces:**
- Consumes: `checkStageProgression(args)` existing arg object.
- Produces: `checkStageProgression` accepts optional `routeCode?: string | null`; new export `eventStagePrereq(eventType: string, routeCode?: string | null): ReadonlyArray<string> | undefined`. On `PRE_BLISTERED_CARD`, `SEALING_COMPLETE` and `SEALING_SEGMENT_COMPLETE` require `STARTED`; every other route/event is byte-identical to today.

- [ ] **Step 1: Write failing tests**

```ts
describe("PRE_BLISTERED_CARD sealing prereqs", () => {
  it("allows SEALING_COMPLETE from STARTED on the pre-blistered route", () => {
    expect(
      checkStageProgression({
        eventType: "SEALING_COMPLETE",
        currentStage: "STARTED",
        routeCode: "PRE_BLISTERED_CARD",
      }),
    ).toEqual({ allowed: true });
  });
  it("still blocks SEALING_COMPLETE from STARTED on CARD_BLISTER", () => {
    const r = checkStageProgression({
      eventType: "SEALING_COMPLETE",
      currentStage: "STARTED",
      routeCode: "CARD_BLISTER",
    });
    expect(r.allowed).toBe(false);
  });
  it("still blocks with no routeCode (legacy callers)", () => {
    const r = checkStageProgression({
      eventType: "SEALING_COMPLETE",
      currentStage: "STARTED",
    });
    expect(r.allowed).toBe(false);
  });
  it("SEALING_SEGMENT_COMPLETE mirrors SEALING_COMPLETE", () => {
    expect(
      checkStageProgression({
        eventType: "SEALING_SEGMENT_COMPLETE",
        currentStage: "STARTED",
        routeCode: "PRE_BLISTERED_CARD",
      }),
    ).toEqual({ allowed: true });
  });
});
```

Run: `npx vitest run lib/production/stage-progression.test.ts` — expected FAIL (unknown property / blocked).

- [ ] **Step 2: Implement**

In `stage-progression.ts`, after `EVENT_STAGE_PREREQ`:

```ts
/** PRE-BLISTERED-1 — per-route prereq overrides. The flat table above
 *  stays authoritative for every route not listed here. Targeted, not
 *  graph-derived: only the sealing events differ, because on the
 *  pre-blistered route the bag arrives at sealing as STARTED (there is
 *  no blister op to produce BLISTERED). Same route-parameterization
 *  pattern as QUEUE_FOR_BAG_STAGE in engine/stage-lexicon.ts. */
const EVENT_STAGE_PREREQ_BY_ROUTE: Readonly<
  Record<string, Readonly<Record<string, ReadonlyArray<string>>>>
> = {
  PRE_BLISTERED_CARD: {
    SEALING_SEGMENT_COMPLETE: ["STARTED"],
    SEALING_COMPLETE: ["STARTED"],
  },
};

export function eventStagePrereq(
  eventType: string,
  routeCode?: string | null,
): ReadonlyArray<string> | undefined {
  if (routeCode) {
    const override = EVENT_STAGE_PREREQ_BY_ROUTE[routeCode]?.[eventType];
    if (override) return override;
  }
  return EVENT_STAGE_PREREQ[eventType];
}
```

In `checkStageProgression`: add `routeCode?: string | null;` to the args type and replace `const prereq = EVENT_STAGE_PREREQ[args.eventType];` with `const prereq = eventStagePrereq(args.eventType, args.routeCode);`. Also thread `routeCode` into the error message unchanged (message already interpolates `prereq`).

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/production/stage-progression.test.ts`
Expected: PASS.

- [ ] **Step 4: Thread routeCode from the engine callers**

Each caller already resolves the bag's route (via `resolveOperation` / `getRouteForProduct` / graph context) or can reach it cheaply:

- `lib/production/engine/record-stage-event.ts:176` — this module resolves the operation for the event; pass the resolved route code (`resolveOperation` returns route context — check its return type in `lib/production/engine/resolve-operation.ts`; if the route code isn't in scope at line 176, load it with `getRouteForProduct(productId)` which the module already imports or can import from `@/lib/production/routes`).
- `lib/production/engine/station-view.ts:296` — same: the station view resolves the operation before gating; pass its route code.
- `lib/production/flow-overlap-readiness.ts:177,273,282` — this readiness helper receives bag/product context; add `routeCode: string | null` to its input type, pass it through to the three `checkStageProgression` calls, and update its callers (grep `flow-overlap-readiness` importers) to supply the resolved route code, defaulting to `null` where unavailable (null preserves legacy behavior exactly).
- `lib/production/engine/record-packaging-complete.ts:161` — PACKAGING prereqs are unchanged on the new route; pass `routeCode` anyway if in scope, else leave (behavior identical either way — SEALED is the prereq on both routes).

Sealing UI gate: `app/(floor)/floor/[token]/stage-action-buttons.tsx` and `page.tsx` import stage-progression per the header comment in that file — grep for `checkStageProgression` / `EVENT_STAGE_PREREQ` usage in `app/(floor)` and pass the bag's route code where sealing buttons are gated (the floor page already knows the product; resolve via the station-view payload, which after this task carries the route code — add it to the station-view response type if not present).

- [ ] **Step 5: Typecheck + affected tests**

Run: `npm run typecheck && npx vitest run lib/production`
Expected: clean, all green (untouched routes unaffected).

- [ ] **Step 6: Commit**

```bash
git add -A lib/production app/\(floor\)
git commit -m "feat(engine): route-parameterized sealing prereqs for pre-blistered route"
```

---

### Task 4: Assignment-aware queue route resolution

**Files:**
- Modify: `lib/projector/bag-queue.ts:44-53` (signature) and `:80-141` (wiring)
- Test: `lib/projector/bag-queue.test.ts` (extend; if the file doesn't exist, create it for the pure function only)

**Interfaces:**
- Consumes: `legacyProductKindToRoute` from `@/lib/production/routes`; schema tables `productRouteAssignments`, `productionRoutes`, `tabletTypes` (already imported or importable in bag-queue.ts).
- Produces: `resolveRouteCodeForQueue(args: { assignedRouteCode: string | null; productKind: string | null; stationKind: string | null; tabletTypeIsPreBlistered?: boolean | null }): string | null` — still pure/sync. `applyBagQueueTransition` fetches `assignedRouteCode` (one indexed query when the bag has a product) and `tabletTypeIsPreBlistered` (added to the existing bagRow select). Precedence: assignment > legacy kind > pre-blistered tablet flag > station-kind fallback.

- [ ] **Step 1: Write failing tests for the pure function**

```ts
describe("resolveRouteCodeForQueue", () => {
  it("assignment wins over legacy kind", () => {
    expect(resolveRouteCodeForQueue({
      assignedRouteCode: "PRE_BLISTERED_CARD", productKind: "CARD",
      stationKind: "SEALING", tabletTypeIsPreBlistered: true,
    })).toBe("PRE_BLISTERED_CARD");
  });
  it("legacy kind still resolves when no assignment", () => {
    expect(resolveRouteCodeForQueue({
      assignedRouteCode: null, productKind: "CARD",
      stationKind: null, tabletTypeIsPreBlistered: null,
    })).toBe("CARD_BLISTER");
  });
  it("unmapped bag of a pre-blistered tablet type resolves by the flag", () => {
    expect(resolveRouteCodeForQueue({
      assignedRouteCode: null, productKind: null,
      stationKind: "SEALING", tabletTypeIsPreBlistered: true,
    })).toBe("PRE_BLISTERED_CARD");
  });
  it("station-kind fallbacks unchanged for loose stock", () => {
    expect(resolveRouteCodeForQueue({
      assignedRouteCode: null, productKind: null,
      stationKind: "BOTTLE_HANDPACK", tabletTypeIsPreBlistered: false,
    })).toBe("BOTTLE");
    expect(resolveRouteCodeForQueue({
      assignedRouteCode: null, productKind: null,
      stationKind: "BLISTER", tabletTypeIsPreBlistered: null,
    })).toBe("CARD_BLISTER");
  });
});
```

Run: `npx vitest run lib/projector/bag-queue.test.ts` — expected FAIL.

- [ ] **Step 2: Implement the pure function**

```ts
export function resolveRouteCodeForQueue(args: {
  /** production_routes.code of the product's active default assignment,
   *  or null. Fetched by the caller — this function stays pure. */
  assignedRouteCode: string | null;
  productKind: string | null;
  stationKind: string | null;
  /** PRE-BLISTERED-1: lets an unmapped bag (no product yet — sealing
   *  picks the product later) resolve to the pre-blistered route from
   *  its tablet type. */
  tabletTypeIsPreBlistered?: boolean | null;
}): string | null {
  if (args.assignedRouteCode) return args.assignedRouteCode;
  const fromProduct = legacyProductKindToRoute(args.productKind);
  if (fromProduct) return fromProduct;
  if (args.tabletTypeIsPreBlistered) return "PRE_BLISTERED_CARD";
  if (args.stationKind && BOTTLE_STATION_KINDS.has(args.stationKind)) return "BOTTLE";
  if (args.stationKind) return "CARD_BLISTER";
  return null;
}
```

- [ ] **Step 3: Wire into applyBagQueueTransition**

In the bagRow select (`bag-queue.ts:80-99`) add `tabletTypeIsPreBlistered: tabletTypes.isPreBlistered,` (the `tabletTypes` join already exists). After the bagRow guard, fetch the assignment (one indexed query, only when the bag has a product — acceptable next to the function's existing 3 queries per flow event):

```ts
  // PRE-BLISTERED-1 / split-brain fix: the queue projector must agree
  // with resolveOperation (station view / advanceBag) on the bag's
  // route, so assignments are consulted first — same precedence as
  // getRouteForProduct in lib/production/routes.ts.
  let assignedRouteCode: string | null = null;
  if (bagRow.productId) {
    const [assignment] = await tx
      .select({ code: productionRoutes.code })
      .from(productRouteAssignments)
      .innerJoin(productionRoutes, eq(productionRoutes.id, productRouteAssignments.routeId))
      .where(
        and(
          eq(productRouteAssignments.productId, bagRow.productId),
          eq(productRouteAssignments.isActive, true),
          eq(productRouteAssignments.isDefault, true),
        ),
      )
      .limit(1);
    assignedRouteCode = assignment?.code ?? null;
  }
```

Add `productRouteAssignments, productionRoutes` to the schema import. Update the `deriveQueueTransition` call:

```ts
    routeCode: resolveRouteCodeForQueue({
      assignedRouteCode,
      productKind: bagRow.productKind ?? null,
      stationKind,
      tabletTypeIsPreBlistered: bagRow.tabletTypeIsPreBlistered ?? null,
    }),
```

- [ ] **Step 4: Fix any other callers of the old signature**

Run: `grep -rn "resolveRouteCodeForQueue" lib app --include="*.ts"` and update every caller/test to the new args shape.

- [ ] **Step 5: Consolidate the duplicate resolver**

`lib/production/product-structure.ts:566` `resolveRouteForProduct` duplicates `getRouteForProduct` without the legacy fallback. Re-point its callers to `getRouteForProduct` from `@/lib/production/routes` and delete the duplicate (grep `resolveRouteForProduct` first; if its callers rely on assignment-only semantics — no legacy fallback — keep behavior by checking `source === "ASSIGNMENT"` at the call sites).

- [ ] **Step 6: Tests + typecheck**

Run: `npx vitest run lib/projector lib/production && npm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A lib/projector lib/production
git commit -m "feat(projector): assignment-aware queue route resolution (split-brain fix)"
```

---

### Task 5: Fresh-bag start at sealing

**Files:**
- Modify: `lib/production/first-op-product.ts` (new pure helper)
- Modify: `lib/production/engine/fresh-bag-start.ts:53-92`
- Modify: `app/(floor)/floor/[token]/actions.ts` (scanCardAction gating, ~lines 57-63 note the duplicated set, plus the `checkFirstOpProductSelection` sites at 313/488/670)
- Test: `lib/production/first-op-product.test.ts` (extend)

**Interfaces:**
- Consumes: `tabletTypes.isPreBlistered` (Task 1); `FIRST_OP_STATION_KINDS`, `PRODUCT_AT_START_STATION_KINDS` (existing).
- Produces: new export from `first-op-product.ts`:
  `canStartFreshBagAtStation(args: { stationKind: string; tabletTypeIsPreBlistered: boolean | null }): { ok: true } | { ok: false; reason: string | null }`
  — reason is an operator-facing message when the refusal is instructive (pre-blistered bag at a blister station), null when the station simply isn't a start station. `resolveFreshBagStart` keeps its signature; SEALING becomes a valid fresh-start kind for pre-blistered stock only.

- [ ] **Step 1: Write failing tests**

```ts
describe("canStartFreshBagAtStation", () => {
  it("pre-blistered stock starts at SEALING only", () => {
    expect(canStartFreshBagAtStation({ stationKind: "SEALING", tabletTypeIsPreBlistered: true }))
      .toEqual({ ok: true });
    const atBlister = canStartFreshBagAtStation({ stationKind: "BLISTER", tabletTypeIsPreBlistered: true });
    expect(atBlister.ok).toBe(false);
    if (!atBlister.ok) expect(atBlister.reason).toMatch(/pre-blistered/i);
    // COMBINED's first event is BLISTER_COMPLETE — wrong for this stock.
    expect(canStartFreshBagAtStation({ stationKind: "COMBINED", tabletTypeIsPreBlistered: true }).ok).toBe(false);
  });
  it("loose stock keeps the legacy start set; SEALING refuses it", () => {
    expect(canStartFreshBagAtStation({ stationKind: "BLISTER", tabletTypeIsPreBlistered: false }))
      .toEqual({ ok: true });
    expect(canStartFreshBagAtStation({ stationKind: "SEALING", tabletTypeIsPreBlistered: false }).ok).toBe(false);
    expect(canStartFreshBagAtStation({ stationKind: "SEALING", tabletTypeIsPreBlistered: null }).ok).toBe(false);
  });
  it("unknown tablet type (unreceived card) keeps legacy behavior", () => {
    expect(canStartFreshBagAtStation({ stationKind: "BLISTER", tabletTypeIsPreBlistered: null }))
      .toEqual({ ok: true });
  });
});
```

Run: `npx vitest run lib/production/first-op-product.test.ts` — expected FAIL.

- [ ] **Step 2: Implement the helper**

In `first-op-product.ts`:

```ts
/** PRE-BLISTERED-1 — station kinds that may create a fresh workflow_bag,
 *  decided per tablet type instead of the flat FIRST_OP_STATION_KINDS
 *  set. Pre-blistered stock starts at SEALING (its route's first
 *  stationed op is heat-seal); everything else keeps the legacy set.
 *  null tabletTypeIsPreBlistered = card has no received bag linked yet —
 *  keep legacy behavior so scanCardAction's "receive the bag first"
 *  refusal still reaches the operator at blister stations. */
export function canStartFreshBagAtStation(args: {
  stationKind: string;
  tabletTypeIsPreBlistered: boolean | null;
}): { ok: true } | { ok: false; reason: string | null } {
  if (args.tabletTypeIsPreBlistered === true) {
    if (args.stationKind === "SEALING") return { ok: true };
    if (FIRST_OP_STATION_KINDS.has(args.stationKind)) {
      return {
        ok: false,
        reason:
          "This product arrives pre-blistered — start it at a sealing station.",
      };
    }
    return { ok: false, reason: null };
  }
  if (FIRST_OP_STATION_KINDS.has(args.stationKind)) return { ok: true };
  if (args.stationKind === "SEALING") {
    return {
      ok: false,
      reason: null, // loose stock at sealing is a CLAIM, not a start
    };
  }
  return { ok: false, reason: null };
}
```

- [ ] **Step 3: Rework resolveFreshBagStart**

In `engine/fresh-bag-start.ts`: replace the early `if (!FIRST_OP_STATION_KINDS.has(args.stationKind)) return null;` with a cheap pre-filter that also admits SEALING, add `isPreBlistered: tabletTypes.isPreBlistered` to the select (add a `leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))`), then gate after the lookup:

```ts
  const kindMayEverStart =
    FIRST_OP_STATION_KINDS.has(args.stationKind) || args.stationKind === "SEALING";
  if (!kindMayEverStart) return null;
  ...
  if (!card) return null;
  const gate = canStartFreshBagAtStation({
    stationKind: args.stationKind,
    tabletTypeIsPreBlistered: card.isPreBlistered ?? null,
  });
  if (!gate.ok) return null;
```

`needsProduct` stays as-is (`PRODUCT_AT_START_STATION_KINDS` does not include SEALING): a pre-blistered fresh start creates the bag product-less and the existing sealing product-save step (`sealing-product.ts`, "Step 1: Save product") records the SKU — no new UI. `filterSealingProductsByTabletType` then only offers products allowed for the pre-blistered tablet type.

- [ ] **Step 4: scanCardAction parity**

In `app/(floor)/floor/[token]/actions.ts`: the comment at lines 60-63 says its own first-op set must change in tandem with `FIRST_OP_STATION_KINDS`. Replace that duplicated membership check with `canStartFreshBagAtStation` (the action loads the card + inventory bag + tablet type rows already or can add `isPreBlistered` to its select). When the gate returns `{ok: false, reason: string}`, return that reason to the operator (same error-return shape the action uses elsewhere). Verify the three `checkFirstOpProductSelection` call sites (313/488/670) still behave: that helper's `FIRST_OP_STATION_KINDS.has()` early-return means SEALING falls into the "not first-op: no product gate" branch, which is correct (product save happens later at sealing) — add a test in `first-op-product.test.ts`:

```ts
  it("checkFirstOpProductSelection does not gate a SEALING fresh start", () => {
    expect(
      checkFirstOpProductSelection({
        stationKind: "SEALING", cardStatus: "IDLE",
        pickedProductId: null, product: null,
      }),
    ).toEqual({ ok: true, productId: null });
  });
```

- [ ] **Step 5: Tests + typecheck**

Run: `npx vitest run lib/production && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A lib/production app/\(floor\)
git commit -m "feat(floor): fresh bag start at sealing for pre-blistered tablet types"
```

---

### Task 6: Queue-state + metrics route awareness

**Files:**
- Modify: `lib/projector/queue-state.ts:81-160` (StageDef + SQL)
- Modify: `lib/production/metrics.ts` (~line 697, `STAGE_TO_BAG_STAGES` fallback path)
- Test: `lib/projector/queue-state.test.ts`, `lib/production/metrics.test.ts` (extend whichever exist; pure parts only — the SQL path is covered by typecheck + the flow test in Task 12)

**Interfaces:**
- Consumes: effective-route resolution semantics from Task 4 (assignment > legacy kind > tablet flag).
- Produces: `StageDef` gains `routeStages?: Array<{ routeCode: string; bagStages: string[] }>` and `excludeRouteCodes?: string[]`. `BLISTER_QUEUE` excludes `PRE_BLISTERED_CARD`; `SEALING_QUEUE` additionally admits `{routeCode: "PRE_BLISTERED_CARD", bagStages: ["STARTED"]}`. Pre-blistered STARTED bags count in the sealing queue, never the blister queue.

- [ ] **Step 1: Extend StageDef and the two defs**

```ts
  BLISTER_QUEUE: {
    bagStages: ["STARTED"],
    productKind: "CARD",
    // PRE-BLISTERED-1: pre-blistered CARD bags start at sealing; their
    // STARTED bags must not be counted as waiting for a blister machine.
    excludeRouteCodes: ["PRE_BLISTERED_CARD"],
  },
  SEALING_QUEUE: {
    bagStages: ["BLISTERED"],
    queueStageFilter: "SEALING_QUEUE",
    // PRE-BLISTERED-1: on this route the bag reaches sealing at STARTED.
    routeStages: [{ routeCode: "PRE_BLISTERED_CARD", bagStages: ["STARTED"] }],
  },
```

- [ ] **Step 2: Add effective-route resolution to the refresh SQL**

In `refreshQueueState`'s per-stage SQL, add (only emitted when the def has `routeStages` or `excludeRouteCodes`, to keep untouched stages' SQL identical):

```sql
LEFT JOIN workflow_bags wb ON wb.id = rbs.workflow_bag_id
LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
LEFT JOIN tablet_types tt ON tt.id = ib.tablet_type_id
LEFT JOIN (
  SELECT pra.product_id, pr.code
  FROM product_route_assignments pra
  JOIN production_routes pr ON pr.id = pra.route_id
  WHERE pra.is_active AND pra.is_default
) route ON route.product_id = rbs.product_id
```

with an effective-route expression matching Task 4's precedence:

```sql
COALESCE(
  route.code,
  CASE p.kind WHEN 'CARD' THEN 'CARD_BLISTER' WHEN 'BOTTLE' THEN 'BOTTLE' WHEN 'VARIETY' THEN 'CARD_BLISTER' END,
  CASE WHEN tt.is_pre_blistered THEN 'PRE_BLISTERED_CARD' END
)
```

Membership predicate: `(rbs.stage IN (<bagStages>) AND effective_route IS DISTINCT FROM ALL excluded) OR (effective_route = '<routeCode>' AND rbs.stage IN (<routeStages.bagStages>))` — express it with the same `sql` template style the function already uses (build the two branches conditionally; note `IS DISTINCT FROM` per code, not `ALL` — one exclude code today, keep it a simple `<>` guarded for NULL: `effective_route IS NULL OR effective_route <> 'PRE_BLISTERED_CARD'`). Check the join aliases against the actual FROM clause in the file (it selects from `read_bag_state rbs` joined to `products p`) — verify `read_bag_state` columns for the workflow-bag id name before writing the joins.

- [ ] **Step 3: Mirror in metrics fallback**

In `lib/production/metrics.ts` `STAGE_TO_BAG_STAGES` (~line 697): this map feeds the live fallback when `read_queue_state` is missing. Apply the same two changes (exclude pre-blistered from `BLISTER_QUEUE`, admit pre-blistered STARTED into `SEALING_QUEUE`) using whatever shape the consuming function takes — if the map is consumed by SQL, reuse Step 2's expression; if consumed in TS against loaded rows, extend the rows' select with the effective route and filter in TS. Read the consuming function (`deriveQueueAging`, directly below the map) first and follow its style.

- [ ] **Step 4: Typecheck + projector tests**

Run: `npm run typecheck && npx vitest run lib/projector lib/production/metrics.test.ts`
Expected: green (existing stage behavior unchanged — the new SQL only emits for the two touched defs).

- [ ] **Step 5: Commit**

```bash
git add lib/projector/queue-state.ts lib/production/metrics.ts -A
git commit -m "feat(projector): route pre-blistered STARTED bags to the sealing queue"
```

---

### Task 7: Tablet-type admin fields

**Files:**
- Modify: `app/(admin)/tablet-types/actions.ts` (zod schema + parse)
- Modify: `app/(admin)/tablet-types/tablet-type-dialog.tsx` (two fields)
- Modify: `lib/db/queries/tablet-types.ts` (`createTabletType` / `updateTabletType` input types — check the file; pass-through columns)
- Test: extend `lib/db/queries/tablet-types.test.ts` if it exists; else validation-level test in a new `app` test is unnecessary — cover via the zod refine below in `lib/receive` style pure test if the repo has one; otherwise rely on typecheck + Task 13 suite.

**Interfaces:**
- Produces: tablet-type create/edit accepts `isPreBlistered: boolean` and `tabletsPerBlister: number | null`; refuses `isPreBlistered && !tabletsPerBlister` at the form layer (friendly message, before the DB check fires).

- [ ] **Step 1: Extend the action schema**

In `app/(admin)/tablet-types/actions.ts`:

```ts
const schema = z
  .object({
    // ...existing fields unchanged...
    isPreBlistered: z.coerce.boolean().optional(),
    tabletsPerBlister: z.coerce.number().int().min(1).max(1000).optional().nullable(),
  })
  .refine(
    (v) => !v.isPreBlistered || (v.tabletsPerBlister != null && v.tabletsPerBlister > 0),
    { message: "Pre-blistered tablet types need tablets per blister (at least 1)." },
  );
```

Parse: `isPreBlistered: formData.get("isPreBlistered") === "on", tabletsPerBlister: formData.get("tabletsPerBlister") || null,`.

- [ ] **Step 2: Dialog fields**

In `tablet-type-dialog.tsx`, following the dialog's existing input/checkbox style (match `product-dialog.tsx` idioms — `Label` + `Input`, checkbox as `<input type="checkbox" name=... defaultChecked=... />`): add a "Pre-blistered" checkbox (`name="isPreBlistered"`) with helper text "Arrives as filled, foil-sealed blister strips — skips the blister machine" and a "Tablets per blister" number input (`name="tabletsPerBlister"`, `min={1}`), shown only while the checkbox is checked (local `useState` mirroring the dialog's `kind` state pattern).

- [ ] **Step 3: Pass through the query layer**

In `lib/db/queries/tablet-types.ts` add both fields to the create/update input types and column writes; audit_log per the file's existing pattern.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck && npx vitest run lib/db`
Expected: clean.

```bash
git add -A app/\(admin\)/tablet-types lib/db/queries/tablet-types.ts
git commit -m "feat(admin): pre-blistered flag + tablets-per-blister on tablet types"
```

---

### Task 8: Product route assignment — write path + validations

**Files:**
- Create: `lib/db/queries/product-route-assignment.ts`
- Create: `lib/production/pre-blistered-product.ts` (pure validation helpers)
- Test: `lib/production/pre-blistered-product.test.ts`

**Interfaces:**
- Consumes: `productRouteAssignments`, `productionRoutes`, `workflowBags`, `productAllowedTablets`, `tabletTypes`, `products` schema tables; audit-log write pattern from `lib/db/queries/products.ts`.
- Produces:
  - `setProductRouteAssignment(args: { productId: string; routeCode: "PRE_BLISTERED_CARD" | null; actor: <same actor type as updateProduct> }): Promise<{ ok: true } | { ok: false; error: string }>` — `null` reverts to the legacy kind-derived route by deactivating the assignment (soft).
  - Pure helpers in `pre-blistered-product.ts`:
    - `validatePreBlisteredTabletCompatibility(args: { productIsPreBlisteredRoute: boolean; tablets: Array<{ name: string; isPreBlistered: boolean; tabletsPerBlister: number | null }>; tabletsPerUnit: number | null }): { ok: true } | { ok: false; error: string }`
    - `blistersPerUnit(args: { tabletsPerUnit: number; tabletsPerBlister: number }): number | null` — null when not evenly divisible.

- [ ] **Step 1: Write failing tests for the pure helpers**

```ts
describe("blistersPerUnit", () => {
  it("divides evenly", () => {
    expect(blistersPerUnit({ tabletsPerUnit: 30, tabletsPerBlister: 10 })).toBe(3);
  });
  it("null when a card cannot hold whole blisters", () => {
    expect(blistersPerUnit({ tabletsPerUnit: 30, tabletsPerBlister: 8 })).toBeNull();
  });
});

describe("validatePreBlisteredTabletCompatibility", () => {
  const preTab = { name: "Alpha 10ct", isPreBlistered: true, tabletsPerBlister: 10 };
  const looseTab = { name: "Beta loose", isPreBlistered: false, tabletsPerBlister: null };
  it("pre-blistered route requires all tablets pre-blistered", () => {
    const r = validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: true, tablets: [preTab, looseTab], tabletsPerUnit: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Beta loose");
  });
  it("standard route refuses pre-blistered tablets", () => {
    const r = validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: false, tablets: [preTab], tabletsPerUnit: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Alpha 10ct");
  });
  it("divisibility enforced per pre-blistered tablet", () => {
    const r = validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: true,
      tablets: [{ ...preTab, tabletsPerBlister: 8 }], tabletsPerUnit: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/whole number of blisters|divisible/i);
  });
  it("valid pre-blistered config passes", () => {
    expect(validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: true, tablets: [preTab], tabletsPerUnit: 30,
    })).toEqual({ ok: true });
  });
  it("no tablets configured yet passes (configured later on product page)", () => {
    expect(validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: true, tablets: [], tabletsPerUnit: 30,
    })).toEqual({ ok: true });
  });
});
```

Run: `npx vitest run lib/production/pre-blistered-product.test.ts` — expected FAIL.

- [ ] **Step 2: Implement the pure helpers**

```ts
// PRE-BLISTERED-1 — cross-table rules for pre-blistered products, kept
// pure so the product-save and allowed-tablet actions share one brain.

export function blistersPerUnit(args: {
  tabletsPerUnit: number;
  tabletsPerBlister: number;
}): number | null {
  if (args.tabletsPerBlister <= 0) return null;
  if (args.tabletsPerUnit % args.tabletsPerBlister !== 0) return null;
  return args.tabletsPerUnit / args.tabletsPerBlister;
}

export function validatePreBlisteredTabletCompatibility(args: {
  productIsPreBlisteredRoute: boolean;
  tablets: ReadonlyArray<{
    name: string;
    isPreBlistered: boolean;
    tabletsPerBlister: number | null;
  }>;
  tabletsPerUnit: number | null;
}): { ok: true } | { ok: false; error: string } {
  if (args.productIsPreBlisteredRoute) {
    const loose = args.tablets.find((t) => !t.isPreBlistered);
    if (loose) {
      return {
        ok: false,
        error: `Tablet type ${loose.name} is not pre-blistered. A pre-blistered product may only use pre-blistered tablet types.`,
      };
    }
    if (args.tabletsPerUnit != null && args.tabletsPerUnit > 0) {
      const indivisible = args.tablets.find(
        (t) =>
          t.tabletsPerBlister != null &&
          blistersPerUnit({
            tabletsPerUnit: args.tabletsPerUnit as number,
            tabletsPerBlister: t.tabletsPerBlister,
          }) == null,
      );
      if (indivisible) {
        return {
          ok: false,
          error: `Tablets per unit (${args.tabletsPerUnit}) is not divisible by ${indivisible.name}'s tablets per blister (${indivisible.tabletsPerBlister}) — a card must hold a whole number of blisters.`,
        };
      }
    }
    return { ok: true };
  }
  const pre = args.tablets.find((t) => t.isPreBlistered);
  if (pre) {
    return {
      ok: false,
      error: `Tablet type ${pre.name} arrives pre-blistered. Set this product's route to Pre-blistered to use it.`,
    };
  }
  return { ok: true };
}
```

Run the tests — expected PASS.

- [ ] **Step 3: Implement setProductRouteAssignment**

`lib/db/queries/product-route-assignment.ts`, modeled on the transaction + audit pattern in `lib/db/queries/products.ts` (read that file first and copy its actor type and audit insert shape):

```ts
export async function setProductRouteAssignment(args: {
  productId: string;
  routeCode: "PRE_BLISTERED_CARD" | null;
  actor: Actor; // exact type from products.ts
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: productRouteAssignments.id, code: productionRoutes.code })
      .from(productRouteAssignments)
      .innerJoin(productionRoutes, eq(productionRoutes.id, productRouteAssignments.routeId))
      .where(and(
        eq(productRouteAssignments.productId, args.productId),
        eq(productRouteAssignments.isActive, true),
        eq(productRouteAssignments.isDefault, true),
      ))
      .limit(1);
    const currentCode = current?.code ?? null;
    if (currentCode === args.routeCode) return { ok: true }; // no-op

    // Route changes strand in-flight bags mid-graph (a STARTED bag on the
    // pre-blistered route has no BLISTERED stage to reach). Block while
    // the product has open workflow bags.
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowBags)
      .where(and(eq(workflowBags.productId, args.productId), isNull(workflowBags.finalizedAt)));
    if ((open?.n ?? 0) > 0) {
      return {
        ok: false,
        error: `This product has ${open?.n} bag(s) in production. Finish or void them before changing its route.`,
      };
    }

    // Deactivate first — the partial unique index allows one default-active
    // assignment per product, so deactivate-then-insert, in this order.
    if (current) {
      await tx
        .update(productRouteAssignments)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(productRouteAssignments.id, current.id));
    }
    if (args.routeCode) {
      const [route] = await tx
        .select({ id: productionRoutes.id })
        .from(productionRoutes)
        .where(eq(productionRoutes.code, args.routeCode))
        .limit(1);
      if (!route) return { ok: false, error: `Route ${args.routeCode} is not seeded.` };
      await tx.insert(productRouteAssignments).values({
        productId: args.productId,
        routeId: route.id,
        isDefault: true,
        isActive: true,
      });
    }
    // audit_log insert per products.ts pattern:
    // action "PRODUCT_ROUTE_ASSIGNED", detail { from: currentCode, to: args.routeCode }
    ...
    return { ok: true };
  });
}
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npx vitest run lib/production lib/db`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/db/queries/product-route-assignment.ts lib/production/pre-blistered-product.ts lib/production/pre-blistered-product.test.ts
git commit -m "feat(products): route assignment write path + pre-blistered validation rules"
```

---

### Task 9: Product dialog route option + save wiring

**Files:**
- Modify: `app/(admin)/products/actions.ts` (schema + save flow)
- Modify: `app/(admin)/products/product-dialog.tsx` (route selector)
- Modify: `app/(admin)/products/page.tsx` and/or `products-browser.tsx` (pass current assignment into the dialog)
- Modify: the allowed-tablet add action on the product page (`grep -rn "productAllowedTablets" app/\(admin\)/products` to find it) — enforce `validatePreBlisteredTabletCompatibility` there too
- Test: covered by Task 8's pure tests; action-level behavior via typecheck + Task 13 suite

**Interfaces:**
- Consumes: `setProductRouteAssignment`, `validatePreBlisteredTabletCompatibility` (Task 8); `getRouteForProduct` (`lib/production/routes.ts`).
- Produces: product dialog shows, for `kind=CARD` only, a "Production route" select (`name="routeOption"`, values `STANDARD` | `PRE_BLISTERED`, labels "Standard (blister on-site)" / "Pre-blistered (skip blister)"), defaulting to the product's current assignment. Save calls `setProductRouteAssignment` after the product upsert; validation errors from either surface in the dialog's existing error slot.

- [ ] **Step 1: Extend saveProductAction**

Add to the zod schema: `routeOption: z.enum(["STANDARD", "PRE_BLISTERED"]).optional(),` parsed via `routeOption: (formData.get("routeOption") as string | null) || undefined,`. After the successful `createProduct`/`updateProduct` call and before `revalidatePath`:

```ts
  if (parsed.data.kind === "CARD" && parsed.data.routeOption) {
    const productId = id ?? row.id; // row from createProduct
    // Cross-validate against the product's allowed tablets before assigning.
    const tablets = await getAllowedTabletsWithPreBlister(productId); // small select: join product_allowed_tablets -> tablet_types, pick name/isPreBlistered/tabletsPerBlister
    const compat = validatePreBlisteredTabletCompatibility({
      productIsPreBlisteredRoute: parsed.data.routeOption === "PRE_BLISTERED",
      tablets,
      tabletsPerUnit: parsed.data.tabletsPerUnit ?? null,
    });
    if (!compat.ok) return { error: compat.error };
    const r = await setProductRouteAssignment({
      productId,
      routeCode: parsed.data.routeOption === "PRE_BLISTERED" ? "PRE_BLISTERED_CARD" : null,
      actor,
    });
    if (!r.ok) return { error: r.error };
  }
```

Put `getAllowedTabletsWithPreBlister` in `lib/db/queries/product-route-assignment.ts` alongside Task 8's function and export it.

- [ ] **Step 2: Dialog UI**

In `product-dialog.tsx`: the dialog receives a new optional prop `currentRouteOption?: "STANDARD" | "PRE_BLISTERED"`. Below the Kind select, render only when `kind === "CARD"`:

```tsx
{kind === "CARD" && (
  <div className="space-y-1.5">
    <Label htmlFor="routeOption">Production route</Label>
    <Select id="routeOption" name="routeOption" defaultValue={currentRouteOption ?? "STANDARD"}>
      <option value="STANDARD">Standard (blister on-site)</option>
      <option value="PRE_BLISTERED">Pre-blistered (skip blister)</option>
    </Select>
    <p className="text-xs text-text-subtle">
      Pre-blistered products arrive as filled, foil-sealed blisters and start at sealing.
    </p>
  </div>
)}
```

- [ ] **Step 3: Feed the current assignment in**

Where the edit dialog is instantiated (`products-browser.tsx` / `page.tsx`): the page's product query gains a left join to `product_route_assignments`+`production_routes` (active default) — or call `getRouteForProduct` per row if the list is small — and passes `currentRouteOption={assignmentCode === "PRE_BLISTERED_CARD" ? "PRE_BLISTERED" : "STANDARD"}`.

- [ ] **Step 4: Allowed-tablet action symmetry**

In the product-page action that inserts into `productAllowedTablets`: before insert, load the product's route (`getRouteForProduct`) and the candidate tablet type's `isPreBlistered`/`tabletsPerBlister`, then run `validatePreBlisteredTabletCompatibility` with the would-be tablet list (existing + candidate); refuse with its error message.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck && npx vitest run lib`
Expected: green.

```bash
git add -A app/\(admin\)/products lib/db/queries/product-route-assignment.ts
git commit -m "feat(admin): pre-blistered route option on the product form"
```

---

### Task 10: Intake pure helpers — blister denomination

**Files:**
- Modify: `lib/production/raw-bag-intake.ts` (RawBagRowSeed + validation + derivation)
- Test: `lib/production/raw-bag-intake.test.ts` (extend)

**Interfaces:**
- Consumes: `RawBagRowSeed`, `validateBagRowSeeds`, `generateBagRowSeed` (existing exports — read their exact shapes first).
- Produces:
  - `RawBagRowSeed` gains `blisterCount?: number | null`.
  - New export `deriveTabletsFromBlisters(args: { blisterCount: number; tabletsPerBlister: number }): number` (simple integer product).
  - `validateBagRowSeeds` gains an options/context param carrying `{ isPreBlistered: boolean; tabletsPerBlister: number | null }` for the receiving tablet type (thread however the function currently receives per-type context — read it first; if it has none, add a second argument `tabletTypeContext`), producing issues: pre-blistered rows must have `blisterCount >= 1`; non-pre-blistered rows must not carry `blisterCount`.

- [ ] **Step 1: Write failing tests**

```ts
describe("deriveTabletsFromBlisters", () => {
  it("multiplies", () => {
    expect(deriveTabletsFromBlisters({ blisterCount: 48, tabletsPerBlister: 10 })).toBe(480);
  });
});

describe("validateBagRowSeeds — pre-blistered", () => {
  // Build minimal valid seeds the way the file's existing tests do
  // (copy their seed factory), then:
  it("requires blisterCount >= 1 on every row for a pre-blistered type", () => {
    const issues = validateBagRowSeeds(seedsWithout("blisterCount"), {
      isPreBlistered: true,
      tabletsPerBlister: 10,
    });
    expect(issues.some((i) => /blister/i.test(i.message))).toBe(true);
  });
  it("refuses blisterCount on loose tablet types", () => {
    const issues = validateBagRowSeeds(seedsWith({ blisterCount: 12 }), {
      isPreBlistered: false,
      tabletsPerBlister: null,
    });
    expect(issues.some((i) => /not pre-blistered|loose/i.test(i.message))).toBe(true);
  });
  it("clean pre-blistered rows pass", () => {
    const issues = validateBagRowSeeds(seedsWith({ blisterCount: 12 }), {
      isPreBlistered: true,
      tabletsPerBlister: 10,
    });
    expect(issues).toEqual([]);
  });
});
```

Adapt the seed factory and the issue-object shape (`RawBagRowValidationIssue` at `raw-bag-intake.ts:124`) to the file's actual conventions; keep existing call sites compiling by making the new context parameter optional with a default of `{ isPreBlistered: false, tabletsPerBlister: null }`.

Run: `npx vitest run lib/production/raw-bag-intake.test.ts` — expected FAIL.

- [ ] **Step 2: Implement**

Add the field, the helper, and the validation branch. Weight-derived estimation: find where intake estimates `pillCount` from `weightGrams` (grep `defaultMgPerTablet` in `lib/production/raw-bag-intake.ts` and `lib/db/queries/raw-bag-intake.ts`) and gate it: when the tablet type `isPreBlistered`, never estimate from weight (weight includes foil/PVC); `pillCount` comes only from `deriveTabletsFromBlisters` or the receiver's explicit entry.

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/production/raw-bag-intake.test.ts`
Expected: PASS (including all pre-existing tests, via the defaulted context).

- [ ] **Step 4: Commit**

```bash
git add lib/production/raw-bag-intake.ts lib/production/raw-bag-intake.test.ts
git commit -m "feat(intake): blister-count denomination helpers for pre-blistered types"
```

---

### Task 11: Intake write path + wizard + manual add-bag

**Files:**
- Modify: `lib/db/queries/raw-bag-intake.ts` (`createRawBagIntakeAtomic` — persist `blisterCount`, thread tablet-type context into validation)
- Modify: `app/(admin)/inbound/new/receive-wizard.tsx` (per-bag Blisters input for pre-blistered types)
- Modify: `lib/receive/add-bag.ts`, `lib/db/queries/receive-add-bag.ts`, `app/(admin)/inbound/[id]/add-bag/actions.ts`, `app/(admin)/inbound/[id]/add-bag/add-bag-form.tsx` (manual path)
- Test: `lib/receive/add-bag.test.ts` (extend), plus whatever tests cover `createRawBagIntakeAtomic` inputs

**Interfaces:**
- Consumes: Task 10 helpers; `tabletTypes.isPreBlistered` / `tabletsPerBlister`.
- Produces: both intake paths persist `inventory_bags.blister_count` and a tablet-denominated `pill_count`. Wizard UX for a pre-blistered tablet type: per-bag primary input is Blisters; a derived tablet count renders live labeled "derived (blisters × N)" and is editable — an edited value is stored as entered and relabeled "entered as counted". Weight field remains, labeled "reference only" for pre-blistered types. `AddBagToReceiveInput` gains `blisterCount?: number | null`.

- [ ] **Step 1: createRawBagIntakeAtomic**

Read the function (`lib/db/queries/raw-bag-intake.ts:72`). Add `blisterCount` to the per-row insert values. Load the receiving tablet type's `isPreBlistered`/`tabletsPerBlister` where the function already loads the tablet type / PO line, pass it to `validateBagRowSeeds` (Task 10 signature), and refuse with the returned issues exactly as the function surfaces existing validation issues. When a pre-blistered row arrives with `blisterCount` set and no explicit pill count, set `pillCount = deriveTabletsFromBlisters(...)`.

- [ ] **Step 2: Receive wizard**

In `receive-wizard.tsx`: where per-bag rows render count/weight inputs, branch on the selected tablet type's `isPreBlistered` (the wizard already knows the tablet type from the PO line — add the two new columns to whatever query feeds it). Pre-blistered row: "Blisters" number input (required, min 1), "Tablets" input auto-filled `blisters × tabletsPerBlister` with sublabel `derived (N per blister)`, becoming `entered as counted` once the operator edits it (track a `touched` boolean per row); weight input keeps working but its sublabel reads `reference only — not used for counting`. Guard: if the tablet type is pre-blistered but `tabletsPerBlister` is null (cannot happen post-migration constraint, but the row may predate a partial save), show "Configure tablets per blister on the tablet type first" and block submit.

- [ ] **Step 3: Manual add-bag path (TDD on the pure part)**

Extend `lib/receive/add-bag.ts`:

```ts
export type AddBagToReceiveInput = {
  // ...existing fields...
  blisterCount?: number | null;
};
```

Add to `validateAddBagInput` a new optional context arg `tabletType?: { isPreBlistered: boolean; tabletsPerBlister: number | null }` with rules mirroring Task 10 (pre-blistered requires `blisterCount >= 1`; loose refuses it). Failing test first in `lib/receive/add-bag.test.ts`:

```ts
it("pre-blistered add-bag requires a blister count", () => {
  const r = validateAddBagInput(
    { addReason: "recount" },
    1,
    { isPreBlistered: true, tabletsPerBlister: 10 },
  );
  expect(r.ok).toBe(false);
});
```

Then thread through `receive-add-bag.ts` (write `blisterCount`, derive `pillCount` when absent), `actions.ts` (parse `blisterCount` like `declaredPillCount`), and `add-bag-form.tsx` (conditional field, same derived/entered labeling as the wizard).

- [ ] **Step 4: Tests + typecheck**

Run: `npx vitest run lib/receive lib/production lib/db && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A lib/receive lib/db/queries app/\(admin\)/inbound lib/production
git commit -m "feat(intake): blister-count intake for pre-blistered stock (wizard + manual add)"
```

---

### Task 12: Surfaces + reconciliation verification

**Files:**
- Modify: `lib/floor-command/production-lines.ts` + the bag chip component it feeds (grep the file's exports' consumers) — "Pre-blistered" badge
- Modify: `app/(admin)/inbound/[id]/page.tsx` — show `Blisters: N` beside pill count when `blister_count` is not null
- Test: `lib/ops/roll-yield-reconciliation` scoping test (find its test file; extend), plus a queue-transitions flow test

**Interfaces:**
- Consumes: effective-route resolution (Task 4), `inventoryBags.blisterCount` (Task 1).
- Produces: floor board bag chips for pre-blistered bags carry a small neutral chip labeled `Pre-blistered` (text chip per repo chip idiom, no emoji); inbound bag rows show the blister count; a test proves roll-yield reconciliation ignores bags with no blister events; a pure flow test proves the queue walk end-to-end.

- [ ] **Step 1: Flow test (pure, no DB)**

In `lib/production/engine/queue-transitions.test.ts` (extend, following its existing scenario style), add a PRE_BLISTERED_CARD scenario using the Task 2 graph fixture:

```
CARD_ASSIGNED at SEALING station  -> WORKING, queueStageKey SEALING_QUEUE, claimed by that station
SEALING_COMPLETE                  -> READY/advance toward PACKAGING_QUEUE (assert against how the
                                     existing CARD_BLISTER scenario asserts its post-sealing transition)
BAG_FINALIZED at PACKAGING        -> REMOVE
```

Assert intermediate destinations with the same helpers the file uses for the CARD_BLISTER walk. Expected first: FAIL only if Tasks 2/4 missed something — this is the integration checkpoint; fix whatever it exposes.

- [ ] **Step 2: Roll-yield scoping test**

Read `lib/ops/roll-yield-reconciliation` (explorer path: `lib/production/roll-yield-reconciliation.ts` or `lib/ops/` — locate with `grep -rn "roll-yield" lib --include="*.ts" -l`). Confirm its bag population is keyed off blister events/machines (BLISTER_COMPLETE, active_rolls at blister machines). Add a test: a bag whose event history contains no BLISTER_COMPLETE contributes zero expected roll consumption / is absent from the reconciler's population. If the reconciler turns out to sweep all CARD bags regardless of events, add an explicit route guard (skip bags whose effective route is PRE_BLISTERED_CARD) — and say which branch you took in the commit body.

- [ ] **Step 3: Floor board badge**

In the floor-command bag chip: the data feeding chips must expose `isPreBlistered` — extend the board's bag query with the `tablet_types.is_pre_blistered` join (same join as Task 6's SQL). Chip: text `Pre-blistered`, styled like the repo's existing neutral/slate chips (find an existing chip in the floor-command components and copy its classes).

- [ ] **Step 4: Inbound bag display**

In `app/(admin)/inbound/[id]/page.tsx`, where a bag row prints pill counts: when `blisterCount != null`, add `· {blisterCount} blisters`. Do not print anything blister-related when null (missing is not zero).

- [ ] **Step 5: Tests + typecheck**

Run: `npx vitest run lib && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A lib app/\(admin\)/inbound
git commit -m "feat(floor): pre-blistered badge, blister display, reconciliation scoping proof"
```

---

### Task 13: Closeout — suite, docs, release

**Files:**
- Modify: `docs/PRODUCT_ONBOARDING_AND_EXTENSIBILITY.md` (§2 hardcode-site audit: mark the sites this plan route-parameterized — stage lexicon entry added, sealing prereqs now route-aware, fresh-bag-start now tablet-type-driven, queue routing assignment-aware; §7 gains a short "pre-blistered card" worked example referencing the spec)
- Modify: `package.json` version -> `1.37.0`
- Modify: `CHANGELOG.md` if the repo keeps one (check root)

**Interfaces:** none — verification and release only.

- [ ] **Step 1: Full verification (luma-test-build-deploy shape)**

Run, in order, and paste real output in the task report:

```bash
npm run typecheck
npm run lint
npx vitest run
npm run build
```

Expected: all clean/green. Any failure: fix before proceeding (systematic-debugging if non-obvious).

- [ ] **Step 2: Docs + version**

Update the extensibility doc sections named above; bump version; commit:

```bash
git add -A docs package.json
git commit -m "chore(release): v1.37.0 pre-blistered product route"
```

- [ ] **Step 3: Merge/push per repo flow**

Follow superpowers:finishing-a-development-branch — merge the worktree branch into `main` only with the suite green, push, then confirm deploy: the LXC 122 systemd timer pulls `main` within 60s; verify the health endpoint reports the new SHA before declaring done. After deploy, run `npm run rebuild:read-models` on the LXC (established practice after projector changes; no pre-blistered bags exist yet, so this is belt-and-braces for the queue-state SQL change).

- [ ] **Step 4: Onboarding note for the operator (you)**

Report to the user the no-SQL onboarding path: create tablet types (pre-blistered + tablets per blister) -> create products (kind CARD, route Pre-blistered) -> allowed tablets -> BOM without PVC/foil rolls -> receive against tablet PO lines entering blister counts -> floor starts these bags at sealing.
