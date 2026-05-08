# QC, rework, damage accounting + count-confidence model

> **Status:** production-readiness blocker. Must ship before cutover.
> Owner-flagged in the TEST D normal path.
>
> **Do not implement piecemeal.** This plan is the contract for a
> dedicated multi-phase effort. Touching it in fragments will leave
> reconciliation in a half-correct state.

## Why this exists

During TEST D the operator surfaced a real-world rule that the
current model does not enforce:

> Counts from the blister and sealing machines are **not true
> finished-good counts**. The blister counter measures press activity
> (and roll yield); the sealing counter measures press cycles. Only
> the packaging-station verified count is the source of truth for
> finished output, PO reconciliation, and supplier settlement.

> Defects, damage, and rework are not all the same thing. A damaged
> card/package consumes packaging material. A damaged pill/product
> consumes raw product. A rework item is not yet scrap. Packaging
> sending sealed cards back to sealing is not final loss.

The current model treats all "damage" and "rework" entries as one
flat `known_loss` number and treats all counts as equally
authoritative. That's incorrect for production accounting.

## Current state (what exists today)

| Thing | Status |
|---|---|
| `workflowEventTypeEnum` | Has the right names — `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `QA_HOLD_STARTED`, `QA_HOLD_RELEASED`, `PACKAGING_DAMAGE_RETURN`, `BATCH_HELD`, `BATCH_RECALLED`, `BAG_VERIFIED` — but most are not emitted anywhere |
| `MetricResult.confidence` ladder (`HIGH/MEDIUM/LOW/MISSING`) | Exists for the math layer |
| `count_source` on events | **does not exist** — no discriminator between blister-press, sealing-press, packaging-verified, vendor-declared, weight-derived counts |
| `SEALING_COMPLETE` payload | only `count_total` — no defect / rework / scrap fields |
| `packagingCompleteAction` | accepts `masterCases`, `displaysMade`, `looseCards`, `damagedPackaging`, `rippedCards` — but writes them ONLY into the `PACKAGING_COMPLETE` payload. Never emits `PACKAGING_DAMAGE_RETURN`, `SCRAP_RECORDED`, or `REWORK_SENT` |
| `lib/production/po-reconciliation.ts:302-319` | sums damage+rework into a single `known_loss` regardless of which event/role/material they belong to |
| `lib/production/diagnostics.ts:396-400` | already flags *"REWORK_SENT events are not yet emitted by any flow"* — the gap is documented but unfixed |
| `lib/projector/sku-daily.ts:52-53` + `station-daily.ts:17-19` | hard-coded `0 AS rework, 0 AS scrap` because no events emit them |
| Bag travel | Forward-only (`BAG_PICKED_UP` from VALIDATION-2D). No rework-back-to-sealing path |

## Count-confidence hierarchy (the rule)

Every count we record must carry a `count_source` discriminator. The
hierarchy, highest first:

| Rank | `count_source` | Purpose |
|---|---|---|
| 1 | `PACKAGING_FINAL_COUNT` | finished output, PO reconciliation, supplier settlement, finished inventory |
| 2 | `MANUAL_VERIFIED_COUNT` | hand-counted verified units when done |
| 3 | `SEALING_COUNTER` | sealing-station press activity → process throughput, **not** finished-good count |
| 4 | `BLISTER_COUNTER` | blister-machine press count → PVC/foil roll yield + gross activity, **not** finished-good count |
| 5 | `VENDOR_DECLARED_COUNT` | supplier weight-based declared count → vendor comparison only |
| 6 | `RECEIVED_WEIGHT_ESTIMATE` | our received weight ÷ unit-weight standard → estimate only |

**Accounting rules driven by source:**

- **Blister counter** drives: PVC/foil roll yield, gross blister
  activity, machine rate, empty-run/press-variance signal.
- **Sealing counter** drives: sealing-press activity, throughput,
  gross-to-sealed comparison, operator/machine productivity.
- **Packaging final count** drives: finished goods, sellable output,
  PO reconciliation, supplier settlement, finished inventory,
  production-target completion.

Reconciliation **must not** mix these into a single number.

## Defect / rework / scrap event model (additive)

All new fields are payload-only (no schema migration required for the
column-level enum, since the enum already has the right primitives).
The model:

### New event emissions

| Event type (already in enum) | Fired by | Meaning |
|---|---|---|
| `QUALITY_DEFECT_RECORDED` | new — needs to be added to enum | A defect was observed at this station; carries `defect_type` + `affects_raw_product` + `affects_packaging_material` |
| `SCRAP_RECORDED` | sealing or packaging | Confirmed final loss. Affects raw and/or packaging accounting |
| `PACKAGING_DAMAGE_RETURN` | packaging | Cards returned from packaging because of bad seal etc. — **NOT scrap until explicitly scrapped later** |
| `REWORK_SENT` | packaging (rename: `REWORK_SENT_BACK` clearer) | A subset of cards is sent back to sealing |
| `REWORK_RECEIVED` (existing) — alias `REWORK_PICKED_UP` | sealing | Sealing accepts the rework batch |
| `REWORK_RESOLVED` | new — needs to be added to enum | Rework completed at sealing, ready to return to packaging |

### Standard payload contract (every new event)

```ts
{
  workflow_bag_id: uuid,
  station_id: uuid,
  machine_id: uuid | null,
  product_id: uuid | null,
  defect_type: enum,                       // see reason codes below
  defect_source_station: 'BLISTER' | 'SEALING' | 'PACKAGING' | null,
  quantity: integer,
  unit: 'cards' | 'pills' | 'blisters' | 'packages',
  count_source: see hierarchy above,
  count_confidence: HIGH | MEDIUM | LOW | MISSING,
  affects_raw_product: boolean,            // pill/product loss?
  affects_packaging_material: boolean,     // card/foil/case loss?
  material_item_id: uuid | null,           // packaging material if applicable
  material_lot_id: uuid | null,
  reason_code: enum,
  notes: string | null,
  actor_user_id: uuid | null,
  client_event_id: uuid | null,
  segment_group_id: uuid | null,           // correlation across rows from one form submit
}
```

### Reason codes (enum, payload-side)

```
MIS_PRESS
EMPTY_RUN
MISSED_PILLS
BAD_SEAL
DAMAGED_CARD
DAMAGED_PILL
DAMAGED_PACKAGING
WRONG_COUNT
COUNTER_MISMATCH
RETURNED_FROM_PACKAGING
OPERATOR_ERROR
MACHINE_SETUP
OTHER
```

## Reconciliation model

For each bag / PO / product route, **preserve all count layers**
separately:

```
vendor_declared_count
received_weight_estimate
blister_press_count
sealing_press_count
packaging_verified_count
known_card_packaging_damage          (affects_packaging_material=true)
known_raw_product_damage             (affects_raw_product=true)
rework_wip                           (REWORK_SENT minus REWORK_RESOLVED)
scrap                                (SCRAP_RECORDED only)
unknown_variance                     (residual — may not be loss)
```

Derived metrics (each carries its own `confidence`):

```
blister_to_packaging_variance =
    blister_press_count - packaging_verified_count
    - known_card_packaging_damage - known_raw_product_damage
    - rework_wip - scrap

sealing_to_packaging_variance =
    sealing_press_count - packaging_verified_count
    - known_card_packaging_damage - rework_wip - scrap

vendor_to_packaging_variance =
    vendor_declared_count - packaging_verified_count
    - known_raw_product_damage - scrap - remaining_inventory
```

**Labels in reports** (do not call variance "loss" unless confirmed):
- *"Press-count variance"*
- *"Counter mismatch"*
- *"Known card / packaging damage"*
- *"Known raw product damage"*
- *"Rework WIP"*
- *"Scrap"*
- *"Unknown variance"*
- *"Manual review required"*

### Inventory accounting impact

| Event | Raw product ledger | Packaging material ledger | Finished output |
|---|---|---|---|
| Damaged card/package only | unchanged | -qty | -qty (not finished) |
| Damaged pill/product | -qty | depends | -qty |
| Both | -qty | -qty | -qty |
| Rework sent | unchanged | unchanged (in WIP) | not yet finished |
| Rework resolved | unchanged | possibly +qty extra | now eligible for finishing |
| Scrap | -qty | -qty | -qty |

## UI changes

### Sealing complete (collapsed, defaults all to 0)

```
Sealing press counter:    [_____]  required
                          ⓘ "Press activity, not finished count."

Optional details (default 0):
  Damaged cards/packages:  [0]
  Damaged pills/product:   [0]
  Bad seals (rework):      [0]
  Empty/mis-press count:   [0]
  Scrap (final loss):      [0]

[Complete sealing]
```

If any optional > 0 → fire `QUALITY_DEFECT_RECORDED` and/or
`SCRAP_RECORDED` events alongside `SEALING_COMPLETE`.

### Packaging complete (extended)

```
Master cases:        [_]   Displays:        [_]   Loose cards: [_]
Bottles (if route):  [_]
Damaged packaging:   [0]
Bad seal found:      [0]   ← new — fires PACKAGING_DAMAGE_RETURN
Send back to sealing:[0]   ← new — fires REWORK_SENT
Scrap (final loss):  [0]   ← new — fires SCRAP_RECORDED
Notes:               [_____________]

[Complete packaging]
```

### Rework picked up at sealing

When a bag is in rework state (sealing-side), surface
"Rework picked up" + "Rework resolved" buttons. Picking up a rework
fires `REWORK_PICKED_UP`; resolving fires `REWORK_RESOLVED` and
returns the bag to the packaging queue.

## Bag travel for rework

Forward-only travel from VALIDATION-2D extends with backward path:

```
Blister → Sealing → Packaging → (PACKAGING_COMPLETE)
                            └→ (REWORK_SENT) → Sealing rework queue
                                            → REWORK_PICKED_UP at sealing
                                            → REWORK_RESOLVED at sealing
                                            → back to Packaging queue
                                            → eventual PACKAGING_COMPLETE + Finalize
```

**Same `workflow_bag_id` throughout.** No new bags created. The
workflow_bag's stage may regress (`PACKAGED → SEALED`) when rework
fires — needs an explicit projector branch (separate from the
forward-only `EVENT_STAGE_PREREQ` rule).

## Tests required

| # | Behavior |
|---|---|
| 1 | Sealing press count is stored as `count_source=SEALING_COUNTER` |
| 2 | Packaging count is stored as `count_source=PACKAGING_FINAL_COUNT` and treated as the primary finished-output number in PO reconciliation |
| 3 | Blister counter drives roll yield (existing) but does NOT count toward finished-output reconciliation |
| 4 | Sealing complete with 0 defects behaves like the current path |
| 5 | Sealing complete with `damaged_cards > 0` records `QUALITY_DEFECT_RECORDED` with `affects_packaging_material=true, affects_raw_product=false` |
| 6 | Sealing complete with `damaged_pills > 0` records `QUALITY_DEFECT_RECORDED` with `affects_raw_product=true` |
| 7 | Packaging can send `bad_seals > 0` back to sealing — fires `REWORK_SENT` (not `SCRAP_RECORDED`) |
| 8 | Rework-sent items are NOT counted as scrap |
| 9 | `REWORK_RESOLVED` returns the bag to the packaging queue |
| 10 | PO reconciliation separates `known_card_packaging_damage`, `known_raw_product_damage`, `rework_wip`, `scrap`, `unknown_variance` |
| 11 | Packaging-material inventory reflects `damagedPackaging` losses |
| 12 | Raw-bag reconciliation reflects damaged raw product losses, NOT packaging damage |
| 13 | Floor UI defaults all optional QC counts to 0 |
| 14 | Missing/blank QC counts do NOT silently fabricate loss numbers |

## Implementation phases (suggested)

### Phase QC-1 — schema + event vocabulary (small)
- Add migration to add `QUALITY_DEFECT_RECORDED`, `REWORK_RESOLVED`,
  `REWORK_SENT_BACK` (alias), `REWORK_PICKED_UP` (alias) to
  `workflowEventTypeEnum`.
- Stable payload contract documented in `lib/production/qc-events.ts`
  (TS types only; no DB shape change beyond enum).
- No emission paths yet; no reconciliation changes.

### Phase QC-2 — emission paths from existing actions
- Extend `sealingComplete` / `packagingCompleteAction` payloads with
  the optional defect / rework / scrap fields (defaults 0).
- When any defect/rework/scrap field > 0, emit the corresponding new
  event(s) alongside the existing stage event in the same DB tx.
- All inserts use `randomUUID()` `client_event_id` per row +
  `segment_group_id` correlation in payload (matches the v2F rule).
- Add UI fields on sealing + packaging forms (collapsed, default 0).

### Phase QC-3 — rework backward travel
- New action `reworkPickedUpAction` (sealing).
- New action `reworkResolvedAction` (sealing).
- Projector branch allowing stage regression `PACKAGED → SEALED` on
  `REWORK_SENT`.
- Floor UI: surface rework queue at sealing station (when
  `REWORK_SENT` events exist for bags whose card is ASSIGNED but
  whose station_live is empty).

### Phase QC-4 — reconciliation rewrite
- Update `derivePoRawMaterialReconciliation` to split
  `known_loss` into the five labelled buckets above.
- Update `lib/projector/material-reconciliation.ts` with separate
  raw-vs-packaging consumption ledgers.
- Update `read_sku_daily` + `read_station_daily` to populate
  `rework`, `scrap`, `defects` columns (already declared in schema,
  currently `0`).

### Phase QC-5 — admin reports
- New `/qc-defects` admin page with per-station, per-shift, per-
  reason-code breakdown.
- Update `/po-reconciliation` to display the five separate
  `known_loss` buckets instead of one number.
- Update `/material-reconciliation` to surface raw-vs-packaging
  ledgers separately.

### Phase QC-6 — tests + smoke + manual TEST D-QC path
- Add the 14 tests above.
- Add an explicit TEST D-QC path to
  `docs/MANUAL_WORKFLOW_TEST_PACKET.md` that exercises mis-press +
  bad-seal + rework + return.

Total: estimated 5–8 working days for a focused implementer. **Not
attempted as a quick fix**.

## TEST D normal path — can it continue safely now?

**Yes, with a caveat.**

The TEST D normal path (no defects, no rework, packaging counts
entered, finalize) exercises only the forward flow that VALIDATION-2D
already shipped. The numbers it produces today are correct **for
zero-defect bags** because:

- `damagedPackaging` and `rippedCards` defaulted to 0 mean the
  current `known_loss = 0` — no aggregation bug surfaces.
- Packaging `master_cases × cards_per_case + displays × cards_per_display + loose_cards`
  is the only "finished" signal Luma uses today, and it works for the
  zero-defect path.
- PO reconciliation's flat `known_loss` collapses to 0 — variance
  surfaces correctly.

**The caveat:** any non-zero defect / damage / rework on a real
production bag in the current build will be silently aggregated into
a flat `known_loss` and **lose its origin / source / reason / type**.
That is acceptable for the TEST D-normal validation but is **not
acceptable for cutover**.

## Production-readiness blocker

This document is a **non-negotiable cutover prerequisite**:

- Cutover **may not** happen while real damage / rework / scrap
  events compress to a single `known_loss` aggregator.
- Cutover **may not** happen while `SEALING_COMPLETE` and
  `BLISTER_COMPLETE` press counts are treated as authoritative
  finished-output sources by reconciliation.
- Cutover **may not** happen while packaging cannot send a bag back
  to sealing (no rework loop).
- Cutover **may not** happen while the floor UI lets an operator
  enter damage without recording defect type / origin / raw-vs-
  packaging effect.

The owner has approved continuing TEST D normal path now, but
phases QC-1 through QC-6 must complete before the cutover go-live
checklist is signed off.
