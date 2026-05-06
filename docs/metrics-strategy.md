# Luma metrics strategy — what to pull from the data

Author's note: this is an opinionated, "what an ops VP would actually pin to the
wall" spec. It assumes the data already in `inventory_bags`, `workflow_events`,
`legacy_warehouse_submissions`, `legacy_machine_counts`, `legacy_blister_rolls`,
`legacy_compressors`, `legacy_po_damage_closeout`, `read_bag_metrics`,
`read_daily_throughput`, `read_operator_daily`, `read_material_burn`. Where a
metric needs a field that is not yet captured, it lives in **Section 15 —
Phase-2 instrumentation gaps**, not in the live sections.

The 7 months of legacy history is the gold here. Most outside-the-box metrics
need 30+ days to stabilize, and Luma forward-only would not have that for
months. Synthesizing legacy `warehouse_submissions` (1,767 rows) and
`machine_counts` (984 rows) into Luma `workflow_events` is therefore a
prerequisite for almost everything in Sections 5, 8, 10, 11, 12. Treat that
synthesis as the metric foundation, not an afterthought.

---

## The five questions a metric must answer

A metric earns the dashboard if it answers at least one. If it does not, kill
it — vanity metrics rot trust.

1. **What changed?** (today vs. yesterday, this week vs. last)
2. **Where is the leak?** (which station, machine, operator, flavor, bag, vendor)
3. **What's running out?** (material, capacity, hours of work, ramp window)
4. **Who or what is at risk?** (forgotten bag, sliding operator, lapsing batch,
   late vendor)
5. **What's the dollar cost of doing nothing?** (cash on the floor, downtime $,
   damage $, vendor weight cheating)

Every metric in the rest of this doc is tagged with the one or two questions
it answers; if it doesn't trigger an action, it's cut.

---

## Section 1 — Throughput & cycle (the table-stakes, but go deep)

**Reads from:** `read_bag_metrics` (per-bag), `read_daily_throughput` (per-day
per-machine), `workflow_events` (raw), `read_bag_state` (live), legacy stash
once synthesized.

For each metric below: `name | definition (SQL pattern) | surface | audience |
action | source | refresh | gotchas`. Most "gotchas" exist because we have
parallel-station claims (one bag is held by sealing + packaging concurrently)
and pause-aware cycle math.

### 1.1 Bags-finalized today
- **SQL pattern:** `SELECT SUM(bags_finalized) FROM read_daily_throughput WHERE day = current_date`
- **Surface:** Owner home tile #1, floor TV header
- **Audience:** owner, lead
- **Action:** if < 70% of 7-day-avg by 14:00 ET → push to lead "behind pace"
- **Refresh:** live (pg_notify on BAG_FINALIZED)
- **Gotcha:** day boundary in `America/New_York`, not UTC. Cast `now()` to ET
  before truncating.

### 1.2 Units-yielded today (and YTD)
- **SQL pattern:** `SELECT SUM(units_yielded) FROM read_bag_metrics WHERE finalized_at::date = ...`
- **Surface:** Owner home, accountant week-close
- **Action:** drives ship-against-PO forecasting
- **Gotcha:** `units_yielded` is post-yield (ripped/damaged subtracted).
  Don't confuse with `bag_label_count`.

### 1.3 Average + p50 + p90 cycle time, total / active / paused
- **SQL pattern:**
  ```sql
  SELECT
    AVG(total_seconds), AVG(active_seconds), AVG(paused_seconds),
    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY active_seconds),
    PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY active_seconds),
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY active_seconds)
  FROM read_bag_metrics
  WHERE finalized_at >= now() - '30 days'::interval
  ```
- **Surface:** /metrics overview, /metrics/[lane]
- **Audience:** lead, plant manager
- **Action:** p99 > 2× p50 → investigate which bag is the outlier; p90 trending
  up week-over-week → meeting topic
- **Gotcha:** `active_seconds = total - paused`; using total directly mixes in
  end-of-day pauses.

### 1.4 Per-stage cycle (blister, sealing, packaging, bottle hand-pack, sticker,
cap-seal)
- **SQL pattern:** the per-stage seconds columns on `read_bag_metrics`. Unify
  card lane and bottle lane to a 3-step ladder with a "lane" dimension.
- **Surface:** /metrics, /floor-board lane chips
- **Action:** longest-stage today gets a "current bottleneck" pill on TV
- **Gotcha:** `staging_1_seconds` / `staging_2_seconds` are gaps between stages,
  not stage time — they are pure handoff loss. Keep separate.

### 1.5 Through-put / shift-hour (per machine, per lane)
- **SQL pattern:**
  `bags_finalized_in_window / shift_hours_active_in_window`
  Shift-hours is `count(distinct hour) FROM workflow_events WHERE event_type IN ('BAG_CLAIMED','BLISTER_COMPLETE','SEALING_COMPLETE','PACKAGING_*','BOTTLE_*') GROUP BY machine`.
- **Surface:** /metrics By machine
- **Action:** drives daily plant-manager standup
- **Gotcha:** "shift hour" = an hour with at least one production-positive
  event on that machine; otherwise idle hours dilute the rate.

### 1.6 Units / shift-hour (cards-finalized / displays-finalized)
- Same as 1.5 but yield-aware.

### 1.7 Bags-in-flight count (snapshot)
- **SQL pattern:** `SELECT COUNT(*) FROM read_bag_state WHERE NOT is_finalized`
- **Surface:** floor TV header
- **Refresh:** live

### 1.8 Median age of bags-in-flight
- **SQL pattern:** `EXTRACT(epoch FROM now() - workflow_bags.started_at)` for
  not-finalized, take median.
- **Action:** > 1.5× 30-day-median → at least one bag is stuck → list 3 oldest
  in flight, pull-up the assigned card, ask the lead.

### 1.9 First-pass yield rate (FPY)
- **Definition:** finalized bags whose `(damaged_packaging + ripped_cards) /
  (units_yielded + damaged_packaging + ripped_cards) <= 1%`. Roll up to a %.
- **Surface:** /metrics top strip, owner digest
- **Action:** falling FPY week-over-week is the single most-actionable
  quality signal — operator coaching, vendor batch trace.

### 1.10 Tablets pressed vs. tablets sealed vs. tablets packed reconciliation
- **SQL pattern:** sum the `BLISTER_COMPLETE.payload.count` × `cards_per_turn` ×
  `tablets_per_card` vs `SEALING_COMPLETE.payload.count` × ... vs the
  `PACKAGING_COMPLETE.payload.units_yielded`.
- **Surface:** Counter-error report (existing legacy report, ported)
- **Action:** any % delta > 3% is a mis-count → flag for warehouse-edit
- **Gotcha:** `cards_per_turn` lives on `machines` (2/3/6); a sealing machine
  doing 3-up will produce 3× the count for the same press. Multiply, don't add.

### 1.11 First-event-to-finalize lead time
- **SQL pattern:** `finalized_at - started_at` from `read_bag_metrics`.
- **Use:** the headline cycle metric a non-ops owner intuits.
- **Gotcha:** includes overnight gaps; pair with active_seconds.

### 1.12 Stages skipped count
- **Definition:** how many bags reached PACKAGED without a SEALING_COMPLETE
  (legacy data has these — manual rework). Walk events per bag, look for the
  set difference of expected stages.
- **Action:** non-zero = audit the workflow

### 1.13 Re-claim rate
- **Definition:** count of bags with > 1 `BAG_CLAIMED` event for the same
  station kind. SQL: `count(*) FILTER (WHERE bag_claim_count > 1)`.
- **Action:** > 5% means the floor is doing handoff sloppily.

### 1.14 Concurrent-station load
- **Definition:** for each minute in a day, count of stations with an active,
  non-paused `read_station_live.current_workflow_bag_id`. Render as heatmap.
- **Surface:** /metrics By station heatmap
- **Audience:** plant manager
- **Action:** valleys = under-utilization, peaks = bottleneck.

### 1.15 Time spent per claim ("attention slice")
- **Definition:** for every claim event, time from BAG_CLAIMED → next
  same-station event (PAUSE/COMPLETE).
- **Action:** > 30 min between claim and pause for sealing means an operator
  walked away.

### 1.16 Bottleneck-of-the-hour
- **Definition:** the lane (BLISTER, SEALING, PACKAGING, BOTTLE) with the
  highest p90 cycle in the trailing 60 minutes.
- **Surface:** floor TV
- **Refresh:** live

### 1.17 Throughput stability index
- **Definition:** stddev / mean of `bags_finalized` per day across last 30
  days. < 0.25 is "stable", > 0.5 is "lumpy".
- **Audience:** owner
- **Action:** lumpy plants ship late even at high mean.

### 1.18 Machine occupancy %
- **Definition:** `(seconds with a non-NULL current_workflow_bag_id on
  read_station_live) / (working seconds in window)`.
- **Surface:** /metrics By machine
- **Audience:** plant manager
- **Gotcha:** working seconds = (shift end - shift start) - lunch. Read from
  the `company.timezone` and a Setting for shift hours.

### 1.19 Single-piece-flow indicator
- **Definition:** for each machine in a day, max number of distinct workflow
  bags it serviced. > 4/day = lots of context-switching → setup losses.
- **Audience:** plant manager
- **Action:** schedule fewer flavors per day per machine.

### 1.20 Setup-time-per-flavor-change
- **Definition:** for sealing & blister machines, the gap between
  PRODUCT_MAPPED on bag N and BLISTER_COMPLETE/SEALING_COMPLETE on bag N+1
  if `bag(N+1).productId ≠ bag(N).productId`.
- **Audience:** lead
- **Gotcha:** real setup is the time the operator spends, not wall time. If
  the floor is single-shift and there's a lunch in the middle, exclude
  "lunch hours" (Settings).

### 1.21 Re-blister rate (rework)
- **Definition:** count of bags with two `BLISTER_COMPLETE` events.
- **Audience:** lead
- **Action:** name the bag and the operator for follow-up.

### 1.22 First-bag-of-day cycle
- **Definition:** for each operating day, first `BAG_FINALIZED` —
  `BAG_CLAIMED` (lane-first). Slow first bag = warm-up loss.
- **Action:** if first-bag is consistently > 1.5× median, schedule a 5-min
  warm-up earlier.

### 1.23 Last-bag-of-day cycle
- **Definition:** symmetric to 1.22.
- **Action:** "shift cliff" — see Section 12.

### 1.24 Bags packed per million-pills-input
- **Definition:** `1e6 × bags_finalized / SUM(input_pill_count)`.
- **Audience:** owner — apples-to-apples across flavors.

### 1.25 Multi-flavor-day count
- **Definition:** `count(DISTINCT product_id) FILTER (BAG_FINALIZED) per day`.
- **Use:** leading indicator of changeover-loss.

### 1.26 Time-to-first-blister (per bag)
- **Definition:** `BLISTER_COMPLETE.occurred_at - workflow_bags.started_at`.
- **Use:** captures both setup and intake dwell.

### 1.27 Time-to-zoho-push (per finished_lot)
- **Definition:** `zoho_pushes.pushed_at - finished_lots.created_at`.
- **Audience:** accountant
- **Action:** sticky lots that don't push = unbilled.

### 1.28 Damage rate (per lane / per machine / per operator)
- **Definition:** `(damaged_packaging + ripped_cards) / (units_yielded +
  damaged_packaging + ripped_cards)`.
- **Audience:** lead, plant manager
- **Action:** > 2σ over 30-day-mean → coaching.

### 1.29 Lane-imbalance ratio
- **Definition:** `bags_blistered / bags_packaged` over rolling 24h.
  > 1.2 means blister-room is lapping packaging → WIP build-up.
- **Audience:** lead
- **Action:** redirect a packager.

### 1.30 Predictable-day-percentage
- **Definition:** % of days in last 90 where `bags_finalized` was within 20%
  of the 7-day rolling mean.
- **Audience:** owner
- **Use:** strategic — drives hiring, schedule expansion.

### 1.31 Hours-of-work-on-the-floor
- **Definition:** `SUM(read_operator_daily.active_seconds_total)` in window.
- **Audience:** accountant (cross-check vs. payroll)

### 1.32 Idle hours per machine (this hour, today, this week)
- **Definition:** complement of 1.18; surface as "$ wasted" using assumed
  `machine_overhead_rate` (Settings, e.g. $/hr).

---

## Section 2 — OEE the way TPM-trained ops people actually use it

Standard OEE = Availability × Performance × Quality. Each gets attributed to
one of the **6 big losses**. The legacy app's pause-reason taxonomy maps
almost 1:1; below is the binding.

```
Availability  ┐  L1 Equipment failure        → pause.reason = 'machine_jam', 'compressor_down'
              ├  L2 Setup/adjustment         → pause.reason = 'material_change' on first bag of flavor
Performance   ┐  L3 Idling / minor stoppages → pauses < 60s OR claim→pause without count
              ├  L4 Reduced speed            → active_seconds vs ideal_seconds_per_bag (per machine kind)
Quality       ┐  L5 Defects / rework         → ripped_cards + damaged_packaging
              └  L6 Startup losses           → first-bag-of-day cycle - normal cycle
```

### 2.1 Availability %
```sql
WITH planned AS (
  SELECT machine_id,
         SUM(EXTRACT(epoch FROM (shift_end - shift_start))) AS planned_sec
  FROM machine_shift_calendar      -- Settings-driven; see §15
  WHERE day BETWEEN ... AND ...
  GROUP BY machine_id
),
unplanned_down AS (
  SELECT s.machine_id,
         SUM(EXTRACT(epoch FROM (resumed_at - paused_at))) AS down_sec
  FROM paired_pauses p
  JOIN stations s ON s.id = p.station_id
  WHERE p.reason IN ('machine_jam','compressor_down','material_change','operator_change','handoff')
  GROUP BY s.machine_id
)
SELECT m.id,
       (planned_sec - COALESCE(down_sec,0)) / NULLIF(planned_sec,0) AS availability
  FROM planned p
  LEFT JOIN unplanned_down u USING (machine_id)
  JOIN machines m ON m.id = p.machine_id
```
- **Surface:** /metrics OEE tab (new)
- **Action:** < 0.75 → maintenance huddle.

### 2.2 Performance %
- **Definition:** `actual_units / (run_time_sec / ideal_sec_per_unit)`.
  `ideal_sec_per_unit` comes from a Settings table per machine kind (the
  blister machine spec is e.g. `cards_per_turn × turns_per_minute = 60 cpm`).
- **Phase-2 gap:** Luma needs `machines.ideal_units_per_hour` field — see §15.

### 2.3 Quality %
- **Definition:** `1 - (damaged + ripped) / total_handled`.

### 2.4 OEE = A × P × Q
- **Surface:** Owner digest one-line. Big donut on /metrics.
- **Industry benchmark:** 60% is OK, 75% is good, 85% is world-class.

### 2.5 Loss attribution waterfall
- **Surface:** stacked horizontal bar showing planned-time → minus L1 → minus
  L2 ... → effective production time.
- **Audience:** plant manager (and any consultant brought in)
- **Use:** the single most actionable chart in TPM. Tells you which loss to
  attack this month.

### 2.6 Loss attribution by reason (the legacy-pause taxonomy)
- For each of `material_change`, `end_of_day`, `paused_end_of_day`,
  `out_of_packaging_hold`, `handoff`, `taken_for_delivery`, `operator_change`:
  total seconds, occurrences, avg duration, $-cost (Settings-defined
  `cost_per_idle_hour` per machine).
- **Surface:** /metrics OEE → "Where did the time go?"

### 2.7 OEE trend (per machine, 30/90-day rolling)
- **Surface:** /metrics line chart per machine
- **Action:** machine where OEE drops > 5pp week-over-week is the next
  service target.

---

## Section 3 — Downtime intelligence

### 3.1 Pause-reason heatmap
- Matrix: machine × pause_reason, cell = total seconds in window.
  Color-coded.
- **SQL pattern:** the existing `paired` CTE in `loadMetrics`, grouped by
  `(machine_id, reason)` and pivoted in the UI.
- **Surface:** /metrics OEE
- **Audience:** plant manager
- **Action:** dark cells = where to invest.

### 3.2 MTBF (mean time between failures) per machine
- **Definition:** for `pause.reason IN ('machine_jam','compressor_down')`,
  `AVG(time_between_consecutive_pauses)` per machine.
- **Source:** `workflow_events` filtered to BAG_PAUSED with those reasons.
- **Industry meaning:** higher is better; if MTBF is dropping, machine is
  decaying.

### 3.3 MTTR (mean time to repair)
- **Definition:** `AVG(resumed_at - paused_at)` for jam/compressor reasons.
- **Surface:** /metrics By machine column
- **Action:** high MTTR + low MTBF = retire/replace candidate.

### 3.4 First-time-fix rate
- **Definition:** % of pauses that resume without another pause of the same
  reason within 10 min on the same machine.
- **Audience:** plant manager
- **Action:** low rate = repair quality issue (or operator misdiagnosing).

### 3.5 Pause clustering (by hour-of-day)
- **SQL pattern:** `GROUP BY EXTRACT(hour FROM paused_at AT TIME ZONE
  'America/New_York'), reason`.
- **Surface:** heatmap, hour × reason
- **Insight:** end-of-day pauses naturally spike at 17–18 (legitimate);
  material-change spikes at 10:30 = roll-finished pattern.

### 3.6 Pause clustering by shift-segment
- Buckets: first hour, peak (mid-shift), last hour.
- **Action:** if material-change concentrates in last hour → operators using
  EOD pause as material-change pause (see 3.7).

### 3.7 Pause-reason-misclassification detector
- **Definition:** pauses tagged "material_change" but lasting > 90th
  percentile of material-change duration → likely actually EOD or jam,
  recategorize candidate.
- **Surface:** weekly anomaly digest

### 3.8 "Forgotten bag" detector
- **Definition:** a bag whose `read_bag_state.is_paused = true` AND
  `(now() - paused_at) > p99(closed_pause_durations for same machine, 30d)`.
- **Surface:** Floor lead "act now" panel + push to lead
- **Audience:** lead
- **Action:** clickthrough to release / continue.

### 3.9 "Walked away" detector
- **Definition:** a station claimed (BAG_CLAIMED) > 30 min ago with no
  subsequent count event AND no pause event.
- **Surface:** Floor lead alert
- **Action:** push to operator (in-app), reassign card.

### 3.10 Pause-streak detection
- **Definition:** machine with ≥ 3 pauses of the same reason within 90 min.
- **Action:** call maintenance.

### 3.11 Predicted next-pause window
- **Definition:** for each machine, given last-N pauses, fit a simple
  exponential-distribution to the inter-arrival time and surface the 50%
  CI for "next pause expected by ...". (Section 10 for model details.)
- **Surface:** Floor TV "next pause expected: 14:25 ± 12 min".
- **Audience:** lead
- **Action:** schedule the lunch break around it.

### 3.12 Productive-vs-setup-vs-handoff time pie
- For a machine in a window: split active_seconds across (real-blister-run,
  setup-after-flavor-change, handoff-between-bags). Setup and handoff use the
  pause-reason taxonomy.
- **Surface:** /metrics By machine drill-down
- **Audience:** plant manager
- **Use:** if handoff > 15% of total, the standard handoff procedure needs a
  rewrite.

### 3.13 Cost-of-pause $
- **Definition:** `pause_seconds × machine_overhead_rate_per_hour / 3600`.
  `machine_overhead_rate` is a Setting (operator wage + electricity +
  overhead allocation).
- **Surface:** owner digest, weekly accountant
- **Use:** "$2,400 of compressor downtime last week" gets attention.

### 3.14 Pause-mix shift detector
- Compare this-week distribution of pause reasons vs. last-month
  distribution. χ² test; flag reasons whose share moved > 5pp.
- **Surface:** weekly digest

### 3.15 Compressor-attributable downtime
- **Definition:** join `legacy_compressors` to `machines` (via
  `legacy_compressors.machine_id`); for each compressor, attribute the share
  of machine downtime where reason ∈ {compressor_down, machine_jam} during
  windows the compressor was the primary feed.
- **Source:** `legacy_compressors` (4 rows, has `cost`, `tank_size`).
- **Surface:** /metrics Compressors tab (new)
- **Action:** compressor with highest $-cost per finished bag is the next
  buy.

---

## Section 4 — Material economics & runway

### 4.1 Days-of-supply per packaging material
- **SQL pattern:**
  `qty_on_hand_total / (consumed_30d / 30)` per material from
  `packaging_lots` and `read_material_burn`.
- Already in `/metrics/forecast`. Tighten: add **per-flavor** runway (4.2).

### 4.2 Days-of-supply per (material × flavor)
- Same as 4.1 but the burn is restricted to bags of a specific product_id.
  Gives "we have 12 days of bottles and 4 days of bottles-for-flavor-X
  because it's the only one consuming the matte cap".
- **Surface:** /metrics Forecast → expanded
- **Action:** flavor-specific reorder before generic reorder.

### 4.3 Vendor-by-vendor damage attribution
- **SQL pattern:** join `legacy_po_damage_closeout` (6 rows so far, will
  grow) to `purchase_orders.vendor_name`. SUM(damage_weight_kg) per vendor.
- **Surface:** /metrics Vendors tab (new) — vendor scorecard (12.10)
- **Action:** highest damage vendor = renegotiate or terminate.

### 4.4 Blister-roll-wear vs output correlation
- **Source:** `legacy_blister_rolls` — has `start_press_count`, `end_press_count`,
  `total_blisters`, `started_at`, `ended_at`.
- **Definition:** `blisters_per_press_actual = total_blisters / (end_press_count -
  start_press_count)` vs the configured `blisters_per_press`. Falls below 90% =
  the roll is wearing the die.
- **Surface:** /metrics Blister rolls (new tab)
- **Action:** schedule die-clean before next roll.

### 4.5 PVC vs Foil change-rate ratio
- **Definition:** count of `BAG_PAUSED.payload.material = 'pvc'` vs
  `'foil'` across 30d. If PVC changes > 2× foil changes, you're using the
  wrong PVC width or you've got machine wandering.
- **Audience:** plant manager

### 4.6 Predicted material need (next 30 days) given current PO mix
- **Source:** `purchase_orders` × `po_lines` × `products` × BOM. For every
  open PO, derive the expected packaging material consumption from the
  tablet types and BOM. Sum it.
- **SQL pattern:**
  ```sql
  SELECT pm.id, pm.name, pm.uom,
         SUM(po_lines.qty_ordered * pps.qty_per_unit
             * (CASE pps.per_scope WHEN 'UNIT' THEN 1
                                   WHEN 'DISPLAY' THEN 1.0/p.units_per_display
                                   WHEN 'CASE' THEN 1.0/(p.units_per_display*p.displays_per_case)
                END)) AS expected_consumption
    FROM purchase_orders po
    JOIN po_lines       ON po_lines.po_id = po.id
    JOIN product_allowed_tablets pat ON pat.tablet_type_id = po_lines.tablet_type_id
    JOIN products p ON p.id = pat.product_id
    JOIN product_packaging_specs pps ON pps.product_id = p.id
    JOIN packaging_materials pm ON pm.id = pps.packaging_material_id
   WHERE po.status IN ('OPEN','RECEIVING')
   GROUP BY pm.id, pm.name, pm.uom
  ```
- **Surface:** /metrics Forecast → "Order to cover open POs"
- **Action:** generate suggested reorder list, button to email vendor.

### 4.7 Material reorder timing (vendor-aware)
- **Definition:** for each material, `days_until_stockout - vendor_lead_days`.
  `vendor_lead_days` is a setting per packaging_material (Phase 2 gap).
- **Action:** banner if number goes negative.

### 4.8 Compressor-uptime vs PVC/foil-waste correlation
- **Definition:** roll efficiency (4.4) regressed against compressor downtime
  in same window. Negative slope (less compressor = more waste) = pneumatic
  feed problem.

### 4.9 Cost-per-finished-display
- **Definition:** allocate every consumed material at lot-cost (need
  `packaging_lots.unit_cost_cents` — Phase 2 gap), plus tablet cost (PO
  unit cost), plus operator hours × wage rate, divide by displays_produced.
- **Surface:** owner home — "$/display by flavor" tile
- **Action:** flavor with highest cost = pricing or renegotiation target.

### 4.10 Material-yield per bag
- **Definition:** for each finalized bag, ratio of theoretical material
  consumption (BOM × units_yielded) vs. actual material decrement (sum of
  packaging_lot deductions). Negative = scrap.
- **Action:** > 5% scrap on a single bag → flag.

### 4.11 Roll-to-roll output per machine
- For blister machine, plot total blisters per roll over time. Drift
  upward = die degradation, drift downward = roll inconsistency.

### 4.12 Damage-weight to damage-tablets reconciliation
- **Source:** `legacy_po_damage_closeout`. `damage_weight_kg × 1000 /
  grams_per_tablet ≈ estimated_damaged_tablets`. Discrepancy > 5% = bad
  density assumption (= bad bag-weight estimates).

---

## Section 5 — Operator productivity & development

This section depends on operator codes being captured at scan time
(`read_bag_state.current_operator_code` is the field, and
`read_operator_daily` aggregates by code). Legacy data has free-text names,
mappable post-import. Where we mention "operator", we mean a normalized
employee identity.

### 5.1 Tablets-per-hour by operator (already partially live)
- **SQL pattern:** `units / (active_seconds_total / 3600)` from
  `read_operator_daily`.
- **Audience:** lead
- **Action:** weekly leaderboard.

### 5.2 Bags-finalized per operator (already live)
- **Already in:** `loadMetrics().operators`.

### 5.3 Per-operator damage rate (already partly live)
- **SQL pattern:** `damage_count_total / (units + damage)` in
  `read_operator_daily`.
- **Action:** > 2× plant mean → coaching trigger.

### 5.4 Ramp-up curve for new hires
- **Definition:** for each operator, plot `units_per_hour_per_day` from their
  first day forward. Fit `y = A × (1 - e^(-t/τ))`. Surface τ (days to 63% of
  steady-state).
- **Audience:** owner / HR
- **Use:** "this hire is at 0.7× steady-state at week 2 vs. typical 1.0× —
  intervene".

### 5.5 Variance-based "learning vs. struggling" detector
- **Definition:** for each operator, rolling-7d stddev of bags-per-day.
  Decreasing stddev = learning. Stable mean + increasing stddev = struggling
  / mood / health. Mean dropping = regression.
- **Surface:** owner → quarterly people review

### 5.6 Shift-length productivity decay curve
- **Definition:** for each operator, average units-per-15min bucket from
  shift start. Almost always declines after 5h. Per-operator shape varies.
- **Surface:** /metrics Operators → pick operator → curve
- **Action:** schedule a forced 10-min break at the inflection point.

### 5.7 Best-fit-station recommender
- **Definition:** for each (operator, station_kind) pair, compute median
  units/hour. Operator's top-2 stations by median get tagged "best fit".
- **Surface:** lead's "where to put X today" panel
- **Audience:** lead
- **Action:** schedule per-fit, not per-availability.

### 5.8 Operator pairing performance
- **Definition:** for sealing-stations that historically saw two operators
  during a single bag (claim → claim within 5 min, two distinct
  operator_codes), compute mean cycle vs. solo cycle.
  - Heimy+Jenifer at sealing 1: mean cycle = X
  - Heimy+Joana at sealing 1: mean cycle = Y
  Surface a matrix of pairs.
- **Surface:** /metrics Operators → Pairings tab
- **Use:** schedule the best pairing on the bottleneck shift.
- **Gotcha:** legacy `employee_name` is free-text; needs name→employee_id
  resolution before this can be reliable. Mark "best-effort" until clean.

### 5.9 Operator-flavor affinity index
- See §12.1.

### 5.10 First-error-on-known-flavor detector
- **Definition:** operator X has packed flavor F 200× without a damaged
  count. Today's run has damages > 0. Flag.
- **Surface:** anomaly digest
- **Action:** ask if equipment changed.

### 5.11 Cross-training depth
- **Definition:** per operator, count of distinct station_kinds with > 5
  bags-finalized in last 90d. Owner KPI: median cross-trained skills > 2.
- **Action:** singletons (only 1 station) = bus-factor risk.

### 5.12 Operator-attendance anomaly
- **Definition:** operator who normally appears Mon-Fri but has 3 missed days
  in last 14. Flag.
- **Audience:** HR / owner
- **Source:** `read_operator_daily`.

### 5.13 First-event-of-day-per-operator (effective start time)
- **Definition:** earliest `workflow_event` per operator per day.
- **Use:** payroll cross-check (Section 13 accountant view).

### 5.14 Last-event-of-day-per-operator (effective end time)
- Same logic.

### 5.15 Operator vs. shift-mean productivity z-score
- **Definition:** standardize each operator's daily production against the
  same-day shift-mean. Persistent low z = train; persistent high = retain
  / promote.

---

## Section 6 — Bag/lot economics & yield

### 6.1 Yield % per bag (live)
- Already in `read_bag_metrics.yield_pct`.

### 6.2 Yield % distribution per flavor
- **SQL pattern:** `PERCENTILE_CONT(0.5/0.9/0.99) WITHIN GROUP (...)` for
  yield_pct grouped by product. Surface as box-plot per flavor.
- **Surface:** /metrics By product → "Yield distribution"
- **Action:** flavors with widest IQR = most variable input.

### 6.3 Ripped-cards rate by flavor
- **SQL pattern:** `SUM(ripped_cards) / SUM(units_yielded + ripped_cards)`.
- **Use:** flavor-specific roll/heat calibration.

### 6.4 Weight-vs-count drift detection
- **Definition:** per bag,
  `bag.estimated_tablets_from_weight - bag.bag_label_count`.
  Drift % = `(estimated - label) / label`. Aggregated per vendor in 4.3 /
  12.10; per-bag here flags individual outliers.
- **Surface:** /inbound bag detail; weekly digest
- **Action:** > ±5% on a bag = label-mismatch incident.

### 6.5 Denorm-vs-ledger reconciliation
- **Definition:** for each `inventory_bag`,
  `bag.packaged_count` (denorm) vs `SUM(legacy_submission_bag_deductions
  .tablets_deducted) + SUM(workflow events that deduct)`.
- **Surface:** /inbound or owner digest "drift" widget
- **Source:** `legacy_warehouse_submissions`,
  `legacy_submission_bag_deductions`, plus future Luma deduction events.
- **Gotcha:** pre-Phase-2 there is no Luma deduction event for legacy bags;
  the synthesizer will materialize one per submission_bag_deduction row.

### 6.6 Predicted yield for a new bag
- **Definition:** for a newly received bag with weight W, tablet_type T,
  vendor V, predict its eventual yield using a simple model:
  `predicted_yield = avg_yield_for(T, V) * (1 + α × (W - mean_weight_for(T)))`.
  See §10.4.
- **Surface:** /inbound bag detail tile, "Expected: 11,840 cards (±300)"
- **Use:** sets baseline for 6.7.

### 6.7 "Under-yielding by N%" alert
- **Definition:** at BAG_FINALIZED, compare actual to predicted (6.6). If
  actual < predicted - 1σ → push to lead.
- **Surface:** anomaly digest, push.
- **Use:** catches counting errors and machine misalignment.

### 6.8 Bag age curve (intake → consumption start)
- **Definition:** for each finalized bag, days from `inventory_bags.created_at`
  to first `BAG_CLAIMED`. Distribution by flavor.
- **Surface:** /metrics Bags Aging tab (new)
- **Action:** flavors with median > 60 days = over-ordered.

### 6.9 Bag-aging exposure (cash on the floor)
- **Definition:** for unconsumed bags, sum of `pill_count × tablet_unit_cost`
  by age bucket (0-30, 31-60, 61-90, 91+).
- **Surface:** owner home — "$X in raw inventory > 60d old"
- **Audience:** owner, accountant

### 6.10 Per-bag operator-mix yield
- **Definition:** group finalized bags by the *first* operator vs *last*
  operator. If single-operator runs yield > multi-operator, rethink handoff.
- **Source:** `read_bag_metrics.operatorCodes` (array).

### 6.11 Bags-with-discrepancy-flag rate
- **Source:** `legacy_warehouse_submissions.payload->>'discrepancy_flag'`,
  forward `workflow_events.payload->>'count_status' IN ('over','under')`.
- **Surface:** /metrics anomaly tab.

### 6.12 Bag-level vendor barcode mismatch
- **Definition:** at first BAG_VERIFIED, `payload.scanned_barcode !=
  inventory_bags.vendor_barcode`. Hard error.
- **Surface:** anomaly + push to lead.

### 6.13 Bag input-output value bridge
- **Definition:** each bag's input cost (tablet cost × pill_count) vs. output
  value (units_yielded × wholesale_price).
- **Surface:** owner per-bag drill-down
- **Use:** reveals hidden negative-margin SKUs.

### 6.14 Bag-tablet-type reassignment count
- **Definition:** how many bags had `tablet_type_id` overridden after
  receive (i.e. the audit_log shows a tablet_type_id mutation). Sustained
  > 0 = vendor mislabels.

---

## Section 7 — Order-to-cash velocity & cash-on-floor

### 7.1 PO lifecycle stopwatch
- **Definition:** for each PO, capture timestamps:
  - `t_open`            = `purchase_orders.opened_at`
  - `t_received`        = MIN(`receives.received_at`)
  - `t_first_bag`       = MIN(`inventory_bags.created_at` for box in receive)
  - `t_first_packed`    = MIN(`workflow_events.occurred_at` of
    PACKAGING_COMPLETE for any bag of any product whose tablet_type was
    on this PO)
  - `t_finalized`       = MAX(`workflow_bags.finalized_at` for derived bags)
  - `t_pushed_zoho`     = MAX(`zoho_pushes.pushed_at`)
- **Surface:** /metrics PO velocity tab; accountant week-close
- **Action:** PO open > 60d = flag for write-down review.

### 7.2 Cash-tied-up at each stage
- **Definition:** total tablet cost (PO unit cost × on-hand pill_count) for
  bags in each stage (RECEIVED-not-CLAIMED, CLAIMED-not-FINALIZED,
  FINALIZED-not-SHIPPED, SHIPPED-not-Zoho-pushed).
- **Surface:** owner home tile (this is the highest-stakes number)
- **Audience:** owner, accountant
- **Action:** action lives at whichever stage has the most cash stuck.

### 7.3 Days-from-receive-to-finalize per flavor
- **Definition:** for each flavor, p50/p90 of `(t_finalized - t_received)`.
- **Action:** longest p90 = supply-chain bottleneck.

### 7.4 Days-from-finalize-to-Zoho-push
- **Definition:** mean & p90 of `zoho_pushes.pushed_at - finished_lots.created_at`.
- **Action:** > 24h mean = something's wrong with the push pipeline.

### 7.5 Aged-unfinalized-inventory $
- **Definition:** sum of (input cost) for bags whose
  `started_at < now() - 30d AND finalized_at IS NULL`.
- **Surface:** owner home — "$X in unfinalized inventory aged > 30 days"
- **Action:** click → list of bags + assign-to-finish CTA.

### 7.6 Cash-cycle trend per vendor
- **Definition:** mean (`t_finalized - t_received`) per vendor over time.
- **Source:** `purchase_orders.vendor_name` + 7.1.
- **Use:** vendor-level stocking decisions.

### 7.7 Open-PO aging buckets
- 0-15, 16-30, 31-60, 61+ days. Count and $ in each bucket.

### 7.8 Inventory turnover rate
- **Definition:** (annualized cost-of-goods-finalized) / (avg on-hand
  tablet inventory $). Industry: 8-12 turns/yr good for CPG.
- **Audience:** owner

### 7.9 Receive-to-pack velocity (per bag)
- Same as 7.3 but per-bag, used for Pareto.

### 7.10 Predicted PO closeout date
- **Definition:** for an open PO with R% received and current burn rate B,
  expected close = today + (100 - R)/B days.
- **Surface:** /inbound PO list column
- **Audience:** accountant.

### 7.11 Cash-flip ranking by flavor
- **Definition:** $ revenue per $ inventory tied up, last 30d, per flavor.
- **Surface:** owner home; "best/worst flavors for cash"
- **Action:** prioritize promotion of high-flip flavors.

### 7.12 Per-vendor settlement summary (week-close)
- For accountant: total received this week × unit cost - any damage
  closeouts, by vendor, with payable due dates.

---

## Section 8 — Variety-pack lineage & source-yield analytics

### 8.1 Source-bag consumption by variety
- **SQL pattern:** for each variety bag, walk `workflow_events` of type
  `VARIETY_SOURCES_ASSIGNED` and the deductions stream. Sum per source
  tablet_type.
- **Surface:** Variety detail page

### 8.2 Source-mix variance vs. spec
- **Definition:** for each variety_pack product, the BOM defines ideal
  source-tablet ratio (e.g. equal parts of 4 flavors). Actual consumption
  ratio diverges. Compute χ² per variety run.
- **Action:** > 5% deviation on any source = the variety is mis-allocated.

### 8.3 Source-bag asymmetry early warning
- **Definition:** during a multi-day variety run, detect when source X is
  being consumed > 1.2× the rate of source Y, despite spec ratio = 1:1.
  Predict run-out date.
- **Surface:** floor TV anomaly chip.

### 8.4 Variety pack yield per source-bag
- **Definition:** ratio of variety-pack units yielded per source-tablet
  consumed, vs. that source's flavor-as-card yield.
- **Use:** shows whether variety operations bleed yield.

### 8.5 Source over-consumption month-over-month
- "This variety used 3% more of source X than expected last month" —
  rolling χ² test over 30d windows; flag deltas.

### 8.6 Variety pack ripped-cards by source-flavor
- **Source:** event-payload damage attribution. Determines which source
  flavor's blister format is fragile.

### 8.7 Variety vs. single SKU yield-loss penalty
- **Definition:** for the same tablet_type, compare yield_pct when consumed
  in a single-flavor card vs. a variety pack. Often variety yields less due
  to handling.
- **Audience:** owner — informs pricing.

---

## Section 9 — Quality & traceability surface

### 9.1 Recall blast-radius query
- **SQL pattern:** recursive CTE on `finished_lot_inputs.batch_id`. Already
  designed in spec.
- **Surface:** /recall (existing route)
- **Action:** export of finished lots, customers, ship dates.

### 9.2 Batch-quarantine effect on cycle
- **Definition:** for batches that went `QUARANTINE → RELEASED`, mean time
  in quarantine; for `QUARANTINE → ON_HOLD → RELEASED`, mean cycle penalty.
- **Audience:** plant manager

### 9.3 Repack rate per batch
- **SQL pattern:** count of `legacy_warehouse_submissions.submission_type =
  'repack'` per source bag (via `legacy_submission_bag_deductions`).
- **Action:** batches with > 1 repack event = systemic vendor issue.

### 9.4 Bag-count-vs-label drift trend per vendor
- **Definition:** per vendor, time-series of mean
  `(estimated_count_by_weight - bag_label_count) / bag_label_count`.
  Compounds 4.3 with a temporal view.
- **Action:** if drift moves consistently negative, vendor is short-loading.
- **Source:** `legacy_warehouse_submissions.payload->>'estimated_count_by_weight'`,
  `legacy_warehouse_submissions.payload->>'bag_label_count'`.

### 9.5 Discrepancy-flag rate per operator
- **Source:** `legacy_warehouse_submissions.payload->>'count_status'` ∈
  {`under`, `over`, `match`, `no_bag`}.
- **Action:** consistent `under`-er = miscounting; consistent `over`-er =
  short-loading by vendor or shrinkage.

### 9.6 Batch-on-hold MTTR
- Time from `BATCH_HELD` to `BATCH_RELEASED`. Owner cares because it's
  inventory frozen.

### 9.7 Batch-retention-sample compliance
- **Phase-2 gap:** capture sample-pull events on BAG_FINALIZED. See §15.

### 9.8 Recall-window finished lots
- **Definition:** finished_lots within the last (recall window) days =
  potentially-recallable. Owner home stat.

### 9.9 Quarantine-ageing
- Batches in QUARANTINE > 14d → push to QA owner.

### 9.10 Vendor-batch-number reuse detector
- **Definition:** different vendors using the same batch_number string.
  Easy traceability bug.
- **Action:** weekly cleanup digest.

### 9.11 Bag-default vs submission-recorded batch mismatch
- **Definition:** legacy submission with `batch_number` ≠
  `inventory_bags.batch_number`. Either operator misreported or bag
  resealed mid-run. Investigate per case.

---

## Section 10 — Predictive / forecasting

For each: name, horizon, model, confidence, action.

### 10.1 Predicted finalization time (per in-flight bag)
- **Horizon:** the bag's current run.
- **Model:** `now + (mean_remaining_active_seconds_for_this_product_at_this_stage)`.
  Use historical p50 from `read_bag_metrics`. CI = p25–p75.
- **Surface:** floor TV bag tile, /floor-board active-bags table column.
- **Action:** if predicted > shift end, escalate to lead.

### 10.2 Predicted bags-finalized this shift
- **Horizon:** end-of-shift.
- **Model:** `bags_finalized_so_far + (remaining_shift_min / mean_min_per_bag_today)`.
  Today's mean falls back to 7d trailing if today is sparse.
- **CI:** ±15% (rule of thumb; quantify after 90d data).
- **Action:** if predicted < quota → push to lead.

### 10.3 Predicted bags-finalized today / week / month / quarter
- **Horizon:** as named.
- **Model:** rolling-mean × Hodrick-Prescott-style detrend OR exponential
  smoothing (Holt-Winters with weekly seasonality once we have 90d). For
  v1 use simple weighted mean (last 7d weight 0.6 + last 30d 0.3 + last 90d 0.1).
- **Action:** week-monthly-projection vs commitment.

### 10.4 Predicted yield % (per new bag, per flavor at intake)
- **Horizon:** that bag's full run.
- **Model:** Bayesian update on flavor-mean yield using bag's weight
  (deviation from flavor-typical), vendor batch ID. Weight as prior:
  `posterior_yield = w₁ × flavor_mean + w₂ × vendor_mean + w₃ × weight_correction`.
- **CI:** ±2σ-of-flavor.
- **Action:** at receive time, set "expected" units; if a bag finalizes
  more than 1σ below, raise the under-yield alert (6.7).

### 10.5 Predicted run-out date per packaging material
- See 4.6/4.7.

### 10.6 Predicted run-out date per tablet type
- Symmetric to 10.5: `total_pill_count_on_hand /
  (units_consumed_per_day_for_products_using_this_tablet_type)`.

### 10.7 Predicted PO closeout date
- See 7.10.

### 10.8 Predicted overtime need
- **Horizon:** today and this week.
- **Model:** if `bags_demanded_this_week_to_meet_committed_orders > predicted_capacity`,
  estimate overtime hours = `(deficit / units_per_active_hour)`.
- **Surface:** owner home, accountant week-close
- **Action:** approve OT or push next-day delivery.

### 10.9 Predicted compressor service date
- **Horizon:** trailing pause-rate trend.
- **Model:** Poisson regression on jam events; predict next jam given
  recent inter-arrival interval (3.11).
- **Surface:** /metrics machine card.

### 10.10 Predicted vendor lead-time
- **Horizon:** for each vendor, predicted days from PO open → first receive.
- **Model:** mean + 1σ over last 6 PO closures.
- **Use:** drives reorder-point math (4.7).

### 10.11 Predicted next pause window per machine
- See 3.11.

### 10.12 Predicted "first-error today" per operator
- **Definition:** based on shift-decay curve (5.6) and operator's
  damage-rate profile, when in the day will damage probability cross 5%?
- **Use:** schedule the QA spot-check just before that.

---

## Section 11 — Anomaly detection

The general pattern: rolling-30d distribution per dimension; today's
observation gets a z-score; |z| > 2 = warn, > 3 = alarm. Specific cases:

### 11.1 Late-night activity from a daytime employee
- Operator code with > 95% of historical events between 09:00–18:00 ET fires
  an event at 22:00. Push to owner.

### 11.2 Pause without a known reason
- `BAG_PAUSED.payload.reason` not in known taxonomy → flag.

### 11.3 Throughput deviation > 2σ (per machine, per operator, per flavor)
- Z-score the daily throughput by dimension.

### 11.4 Station-no-movement during active run
- Station has `current_workflow_bag_id` but `lastEventAt` > 20 min ago AND
  not in any pause state → push to lead.
- **Source:** `read_station_live`.

### 11.5 First-error-on-veteran-flavor (5.10)

### 11.6 Batch_number mismatch between submitted and bag-default (9.11)

### 11.7 "Counted then walked away"
- **Definition:** a `_COMPLETE` event followed by no further events for >
  shift-end-quiet-window AND no BAG_FINALIZED. Implies operator entered
  count, didn't tap finalize, walked off.
- **Action:** push to lead, "did you mean to finalize bag X?"

### 11.8 Unusual first-event time per operator
- Z-score first-event-of-day time per operator. New shift behavior.

### 11.9 Card-on-bag-too-long
- QR card assigned > p99 of normal bag duration → likely card lost or bag
  abandoned.

### 11.10 Vendor-barcode collision
- Two distinct inventory_bags claim the same vendor_barcode within 30d.
  Vendor printing dupes = supplier issue.

### 11.11 Repack-event ping during a normal run
- Mid-run repack should be rare; flag whenever it happens.

### 11.12 Material-roll-replaced earlier than expected
- `legacy_blister_rolls.actual_press_count_at_replacement <
  configured_press_count_per_roll × 0.7` → premature swap; investigate.

### 11.13 Tablet_type swap mid-bag
- A `PRODUCT_MAPPED` event after BLISTER_COMPLETE — workflow switch,
  rare and suspicious.

### 11.14 OEE-cliff alert
- Plant OEE drops > 10pp DoD → owner push.

### 11.15 Damage cluster
- 3+ damaged bags on the same machine within 4 hours = machine drift.

### 11.16 Compressor short-cycling
- (Phase-2) compressor turning on > N times/hr without proportional
  blister output. See §15.

---

## Section 12 — Outside-the-box metrics nobody else builds

These are deliberately ambitious. Each ones earns its keep by surfacing a
decision the team would never reach by staring at throughput.

### 12.1 Operator-flavor affinity index
- **Definition:** for each (operator, product) pair, normalize that
  pair's mean units/hour against operator's overall mean and the
  product's overall mean (Bradley-Terry-style residual).
- **Surface:** /metrics Operators → Affinity heatmap (operator × flavor)
- **Use:** schedule each flavor with its highest-affinity operator
  available. Will frequently disagree with seniority-based scheduling and
  beat it on throughput by 5-12% (industry rule of thumb).

### 12.2 Run-effort score
- **Definition:** for each finalized bag,
  `run_effort = z(pause_count) + z(yield_loss) + z(pause_duration_var)`.
  Normalize across the past 90d; bags above the 80th percentile = "hard"
  runs. Aggregate per flavor for "this flavor is a 1.3 effort, 30% above
  baseline".
- **Surface:** /metrics By product → "Effort score"
- **Use:** schedule hard flavors with best operators on best machines.

### 12.3 Heat map of late-day yield drop
- **Definition:** group by hour-of-day; compute mean yield per bag started
  in that hour. Plot yield vs hour.
- **Use:** quantifies the "after lunch slump" or "last-hour yield loss".
  Often costs 1-3 pp yield. Translate to dollars.
- **Action:** rebalance lunch break, pre-emptive 5-min stretch break.

### 12.4 Variety pack consumption asymmetry
- See 8.3.

### 12.5 Floor scan-rhythm
- **Definition:** time gap between any two consecutive `workflow_events`
  in the system as a whole, plotted as a histogram per hour.
- **Insight:** the system's "heartbeat". When the gap distribution
  shifts (mean rises, tail thickens), the floor is in micro-stoppage
  mode even before anyone hits PAUSE.
- **Action:** real-time alarm when scan-rhythm tail > 60s for > 5 min.

### 12.6 Cost of pause $
- See 3.13. Rolled up monthly to a single owner-home tile: "Last month
  $X was spent doing nothing — $A in PVC swaps, $B in EOD shutdowns, $C
  in jams." Ranks the next investment.

### 12.7 Customer-of-the-month
- **Definition:** finished_lots → shipping/sales (Phase-2 gap on shipping,
  but proxy with finished-lot creation under a Zoho push). Largest
  recipient by tablet count.
- **Audience:** owner — sales conversation prompt.

### 12.8 Vendor scorecard
- **Composite:** weighted ranking on:
  - Damage rate (weight 30%) — `legacy_po_damage_closeout` / total received
  - On-time delivery (25%) — `t_received - po.opened_at` vs vendor norm
  - Weight-vs-label accuracy (25%) — `estimated_tablets_from_weight` vs
    `bag_label_count`
  - Yield-after-receive (10%) — bags from vendor's PO finalized at >
    expected yield
  - Repack rate (10%) — repacks needed per PO
  Output: 0–100 score per vendor, ranked.
- **Surface:** /metrics Vendors tab (new), owner monthly digest

### 12.9 Bag age curve, segmented by flavor
- See 6.8 + 6.9.

### 12.10 Card-recycling efficiency
- **Definition:** average count of finalized bags per QR card per month;
  ratio of `qr_cards.status = IDLE` cards historically vs. recently.
- **Source:** `qr_cards`, `workflow_bags.qrCardId` (via assignment events).
- **Use:** identifies lost or hoarded cards.

### 12.11 Shift-cliff
- See 1.23 + 5.6. Quantify yield + throughput drop in last 30 min of
  shift. Express as $ per shift.

### 12.12 Bag-flow diversity score per shift
- **Definition:** Shannon entropy of (bag_id × station_id) events per
  hour. Low entropy = monoculture = brittle if a station goes down.

### 12.13 Schedule-respected % per machine
- **Definition:** (Phase-2 needs a planned schedule). Until then: surrogate
  is "did the planned flavor for slot N actually run in slot N?", measured
  manually.

### 12.14 Blister-die-hours-since-clean
- **Definition:** cumulative `total_blisters` since last "die clean" event
  per machine. (Phase-2: capture die-clean event; see §15.)

### 12.15 Pump-the-bottleneck dollar ROI
- **Definition:** if you removed the current bottleneck stage by 10%, how
  many extra units/day, at what wholesale price = $/day. Rolling.
- **Use:** the single number that justifies a capital purchase.

### 12.16 Foil/PVC waste-per-bag-vs-best-bag
- Within a flavor, the top-quartile bags by yield consumed N units of
  packaging; compare worst-quartile. Difference × material cost = waste $.

### 12.17 "Rookie-Veteran" pairing yield premium
- For sealing where two distinct operators worked a bag, did rookie+veteran
  pairing yield N% better than rookie+rookie? Schedule accordingly.

### 12.18 Bag-tracking-leak detector
- Bags that have CARD_ASSIGNED but no further events for > 4h. Implies
  someone scanned a card and didn't pick a bag, or picked a bag and
  walked off.

### 12.19 Cross-shift handoff penalty
- If a bag is started on shift A and finalized on shift B, mean cycle vs.
  same-shift bags. Almost always longer.
- **Action:** schedule "do not start bags after 16:00" if penalty large.

### 12.20 Time-of-day tablet-density drift
- **Definition:** `weight_grams / pill_count` per bag, plotted by intake
  time. Should be flat. Drift = scale calibration walk.

---

## Section 13 — Dashboards by audience

Three pages, three audiences. Discipline: each page shows numbers the user
can act on *today*. No vanity tiles.

### 13.1 Owner home (`/dashboard`)

**The 5 numbers that matter.**

1. **Finalized today** (1.1) — small Δ vs. yesterday and 7d-avg.
   - Click-through: /floor-board.
2. **Cash on the floor right now** (7.2) — single $ figure, with the
   stage that holds the most.
   - Click-through: /metrics → cash-by-stage.
3. **OEE today** (2.4) — 0–100 donut with the dragging factor (A, P, Q).
   - Click-through: /metrics → OEE waterfall.
4. **Predicted shippable units this week** (10.3) — vs commitment.
   - Click-through: forecast.
5. **Aged-unfinalized inventory $** (7.5) — owner-actionable urgency.
   - Click-through: list of stuck bags with finalize CTAs.

Plus a single-line "**The one prediction with the highest financial swing
this week**":
> "If you reduce average PVC-swap time by 20%, you'll add ~120 displays
> ($X revenue) by Friday."

This is a derived metric: scan all the loss-attribution buckets, multiply
each by its $/hour rate, pick the top one, and counterfactually compute
what a 20% reduction yields.

**Daily emailed digest:** the same 5 numbers, plus the top-3 anomalies
detected overnight (Section 11) and the day's top-3 bags by run-effort
(12.2).

### 13.2 Floor lead live (`/floor-board`)

**Real-time exceptions only — "act now" panel.**

Tiles, top to bottom:

1. **Forgotten bags** (3.8) — list, with "Resume" / "Release" / "Finalize"
   CTAs.
2. **Walked-away stations** (3.9 / 11.4) — list, with operator avatar and
   minutes-since-last-event.
3. **Lane-imbalance alert** (1.29) — "Blister is 1.4× ahead of Packaging.
   Pull a packager from sealing 2."
4. **Predicted next pause** (3.11) — banner: "Compressor 1 likely to pause
   in next 10–25 min."
5. **Material-runway under 3d** (4.1, RUNWAY_CRITICAL) — list with
   reorder CTA.
6. **Bottleneck-of-the-hour** (1.16) — single big chip.
7. **Damage cluster active?** (11.15) — yes/no chip, click → list.
8. **Operator suggestions for next bag** (5.7 + 12.1) — "Heimy on
   sealing-3 (best match)".

No throughput tiles — they're on the TV; the lead has the TV in their
peripheral. This page is for *actions*.

### 13.3 Accountant week-close (`/reports/week-close`)

1. **Per-PO cash flip table** (7.1) — PO# | Vendor | t_open | t_received |
   t_finalized | t_pushed | Cash $ | Days-to-flip.
2. **Per-vendor settlement summary** (7.12) — Vendor | Received this week
   $ | Damage $ | Net payable | Due-date.
3. **Operator hours vs. payroll** (5.13/5.14) — Operator | Effective
   start | Effective end | Active hours | Payroll-recorded hours | Δ.
4. **Aged-unfinalized inventory by flavor** (7.5) — exception list for
   adjustment.
5. **Open-PO aging buckets** (7.7) — reserve-for-write-down candidates.
6. **Zoho push delta** — finished_lots not yet pushed; finished_lots that
   pushed in error (status = FAILED). Single CTA: "Re-push all" / "Mark
   resolved".
7. **Ship-against-PO gap** — predicted shippable (10.3) vs. committed.
   Triggers OT discussion.

---

## Section 14 — Alerts (push, email, in-app)

Alert spec — every row gets these fields. Email is disabled by company
policy; "channel" is `push|in-app` only. Push uses VAPID/Web Push
(already in stack).

| # | Trigger | Recipient | Urgency | Dedupe | Suppress | Action link |
|---|---|---|---|---|---|---|
| A1 | Forgotten bag (3.8) | LEAD | medium | 1/bag/24h | shift-end +/- 30min | /floor-board?bag=… |
| A2 | Walked-away station (3.9) | LEAD | medium | 1/station/15min | shift-end +/- 15min | /floor-board?station=… |
| A3 | Material under 3d runway | OWNER, ADMIN | high | 1/material/24h | none | /metrics/forecast |
| A4 | OEE-cliff (11.14) | OWNER | high | 1/day | weekend | /metrics/oee |
| A5 | Damage cluster (11.15) | LEAD, MANAGER | high | 1/machine/4h | none | /floor-board?machine=… |
| A6 | First-error veteran flavor (5.10) | LEAD | low | 1/operator-flavor/7d | none | operator profile |
| A7 | Predicted-overtime needed (10.8) | OWNER | medium | 1/day | none | /dashboard |
| A8 | Vendor barcode mismatch | LEAD | high | 1/bag | none | inventory_bag detail |
| A9 | Vendor barcode dupe (11.10) | ADMIN | medium | 1/barcode | none | /inbound |
| A10 | Bag under-yielding > 1σ (6.7) | LEAD, OWNER | medium | per finalize | none | bag detail |
| A11 | Compressor service due (10.9) | MANAGER | medium | 1/machine/72h | none | /metrics machines |
| A12 | Aged unfinalized > 30d $ jumps > 10% DoD (7.5) | OWNER | high | 1/day | none | /dashboard |
| A13 | Discrepancy-flag rate spike per operator | LEAD | low | 1/operator/24h | none | operator profile |
| A14 | Variety asymmetry (8.3) | LEAD | medium | 1/variety-run/24h | none | variety bag detail |
| A15 | Forgotten card (12.18) | LEAD | low | 1/card/24h | shift-end | qr-cards |
| A16 | Pause-without-known-reason (11.2) | ADMIN | low | 1/event-type/24h | none | event detail |
| A17 | Cash-on-floor jumps > X $ (7.2) | OWNER | high | 1/day | none | /dashboard |
| A18 | Schedule-violation (12.13) | LEAD | low | per-shift | none | n/a |

Notes:
- "Suppress shift-end ± 30min" = a pause at 17:30 on a shift that ends at
  18:00 is normal end-of-day, not a forgotten bag. Read shift hours from
  Settings.
- Push payload includes `action_url` so the click takes the recipient
  straight to the actionable surface.

---

## Section 15 — Phase-2 instrumentation gaps

Metrics blocked by missing inputs. Add these inputs and the metrics light
up.

### 15.1 `machines.ideal_units_per_hour` — needed for OEE Performance (2.2)
Currently `cards_per_turn` is captured; we need the machine's nameplate
speed. Add field; preload from manufacturer specs; allow per-flavor
override (some flavors run slower).

### 15.2 `packaging_lots.unit_cost_cents` — needed for Cost-per-display (4.9), 12.6, 12.16
Add column; pull from PO line cost; integer cents.

### 15.3 `tablet_types.unit_cost_cents` — same purpose for tablet inputs

### 15.4 `vendor_lead_days` per packaging_material / tablet_type
Without this, reorder-point math (4.7) is heuristic.

### 15.5 `machines.maintenance_calendar` — for Availability denominator (2.1)
Currently we infer "shift hours" from a single Setting. Per-machine
schedule (e.g. machine 2 down for service Monday) refines it.

### 15.6 Capture **die-clean event** on blister machine (12.14)
Add a new `workflow_event_type` value `BLISTER_DIE_CLEANED` with operator
+ machine_id + counter at clean. Wires into 12.14 + roll-quality
analysis.

### 15.7 Capture **compressor on/off cycles** (11.16)
A simple "compressor heartbeat" event from a Pi or PLC tap, every minute.
Today the compressor table is descriptive only (`legacy_compressors`); we
have no live state. Phase-2: small `compressor_events` table.

### 15.8 Capture **shipping events**
Nothing today links a finished_lot to a customer/order beyond the Zoho
push. If shipping/sales data is brought in, 12.7 and 7.11 land.

### 15.9 Capture **retention-sample pulls** at finalize (9.7)
A boolean + sample_id on BAG_FINALIZED. QA compliance.

### 15.10 Capture **planned schedule** (12.13)
A simple per-machine, per-shift "expected flavor" plan; compare to
actual.

### 15.11 Capture **operator code at every event**
Today `read_bag_state.current_operator_code` and `OPERATOR_CHANGE` events
exist but the legacy `employee_name` is free-text. A clean import (with a
fuzzy-match-to-employees step the owner blesses) unlocks clean operator
metrics for the 7 months of history.

### 15.12 Capture **bag-weight at finalize** (Phase-2)
Today bag weight is intake-only. A finalize-time empty-bag weight gives a
direct yield-from-weight reading and detects rip-loss exactly.

### 15.13 Capture **wholesale price per finished good**
Needed for $-cost metrics (1.30, 12.7, 12.15). Likely already in Zoho;
pull on push.

### 15.14 Capture **vendor SLAs** (lead time, on-time %)
Sets vendor scorecard baselines (12.8). Today inferred from history;
explicit SLA fields lift accuracy.

### 15.15 Capture **operator break events**
For 5.6 / 12.3 / shift-cliff math, "operator on break" needs to subtract
from active_seconds without polluting pause data. Today PAUSE reasons
include `operator_change` / `handoff` but not "lunch".

---

## Section 16 — Implementation priority

Each metric scored on **business value (1–5)** × **ease (1–5, 5 = trivial,
1 = needs gap-fill or new ETL)** = priority. The top-12 quick wins:

| # | Metric | Value | Ease | Score | Implementation note |
|---|---|---|---|---|---|
| 1 | 7.2 Cash on the floor | 5 | 4 | 20 | Aggregates `inventory_bags.pillCount` by stage × `tablet_types.unit_cost_cents`. Needs §15.3; if missing, surface "units" only. |
| 2 | 7.5 Aged unfinalized $ | 5 | 4 | 20 | `workflow_bags WHERE finalized_at IS NULL AND started_at < now()-30d` joined to bag input cost. |
| 3 | 3.8 Forgotten bag detector | 5 | 5 | 25 | `read_bag_state.is_paused` + p99 of paired-pause durations. Pure SQL, ships now. |
| 4 | 3.13 Cost-of-pause $ | 4 | 4 | 16 | Multiply existing `downtimeByReason.total_seconds` by Settings rate. |
| 5 | 6.7 Bag under-yielding alert | 5 | 4 | 20 | Compare `read_bag_metrics.yieldPct` to product rolling-mean at BAG_FINALIZED. Project event in projector. |
| 6 | 9.4 Vendor count-vs-label drift | 4 | 4 | 16 | Aggregate `legacy_warehouse_submissions.payload->>'estimated_count_by_weight'` vs `bag_label_count` per vendor. |
| 7 | 12.8 Vendor scorecard | 5 | 3 | 15 | Composite of 4.3, 9.4, 7.6. New Vendors tab. |
| 8 | 1.16 Bottleneck-of-the-hour | 4 | 5 | 20 | Pure read_bag_metrics aggregation, last-60-min slice. Floor TV chip. |
| 9 | 5.7 Best-fit station recommender | 5 | 3 | 15 | Per-(operator, station_kind) median throughput from synthesized legacy events. Needs Phase-2 synthesis. |
| 10 | 12.1 Operator-flavor affinity | 5 | 3 | 15 | Same upstream as 5.7; matrix render. |
| 11 | 4.6 Predicted material need (open POs) | 5 | 4 | 20 | Pure SQL on POs × BOM; surface in /metrics/forecast. |
| 12 | 1.29 Lane-imbalance ratio | 4 | 5 | 20 | `bags_blistered / bags_packaged` rolling 24h. Floor TV chip + lead alert. |

Top-12 covers Owner home tiles, floor-lead "act now" panel, and vendor
scorecard — i.e. the three audience pages all light up.

Subsequent waves, in rough order:

**Wave 2 (after legacy synthesis):** 5.4 ramp-up curve, 5.6 shift-decay,
6.2 yield distribution, 12.2 run-effort, 12.3 late-day yield drop, 8.x
variety mix, 3.5 pause-clustering heatmap.

**Wave 3 (after §15 instrumentation gaps land):** OEE proper (2.x),
12.14 die-hours, 11.16 compressor short-cycling, 9.7 retention-sample,
12.7 customer-of-the-month.

**Wave 4 (predictive):** 10.x forecasting models, 11.x z-score-based
anomaly digest, 12.15 pump-the-bottleneck ROI calculation.

---

## Closing note for the owner

The single highest-leverage move is finishing the legacy synthesizer (Phase
2 in `phases.md`). 7 months of historical pause-reasons, count statuses,
and bag deductions are sitting in the stash tables; until they're walked
into Luma `workflow_events`, half the metrics in this doc are vapor on
weeks-old data. Once synthesized, the operator-affinity, ramp-up, vendor
scorecard, and shift-cliff metrics light up on day one — and every metric
in Sections 10 / 11 / 12 has 7 months of distribution to standardize
against, instead of waiting until October to gather it forward-only.

After synthesis, the smallest "ship in a week" set is **Top-12 (table
above) + the three dashboard pages (§13)**. That gives the owner one
glance → action workflow. Everything else is building on top.
