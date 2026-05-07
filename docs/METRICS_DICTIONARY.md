# Luma Metrics Dictionary

**Phase B canonical reference.** Every metric returned by `lib/production/metrics.ts` is documented below: its formula, source tables, required inputs, confidence rules, missing-data behaviour, and classification. This dictionary is the contract — if a metric returns a value, it must match what's written here. If you change the formula, change this file in the same commit.

## Classification

Each metric falls into one of three buckets:

- **Actual** — a number directly recorded by the floor (e.g. counter delta from a stage event).
- **Derived actual** — composed from other actuals, no standards involved (e.g. bag lead time = finalized_at − received_at).
- **Performance vs standard** — requires a standards table to interpret (e.g. OEE, on-time completion). Refused without standards.

## Confidence ladder

```
HIGH    All required inputs present and audited
MEDIUM  Some inputs present, others absent; computation OK with caveats
LOW     Inputs estimated or stitched across sources (e.g. legacy import)
MISSING Refused to compute — required input absent
```

Anything **MISSING** is rendered to the UI with a `label` (e.g. *"Insufficient data for OEE"*) and a `missingInputs[]` list. Never with a numeric value.

## OEE rule (locked)

True OEE is **never** displayed unless every input below is present:

1. Planned production time (`production_calendars`)
2. Actual runtime (workflow event durations)
3. Ideal cycle / target rate (`station_standards`)
4. Total units, good units, reject/scrap units (`workflow_events`, projector counts)

If any of (1)–(4) is missing the function returns `MISSING` with the label *"Insufficient data for OEE"*. **OEE never displays above 100.**

A proxy metric — say, an actuals-only ratio — must never be labelled "OEE". Use names like `runtimeRatio` or `outputRatio` and explicitly call them proxies.

---

## Metrics

### `bagsInFlow` (actual)

| | |
|--|--|
| **Formula** | `COUNT(*) FROM read_bag_state WHERE is_finalized = false` |
| **Source** | `read_bag_state` |
| **Required inputs** | None |
| **Confidence** | HIGH always (zero is the honest answer when nothing is in flow) |
| **Missing behaviour** | Returns `0` with HIGH confidence |
| **Unit** | `bags` |

### `goodUnitsToday`, `displaysToday`, `casesToday`, `bagsFinalizedToday` (actual)

| | |
|--|--|
| **Formula** | `SUM(read_daily_throughput.{units_produced, displays_produced, cases_produced, bags_finalized}) WHERE day = today` |
| **Source** | `read_daily_throughput` |
| **Required inputs** | None |
| **Confidence** | HIGH |
| **Missing behaviour** | Returns `0` with HIGH confidence |
| **Unit** | `units` / `displays` / `cases` / `bags` |

### `oldestQueueAgeMinutes` (derived actual)

| | |
|--|--|
| **Formula** | `EXTRACT(EPOCH FROM (now() - MIN(read_bag_state.last_event_at)))` for non-finalized bags |
| **Source** | `read_bag_state` |
| **Required inputs** | At least one non-finalized bag with `last_event_at` set |
| **Confidence** | HIGH when bags exist; otherwise `0` with HIGH (queues clear) |
| **Missing behaviour** | `0` + explanation "No active bags in queue" |
| **Unit** | `min` |

### `pausedBagsOverThreshold` (actual)

| | |
|--|--|
| **Formula** | `COUNT(*) FROM read_bag_state WHERE is_paused AND paused_at < now() - 30min` |
| **Source** | `read_bag_state` |
| **Required inputs** | None |
| **Confidence** | HIGH |
| **Missing behaviour** | `0` |
| **Unit** | `bags` |

### `scheduleGap` (performance vs standard)

| | |
|--|--|
| **Formula** | `COUNT(*) FROM due_targets WHERE completed_at IS NULL AND due_at < now() + 24h` |
| **Source** | `due_targets` |
| **Required inputs** | At least one row in `due_targets` |
| **Confidence** | HIGH when standards present, MISSING otherwise |
| **Missing behaviour** | `MISSING` + label *"No target configured"* |
| **Unit** | `open targets due ≤24h` |

---

### `bagGenealogy` (actual)

| | |
|--|--|
| **Formula** | `SELECT * FROM workflow_events WHERE workflow_bag_id = $1 ORDER BY occurred_at, id` joined with `stations`, `machines`, `employees` |
| **Source** | `workflow_events`, `stations`, `machines`, `employees` |
| **Required inputs** | A valid bagId with at least one event |
| **Confidence** | HIGH when events exist; MISSING otherwise |
| **Missing behaviour** | Empty `events[]` + `confidence: MISSING` + `missingInputs: ["events"]` |
| **Unit** | n/a (returns event list + summary metrics) |

**Why no materialised read model:** `workflow_events` is already an append-only chronological event log keyed on `workflow_bag_id` with the right index. A separate `read_bag_genealogy` would duplicate the log. Phase B reads straight off the event table.

---

### Machine metrics (`deriveMachineMetrics`)

#### `state` (derived actual)

| | |
|--|--|
| **Formula** | Logic over `read_station_live` + workflow event activity today |
| **Source** | `read_station_live`, `workflow_events`, `stations`, `machines` |
| **Required inputs** | Machine row exists |
| **Confidence** | HIGH always |
| **Values** | `LIVE` / `NO_ACTIVITY_TODAY` / `NOT_INTEGRATED` |
| **Rules** | <ul><li>**NOT_INTEGRATED**: no station rows reference this machine</li><li>**LIVE**: at least one station has `last_event_at` ≥ today's start</li><li>**NO_ACTIVITY_TODAY**: configured but quiet</li></ul> |

#### `currentBag`, `currentSku`, `currentOperator` (actual)

| | |
|--|--|
| **Formula** | `read_station_live.current_workflow_bag_id` joined to `read_bag_state` |
| **Required inputs** | A LIVE machine state with current bag set |
| **Confidence** | HIGH when present, MISSING (label "Idle" or "Unknown") otherwise |

#### `activeRuntimeToday` (derived actual)

| | |
|--|--|
| **Formula** | Sum of (`occurred_at` − previous-stage `occurred_at`) for completion events on the machine's stations within the day |
| **Source** | `workflow_events` |
| **Confidence** | HIGH when events exist |
| **Missing behaviour** | `0` with HIGH confidence |
| **Unit** | `min` |

#### `unitsToday` / `unitsPerHour` (actual / derived actual)

| | |
|--|--|
| **Formula** | `SUM(read_daily_throughput.units_produced)` / `(unitsToday / runtimeSec) * 3600` |
| **Source** | `read_daily_throughput` |
| **Confidence** | HIGH when both present, otherwise `zero("units/hr")` |

#### `idealCycleSeconds` (performance vs standard)

| | |
|--|--|
| **Formula** | `station_standards.ideal_cycle_seconds` for the machine, effective at the date |
| **Source** | `station_standards` |
| **Required inputs** | An active standard row matching `(machine_id, asOf)` |
| **Confidence** | HIGH when present, MISSING otherwise |
| **Missing behaviour** | `MISSING` + label *"No standard configured"* |
| **Unit** | `sec/unit` |

#### `oeeAvailability`, `oeePerformance`, `oeeQuality`, `oee` (performance vs standard)

| | |
|--|--|
| **Availability** | `runtime_seconds / planned_production_seconds` × 100 |
| **Performance** | `(units_today / (runtime_seconds / ideal_cycle_seconds)) × 100`, clamped 0–100 |
| **Quality** | `good_units / total_units` × 100, **MISSING until reject events emit** |
| **OEE** | `Availability × Performance × Quality / 10000`, clamped 0–100 |
| **Source** | `production_calendars`, `station_standards`, `workflow_events`, future reject events |
| **Required inputs** | All four (planned time, runtime, ideal cycle, reject data). Phase B does not yet have reject events; Quality and OEE return MISSING. |
| **Missing behaviour** | `MISSING` + label *"Insufficient data for OEE"* and `missingInputs` listing missing tables |
| **Critical rule** | OEE values **never exceed 100**. `clampPct` enforces this. |

---

### Station metrics (`deriveStationMetrics`)

Same shape as machine metrics, narrowed to a single station. State derived directly from `read_station_live`.

### Route metrics (`deriveRouteMetrics`)

| | |
|--|--|
| **Routes** | `CARD` (BLISTER + SEALING + PACKAGING) / `BOTTLE` (BOTTLE_HANDPACK + BOTTLE_CAP_SEAL + BOTTLE_STICKER) |
| **Formula** | `SUM(read_daily_throughput)` joined with `machines.kind IN (route kinds)` |
| **Source** | `read_daily_throughput`, `machines` |
| **Confidence** | HIGH always; zero is honest |
| **Bottle line rule** | Returns `0` with explanation when no bottle activity captured. **Never invents activity.** |

### Stage metrics (`deriveStageMetrics`)

| | |
|--|--|
| **Stages** | `BLISTER_QUEUE`, `POST_BLISTER_STAGING`, `SEALING_QUEUE`, `POST_SEAL_STAGING`, `PACKAGING_QUEUE`, `BOTTLE_FILL_QUEUE`, `BOTTLE_STICKER_QUEUE`, `BOTTLE_INDUCTION_QUEUE`, `FINISHED_GOODS_QUEUE` |
| **Formula** | `COUNT(*)` and `MIN(now() - last_event_at)` from `read_bag_state` filtered to the matching stage(s) |
| **Source** | `read_bag_state` (live fallback while `read_queue_state` projector is not yet wired in Phase A) |
| **Confidence** | HIGH always |

### Queue aging (`deriveQueueAging`)

Aggregates `deriveStageMetrics` across all stages. Reads `read_queue_state` first; falls back to live computation when empty (until Phase C extends the projector).

### Bottleneck (`deriveBottleneck`)

| | |
|--|--|
| **Formula** | Stage with maximum `oldestAgeMinutes`; tiebreaker on WIP |
| **Source** | `deriveQueueAging` output |
| **Reason values** | `QUEUE_AGE` (>60min) or `WIP` |
| **`cycleVsStandardPct`** | MISSING until `station_standards` populated |
| **No-data behaviour** | Returns MISSING `stageKey` + label *"No bottleneck — queues clear"* |

---

### Packaging metrics (`derivePackagingMetrics`)

| | |
|--|--|
| **Formulas** | `SUM(read_bag_metrics.{master_cases, displays_made, loose_cards, damaged_packaging, ripped_cards})` windowed by `finalized_at` |
| **`damageRatePct`** | `(damaged + ripped) / (cases + displays + loose) × 100`, MISSING when denominator is zero |
| **Source** | `read_bag_metrics` |
| **Confidence** | HIGH always; missing data → 0 |

### Damage & rework metrics (`deriveDamageAndReworkMetrics`)

| | |
|--|--|
| **`damageEvents`** | `COUNT(*) FROM workflow_events WHERE event_type = 'PACKAGING_DAMAGE_RETURN'` |
| **`reworkEvents`** | `COUNT(*) FROM workflow_events WHERE event_type = 'REWORK_SENT'` — **MISSING** when no rework events exist (event type added Phase A; emission paths land Phase C) |
| **`forceReleaseEvents`** | `COUNT(*) FROM workflow_events WHERE event_type = 'CARD_FORCE_RELEASED'` |
| **`firstPassYieldPct`** | `((bags_finalised - bags_with_damage) / bags_finalised) × 100` |
| **Confidence** | HIGH when bags exist, MISSING (`No reject data`) when none |

### Flavor metrics (`deriveFlavorMetrics`)

| | |
|--|--|
| **Primary path** | Read from `read_sku_daily` (Phase A read model) |
| **Fallback** | Aggregate `read_daily_throughput` by `product_id`, marked `_source: read_daily_throughput (fallback)` |
| **Confidence** | HIGH or LOW depending on source |
| **Missing behaviour** | `_status: MISSING` when both sources empty |

### Operator metrics (`deriveOperatorMetrics`)

| | |
|--|--|
| **Source** | `read_operator_daily` (already populated by existing projector at BAG_FINALIZED time) |
| **Per-operator metrics** | `bagsFinalized`, `activeMinutes`, `damages`, `unitsPerHour` |
| **Confidence** | HIGH when bags exist |
| **Missing** | `_status: MISSING` when no rows |

### Material reconciliation (`deriveMaterialReconciliation`)

| | |
|--|--|
| **Primary path** | `read_material_reconciliation.variance_qty` per bag (when populated by Phase C projector) |
| **Fallback** | Live join: `inventory_bags.pill_count` − `read_bag_metrics.units_yielded` − `read_bag_metrics.damaged_packaging`; marked **estimated** with `missingInputs[]` listing absent components |
| **Confidence** | HIGH on primary, LOW on fallback |
| **Estimated flag** | `is_estimated` flows through to `MetricResult.confidence = LOW` |
| **Unit** | `tablets` |

### Finished goods metrics (`deriveFinishedGoodsMetrics`)

| | |
|--|--|
| **`releasedLots` / `releasedUnits` / `releasedCases` / `releasedDisplays`** | `COUNT(*)` / `SUM(...)` from `finished_lots` filtered by `status = RELEASED` and window |
| **`pendingQcLots`** | `COUNT(*) FROM finished_lots WHERE status = 'PENDING_QC'` |
| **`onTimeCompletionPct`** | `(due_targets WHERE completed_at <= due_at) / due_targets WHERE due_at IN window`. **MISSING when `due_targets` empty.** |
| **Source** | `finished_lots`, `due_targets` |

---

## Pure helpers (exported for tests)

| Function | Inputs | Output | Purpose |
|---|---|---|---|
| `counterDelta(start, end)` | numbers | number or null | end − start, refuses if end < start (counter wrap) |
| `activeRuntimeSeconds(intervals)` | array of {from, to} | seconds | sums closed intervals |
| `pauseDurationSeconds(events, now)` | array of pause/resume events | seconds | pairs events; open pause → (now − pausedAt) |
| `bagLeadTimeSeconds(receivedAt, finalizedAt)` | dates | seconds | finalized − received |
| `queueAgeSeconds(lastEventAt, now)` | dates | seconds | now − lastEventAt |
| `packagingDisplaysToCases(displays, displaysPerCase)` | numbers | number or null | strict, refuses non-positive ratio |
| `oee(A, P, Q)` | percent | percent or null | clamps each factor 0–100, never returns >100 |
| `calendarPlannedSeconds(c)` | calendar | seconds | handles cross-midnight + breaks |
| `clampPct(n)` | number | number 0–100 | the OEE clamp, used everywhere percentage shows |

## Empty-state copy (locked)

These exact strings are returned in `MetricResult.label` when a metric refuses to compute. The UI must render them verbatim:

- `Insufficient data for OEE`
- `No standard configured`
- `No reject data`
- `No target configured`
- `No labor rate configured`
- `No activity today`
- `No bottleneck — queues clear`
- `Idle`
- `Not integrated`
- `Waiting for first scan`
- `Bottle line not integrated`

If a metric needs new copy, add it here first, then return it — the UI never invents its own empty-state messages.
