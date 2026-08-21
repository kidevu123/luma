# Pre-Blistered Product Route — Design

Date: 2026-08-21
Status: Approved (sections 1–5 reviewed interactively; 6–7 summarized)

## Problem

A new product line arrives from suppliers **pre-blistered**: tablets already
formed, filled, and foil-sealed in blister strips. The floor still heat-seals
the blisters onto printed cards and packages them, but the blister operation
(and its PVC/foil roll consumption) must be skipped entirely. Luma's card
route today is fixed: BLISTER -> SEALING -> PACKAGING.

## Decisions (confirmed with owner)

1. **Remaining work**: sealing + packaging. First station is SEALING.
2. **Intake unit**: track both explicitly — blister count for floor work,
   tablet count for yield/Zoho reconciliation.
3. **Route setup**: a product-form option (kind CARD + "pre-blistered"
   selector), not migration-per-product and not a general route admin page.
4. **Form scope**: pre-blistered is a **fixed property of the tablet type /
   product**. The same tablet type never arrives both loose and
   pre-blistered. No per-bag form flag.

## Approach (chosen: A)

New `PRE_BLISTERED_CARD` route seeded in the data-driven route tables,
mirroring the shipped `STICKER_ONLY` precedent (a route that simply omits
upstream ops). Products stay `kind=CARD`; assignment happens via
`product_route_assignments`, which gains its first write path (the product
form). Requires making the queue projector's route resolution
assignment-aware (fixing a known split-brain) and adding targeted per-route
entries to the still-hardcoded stage tables.

Rejected: **B** — new `product_kind=PRE_BLISTERED` (fans out across ~25
files switching on kind; semantically wrong, the finished good is a card).
**C** — per-call skip flag a la `packagingPartialSealedReady` (stage
progression spaghetti; the route graph exists to avoid this).

## Section 1: Data model

### New route (seed migration, no new tables)

`production_routes` row `PRE_BLISTERED_CARD`, `route_operations` reusing
existing operation types from the card line minus the blister ops:

```
RECEIVING_QUEUE (staging op, no station kind)
  -> SEALING_QUEUE (sealing op, allowed_station_kind SEALING)
  -> POST_SEAL_STAGING (staging op)
  -> PACKAGING_QUEUE (packaging op, allowed_station_kind PACKAGING)
  -> FINISHED_GOODS_QUEUE
```

Satisfies the route-graph build invariants (peer ops at one stage_key share
`next_stage_key` — trivially true, no peers). Timer/counter/scan flags on
each op copied from the corresponding `CARD_BLISTER` ops.

### tablet_types — two new columns (additive)

- `is_pre_blistered boolean not null default false`
- `tablets_per_blister integer` nullable; check constraint: required and > 0
  when `is_pre_blistered`.

Lives on `tablet_types` (not `products`) because intake is denominated in
tablet types (`inventory_bags.tablet_type_id`) and the form is fixed per
product — every bag of a pre-blistered type is blister stock.

### inventory_bags — one new column

- `blister_count integer` nullable; populated only for pre-blistered types.

`pill_count` stays NOT NULL and stores the tablet count, so all
tablet-denominated consumers (reconciliation, Zoho pushes,
expected-consumption math) work untouched.

### product_route_assignments

No schema change. Gains its first write path (product form). The existing
partial unique index (one active default per product) is sufficient.

### No enum changes

No new `product_kind`, `station_kind`, `workflow_event_type`, or bag stages.
The route reuses `SEALING_COMPLETE` / `PACKAGING_COMPLETE` as-is.

All migrations additive-only per `luma-drizzle-migration`; mirrored in
`lib/db/schema.ts`.

## Section 2: Route resolution and product setup

### Product form

Product create/edit dialog gains a route selector, shown only for
`kind=CARD`: "Standard (blister on-site)" vs "Pre-blistered", defaulting to
Standard. Choosing Pre-blistered upserts an active default
`product_route_assignments` row -> `PRE_BLISTERED_CARD`; switching back
deactivates it (`is_active=false`, soft only). Mutation writes `audit_log`.

**Guard**: route change is blocked while the product has open workflow bags
(a STARTED bag on the new route has no BLISTERED stage to reach; switching
mid-flight strands bags). Clear error message; idle/new products switch
freely.

### Assignment-aware queue routing (split-brain fix)

`resolveRouteCodeForQueue` (`lib/projector/bag-queue.ts:44`) currently
resolves from `products.kind` only. It becomes assignment-aware: consult
`product_route_assignments` first (same precedence as `getRouteForProduct`
in `lib/production/routes.ts`), fall back to the legacy kind mapping.
Invariant: **station view, advanceBag, and the queue projector must all
agree on a bag's route.** Consolidate the duplicate resolver
(`resolveRouteForProduct` in `lib/production/product-structure.ts:566`) onto
the canonical `getRouteForProduct`.

### Route-graph cache

`loadRouteGraph`'s process-lifetime memoization survives unchanged: route
*definitions* still change only via migration+deploy; product->route
assignment is resolved per-lookup, not baked into the graph cache.

### Tablet-type form

Gains `is_pre_blistered` checkbox + `tablets_per_blister` field.
Cross-validation at product save (not a DB constraint): a pre-blistered
product may only have pre-blistered tablet types in
`product_allowed_tablets`, and vice versa. Additionally
`products.tablets_per_unit % tablet_types.tablets_per_blister == 0` (a card
must hold a whole number of blisters).

## Section 3: Receiving and intake

- **PO side unchanged.** Still tablet PO lines (`po_lines.tablet_type_id`);
  the pre-blistered fact rides on the tablet type. `is_tablet_po` untouched.
- **Bag intake adapts by tablet type.** For a pre-blistered type the primary
  input is **blister count**; tablet count = blisters x
  `tablets_per_blister`, shown live and stored in `pill_count`. Receiver may
  override the derived tablet count (damaged strips); the override is stored
  as entered, both values kept, and the UI labels the count "derived" vs
  "entered as counted" per `luma-data-honesty`.
- **Weight-based pill estimation suppressed** for pre-blistered types
  (weight includes foil/PVC). `weight_grams` stays optional/informational.
- `declared_pill_count` keeps its meaning (vendor claim, in tablets).
- **Small boxes / QR spine / batch linkage unchanged** — form-agnostic.
- **Zoho unchanged** — raw-bag receive pushes stay tablet-denominated from
  `pill_count`, via the gateway as always.
- **Validation**: intake refuses a pre-blistered type missing
  `tablets_per_blister` (friendly form guard) and refuses blister count 0.

## Section 4: Floor flow — starting at sealing, stage progression

Bag lifecycle on the new route: `CARD_ASSIGNED -> STARTED -> SEALED ->
PACKAGED -> FINALIZED`. `BLISTERED` never occurs.

- **Fresh bag start becomes route-graph-derived.** Replace the static
  `FIRST_OP_STATION_KINDS` check in `resolveFreshBagStart`
  (`lib/production/fresh-bag-start.ts`) / `lib/production/first-op-product.ts`
  with: a station kind may start a fresh bag for a product iff it matches
  the first stationed op on that product's route. Sealing therefore still
  refuses standard card bags (first op = blister) but accepts pre-blistered
  ones. Retires one hardcode site from
  `docs/PRODUCT_ONBOARDING_AND_EXTENSIBILITY.md` §2. Product selection at
  sealing already exists (`lib/production/sealing-product.ts`).
- **Completion gating route-parameterized (targeted).**
  `EVENT_STAGE_PREREQ` for `SEALING_COMPLETE` / `SEALING_SEGMENT_COMPLETE`
  becomes per-route: `BLISTERED` on `CARD_BLISTER` (as today), `STARTED` on
  `PRE_BLISTERED_CARD`. Same pattern as the route-parameterized
  `QUEUE_FOR_BAG_STAGE`. No wholesale graph-derivation of prereqs in this
  change. All other events untouched.
- **Already works untouched**: `STATION_PICKUP_FROM_STAGE` already lets
  SEALING claim a STARTED bag (overlap claiming); `ALLOWED_EVENTS_BY_KIND`
  already lets sealing fire `SEALING_COMPLETE`; everything from SEALED
  onward (packaging, partials, QR lifecycle, holds) is identical to the
  standard card line.
- **Never engages, no suppression needed**: blister cycle math, roll
  segments, blister counters, blister standards — all keyed off the blister
  op running.
- **Stage lexicon**: `QUEUE_FOR_BAG_STAGE`
  (`lib/production/engine/stage-lexicon.ts`) gains a `PRE_BLISTERED_CARD`
  block (`STARTED -> SEALING_QUEUE`, `SEALED -> PACKAGING_QUEUE`, ...)
  following the `STICKER_ONLY` entry's shape.

## Section 5: Projections, queues, and boards

- **Queue projection**: with `resolveRouteCodeForQueue` assignment-aware,
  the queue projector uses the route-parameterized lexicon so a
  pre-blistered STARTED bag lands in `SEALING_QUEUE`, never
  `BLISTER_QUEUE`. Fix the static `STAGE_DEFS` assumption in
  `lib/projector/queue-state.ts` and `QUEUE_STAGE_TO_BAG_STAGES` in
  `lib/production/metrics.ts` the same way.
- **Floor board**: no new lane. Pre-blistered bags ride the card line,
  first appearing in the sealing lane, with a small "Pre-blistered" text
  badge (Lucide + chip, no emoji) on the bag chip.
  `lib/floor-command/production-lines.ts` gets the badge only.
- **Read models**: `read_bag_state` unchanged (stage vocabulary already
  covers the route). `read_daily_throughput` blistered column stays 0 for
  these products — the truth; Grafana untouched. `read_station_live` / SSE
  unchanged. `read_material_burn`: printed `BLISTER_CARD` cards still
  consumed at sealing per BOM; pre-blistered products' BOMs simply exclude
  PVC/foil rolls.
- **Rebuild**: `npm run rebuild:read-models` picks up the assignment-aware
  resolver automatically. No backfill or forced rebuild at deploy (no
  existing product is on the new route).

## Section 6: Reconciliation, materials, genealogy

- **Expected tablet consumption** for pre-blistered bags is attributed at
  the sealing op: expected tablets = cards sealed x
  `products.tablets_per_unit`. Blister count is the secondary check:
  expected blisters = cards sealed x (`tablets_per_unit` /
  `tablets_per_blister`). The divisibility validation (Section 2)
  guarantees this is a whole number. `lib/production/expected-tablet-consumption.ts`
  and the reconciliation modules gain the route-aware attribution point;
  the math itself is unchanged (integers throughout).
- **Roll-yield reconciliation** (`roll-yield-reconciliation.ts`,
  `active_rolls`, roll segment ledger) never engages: these bags never
  touch a blister machine. Verify at implementation that the reconciler
  scopes by blister ops/machines; add an explicit route guard only if it
  does not.
- **Genealogy unchanged**: `finished_lots` / `finished_lot_inputs` link
  finished lots to input batches exactly as today. Pedigree queries work
  as-is.
- **Zoho output push unchanged.**

## Section 7: Error handling, testing, rollout

### Error paths

- Intake: pre-blistered type without `tablets_per_blister` -> friendly form
  guard; blister count 0 refused.
- Product save: route change with open workflow bags -> blocked with clear
  message. Mixed loose/pre-blistered tablet types on one product ->
  validation error. `tablets_per_unit` not divisible by
  `tablets_per_blister` -> validation error.
- Floor: scanning a standard-card product's bag at sealing for fresh start
  -> refused with the existing "wrong station" UX (route-derived).
- Batch status rule unchanged: production refuses a workflow bag whose
  input batch is not RELEASED.

### Testing

- Unit: route graph build for `PRE_BLISTERED_CARD`; graph-derived
  fresh-bag-start eligibility (sealing accepts pre-blistered, refuses
  standard card; blister unchanged); route-parameterized sealing prereqs;
  queue lexicon for the new route; intake derivation + override; product
  form assignment write path + guards; divisibility/compatibility
  validations.
- Projector: queue-state routes pre-blistered STARTED bags to
  SEALING_QUEUE; standard routes unchanged.
- Flow test: receive (blister-denominated) -> fresh start at sealing ->
  SEALING_COMPLETE -> packaging -> finalize; genealogy + reconciliation
  assertions.
- Regression gate: full suite (5.5K+ tests) green — standard card, bottle,
  and sticker route behavior must be unchanged.

### Rollout

1. Additive migrations (enum-free; table DDL + seed).
2. Deploy via normal pipeline (typecheck + lint + suite gate, push to
   `main`, systemd timer deploy, health-SHA confirm).
3. Onboard the new tablet types (pre-blistered + tablets_per_blister) and
   products (kind CARD + Pre-blistered route option) through the admin UI.
   No SQL required.
