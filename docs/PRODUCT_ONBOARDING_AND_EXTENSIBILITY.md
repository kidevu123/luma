# Product onboarding & extensibility audit

**Branch:** `production-intelligence-command-center`
**Audit date:** 2026-05-06
**Last updated:** 2026-05-07 — H.x0.5 generic item structure + Zoho foundation landed (migration `0014_generic_item_structure`).
**Status:** Compatibility layer in place. Read-side helpers route-aware AND structure-aware; write side and floor remain on legacy enums. See companion doc `docs/PRODUCT_STRUCTURE_AND_ZOHO_ITEMS.md` for the structure layer.

---

## Why this document exists

Luma must let an admin onboard a new product (new SKU, new packaging format, new route, new stations) **without code changes**.

Today's app supports two routes: card / blister, and bottle. The data model and UI assume those two. If we add a third route — say, a stickered powder pouch, or a co-packed kit — the spec is currently to either (a) jam it into one of the two routes by abusing fields, or (b) edit half a dozen TS files and ship a migration. Neither is acceptable as a long-term answer.

This audit pins exactly **where** the two-route assumption is hardcoded, exactly **what** is already flexible, and exactly **what tables we would add** to make Luma route-agnostic. It does not refactor any of it. It is the contract we hold ourselves to before writing code for the next product.

---

## 1. Current flexibility — what already supports any product

These pieces are already generic. New products / materials / standards can be added by data-only operations on these:

| Surface | Why it's already flexible |
|---|---|
| `workflow_events` (`lib/db/schema.ts:881`) | Append-only; `payload jsonb`. The body of any event is unconstrained. New payload shapes don't need migrations. |
| `workflow_bags` (`lib/db/schema.ts`) | A bag is a unit of work, not a card or a bottle. The bag itself is route-agnostic. |
| `products` table (`lib/db/schema.ts:310`) | Has `kind`, `sku`, `tablets_per_unit`, `units_per_display`, `displays_per_case`, `default_shelf_life_days`. Adding a product means a row, not a migration — provided the product fits one of the existing kinds. |
| `tablet_types` table (`lib/db/schema.ts:280`) | Raw-material catalog; no enum. A new pill is a row insert. |
| `packaging_materials` table (Phase H) + `packaging_material_kind` enum | The enum has 14 values now (`BLISTER_FOIL`, `HEAT_SEAL_FILM`, `BOTTLE`, `CAP`, `INDUCTION_SEAL`, `LABEL`, `DESICCANT`, `COTTON`, `DISPLAY`, `CASE`, `INSERT`, `OTHER`, `PVC_ROLL`, `FOIL_ROLL`, `SHRINK_BAND`). A new packaging *kind* needs a migration; a new packaging *item* of an existing kind is just a row. |
| `product_packaging_specs` (BOM) | Per-product, per-material, per-scope (UNIT/DISPLAY/CASE) with qty + waste %. Generic; adding a product's BOM is data entry. |
| `blister_material_standards` (Phase H) | Per-material, per-role, per-effective-from. Generic; supports any roll-based consumption rate. |
| `station_standards` (`lib/db/schema.ts:1312`) | Per `(product, station, machine, output_unit, ideal_cycle_seconds, target_units_per_hour, effective_from)`. Generic across product & station. |
| `due_targets` (Phase A) | Per-product, per-target-unit, per-due-date. Generic. |
| `production_calendars` (Phase A) | Working-hours definitions. Not coupled to any route. |
| `labor_rates` (Phase A) | Optional. Not coupled to any route. |
| Read models — `read_bag_state`, `read_bag_metrics`, `read_daily_throughput`, `read_operator_daily`, `read_material_burn`, `read_sku_daily`, `read_material_reconciliation`, `read_station_quality_daily`, `read_material_lot_state`, `read_material_consumption_daily`, `read_roll_usage` | Tables themselves are general; the *projector logic that fills them* is what's hardcoded (see §2). |
| Metric API (`lib/production/metrics.ts`) `MetricResult` envelope | Returns `{ value, unit, confidence, missingInputs, label, explanation }` with no per-route assumption. The *queries inside* the derive functions sometimes assume two routes (see §2). |

**Summary:** the long tail (BOM, materials, standards, due targets, calendar, labor rates) is already configuration-driven. The short tail (route, operation, stage, station kind, machine kind) is not.

---

## 2. Current hardcoded assumptions — what would break if you added a third route

These are the spots where the codebase says "there are exactly two routes (CARD and BOTTLE), and the operations / stations / events for each are these specific values." Each must change to onboard a non-card, non-bottle product without code edits.

### 2.1 Schema-level enums (DDL changes required to extend)

| Enum | Location | Values | Impact |
|---|---|---|---|
| `product_kind` | `lib/db/schema.ts:76` | `CARD`, `BOTTLE`, `VARIETY` | A new route's product (e.g. `POUCH`, `KIT`) cannot exist without a migration. |
| `machine_kind` | `lib/db/schema.ts:56` | `BLISTER`, `SEALING`, `PACKAGING`, `BOTTLE_HANDPACK`, `BOTTLE_CAP_SEAL`, `BOTTLE_STICKER`, `COMBINED` | A new machine type (e.g. `POUCH_FILLER`) cannot exist without a migration. |
| `station_kind` | `lib/db/schema.ts:66` | same 7 as machine_kind | Same problem; floor scan stations are tightly coupled to operation type. |
| `workflow_event_type` | `lib/db/schema.ts:158` | 30+ values, all named after the current two routes' stages (`BLISTER_COMPLETE`, `BOTTLE_STICKER_COMPLETE`, etc.) | A new operation (e.g. `POUCH_FILL_COMPLETE`) cannot fire an event without a migration. |
| `workflow_event_type` enum | same | semantics are baked into the *names* of the values | Even with `payload jsonb`, the projector dispatch is keyed by `event_type` string. |

**Pattern:** today, "what operations exist" lives in a Postgres enum, not a table. Onboarding a new product type requires a DDL change.

### 2.2 Projector dispatch hardcoded by event_type

`lib/projector/index.ts:58–82`

```ts
const STAGE_FOR_EVENT: Record<string, string> = {
  CARD_ASSIGNED: "STARTED",
  BLISTER_COMPLETE: "BLISTERED",
  SEALING_COMPLETE: "SEALED",
  PACKAGING_SNAPSHOT: "PACKAGED",
  PACKAGING_COMPLETE: "PACKAGED",
  BOTTLE_HANDPACK_COMPLETE: "BLISTERED",
  BOTTLE_CAP_SEAL_COMPLETE: "SEALED",
  BOTTLE_STICKER_COMPLETE: "PACKAGED",
  BAG_FINALIZED: "FINALIZED",
};

const THROUGHPUT_COLUMN: Record<string, string> = {
  BLISTER_COMPLETE: "bags_blistered",
  BOTTLE_HANDPACK_COMPLETE: "bags_blistered",
  // ...
};
```

A third route's events would not increment any counter and would not advance any bag stage. The projector would silently no-op.

### 2.3 Floor station — allowed-events table is hardcoded

`app/(floor)/floor/[token]/actions.ts:74`

```ts
const ALLOWED_EVENTS_BY_KIND: Record<string, string[]> = {
  BLISTER:           ["BLISTER_COMPLETE"],
  SEALING:           ["SEALING_COMPLETE"],
  PACKAGING:         ["PACKAGING_SNAPSHOT", "PACKAGING_COMPLETE"],
  BOTTLE_HANDPACK:   ["BOTTLE_HANDPACK_COMPLETE"],
  BOTTLE_CAP_SEAL:   ["BOTTLE_CAP_SEAL_COMPLETE"],
  BOTTLE_STICKER:    ["BOTTLE_STICKER_COMPLETE"],
  COMBINED:          [/* card stages only */],
};
```

This is the floor's authority on "what scan can fire what event." A station of a new kind would be unable to fire any event.

### 2.4 Metric API — route lexicon is a TS literal type

`lib/production/types.ts:144–146`

```ts
export const ROUTES = ["CARD", "BOTTLE"] as const;
export type Route = (typeof ROUTES)[number];
```

`lib/production/sql.ts:12`

```ts
export const ROUTE_TO_MACHINE_KINDS: Record<Route, ReadonlyArray<string>> = {
  CARD:   ["BLISTER", "SEALING", "PACKAGING"],
  BOTTLE: ["BOTTLE_HANDPACK", "BOTTLE_CAP_SEAL", "BOTTLE_STICKER"],
};
```

`deriveRouteMetrics` and most aggregations are keyed by this map. A new route requires a code edit.

### 2.5 Stage key set is also a TS literal

`lib/production/types.ts:131`

```ts
export const STAGE_KEYS = [
  "BLISTER_QUEUE", "POST_BLISTER_STAGING", "SEALING_QUEUE",
  "POST_SEAL_STAGING", "PACKAGING_QUEUE",
  "BOTTLE_FILL_QUEUE", "BOTTLE_STICKER_QUEUE", "BOTTLE_INDUCTION_QUEUE",
  "FINISHED_GOODS_QUEUE",
] as const;
```

Used by `read_queue_state`, by the floor-board process map, and by every queue-aging calculation. Tied to today's two routes.

### 2.6 Read-model fill rules are keyed by `product.kind`

`lib/projector/queue-state.ts:66–74`

```ts
BLISTER_QUEUE:     { bagStages: ["STARTED"], productKind: "CARD"   },
BOTTLE_FILL_QUEUE: { bagStages: ["STARTED"], productKind: "BOTTLE" },
```

Each queue's definition filters by `product.kind`. Adding a new kind silently produces empty queues.

### 2.7 Workflow event payload shape is loose, but the floor's UI is not

The payload column itself is `jsonb` — flexible. But:

- The floor UI's stage-action buttons (`app/(floor)/floor/[token]/stage-action-buttons.tsx`) hardcode button labels and which event types each station kind fires.
- The legacy synthesizer maps machine.kind → event_type by literal string match.

### 2.8 Quality checks — there is no model

There is no `quality_checks` table, no `quality_check_results` table, no FK from a workflow event to a check definition. Today, "damage" is captured as a `PACKAGING_DAMAGE_RETURN` event with payload data; "quality" is captured implicitly by `read_station_quality_daily` aggregating events. There is no way for an admin to define a new quality check (e.g. "verify torque on cap") without writing code.

---

## 3. Proposed product onboarding model

The model below is the **target** state. It does *not* need to be built before H.x3/H.x4. It is the lens through which any future feature should be designed.

The principle: lift today's enums into tables. Today's CARD / BOTTLE flows become **rows in a `routes` table**, not branches in code.

### 3.1 New tables

```text
operation_types (catalog of generic operation kinds)
─────────────────────────────────────────────────
id                 uuid pk
code               text unique          -- e.g. "BLISTER", "SEAL", "FILL", "STICKER"
display_name       text
counter_required   boolean              -- floor enters a count?
timer_required     boolean              -- floor measures cycle time?
output_unit        text                 -- 'cards' | 'bottles' | 'pouches' | …
allowed_station_kinds  text[] (or join table operation_station_kinds)
default_event_code text                 -- e.g. "BLISTER_COMPLETE"
is_active          boolean

routes
────────────
id          uuid pk
code        text unique                 -- "CARD", "BOTTLE", "POUCH", "KIT"
display_name text
is_active   boolean
created_at  timestamptz

route_operations  (ordered list)
────────────────────────────────
route_id          uuid fk → routes
position          integer              -- 1, 2, 3, …
operation_type_id uuid fk → operation_types
required          boolean              -- some routes have optional steps
counter_required  boolean              -- override of operation default
output_unit       text                 -- override
next_position     integer              -- for branching routes (rework)
rework_position   integer              -- where rework sends a bag back to
primary key (route_id, position)

products  (extend existing table)
────────────────────────────────
+ route_id        uuid fk → routes      -- which route this product follows
- kind            (deprecate eventually; keep for backwards-compat during cutover)

station_kinds  (lift the enum into a table)
───────────────────────────────────────────
id          uuid pk
code        text unique                 -- "BLISTER", "SEALING", "BOTTLE_FILL", "POUCH_FILL"
display_name text
allowed_operation_codes  text[]         -- which operation codes this kind can fire
is_active   boolean

machine_kinds  (lift the enum into a table)
──────────────────────────────────────────
id, code, display_name, is_active

quality_checks   (catalog of optional checks)
─────────────────────────────────────────────
id           uuid pk
code         text unique                -- "COUNT_VERIFY", "SEAL_INSPECT", "TORQUE_CHECK"
display_name text
result_kind  enum('BOOLEAN','PASS_FAIL_NOTE','MEASUREMENT','PHOTO')
unit         text                       -- when measurement, e.g. 'gf-cm'
acceptance   jsonb                      -- bounds, regex, etc.
photo_required boolean
supervisor_required boolean
is_active    boolean

route_quality_checks
───────────────────
route_id          uuid fk
operation_position integer              -- which operation in the route
quality_check_id  uuid fk
required          boolean
primary key (route_id, operation_position, quality_check_id)

quality_check_results   (event-sourced, like workflow_events)
────────────────────────────────────────────────────────────
id              uuid pk
workflow_bag_id uuid fk
station_id      uuid fk
quality_check_id uuid fk
result          jsonb                   -- shape determined by check.result_kind
photo_path      text
operator_id     uuid fk → users
supervisor_id   uuid fk → users
recorded_at     timestamptz
client_event_id uuid                    -- idempotency

production_standards   (rename of station_standards once route-aware)
───────────────────────────────────────────────────────────────────
+ route_id        uuid fk → routes      -- existing (product, station, machine) keys stay
+ operation_type_id  uuid fk → operation_types
```

The above is a target model — not a migration to apply now. It is the shape every new feature should be steered toward.

### 3.2 Onboarding wizard (UI surface, draft)

A `/admin/products/new` wizard with 8 steps maps cleanly to the model above:

| Step | Writes to |
|---|---|
| 1. Identity (name, flavor, raw SKU, finished SKU, unit type, active) | `products` |
| 2. Route (pick route from `routes` table, including a "create custom" path that opens a sub-wizard for `route_operations`) | `products.route_id` (+ `routes` + `route_operations` if custom) |
| 3. Operations (pre-filled from chosen route; admin can override per-step counter/timer/output-unit) | `route_operations` overrides |
| 4. Packaging BOM | `product_packaging_specs` (already H.x5) |
| 5. Roll / material standards (only shown if route includes a `BLISTER`-class operation; auto-shown for `BOTTLE` operations) | `blister_material_standards` (already H.x5) |
| 6. Production standards (cycle time, target units/hour per operation) | `station_standards` / `production_standards` |
| 7. Quality checks (pick from `quality_checks` per operation; create new check inline if missing) | `route_quality_checks` |
| 8. Review & activate | gating: refuse `is_active = true` until BOM, standards, and checks for required operations are set |

The wizard is configuration over code. **No new conditional branches in the projector or the floor handler.**

---

## 4. Required future tables — what's missing

Already exist (Phase A + Phase H):
- `production_calendars`, `station_standards`, `labor_rates`, `due_targets`
- `packaging_materials`, `product_packaging_specs`, `blister_material_standards`, `material_inventory_events`

Missing for a fully data-driven model:
- `routes` ← lifts CARD / BOTTLE out of code
- `operation_types` ← lifts BLISTER / SEAL / FILL / STICKER / PACKAGE out of code
- `route_operations` ← ordered sequence per route
- `station_kinds` (table) + `machine_kinds` (table) ← lifts the enums into data
- `quality_checks` + `route_quality_checks` + `quality_check_results` ← gives admins a way to define checks
- `product_route` (or `products.route_id`) ← associates a product with its configured route

Optional but valuable:
- `route_templates` ← a snapshot of `route + operations + checks` that the wizard can clone
- `operation_aliases` ← maps legacy event_type strings to new `operation_type_id` so the existing data stays queryable across the cutover

---

## 5. How the current card / blister route maps to the generic model

Today's hardcoded card flow:

```
CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED
```

In the generic model:

```
routes:
  id=R1, code=CARD, display_name="Card / blister"

operation_types:
  id=O1, code=ASSIGN,    output_unit=cards,       default_event_code=CARD_ASSIGNED
  id=O2, code=BLISTER,   output_unit=blisters,    counter_required=true,  default_event_code=BLISTER_COMPLETE
  id=O3, code=SEAL,      output_unit=cards,       counter_required=true,  default_event_code=SEALING_COMPLETE
  id=O4, code=PACKAGE,   output_unit=cases,       counter_required=true,  default_event_code=PACKAGING_COMPLETE
  id=O5, code=FINALIZE,  output_unit=lots,                                default_event_code=BAG_FINALIZED

route_operations:
  R1, position=1, operation_type=O1
  R1, position=2, operation_type=O2
  R1, position=3, operation_type=O3
  R1, position=4, operation_type=O4
  R1, position=5, operation_type=O5

station_kinds:
  BLISTER, SEALING, PACKAGING, COMBINED
  (each with allowed_operation_codes that match)

route_quality_checks:
  R1, position=2 (BLISTER):    optional COUNT_VERIFY
  R1, position=3 (SEAL):       optional SEAL_INSPECT
  R1, position=4 (PACKAGE):    optional COUNT_VERIFY, optional PHOTO

products:
  any product with route_id = R1
```

The current behavior is preserved; the difference is that CARD is a row, not an enum.

---

## 6. How the current bottle route maps to the generic model

```
CARD_ASSIGNED → BOTTLE_HANDPACK_COMPLETE → BOTTLE_CAP_SEAL_COMPLETE → BOTTLE_STICKER_COMPLETE → BAG_FINALIZED
```

```
routes:
  id=R2, code=BOTTLE, display_name="Bottle"

operation_types (additions):
  id=O6, code=FILL,        output_unit=bottles, counter_required=true, default_event_code=BOTTLE_HANDPACK_COMPLETE
  id=O7, code=CAP_SEAL,    output_unit=bottles, counter_required=true, default_event_code=BOTTLE_CAP_SEAL_COMPLETE
  id=O8, code=STICKER,     output_unit=bottles, counter_required=true, default_event_code=BOTTLE_STICKER_COMPLETE

route_operations:
  R2, position=1, operation_type=O1   (ASSIGN — shared with card route)
  R2, position=2, operation_type=O6   (FILL)
  R2, position=3, operation_type=O7   (CAP_SEAL)
  R2, position=4, operation_type=O8   (STICKER)
  R2, position=5, operation_type=O5   (FINALIZE — shared)

station_kinds (additions):
  BOTTLE_HANDPACK, BOTTLE_CAP_SEAL, BOTTLE_STICKER
```

The bottle and card routes share the ASSIGN and FINALIZE operations; everything between is route-specific. This is exactly what the model is designed to express.

---

## 7. How a future new product would be added without code changes

Worked example: **A new product, "Liquid pouch SKU LP-30", which fills a stand-up pouch from a bulk tank, induction-seals it, weight-verifies, and packs into displays.**

Steps the admin takes — no code, no migrations:

1. `/settings/operation-types` — admin creates: `POUCH_FILL`, `POUCH_INDUCTION`, `WEIGHT_VERIFY`. Each carries its counter/timer/output-unit defaults.
2. `/settings/station-kinds` — admin creates: `POUCH_FILLER`, `POUCH_INDUCTION_SEALER` (each lists the operations it can fire).
3. `/settings/machine-kinds` — admin creates a `POUCH_LINE` machine kind.
4. `/settings/quality-checks` — admin creates `POUCH_WEIGHT` check (result_kind = MEASUREMENT, unit = g, acceptance = `{ min: 28, max: 32 }`).
5. `/settings/routes` — admin creates a new route `POUCH` with operations: `ASSIGN → POUCH_FILL → POUCH_INDUCTION → WEIGHT_VERIFY → PACKAGE → FINALIZE`. Attaches the `POUCH_WEIGHT` check to the `WEIGHT_VERIFY` step.
6. `/machines` — admin registers a physical `POUCH_LINE` machine and a `POUCH_FILLER`-kind station bound to it.
7. `/products/new` — onboarding wizard. Admin picks the new `POUCH` route. Step 4 prompts for BOM (bottle? no — pouch material lot, induction film, display, case). Step 5 prompts for material standards (g/pouch). Step 6 prompts for cycle time per operation. Step 7 confirms the WEIGHT check is wired. Step 8 warns "no labor rate set" but allows activate.
8. `/inbound/packaging-materials` — admin receives the pouch material lot.
9. Floor — operator scans station QR, scans card. The station's `station_kind` resolves to `POUCH_FILLER`; its allowed operations resolve from `station_kinds.allowed_operation_codes`. The bag advances through the new route. Each event lands in `workflow_events` with the `operation_type_id` recorded in payload (or as a new column). Read models pick it up because they're keyed by `route_id` + `operation_type_id`, not by hardcoded strings.

What the developer (you / I) does: **nothing**. The new product runs through the existing projector, the existing read models, the existing metric API, the existing UI.

What the developer must do today, without this model: write a migration that adds `POUCH` to `product_kind`, three values to `machine_kind`, three values to `station_kind`, four values to `workflow_event_type`, then add entries to `STAGE_FOR_EVENT`, `THROUGHPUT_COLUMN`, `ALLOWED_EVENTS_BY_KIND`, `ROUTES`, `ROUTE_TO_MACHINE_KINDS`, `STAGE_KEYS`. Six files and a migration to onboard one product.

---

## 8. Risks of continuing to hardcode today's process

**Engineering risks:**

1. **Migration bloat.** Each new product family triggers an enum-extension migration. Drizzle's `ALTER TYPE ADD VALUE` quirks (see `memory/drizzle-alter-type-gotcha.md`) make this riskier than other migrations.
2. **Projector dispatch divergence.** `STAGE_FOR_EVENT` and `THROUGHPUT_COLUMN` already double-up entries (CARD events + BOTTLE events fold into the same stage names). A third route makes this map fragile; mistakes here silently zero out KPIs.
3. **Floor handler conditional sprawl.** `ALLOWED_EVENTS_BY_KIND` will grow per route; each new route is a place to forget to add the new station-kind / event mapping.
4. **Metric API blind spots.** Several `derive*` functions short-circuit by route. New routes silently get MISSING confidence everywhere because no one updates the routing.
5. **Test coverage gaps.** Today's tests pin the existing two routes' empty-state vocabulary. Adding a third route quietly slips past the test suite without new tests.

**Business / operational risks:**

1. **Time-to-onboard climbs.** A new SKU on an existing route is currently fast. A new SKU on a *new* route is currently weeks (migration, code, test, deploy). The factory will encounter routes that didn't exist when the app was designed; if onboarding takes weeks, ops will route-pun (e.g. running a pouch through the bottle route by hand-coding a workaround), and dirty data accumulates.
2. **Standards / BOM drift.** Without a route abstraction, "standards for pouch fill" gets jammed into `blister_material_standards` (because that's where roll standards live) — corrupting the lexicon and the metric explanations.
3. **Floor confusion.** A station scoped to the wrong `station_kind` will silently refuse to fire some events. The operator gets a generic "operation not allowed" error with no path to fix.
4. **Reporting dishonesty.** A new product's events that don't appear in `STAGE_FOR_EVENT` produce no read-model rows. The floor-board shows that product as "no activity" — a false negative.
5. **Integration debt with Zoho / quality / labor.** Each system will grow per-route handling code if the model itself is per-route.

**Cumulative risk:** the current two-route assumption is already load-bearing in *seven* places (schema enums × 4, projector dispatch × 2, floor allow-list, metric route table, stage-key set, queue-state filter). Adding a third route without first lifting these into data multiplies the surface area of every future feature.

---

## What landed in Phase H.x0 — Route / Operation Compatibility Layer

### Tables added (migration `0013_route_operation_compat.sql`)

| Table | Purpose |
|---|---|
| `production_routes` | Lifts CARD / BOTTLE out of `product_kind`. Keyed by `code`. |
| `operation_types` | Catalog of operation kinds (RECEIVING, BLISTER, HEAT_SEAL, …). Carries `requires_timer / counter / machine / materials` flags + default `output_unit`. |
| `route_operations` | Ordered sequence of operations per route. Carries `stage_key`, `next_stage_key`, optional `rework_stage_key`, `allowed_station_kind`, `allowed_machine_kind`, plus per-operation `requires_*` overrides. |
| `product_route_assignments` | Many-to-many products↔routes with `is_default`, `effective_from / to`, partial-unique on (product, default, active). |
| `route_station_permissions` | Per-`route_operation` permission rows; can target by station_id, machine_id, station_kind, OR machine_kind (check constraint enforces at-least-one). |
| `quality_checks` | Catalog of quality-check definitions. Foundational only; UI behavior per check_type lands later. |
| `route_quality_checks` | Per-`route_operation` join with `is_required` and `sequence`. |

All tables are additive. No existing enum was removed or extended. No projector code changed. No floor handler changed.

### Seeded data

- **Routes:** `CARD_BLISTER`, `BOTTLE`, `STICKER_ONLY`.
- **Operation types:** `RECEIVING`, `BLISTER`, `POST_BLISTER_STAGING`, `HEAT_SEAL`, `POST_SEAL_STAGING`, `PACKAGING`, `BOTTLE_FILL`, `STICKERING`, `INDUCTION_SEAL`, `QA_HOLD`, `FINISHED_GOODS` — 11 entries.
- **route_operations:** 17 rows (CARD_BLISTER × 7 + BOTTLE × 6 + STICKER_ONLY × 4) wiring each route's ordered stages with their `stage_key` / `next_stage_key` / allowed kinds.

Migration is idempotent (`ON CONFLICT DO NOTHING`). Re-runs on a populated DB are safe.

### Mapping helpers — `lib/production/routes.ts`

| Helper | Behavior |
|---|---|
| `getRouteForProduct(productId)` | Resolves the active default route assignment; falls back to legacy `product.kind` mapping when no assignment exists; returns `{ source: "ASSIGNMENT" \| "LEGACY_KIND" \| "MISSING" }`. |
| `getRouteOperations(routeId)` | Ordered route_operations joined with `operation_types` for human labels. |
| `getOperationForStage(routeId, stageKey)` | Lookup the `route_operations` row that handles a given stage in a given route. Returns null when the route doesn't define that stage. |
| `getAllowedStationsForOperation(routeOperationId)` | Returns explicit `route_station_permissions` rows; falls back to the operation's own `allowed_station_kind / machine_kind` when no per-operation permissions exist. |
| `legacyProductKindToRoute(kind)` | Pure map: `CARD → CARD_BLISTER`, `BOTTLE → BOTTLE`, `VARIETY → CARD_BLISTER`. Returns null for unknown. |
| `legacyEventTypeToOperation(type)` | Pure map: workflow_event_type → operation_types.code. The single source of truth for the legacy event-name lexicon. |
| `legacyMachineKindToOperation(kind)` | Pure map: machine_kind → operation_types.code. |

The three legacy-mapping constants (`LEGACY_PRODUCT_KIND_TO_ROUTE`, `LEGACY_EVENT_TYPE_TO_OPERATION`, `LEGACY_MACHINE_KIND_TO_OPERATION`) are exported so any future migration can find every hardcoded translation in one place.

### How current CARD flow maps into route_operations

| Seq | operation_types.code | stage_key | next_stage_key | allowed_station_kind | allowed_machine_kind |
|---|---|---|---|---|---|
| 1 | RECEIVING | RECEIVING_QUEUE | BLISTER_QUEUE | – | – |
| 2 | BLISTER | BLISTER_QUEUE | POST_BLISTER_STAGING | BLISTER | BLISTER |
| 3 | POST_BLISTER_STAGING | POST_BLISTER_STAGING | SEALING_QUEUE | – | – |
| 4 | HEAT_SEAL | SEALING_QUEUE | POST_SEAL_STAGING | SEALING | SEALING |
| 5 | POST_SEAL_STAGING | POST_SEAL_STAGING | PACKAGING_QUEUE | – | – |
| 6 | PACKAGING | PACKAGING_QUEUE | FINISHED_GOODS_QUEUE | PACKAGING | PACKAGING |
| 7 | FINISHED_GOODS | FINISHED_GOODS_QUEUE | – | – | – |

This mirrors today's projector chain `CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED` — but the chain is now data, not a TS literal.

### How current BOTTLE flow maps into route_operations

| Seq | operation_types.code | stage_key | next_stage_key | allowed_station_kind |
|---|---|---|---|---|
| 1 | RECEIVING | RECEIVING_QUEUE | BOTTLE_FILL_QUEUE | – |
| 2 | BOTTLE_FILL | BOTTLE_FILL_QUEUE | BOTTLE_STICKER_QUEUE | BOTTLE_HANDPACK |
| 3 | STICKERING | BOTTLE_STICKER_QUEUE | BOTTLE_INDUCTION_QUEUE | BOTTLE_STICKER |
| 4 | INDUCTION_SEAL | BOTTLE_INDUCTION_QUEUE | PACKAGING_QUEUE | BOTTLE_CAP_SEAL |
| 5 | PACKAGING | PACKAGING_QUEUE | FINISHED_GOODS_QUEUE | PACKAGING |
| 6 | FINISHED_GOODS | FINISHED_GOODS_QUEUE | – | – |

CARD_BLISTER and BOTTLE share `RECEIVING`, `PACKAGING`, and `FINISHED_GOODS` — exactly as the design intends.

### What still remains hardcoded after H.x0

This phase intentionally did not touch the write path. The following sites still encode the two-route assumption and must be migrated in follow-up phases:

| Site | File | Why deferred |
|---|---|---|
| `STAGE_FOR_EVENT` map | `lib/projector/index.ts:58` | Projector dispatch by event_type. Migrating means refactoring the projector to look up `route_operations` by `(route_id, operation_code)` per event. |
| `THROUGHPUT_COLUMN` map | `lib/projector/index.ts:73` | Per-event-type counter. Same dependency as above. |
| `ALLOWED_EVENTS_BY_KIND` | `app/(floor)/floor/[token]/actions.ts:74` | Floor permission. Migrate to read from `route_station_permissions` once route is bound to the in-progress bag. |
| Stage-button UI | `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Hardcoded labels per station kind. Migrate to render from `route_operations` resolved for the bag's product. |
| `ROUTES`, `ROUTE_TO_MACHINE_KINDS`, `STAGE_KEYS` literal tuples | `lib/production/types.ts:131,144`, `lib/production/sql.ts:12` | Used by metric API + queue projector. Migrate to query from `production_routes` + `operation_types` once the metric layer can take a routeId argument. |
| `read_queue_state` `productKind` filter | `lib/projector/queue-state.ts:66` | Each queue definition filters by product.kind; should read from `route_operations.stage_key`. |
| `product_kind`, `machine_kind`, `station_kind`, `workflow_event_type` enums | `lib/db/schema.ts:56–158` | Removal is the final cutover — only after every read+write site reads from the new tables. Until then, the legacy enums remain authoritative for routing. |

### How H.x3, H.x4, H.x7 must use this layer

**Rule:** any new conditional that branches on product kind, route, station kind, or event type must check the route layer first.

- **H.x3** (PACKAGING_COMPLETE projector hook → MATERIAL_CONSUMED_ESTIMATED): when emitting the consumption event, resolve the bag's product → route → BOM via `getRouteForProduct(productId)` + the existing `product_packaging_specs`. Do NOT condition on `product.kind`. The BOM lookup is already kind-agnostic; the consumption code must be too.
- **H.x4** (mountRollAction / unmountRollAction / weighRollAction): when authorizing a station to mount a roll, prefer `getAllowedStationsForOperation(...)` over a hardcoded "BLISTER station only" check. For the v1 implementation, falling back to the legacy mapping is acceptable as long as the helper is the only call site (no inline `station.kind === "BLISTER"`).
- **H.x7** (read-only material UI panels): when rendering "active rolls per machine," compute the operation per route via `getOperationForStage` rather than assuming "blister machines = roll machines." A future roll-based operation on a non-blister route must surface in the same panel without code changes.

### Tests landed

`lib/production/routes.test.ts` — 24 cases covering:
- Legacy product-kind / event-type / machine-kind maps (3 × happy-path + null/undefined/empty + unknown returns null).
- Mapping completeness (every legacy value resolves to a seeded operation_code or route_code).
- Seed-data shape contracts (CARD_BLISTER has 7 ops, BOTTLE has 6, STICKER_ONLY has 4; sequences are dense; RECEIVING is first; FINISHED_GOODS is terminal; PACKAGING converges across routes).
- Extensibility contract (adding a new route requires only `INSERT` statements, no `ALTER TYPE`).

### Worked example — adding a new POUCH product after H.x0

1. `INSERT INTO production_routes (code, name) VALUES ('POUCH', 'Pouch fill')` — no migration.
2. `INSERT INTO operation_types (code, name, requires_counter, requires_timer, requires_machine, requires_materials, output_unit) VALUES ('POUCH_FILL', 'Pouch fill', true, true, true, true, 'pouches')` — no migration.
3. `INSERT INTO route_operations (route_id, operation_type_id, sequence, stage_key, next_stage_key, requires_scan, requires_counter, requires_timer, output_unit) VALUES (...)` × N for the pouch stages.
4. Onboard the product through `/products` (assign route via `product_route_assignments`).
5. Fill packaging BOM at `/settings/packaging-bom`.
6. Configure standards at `/settings/blister-standards` if it uses rolls.
7. Configure quality checks via `quality_checks` + `route_quality_checks` rows.
8. Activate.

Code changes: zero — provided H.x3, H.x4, H.x7 are written against the helpers, not against `product.kind`.

---

## What landed in Phase H.x0.5 — Generic product structure + Zoho foundation

**Migration:** `0014_generic_item_structure.sql` (additive, idempotent).

### Tables added

| Table | Purpose |
|---|---|
| `items` | Polymorphic identity layer over `tablet_types`, `packaging_materials`, `products`. Source rows backfilled with prefixed item codes (`TT:`, `PM:`, `PROD:`). |
| `item_conversions` | Generic "1 X contains N Y" with parent/child pack levels, per-product, optionally per-route. |
| `external_systems` | Registry of upstream systems (`ZOHO`, `PACKTRACK`, `NEXUS`, `QIP` seeded). |
| `external_item_mappings` | Maps `(external_system, external_item_id)` to a Luma item / product / packaging material. Default `mapping_type = UNKNOWN`. |
| `external_inventory_snapshots` | Append-only audit of upstream inventory data. Never mutates Luma genealogy. |

### How H.x0 routes and H.x0.5 product structure work together

The two layers answer different questions:

| Layer | Question | Tables |
|---|---|---|
| **Routes (H.x0)** | What stages does a product flow through? | `production_routes`, `operation_types`, `route_operations`, `product_route_assignments`, `route_station_permissions` |
| **Structure (H.x0.5)** | How does one item become another? How much of each input is needed? | `items`, `item_conversions` |
| **Materials (H.x foundation)** | What packaging materials are consumed? | `packaging_materials`, `product_packaging_specs`, `blister_material_standards` |
| **Identity (H.x0.5)** | How does Zoho map to our items? | `external_systems`, `external_item_mappings`, `external_inventory_snapshots` |

Together: a product has a route (stages), a structure (conversions), a BOM (materials), and one or more external mappings (Zoho today). All four are configurable. None requires code changes to add a new product.

### Helpers (`lib/production/product-structure.ts`)

| Function | Returns |
|---|---|
| `deriveProductStructure(productId)` | Ordered conversion chain (CASE → DISPLAY → ... → RAW). |
| `deriveItemConversionChain(itemId)` | Walks parent → child links from any starting item. |
| `convertItemQuantity(fromItemId, toItemId, quantity)` | Generic forward/inverse conversion. Returns `MetricResult`. |
| `deriveRequiredInputsForOutput(productId, qty, unit)` | "200 cases of X" → required displays + units + tablets. |
| `derivePackagingAndMaterialRequirements(productId, qty, unit)` | BOM × target with `combineConfidence` rollup. |

Every function returns `MetricResult` with `confidence` and `missingInputs`. Empty states use the canonical labels:

- `Product structure missing` → no `item_conversions`.
- `Product route missing` → no `product_route_assignments`.
- `Packaging BOM missing` → no `product_packaging_specs`.
- `Zoho item mapping missing` → Zoho-specific helpers only.

### Pages added

- `/settings/product-structure` — generic conversion editor. Pick a product, list active conversions, add/deactivate. Empty state surfaces "Product structure missing — configure item_conversions."
- `/settings/integrations/zoho-items` — placeholder with the seeded `external_systems` row + counts. Explains what's needed before the live sync lands.

### Zoho foundation

`lib/integrations/zoho/items.ts`:

| Function | Status |
|---|---|
| `getZohoSystemId()` | Live; reads seeded row. |
| `upsertExternalItemMapping(input)` | Live; idempotent; never overwrites non-null Luma references. |
| `recordExternalInventorySnapshot(input)` | Live; append-only. |
| `mapZohoItemToLumaItem(item)` | Pure classifier; conservative (returns UNKNOWN for ambiguous items). |
| `listZohoItems()` | **Stub** — throws `ZohoNotConfiguredError`. |
| `listZohoInventorySnapshots()` | **Stub** — throws `ZohoNotConfiguredError`. |

See `docs/ZOHO_ITEM_SYNC_PLAN.md` for the live-sync implementation plan.

### What still remains hardcoded

Carry-over from H.x0 (unchanged in H.x0.5):

| Site | File:line | Migration follow-up |
|---|---|---|
| Projector dispatch | `lib/projector/index.ts:58,73` | Migrate to `route_operations` lookup once write side is route-aware. |
| Floor allow-list | `app/(floor)/floor/[token]/actions.ts:74` | Read from `route_station_permissions`. |
| Floor stage buttons | `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Render from `route_operations` + `operation_types`. |
| Metric route literals | `lib/production/types.ts:131,144`; `lib/production/sql.ts:12` | Query `production_routes` + `operation_types`. |
| Queue projector kind filter | `lib/projector/queue-state.ts:66` | Read `stage_key` from `route_operations`. |
| Inline `zoho_item_id` columns | `tablet_types`, `packaging_materials`, `products` | Drop after every code path reads from `external_item_mappings`. |
| `product_kind`, `machine_kind`, `station_kind`, `workflow_event_type` enums | `lib/db/schema.ts:56–158` | Removal is the final cutover. Until then, the legacy enums remain authoritative for routing. |

### How new products should be configured without code changes

A new product walks all four layers as data:

| Step | Where | Acceptance |
|---|---|---|
| 1. Identity | `/products` (existing flow) + insert `items` row | Item code globally unique. |
| 2. Route | `/products/<id>` route picker (writes `product_route_assignments`) | At least one default-active row per product. |
| 3. Operations | `production_routes` + `route_operations` (existing seed for CARD/BOTTLE/STICKER_ONLY; new routes via SQL or future admin UI) | Sequence dense (1..n); RECEIVING first, FINISHED_GOODS terminal. |
| 4. Structure | `/settings/product-structure` (writes `item_conversions`) | Every parent/child pair has positive quantities. |
| 5. BOM | `/settings/packaging-bom` (writes `product_packaging_specs`) | Every line has qty > 0 and a valid scope. |
| 6. Standards | `/settings/blister-standards` (writes `blister_material_standards`) | At least one of grams-per-blister or blisters-per-kg. |
| 7. Quality checks | `quality_checks` + `route_quality_checks` (foundation only — UI later) | Per-operation, per-check definition. |
| 8. Zoho mapping | `external_item_mappings` (foundation only — live sync later) | Defaults to `UNKNOWN`; admin confirms. |

If any of those configurations is missing, the production-intelligence layer surfaces a `MISSING` MetricResult with the canonical empty-state label. **Nothing fakes a number.**

### Warning against product-specific conditional logic

The temptation when adding a new product is: *"Just for now, add a kind === 'POUCH' check in the projector."* Do not. The cost of that one shortcut is:

- A second, conflicting source of routing logic alongside `route_operations`.
- A silent gap when the new product's events are emitted but the projector hasn't been updated.
- A precedent for the next contributor to add a third special case.

If a new product needs special behavior, that behavior belongs in the data model (a new `operation_type`, a new `quality_check`, a new `item_conversion`, a new BOM line). Not in code.



Per the user's directive (2026-05-06):

- **No one-off code paths per product.** A new product is configured, not coded.
- **New routes, operations, materials, quality checks** must be modeled as **rows**, not enum values or conditional branches.
- **Before adding any logic that branches on `product.kind`, `route`, `station_kind`, or `event_type`,** the contributor must check this document and either (a) extend the data model, or (b) document why the special case cannot be expressed in data.
- **Phase H.x3, H.x4, H.x7** (and all subsequent phases) must respect this guardrail. If a new feature is found to require hardcoding, that's the signal to lift the relevant enum into a table first.

---

## Concrete reference — files that encode the two-route assumption

For the contributor who's about to add a third route. These are the seven hot spots, in dependency order:

1. `lib/db/schema.ts:56` — `machine_kind` enum
2. `lib/db/schema.ts:66` — `station_kind` enum
3. `lib/db/schema.ts:76` — `product_kind` enum
4. `lib/db/schema.ts:158` — `workflow_event_type` enum
5. `lib/projector/index.ts:58` — `STAGE_FOR_EVENT` map
6. `lib/projector/index.ts:73` — `THROUGHPUT_COLUMN` map
7. `lib/projector/queue-state.ts:66` — per-stage `productKind` filter
8. `app/(floor)/floor/[token]/actions.ts:74` — `ALLOWED_EVENTS_BY_KIND` map
9. `lib/production/types.ts:131` — `STAGE_KEYS` literal tuple
10. `lib/production/types.ts:144` — `ROUTES` literal tuple
11. `lib/production/sql.ts:12` — `ROUTE_TO_MACHINE_KINDS` map

If you change one without changing the others, the read models and the floor will silently disagree.
