# PT-6 — 8-Bucket Material Reconciliation Plan

**Phase:** PT-6A (plan only; no implementation in this commit).
**Status:** Draft — awaiting approval to start PT-6B.
**Source of truth for follow-on phases.** PT-6B/C/D/E reference this doc.

---

## 0. Why this exists

Today Luma reconciles material flow with a single per-bag table (`read_material_reconciliation`) that mashes together "what we received," "what we consumed," and "what's left over" into one variance number. That number is honest about *whether* a discrepancy exists but cannot tell you *what kind* of discrepancy it is.

Operationally we need to separate at least four classes of variance so the wrong team doesn't get blamed:

- **vendor short-shipped us** — supplier owes a credit (RECEIPT_VARIANCE)
- **production used more than the BOM said it should** — process loss / setup waste (CONSUMPTION_VARIANCE)
- **what we counted in stock didn't match what the system thought** — count drift / shrink / mis-issue (CYCLE_COUNT_VARIANCE)
- **we cannot classify this gap** — missing data, surface honestly (UNKNOWN_VARIANCE)

PT-6 splits the single bucket into eight, each with a clear source, a clear formula, and a clear confidence band.

This plan **does not invent inventory math**. Every bucket maps onto sources Luma already captures (after OP-1B/C/E and PT-1..4). The work is structuring + surfacing them, not collecting new data.

---

## 1. The 8 buckets — definitions

Each bucket is per-(material_lot, time_window) by default; per-(workflow_bag) for the cardroute production buckets that already aggregate that way.

### 1.1 DECLARED
- **Business meaning.** Quantity the supplier (or P.O., or box label, or PackTrack receipt) said we received. Trust = LOW until physically counted.
- **Sources.**
  - `packaging_lots.declared_quantity` (populated by PackTrack import + the count-receive form).
  - `material_inventory_events` of type `PACKAGING_BOX_RECEIVED` carrying `payload.declared_quantity`.
  - `material_inventory_events` of type `PACKAGING_RECEIPT_IMPORTED` (PackTrack webhook).
- **Formula.** Direct read; no derivation. Sum across boxes/lots in the window.
- **Confidence rules.**
  - HIGH: never. Declared is by definition not yet verified.
  - MEDIUM: present from supplier-trusted source (PackTrack with valid receipt id) — labelled `MEDIUM (supplier-declared)`.
  - LOW: legacy import / hand-typed at receive without a counted match.
- **Examples.** Supplier ships 1,000 display boxes; declared = 1,000.
- **Missing-data behavior.** If `declared_quantity` is null but `qty_received` exists (legacy rows pre-PT-1), use `qty_received` as a back-compat proxy and tag confidence LOW + reason `legacy_qty_received`.

### 1.2 COUNTED
- **Business meaning.** Quantity a human (or trusted automated count) physically observed. The first source of HIGH-confidence truth.
- **Sources.**
  - `packaging_lots.counted_quantity` (populated by PackTrack import when the carrier counted, or by the receive form when the receiver counted).
  - `material_inventory_events.PACKAGING_BOX_COUNTED` events carrying `payload.counted_quantity`.
- **Formula.** Direct read.
- **Confidence rules.**
  - HIGH: physically counted at receive or via cycle count.
  - MEDIUM: re-derived from a later cycle count (still physical, but stale w.r.t. receive moment).
  - MISSING: counted_quantity is null. Bucket value is null; reconciliation falls back to DECLARED.
- **Examples.** Receiver opens the carton, counts 972 boxes; counted = 972.
- **Missing-data behavior.** Bucket reads null. Downstream formulas treat null as "fall back to DECLARED."

### 1.3 ACCEPTED
- **Business meaning.** What Luma has formally taken into inventory and is willing to consume from. The single quantity that drives `qty_on_hand` initial state. Already lives in `packaging_lots.accepted_quantity`.
- **Sources.**
  - `packaging_lots.accepted_quantity`.
  - Backfill rule (live in PT-1 today): `accepted_quantity = COALESCE(counted_quantity, declared_quantity)`.
- **Formula.** `accepted = counted ?? declared`. If both null, accepted is null and the lot must not be drawn from until it has at least one of the two. Confidence inherits from whichever source backed it.
- **Confidence rules.**
  - HIGH: came from counted_quantity.
  - MEDIUM: came from declared_quantity (supplier said so, no count yet).
  - LOW: legacy rows where neither column is populated and `qty_received` filled in.
- **Examples.** counted 972 → accepted 972 HIGH. counted null, declared 1,000 → accepted 1,000 MEDIUM.
- **Missing-data behavior.** Bucket null → lot is "needs intake" until counted/declared lands.

### 1.4 CONSUMED_ESTIMATED
- **Business meaning.** Material the system thinks production used, derived from output × BOM/standards rather than direct measurement. The default for cards (BLISTER_COMPLETE counter × `blister_material_standards.std_grams_per_blister`) and for any consumption that hasn't been weigh-back-confirmed.
- **Sources.**
  - `material_inventory_events.MATERIAL_CONSUMED_ESTIMATED` (already in the enum, not yet emitted live — see "Implementation phases" §7 for when it lights up).
  - `material_inventory_events.ROLL_COUNTER_SEGMENT_RECORDED` (live; the cardroute consumption signal in grams = `counter_segment_count × g_per_blister`).
  - For tablets: `read_bag_metrics.units_yielded × bom_grams_per_unit` derived through `product_packaging_specs` + `item_conversions`.
  - `blister_material_standards` for PVC / foil consumption per blister.
- **Formula (cards).** `consumed_estimated = sum(counter_segment_count_for_role × g_per_blister)` across the time window for the lot's material role (PVC / FOIL).
- **Formula (packaging).** `consumed_estimated = sum(bag.units_yielded × spec.qty_per_finished_unit)` across finalized bags in the window.
- **Confidence rules.**
  - MEDIUM: standards-driven (BOM × output count). Most cardroute consumption today.
  - LOW: standards missing or inferred from a generic conversion.
  - MISSING: no standard + no event source.
- **Examples.** A bag finalized with 20,324 blisters and `g_per_blister = 0.04218` → consumed_estimated = 857.5 g of PVC.
- **Missing-data behavior.** Empty for the role. UI labels "estimated consumption unavailable — set blister_material_standards."

### 1.5 CONSUMED_ACTUAL
- **Business meaning.** Material whose consumption was directly measured: weigh-back at unmount, end-of-shift physical count, or a confirmed cycle-count adjustment.
- **Sources.**
  - `material_inventory_events.ROLL_WEIGHED` (mid-roll or end-of-roll measurement).
  - `material_inventory_events.ROLL_DEPLETED` carrying `final_roll_yield_blisters` and `net_weight_grams` — at depletion the consumed_actual for that lot equals net_weight_grams (the whole roll was used).
  - `material_inventory_events.MATERIAL_CONSUMED_ACTUAL` (enum present; emitted by future weigh-back-driven flows).
  - `material_inventory_events.PACKAGING_BOX_COUNTED` when applied as a mid-life cycle count (rare for receive-time COUNTED — see §1.2).
- **Formula (rolls).** `consumed_actual_for_lot = starting_weight_grams - latest_observed_weight_grams` when a weigh-back exists, OR `net_weight_grams` when ROLL_DEPLETED has fired.
- **Formula (count-based).** `consumed_actual = (accepted_quantity - cycle_count_remaining)` when a cycle count has happened mid-life.
- **Confidence rules.**
  - HIGH: weigh-back / explicit measurement.
  - MEDIUM: derived from a depletion event whose final yield was inferred from segment ledger rather than weighed.
  - MISSING: no weigh-back, no depletion event, no cycle count.
- **Examples.** PVC roll started at 35,562 g, weigh-back at 25,000 g → consumed_actual = 10,562 g HIGH.
- **Missing-data behavior.** Bucket null. Downstream "actual remaining" falls back to "estimated remaining."

### 1.6 SCRAPPED_OR_DAMAGED
- **Business meaning.** Material explicitly marked unusable by an operator or QC, removed from inventory but **not** counted as production output.
- **Sources.**
  - `material_inventory_events.MATERIAL_SCRAPPED` (enum present; **no live emission today** — QC subsystem deferral).
  - `workflow_events.PACKAGING_DAMAGE_RETURN` (enum present; **no live emission** — QC deferral).
  - `read_bag_metrics.damaged_packaging` and `read_bag_metrics.ripped_cards` — already populated by `PACKAGING_COMPLETE` events. These are the only live damage signals today; they refer to *finished-good damage*, not raw-material scrap.
  - `packaging_lots.status = 'HELD'` or `'SCRAPPED'` indicates the entire lot was disqualified; quantity = `qty_on_hand` at the moment of status change.
- **Formula.** Sum of damaged_packaging + ripped_cards across finalized bags + sum of qty_on_hand at HELD/SCRAPPED status transitions in the window.
- **Confidence rules.**
  - HIGH: from explicit `MATERIAL_SCRAPPED` / `PACKAGING_DAMAGE_RETURN` events (when QC ships).
  - MEDIUM: from `read_bag_metrics.damaged_packaging` + `ripped_cards` columns (live today).
  - MISSING: lot not yet HELD/SCRAPPED and no damage events.
- **Examples.** Bag finalized with `damaged_packaging = 3` cards → SCRAPPED_OR_DAMAGED += 3 cards.
- **Missing-data behavior.** Bucket reads zero (cleanly), labelled "no scrap events recorded — QC subsystem deferral" so the UI doesn't pretend zero scrap means perfect.

### 1.7 ON_HAND
- **Business meaning.** Current usable remaining inventory, what cycle counts will compare against.
- **Sources.**
  - `packaging_lots.qty_on_hand` (live; updated by `PACKAGING_RECEIPT_ADJUSTED` cycle-count flow).
  - `read_material_lot_state` (read model; rebuilt by `rebuildMaterialLotState`).
  - For roll lots: `packaging_lots.current_weight_grams_estimate` is the running estimate; weigh-backs on `ROLL_WEIGHED` snap this to actual.
- **Formula.** `on_hand = accepted - consumed_actual_or_estimated - scrapped + adjustments`. The DB column already maintains this; reconciliation reads it.
- **Confidence rules.**
  - HIGH: cycle-counted within the window.
  - MEDIUM: derived from segment-ledger consumption + standards.
  - LOW: pure-estimate (no weigh-back, no cycle count) — labelled "needs cycle count."
- **Examples.** accepted 1,000, segment ledger says 235 consumed, 0 scrapped, no adjustments → on_hand 765 MEDIUM.
- **Missing-data behavior.** When the column is stale (rebuilder hasn't run), the live derivation re-computes from event ledger; UI flags "rebuild pending."

### 1.8 VARIANCE (with subtypes)
The single number `received - consumed - scrap - remaining` does not fit anywhere good. Replace it with four named subtypes that **never sum into one another**.

#### 1.8.a RECEIPT_VARIANCE
- **Definition.** `counted_quantity - declared_quantity`. The vendor / shipping discrepancy. Negative = supplier short-shipped (or driver lost some); positive = supplier over-shipped (rare).
- **Source.** `packaging_lots` row. Already emitted as `PACKAGING_VARIANCE_RECORDED kind=RECEIPT_VARIANCE` by `receivePackagingMaterialAction` today.
- **Confidence.** HIGH when both counted and declared are HIGH-source; MEDIUM otherwise.
- **Never** counts as production loss.

#### 1.8.b CYCLE_COUNT_VARIANCE
- **Definition.** `counted_now - expected_now` where `expected_now = accepted - consumed_estimated - scrapped + prior_adjustments`. Captures shrink, mis-counts, mis-issues that happened *between* receive and cycle count.
- **Source.** Already emitted as `PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE` by `adjustPackagingLotAction` (PT-4D).
- **Confidence.** HIGH (cycle count is by definition physical).
- **Never** counts as receipt variance or production loss.

#### 1.8.c CONSUMPTION_VARIANCE
- **Definition.** `consumed_actual - consumed_estimated`. Process loss vs BOM. Signed: positive = production used more than the standard predicted (over-feed, setup waste); negative = production used less (standard is loose, or yield was higher than expected).
- **Source.** `MATERIAL_CONSUMED_ACTUAL` event quantity − `MATERIAL_CONSUMED_ESTIMATED` event quantity over the same window. Today the actual side is rarely populated; this surface lights up as weigh-back flows mature.
- **Confidence.** HIGH when actual is from weigh-back; MEDIUM when actual is inferred from depletion-event final yield; MISSING when actual is null (we can only show estimated, no variance to compute).
- **Never** counts as receipt or cycle-count variance.

#### 1.8.d UNKNOWN_VARIANCE
- **Definition.** Residual: `accepted - consumed_actual - scrapped - on_hand`, after all three named variances are accounted for. If the math doesn't close, the gap surfaces here rather than being silently zeroed.
- **Source.** Computed at reconciliation time, not stored as an event.
- **Confidence.** Always LOW (by construction — we don't know what kind of gap it is).
- **UI rule.** When UNKNOWN_VARIANCE > 0, the row gets a "needs investigation" pill. Operators can then drill into the lot's event history to figure out which named bucket the missing quantity belonged to.

---

## 2. Source mapping — current state of each input

### 2.1 Packaging receipt path
| Source | Live? | Bucket(s) it feeds |
|---|---|---|
| `packaging_lots.declared_quantity` | ✓ (PT-1) | DECLARED |
| `packaging_lots.counted_quantity` | ✓ (PT-1) | COUNTED |
| `packaging_lots.accepted_quantity` | ✓ (PT-1; backfilled from `qty_received`) | ACCEPTED |
| `packaging_lots.qty_received` (legacy) | ✓ (pre-PT-1) | ACCEPTED fallback (LOW) |
| `packaging_lots.qty_on_hand` | ✓ | ON_HAND |
| `packaging_lots.status='HELD' / 'SCRAPPED'` | ✓ | SCRAPPED_OR_DAMAGED |
| `material_inventory_events.MATERIAL_RECEIVED` | ✓ (admin actions) | DECLARED + ACCEPTED audit lineage |
| `material_inventory_events.PACKAGING_RECEIPT_IMPORTED` | ✓ (PT-3 webhook) | DECLARED + ACCEPTED audit lineage |
| `material_inventory_events.PACKAGING_BOX_RECEIVED` | ✓ | DECLARED |
| `material_inventory_events.PACKAGING_BOX_COUNTED` | ✓ | COUNTED |
| `material_inventory_events.PACKAGING_RECEIPT_ADJUSTED` | ✓ (PT-4D) | ON_HAND change + audit |
| `material_inventory_events.PACKAGING_VARIANCE_RECORDED kind=RECEIPT_VARIANCE` | ✓ | RECEIPT_VARIANCE |
| `material_inventory_events.PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE` | ✓ | CYCLE_COUNT_VARIANCE |

### 2.2 Production material usage
| Source | Live? | Bucket(s) it feeds |
|---|---|---|
| `material_inventory_events.MATERIAL_CONSUMED_ESTIMATED` | enum present, **no live emission** today | CONSUMED_ESTIMATED (when wired) |
| `material_inventory_events.MATERIAL_CONSUMED_ACTUAL` | enum present, **no live emission** today | CONSUMED_ACTUAL (when wired) |
| `material_inventory_events.ROLL_COUNTER_SEGMENT_RECORDED` | ✓ (H.x3 segment ledger) | CONSUMED_ESTIMATED (cards: segment × g/blister) |
| `material_inventory_events.ROLL_WEIGHED` | ✓ | CONSUMED_ACTUAL (rolls) |
| `material_inventory_events.ROLL_DEPLETED` | ✓ | CONSUMED_ACTUAL (rolls, on full-roll yield) |
| `material_inventory_events.ROLL_MOUNTED` / `ROLL_UNMOUNTED` | ✓ | bookend events; not direct quantity sources |
| `product_packaging_specs` | ✓ (H.x0.5) | CONSUMED_ESTIMATED (packaging-per-finished-unit) |
| `item_conversions` | ✓ (H.x0.5) | CONSUMED_ESTIMATED (unit/case math) |
| `blister_material_standards` | ✓ (H.x3) | CONSUMED_ESTIMATED (cards: g/blister) |
| `read_bag_metrics.units_yielded` | ✓ | CONSUMED_ESTIMATED (driver for packaging consumption) |
| `read_bag_metrics.damaged_packaging` / `ripped_cards` | ✓ | SCRAPPED_OR_DAMAGED (today's only live signal) |

### 2.3 Raw bag / inventory usage (tablet line)
| Source | Live? | Bucket(s) it feeds |
|---|---|---|
| `raw_bag_allocation_events.RAW_BAG_OPENED` | ✓ (H.x3.6) | ACCEPTED audit lineage |
| `raw_bag_allocation_events.RAW_BAG_PARTIAL_CONSUMED` | ✓ | CONSUMED_ACTUAL when `quantity_source='MANUAL_ENTRY'` (HIGH) or CONSUMED_ESTIMATED otherwise |
| `raw_bag_allocation_events.RAW_BAG_RETURNED_TO_STOCK` | ✓ | ON_HAND restored |
| `raw_bag_allocation_events.RAW_BAG_DEPLETED` | ✓ | CONSUMED_ACTUAL (lot fully drawn) |
| `raw_bag_allocation_events.RAW_BAG_ADJUSTED` | ✓ | CYCLE_COUNT_VARIANCE (adjusts qty against expected) |
| `workflow_events` (BLISTER_COMPLETE counts → tablet inputs) | ✓ | CONSUMED_ESTIMATED for tablets |
| `read_material_lot_state` | ✓ | ON_HAND read model |
| `read_roll_usage` | ✓ (H.x4) | CONSUMED_ESTIMATED (cardroute roll segments rolled up) |

### 2.4 Existing reconciliation surface (will be replaced/augmented, not deleted)
- `read_material_reconciliation` — per-bag table with `received_qty`, `consumed_qty`, `finished_qty`, `scrap_qty`, `remaining_qty`, `variance_qty`, `is_estimated`. PT-6B math will treat this as a one-bucket legacy view; PT-6C will project the new 8-bucket shape alongside it without dropping the old one (UI stays compatible during the transition).
- `lib/production/po-reconciliation.ts` — current PO-level reporting. PT-6B helpers will plug in here; PT-6C may replace the projection.
- `app/(admin)/po-reconciliation/page.tsx` — current page. PT-6D rewrites the page around the 8-bucket layout.

---

## 3. Formulas (canonical)

### 3.1 ACCEPTED (per packaging_lot)
```
accepted = COALESCE(counted_quantity, declared_quantity, qty_received)
confidence(accepted) = match {
  counted_quantity not null         → HIGH
  declared_quantity not null         → MEDIUM (supplier-declared)
  qty_received  not null (legacy)    → LOW (legacy_qty_received)
  else                               → MISSING
}
```

### 3.2 RECEIPT_VARIANCE (per packaging_lot)
```
receipt_variance = counted_quantity - declared_quantity
                 (null if either is null)
receipt_variance_pct = receipt_variance / declared_quantity   (when declared > 0)
severity = (|variance_pct| ≤ 1%)  → LOW
           (|variance_pct| ≤ 5%)  → MEDIUM
           else                   → HIGH
```

### 3.3 ESTIMATED_REMAINING (per packaging_lot, time window)
```
estimated_remaining = accepted
                    - consumed_estimated
                    - scrapped_or_damaged
                    + sum(adjustments)
```
where `consumed_estimated` is summed from segment-ledger / BOM-driven sources, and `adjustments` are signed deltas from `PACKAGING_RECEIPT_ADJUSTED` rows other than the cycle count that triggered the current snapshot.

### 3.4 ACTUAL_REMAINING (per packaging_lot)
```
actual_remaining = match {
  latest cycle count exists in window  → cycle count's new_qty_on_hand
  latest weigh-back exists (rolls)     → starting_weight - latest_observed_weight
  else                                 → null  (fall back to estimated_remaining)
}
```

### 3.5 CYCLE_COUNT_VARIANCE
```
cycle_count_variance = actual_remaining - estimated_remaining
                     (null when actual_remaining is null)
```
Already emitted as `PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE` at the moment of adjust; the bucket here just sums those events for the window.

### 3.6 CONSUMPTION_VARIANCE
```
consumption_variance = consumed_actual - consumed_estimated
                     (null when consumed_actual is null)
```
Per-(lot, role, window). For rolls: `consumed_actual` from ROLL_WEIGHED / ROLL_DEPLETED, `consumed_estimated` from segment ledger × standard. For count-based packaging: `consumed_actual` from cycle-count delta, `consumed_estimated` from `units_yielded × spec.qty_per_finished_unit`.

### 3.7 UNKNOWN_VARIANCE
```
unknown_variance = accepted
                 - (consumed_actual ?? consumed_estimated)
                 - scrapped_or_damaged
                 - on_hand
                 - receipt_variance        (already accounted for in accepted source)
                 - cycle_count_variance    (already accounted for via on_hand adjustments)
                 - consumption_variance    (already accounted for via consumed_actual)
```
The arithmetic is intentionally a residual after subtracting every classified piece. UNKNOWN_VARIANCE is whatever's left and means "we can't classify this — investigate."

---

## 4. Confidence rules (canonical ladder)

Already in use across the codebase (`HIGH | MEDIUM | LOW | MISSING`). For PT-6 buckets:

| Confidence | Bucket-level meaning |
|---|---|
| HIGH | Physical count, weigh-back, direct measurement, cycle count. |
| MEDIUM | Supplier-declared quantity, BOM-derived usage, configured standard, segment ledger. |
| LOW | Legacy import, inferred mapping, partial source (e.g., `qty_received` filled but no declared/counted). |
| MISSING | Required source not available. Bucket reports null and the UI shows the missing-input chip. |

**Rule.** A bucket's confidence is the **lowest** of its inputs. ACCEPTED counted_quantity HIGH ∧ declared_quantity MEDIUM → ACCEPTED is HIGH (because counted wins). But if a bucket needs both inputs (e.g., RECEIPT_VARIANCE needs both counted and declared), the lower of the two governs.

---

## 5. UI rules (load-bearing)

The UI **must** keep the four variance subtypes visually distinct so the wrong team doesn't get blamed:

1. **RECEIPT_VARIANCE** — column header literally says "Vendor / shipping" and copy says "vs supplier declared." Never labelled "loss." Severity coloured per the existing `classifyVarianceSeverity` (LOW/MEDIUM/HIGH bands).
2. **CYCLE_COUNT_VARIANCE** — column header "Count drift / cycle adjust." Copy says "vs system expectation at count time." A non-zero value here is **not** vendor short and **not** production over-use; it's drift between events.
3. **CONSUMPTION_VARIANCE** — column header "Process loss vs BOM." Positive value labelled "over BOM" with a magnifier icon (process audit candidate). Negative labelled "under BOM" (standards may be loose).
4. **UNKNOWN_VARIANCE** — column header "Unclassified." Pill says "investigate." Clicking drills into lot's event history.

Estimated values must always carry the existing "estimated" pill / `is_estimated` badge that the codebase already uses in `read_material_reconciliation`. PT-6 adds per-bucket badges, not a single per-row badge.

Legacy rows (created before PT-1, so `accepted_quantity` came from `qty_received` only) **must** show LOW confidence on ACCEPTED with a "legacy import" pill that the UI explicitly explains.

The single "variance_qty" column from today's `read_material_reconciliation` page does **not** disappear; PT-6D keeps it as a "Total movement" summary line for users who want one number, but the four named columns are the primary read.

---

## 6. Data-model changes (proposal — PT-6C will execute)

PT-6 keeps the existing tables and adds projected views. Nothing destructive.

### Proposed (PT-6C will decide and ship)
- `read_material_reconciliation_v2` — per-(packaging_lot_id, day) row with all eight buckets + per-bucket confidence. Same primary-key shape as the existing per-bag table, just keyed on the lot rather than the bag, because most operationally interesting questions are per-material-lot, not per-bag. The existing per-bag `read_material_reconciliation` stays untouched for back-compat readers.
- `read_packaging_reconciliation_daily` — rollup keyed by `(day, packaging_material_id)` for the leaderboard view ("today's variance by SKU"). Same buckets, summed.
- Optionally `read_reconciliation_events` — append-only audit table that captures each bucket-affecting event so the UI's drill-in can render the timeline without re-walking workflow_events / material_inventory_events. Skip in PT-6C if the projector is fast enough at read time.

**Decision deferred to PT-6B.** PT-6B will write the pure helpers first; we'll know whether read-time derivation is fast enough or whether we need a materialised view. If pure-derivation is fast on the staging dataset, we ship without new read-models and skip this portion.

### What we are NOT changing
- `read_material_reconciliation` — kept as the legacy per-bag surface. UI will continue to render it under a "Per-bag totals (legacy)" tab during the PT-6 transition.
- `packaging_lots.qty_on_hand` — keeps being maintained the same way (admin cycle-count flow already does it correctly).
- Existing event types — every bucket maps onto events already in the enum; no new event types in PT-6.

---

## 7. Migration plan

### Constraints
- **Additive only.** No column drops, no type narrowing.
- **No destructive Postgres operations.** Cannot reuse migration numbers; next is `0025` after OP-1E's `0024`.
- **Legacy compatibility.** Every formula has a fallback for pre-PT-1 / pre-OP-1B / pre-H.x4 rows. The `qty_received` legacy column is treated as a LOW-confidence source for ACCEPTED.
- **Replay strategy.** PT-6C's projector should be re-runnable — invoking `rebuildMaterialReconciliationV2(tx)` on a clean DB or after an event-replay must produce the same buckets. Same pattern as existing `rebuildMaterialLotState` / `rebuildRollUsage`.
- **Backfill.** No backfill needed in PT-6C beyond a one-shot `rebuild` invocation. Existing event ledger has all the data; PT-6 just reads it differently.

### Sequencing
1. PT-6C migration creates `read_material_reconciliation_v2` (and the daily rollup if we ship it).
2. PT-6C projector hook fires on every event type from §2 (subscribed to specific event-type values, not blanket on every workflow_event/material_inventory_event so we don't churn the read-model on irrelevant events).
3. After deploy, run `rebuild-read-models.ts` once on staging to seed the v2 table from the historical ledger.
4. PT-6D ships the UI on top of v2 with the legacy table behind a "Legacy view" toggle.
5. After the new UI has been live for one full reconciliation cycle, PT-6F (out-of-scope here, future cleanup) can deprecate the legacy per-bag table.

---

## 8. Test plan

Pure-helper tests (PT-6B):

| Case | Expected |
|---|---|
| 1. declared only (counted null, qty_received null) | ACCEPTED = declared, confidence MEDIUM, RECEIPT_VARIANCE null |
| 2. declared + counted equal | ACCEPTED = counted, confidence HIGH, RECEIPT_VARIANCE = 0 (LOW severity) |
| 3. declared + counted, counted < declared (vendor short) | RECEIPT_VARIANCE negative, ACCEPTED = counted HIGH |
| 4. declared + counted, counted > declared (vendor over) | RECEIPT_VARIANCE positive, ACCEPTED = counted HIGH |
| 5. counted only (declared null) | ACCEPTED = counted HIGH, RECEIPT_VARIANCE null + reason "no declared" |
| 6. PackTrack receipt with both fields | source_system='PACKTRACK', confidence MEDIUM (declared) → HIGH (counted) |
| 7. Manual Luma receipt (single qty_received) | ACCEPTED = qty_received LOW (legacy_qty_received) |
| 8. Cycle-count adjustment (delta non-zero) | CYCLE_COUNT_VARIANCE = delta, kind labelled correctly |
| 9. Production estimated consumption (cards) | CONSUMED_ESTIMATED = sum(segment × g/blister), MEDIUM |
| 10. Actual consumption from ROLL_DEPLETED | CONSUMED_ACTUAL = net_weight_grams, HIGH/MEDIUM per source |
| 11. Weigh-back mid-roll | CONSUMED_ACTUAL = starting - latest_weight, HIGH |
| 12. ROLL_DEPLETED without weigh-back, segment-only | CONSUMED_ACTUAL MEDIUM (depletion-inferred) |
| 13. UNKNOWN_VARIANCE residual | When the equation doesn't close, surfaces as UNKNOWN > 0 with LOW confidence |
| 14. Legacy bag (no counted, no declared, qty_received only) | LOW confidence everywhere, no RECEIPT_VARIANCE |
| 15. No double-counting | A receipt-variance row in the audit ledger does NOT also appear in CONSUMPTION_VARIANCE |
| 16. Receipt variance ≠ production loss | RECEIPT_VARIANCE remains in the receipt bucket even when the lot is also consumed |
| 17. ACCEPTED missing both declared+counted+qty_received | bucket null + MISSING confidence; UI must show "needs intake" |
| 18. Mixed-source lot (PackTrack declared + Luma counted) | source_system='PACKTRACK', counted source 'MANUAL_LUMA', confidence inherits HIGH from counted |
| 19. ON_HAND vs cycle count mid-lot | CYCLE_COUNT_VARIANCE captures only the delta, never re-blamed as receipt |
| 20. Two cycle counts in one window | both deltas sum into CYCLE_COUNT_VARIANCE; ON_HAND reflects latest |

Projection / read-model tests (PT-6C):
- 21. Replay produces deterministic buckets (same events → same output).
- 22. Adding a new `PACKAGING_VARIANCE_RECORDED` event triggers projector and updates exactly one row.
- 23. Daily rollup sums per material match the per-lot view.

UI tests (PT-6D):
- 24. RECEIPT_VARIANCE column never says "loss" anywhere in the rendered HTML.
- 25. CYCLE_COUNT_VARIANCE rows render the cycle-count badge, not the vendor-shortage badge.
- 26. UNKNOWN_VARIANCE > 0 rows render the "investigate" pill.
- 27. Legacy `qty_received`-backed rows render the "legacy import" badge.
- 28. Confidence ladder badges match per-bucket confidence.

---

## 9. Implementation phases (PT-6 split)

| Phase | Scope | Stop condition |
|---|---|---|
| **PT-6A** *(this doc)* | Plan only — no code. | Plan accepted by owner. |
| **PT-6B** | Pure reconciliation helpers (`lib/inbound/reconciliation.ts` or `lib/production/reconciliation-v2.ts`) + 20+ unit tests. No DB changes. | Helpers + tests green; tsc / vitest / build clean. |
| **PT-6C** | Migration `0025_read_material_reconciliation_v2.sql` + projector hook + rebuild script update. Daily-rollup table optional, decided based on PT-6B perf. | Migration applies on staging; rebuild populates v2 from existing event ledger; projector idempotent on replay. |
| **PT-6D** | `app/(admin)/po-reconciliation/page.tsx` rewritten around 8 buckets; legacy view stays behind a toggle. | Page renders all 8 buckets with correct copy + per-bucket confidence; UI tests green; auth smoke clean. |
| **PT-6E** | Staging verification: SHA confirmed, migration applied, rebuild run, finalise a QA bag, confirm each bucket lights up. | Verifier all-pass; stop condition documented in `docs/CURRENT_PHASE_STATUS.md`. |

---

## 10. Risks & open questions

1. **Read-time vs projected.** For small staging datasets pure-derivation is plenty fast. Production has a longer event history; we may need the materialised `read_material_reconciliation_v2`. PT-6B benchmarks the helpers against staging data; PT-6C takes the materialisation decision based on those numbers.
2. **CONSUMED_ACTUAL coverage.** Only roll weigh-backs and depletions populate this today. For count-based packaging materials, CONSUMED_ACTUAL stays MISSING until cycle counts roll in. The UI must explain this clearly so operators don't chase a phantom CONSUMPTION_VARIANCE.
3. **Tablet line.** The plan focuses on packaging_lots; tablet `inventory_bags` reconciliation lives in `raw_bag_allocation_events`. The 8-bucket model maps cleanly there too, but the per-lot key shape is different. PT-6C will decide whether to ship one v2 table that covers both, or two parallel tables (one for packaging_lots, one for inventory_bags). Neutral default: one table with a `lot_kind` discriminator column.
4. **Confidence collapsing.** When a bucket has multiple inputs of different confidence, our rule is "lowest wins" — but for some buckets that's harsh. Example: ACCEPTED has counted (HIGH) overriding declared (MEDIUM); but UNKNOWN_VARIANCE has every bucket as input. We'll need to write explicit confidence rules per bucket in PT-6B; the §4 single-rule sketch is provisional.
5. **Variance signing convention.** For RECEIPT_VARIANCE we use `counted - declared` (negative = supplier short). For CONSUMPTION_VARIANCE we use `actual - estimated` (positive = production over-used). This is intentional but easy to get backwards. PT-6B helper tests must assert the sign for every case.
6. **Damages bucket.** Today's only live damage signal is `read_bag_metrics.damaged_packaging` + `ripped_cards`. These are *finished-good* damages, not raw-material scrap. The 8-bucket model treats them as part of SCRAPPED_OR_DAMAGED but the UI must be honest that scrap of raw material remains MISSING until the QC subsystem ships `MATERIAL_SCRAPPED` / `PACKAGING_DAMAGE_RETURN`.
7. **Time-window ambiguity.** "Per day" is ambiguous if a receipt lands at 11:59pm on day N and is counted at 12:01am on day N+1. The plan uses `occurred_at` of the relevant event for windowing, with a "received-on" attribute carried separately so receipt-day reports stay readable. PT-6B helpers parameterise the window function explicitly.
8. **Variance subtype change-of-mind.** If ops decides cycle-count drift should split into "shrinkage" vs "miscount" later, we don't want to migrate the read model again. PT-6C stores `kind` as text on `PACKAGING_VARIANCE_RECORDED` (already does — fine) and the v2 read model groups by it dynamically rather than by hardcoded columns. Future kinds become new groups without schema changes.

---

## 11. Out of scope (call out to keep PT-6 honest)

- **No QC damage / rework / scrap live wiring.** Those events stay deferred to the QC subsystem phase per OP-1D.
- **No PackTrack write-back / reorder.** PT-7 (shortage recommendations) is read-only forward-looking; not in PT-6.
- **No Zoho live sync.** Existing Zoho stub stays as-is.
- **No visual polish.** PT-6D rewrites the page for correctness, not aesthetics. The command-center polish phase is its own queue item.
- **No `read_material_reconciliation` deletion.** Legacy table stays alive through the transition. A future PT-6F can decide deprecation once v2 has had a full reconciliation cycle live.

---

## 12. Anchor

When PT-6B starts:
- The pure helpers must be fully unit-tested before any DB changes (PT-6C).
- The v2 read model must be re-derivable from the event ledger; never write to it from a path that doesn't also pass through the projector.
- The UI must keep the four variance subtypes visually distinct from the moment it ships.
- Every bucket must carry confidence and `missingInputs` exactly like today's metric infrastructure.
- The static invariant scanner from OP-1F is not affected; PT-6 does not introduce new event types, only new readers.

End of plan.
