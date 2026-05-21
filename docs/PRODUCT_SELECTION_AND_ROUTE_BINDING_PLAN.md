# Product selection + route binding at first production op

> **Status:** production-readiness blocker. Must ship before cutover.
> Owner-flagged in TEST D4.
>
> Same shape as `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md` —
> phased implementation; do not attempt as a quick fix.

## Why this exists

During TEST D4 the operator surfaced a real-world rule that the
current model does not enforce:

> Receiving identifies the **raw item** only — PO, raw item/flavor,
> vendor declared count, received weight, bag QR. The **finished
> product/SKU is selected when the raw bag enters its first
> production operation.** That product carries through every
> downstream station. Downstream stations must inherit, not re-pick.

> A raw inventory bag can feed many products over time (different
> allocation sessions). But each workflow bag / production run has
> exactly one product, set at first-op, locked through finalize.

> Packaging completion must derive cards/display, displays/case from
> the workflow bag's product — never hardcoded. If the product
> structure is missing, packaging completion must be **blocked** with
> *"Product packaging structure missing"*. Do not invent conversion
> math.

The current system has the schema for all of this (foreign keys,
COALESCE projector pattern, products table with unitsPerDisplay /
displaysPerCase, productPackagingSpecs, itemConversions,
productComponentRequirements) — but no **write path** ever attaches
a product to a workflow_bag, and no UI ever asks the operator.

## Current state (verified by code audit)

| Concern | Today |
|---|---|
| `workflow_bags.product_id uuid REFERENCES products(id)` column | **exists**, nullable |
| `PRODUCT_MAPPED` workflow_event_type in the enum | **exists** |
| `PRODUCT_MAPPED` emission path | **none** (legacy importer only) |
| Action that asks operator to pick a product | **none** |
| `read_bag_state.product_id` / `product_name` denormalization | **wired via COALESCE** in projector — but always null because no event fires |
| `raw_bag_allocation_sessions.product_id` | **exists, optional, settable** in `bag-allocation-actions.ts` — but **never propagated to `workflow_bags.product_id`** |
| `products.units_per_display`, `products.displays_per_case` | **exists** |
| `product_packaging_specs` (more granular) | **exists** |
| `item_conversions` (route-aware) | **exists** |
| `product_component_requirements` (variety packs) | **exists** |
| Packaging projector's `unitsYielded` math | **product-scoped** (reads from bag.productId) but **silently skipped** when product_id is null — `unitsYielded` stays at 0 |
| Packaging-complete UI | accepts master/displays/loose, but does not display the product or block on missing product |
| Variety-pack flow | accepts productId on the allocation session but never writes it to workflow_bags |
| Bottle route (filling → sticker → induction → packaging) | not yet exercised; same gap will apply |

## The contract this plan must satisfy

### Product selection — when

| Route | Product selected at | Locked through |
|---|---|---|
| Card / blister | **Blister station** card scan | blister → sealing → packaging → finalize |
| Bottle | **Bottle Filling / Handpack station** card scan | filling → sticker → induction → packaging → finalize |
| Variety pack | **Variety-pack workflow start** (component allocation) | variety packaging → finalize |

### Where product belongs

| Layer | Product? |
|---|---|
| `inventory_bags` (raw bag) | **No.** A raw bag can feed many products across allocation sessions. Product is not a property of the raw item |
| `raw_bag_allocation_sessions` | **Yes.** This session allocates raw to one product |
| `workflow_bags` (production run) | **Yes.** Set at first production op, locked. One product per run |
| `product_route_assignments` | binds product to route ordering (already exists) |

### Inheritance rule

After first-op product selection:
- `workflow_bags.product_id` is set
- A `PRODUCT_MAPPED` workflow_event fires (correlation in payload)
- All downstream stations read `bag.product_id` (or
  `read_bag_state.product_id`/`.product_name`) — they **never ask
  the operator again**
- Each downstream station's UI displays:
  - product / SKU
  - route
  - configured packaging structure
  - next valid action

### Hard rule for packaging

Packaging completion **MUST** use the workflow bag's product to
derive `cards/display`, `displays/case`, `bottles/display`, etc.

If `workflow_bags.product_id IS NULL` OR the product has no
packaging structure (`products.units_per_display IS NULL` /
`displays_per_case IS NULL`):

- **Block** the packagingCompleteAction submission
- Return error: *"Product packaging structure missing — supervisor
  must assign product before packaging completes."*
- Do **not** record PACKAGING_COMPLETE
- Do **not** advance bag stage
- Do **not** allow Finalize

### Supervisor correction

Product can change midstream **only via an explicit supervisor
correction event** (e.g. `PRODUCT_REASSIGNED`). Routine operator
flow cannot change product after first-op set. Same payload
contract as other QC events:
`actor_user_id, reason_code, notes, supervisor_role: true`.

## Phased implementation plan

### Phase PRD-1 — first-op product picker (small)
- New action `setBagProductAction(workflowBagId, productId)`:
  - Loads bag, asserts `product_id IS NULL`
  - Loads product, asserts route matches the firing station's kind
    (uses existing `product_route_assignments`)
  - Updates `workflow_bags.product_id`
  - Fires `PRODUCT_MAPPED` workflow_event with `payload = { product_id, route_id, source_action: "first_op_selection" }`
- Wire into `scanCardAction` for IDLE-card path:
  - Floor station's main page renders a *"What are you making?"*
    chooser BEFORE/INSTEAD OF `Sealing complete` etc. when the
    bag's product is null
  - If a supervisor-planned product is queued for this card/raw bag,
    it pre-selects automatically — operator just confirms
  - Otherwise, dropdown filtered to products allowed at this
    station kind (via `product_route_assignments`)
- Operator cannot fire any forward stage event on the bag until
  the product is set (new guard in `fireStageEventAction` mirroring
  the existing stage-progression guard)

### Phase PRD-2 — packaging conversion guard ✓ shipped (sha 8b7344b)
- `packagingCompleteAction` rejects with *"Product packaging
  structure missing"* when:
  - `bag.product_id IS NULL`, OR
  - `product.units_per_display IS NULL`, OR
  - `product.displays_per_case IS NULL`
- UI surfaces the error in the existing red banner (v2E observable
  forms — already shipped)
- Packaging station's main page should display *"This SKU: X units/
  display · Y displays/case"* sourced from the bag's product BEFORE
  the operator enters counts (UI surfacing pending — guard ships
  the server-side floor first; UI text is part of polish phase or
  can be tacked on with PRD-1)

### Conversion formula (locked — never hardcoded)

When PRD-2's prereqs pass, packaging completion derives good
output from product structure:

```
good_units =
    (master_cases × product.displays_per_case × product.units_per_display)
  + (full_displays × product.units_per_display)
  + loose_good_units
```

The first two terms are product-structure-driven. The third
(`loose_good_units`) is operator-entered and counts as **good
output, not damage**. Loose good units ≠ damaged packaging ≠
damaged pills — those are separate entries with separate accounting
effects. See `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md`
"Packaging output — eight labelled buckets" for the full taxonomy.

Today's `packagingCompleteAction` accepts a `looseCards` field
that is conflated with `damagedPackaging` + `rippedCards` in PO
reconciliation's flat `known_loss`. That conflation is wrong and
must be split when QC-4 ships. Until then, **operators should
leave `looseCards`, `damagedPackaging`, and `rippedCards` at 0**
in TEST D so the flat `known_loss = 0` and the bug doesn't
surface.

### Phase PRD-3 — bottle-route first-op flow
- Bottle Filling / Handpack station inherits the same first-op
  product-picker UX
- Same `setBagProductAction`, different allowed-routes filter
- `BOTTLE_HANDPACK_COMPLETE` etc. inherit `bag.product_id`

### Phase PRD-4 — variety-pack workflow
- Existing `bag-allocation-actions.ts` `productId` on session +
  events stays
- Add propagation step: when the variety-pack workflow opens its
  workflow_bag, copy `session.productId → workflow_bags.product_id`
  AND fire `PRODUCT_MAPPED`
- Variety-pack page validates against
  `product_component_requirements` for the chosen variety SKU

### Phase PRD-5 — supervisor correction
- New event `PRODUCT_REASSIGNED` (add to enum migration)
- Admin-only action with full audit row + `actor_user_id`
- Updates `workflow_bags.product_id`, fires `PRODUCT_REASSIGNED`,
  preserves prior product in payload for genealogy
- Surface in `/genealogy/[bagId]` history

### Phase PRD-6 — tests
| # | Behavior |
|---|---|
| 1 | Receiving raw bag does not require finished product |
| 2 | Blister start requires/selects product for card route |
| 3 | Bottle Filling start requires/selects product for bottle route |
| 4 | Downstream sealing inherits product (no re-pick) |
| 5 | Packaging inherits product (no re-pick) |
| 6 | Product cannot change midstream without `PRODUCT_REASSIGNED` |
| 7 | Same raw bag can be returned and reopened for a different product in a new allocation session |
| 8 | Packaging completion uses product-specific item_conversions/units_per_display |
| 9 | Two products with different displays-per-case calculate correctly |
| 10 | Missing product structure blocks packaging completion (does NOT silently set unitsYielded=0) |
| 11 | `setBagProductAction` rejects products whose route doesn't include this station |
| 12 | `setBagProductAction` rejects when bag already has a product (must use PRODUCT_REASSIGNED) |

## Effort estimate

5–8 working days for a focused implementer. Phase PRD-2 (the
packaging guard) is the smallest urgent slice — could be done as a
1-hour patch ahead of the rest if cutover prep needs an immediate
floor on silent zeros.

## Production-readiness blocker

Cutover **may not** happen while:
- `workflow_bags.product_id` can be null at PACKAGING_COMPLETE time
- The packaging projector silently records `unitsYielded = 0` instead
  of blocking
- The floor UI provides no way for an operator to set product
- The variety-pack flow leaves `workflow_bags.product_id` unset

## TEST D normal path — can it continue safely now?

**Yes, with a documented caveat.**

For TEST D5 (Packaging complete on Bag 1):
- The form will accept inputs and PACKAGING_COMPLETE will fire
- Bag 1 advances to PACKAGED
- Finalize will work
- **`read_sku_daily.units_yielded = 0`** for this bag because the
  product is null → `product?.unitsPerDisplay` is undefined →
  conversion block at `lib/projector/index.ts:544` is skipped
- This is **not a math error in the test** — the user is exercising
  the workflow lifecycle (pickup → complete → release → finalize +
  QR returns to IDLE), and that part is correct
- Reconciliation rollups will silently misreport finished count as 0
  for these test bags, which is acceptable for validation but is
  **not acceptable for cutover**

If the operator wants TEST D5 to also exercise non-zero
`unitsYielded`, the workaround during validation is a one-shot
manual SQL:

```sql
UPDATE workflow_bags
SET product_id = '<some-real-product-uuid>'
WHERE id IN ('8a08c639-...', '7dd73a89-...');
```

That's a temporary validation-only patch. Real fix is Phases PRD-1
through PRD-6.
