# Station Sealing Behavior Audit — STATION-SEALING-BEHAVIOR-AUDIT-1

> **Audit only. No code has been changed.**
> Generated: 2026-05-28 · Branch: main · SHA: b7db101

---

## 1. Current behavior map

### Live timer

| Station | `startedAtMs` source | What it actually shows |
|---|---|---|
| HANDPACK_BLISTER (first op) | `workflow_bags.started_at` | Correct — bag creation time = station start |
| SEALING (downstream) | `workflow_bags.started_at` | **Wrong** — total bag age since handpack started |
| PACKAGING (downstream) | `workflow_bags.started_at` | **Wrong** — total bag age |

The `ElapsedTimer` component (`elapsed-timer.tsx:6`) receives `startedAtMs` wired directly to
`currentAtStation.bag.startedAt` which is `workflow_bags.started_at`
(`page.tsx:429-431`). Pause accounting (`pausedSecondsAccum`, `pausedAt`) comes from
`read_bag_state` — that is global to the bag, not per-station. A sealing operator whose
bag arrived after two hours of handpacking sees "2h 14m" even if they have been working
for 14 minutes.

### Sealing close-out inputs (two paths)

**Path A — Normal SEALING bag (machine-blistered)**

`SealingCompleteForm` in `stage-action-buttons.tsx:702` opens when
`sealingOpen = true`. Fields:

| Form field | Payload key | Consumed downstream |
|---|---|---|
| "Sealed count" (`countTotal`) | `count_total` | `read_bag_metrics.units_yielded` (at finalize); `material-consumption-hook.ts` for roll segment |
| "Packs remaining" (`packsRemaining`) | `packs_remaining` | `material-reconciliation.ts` variance |
| "Cards reopened (scrap)" (`cardsReopened`) | `cards_reopened` | `material-reconciliation.ts` loss tracking |

Action: `fireStageEventAction` → SEALING_COMPLETE event.

**Path B — Hand-packed bag at SEALING (`bagIsHandpacked = true`)**

`SealHandpackForm` in `seal-handpack-form.tsx:6` renders instead.
Field: "plastic blister count" (`plasticBlisterCount`).

| Form field | Payload key | Consumed downstream |
|---|---|---|
| "plastic blister count" | `plastic_blister_count` | Stored in event payload only — **no projector reads it** |
| — | — | Also fires PACKAGING_MATERIAL_ISSUED (consumes oldest BLISTER_CARD lot) |

Action: `sealHandpackBagAction` (`actions.ts:1107`). No `packsRemaining`, no
`cardsReopened`, no roll segment emission.

**Domain mismatch**: Neither path reflects the real floor process. Operators read the
sealing machine's physical counter (cumulative press count) and enter the delta for this
bag's run. The machine's `cards_per_turn` (already in the DB) converts
`counter_presses × cards_per_turn → sealed cards`.

### Machine settings — cardsPerTurn

The `machines` table (`schema.ts:443`) has:

```
cardsPerTurn: integer("cards_per_turn").notNull().default(1)
```

Live values for production SEALING machines:

| Machine name | `cards_per_turn` |
|---|---|
| Sealing Machine 1 | 6 |
| Sealing Machine 2 | 3 |
| Sealing Machine 3 | 6 |

The field is editable in the admin machine form (`machines/forms.tsx:79`, labeled
"Cards / turn") and displayed in the floor-board lifeline (`lifeline-cards.tsx:147`).
It is **not currently passed to the floor station page** or used in any
sealing close-out derivation.

Legacy context: `legacy_blister_rolls.blisters_per_press` (`schema.ts:1547`) is
the TabletTracker predecessor to `machines.cards_per_turn`. The new field is correct;
the legacy table is read-only ETL data.

### Rolls / PVC on sealing

`FLOOR_ROLL_STATION_KINDS = new Set(["BLISTER", "COMBINED", "SEALING"])`
(`floor-station-mobile-nav.ts:7-11`) drives the "Rolls" supervisor tool link.

`STATION_PAUSE_REASON_MATRIX.SEALING = MACHINE_BOUND_REASONS`
(`station-pause-reasons.ts:46`) which includes `pvc_swap` ("PVC roll swap") and
`machine_jam` ("Machine jam").

`material-consumption-hook.ts` (roll segment emission) fires on `BLISTER_COMPLETE`
only — **not** on `SEALING_COMPLETE`. So even though sealing stations show the Rolls
tool, no roll consumption is ever computed for sealing events. The code inclusion of
SEALING in the roll set is a legacy carry-over.

Domain verdict: per the real floor process, sealing stations do not mount PVC or foil
rolls. The Rolls supervisor tool and `pvc_swap` pause reason should be removed from
SEALING. `machine_jam` is legitimate and should stay.

---

## 2. Root causes

### Wrong timer (STATION-TIMER-2)

**Root cause**: `page.tsx:429` passes `currentAtStation.bag.startedAt`
(`workflow_bags.started_at`) as the timer anchor. `workflow_bags.started_at` is set
when the bag is created at the **first** station (`CARD_ASSIGNED` / `BAG_PICKED_UP`
at the first-op station). Downstream stations see bag age, not their own station age.

**Missing data**: There is no `picked_up_at` column in `read_station_live`
(`schema.ts:2457-2470`). The projector writes `lastEventAt` (most recent event) but
not the original pickup timestamp. `read_bag_state` also has no per-station timestamps.

The BAG_PICKED_UP `occurredAt` exists in `workflow_events` but is not materialized to
any read model the page query can use in a single join.

**What exists in finalized metrics**: `read_bag_metrics` (`schema.ts:2555`) has
`sealing_seconds` = gap(BLISTER_COMPLETE → SEALING_COMPLETE), computed once at
BAG_FINALIZED. This uses stage boundary events, not station pickup events.

**Secondary bug** (metrics): `projectMetricsForFinalizedBag` in `projector/index.ts:542`
builds `stageBoundaries` from `BLISTER_COMPLETE`, `SEALING_COMPLETE`, etc. but **not**
`HANDPACK_BLISTER_COMPLETE`. For handpacked bags: `blisterSeconds = null` and
`sealingSeconds` = gap from `_start` (bag.startedAt) to SEALING_COMPLETE — includes
all handpack time. Wrong. Not in scope for STATION-TIMER-2 but must be fixed
alongside (one-line add to stageBoundaries list).

### Wrong sealing count field (STATION-SEALING-COUNTER-1)

**Root cause A** (SealHandpackForm): `sealHandpackBagAction` expects
`plasticBlisterCount` — a direct blister count. Domain: operators enter the machine's
physical counter delta, not a hand-counted blister total.

**Root cause B** (SealingCompleteForm): `countTotal` field labeled "Sealed count" —
ambiguous; operators do not count sealed blisters one by one. They read the machine
counter.

**Root cause C**: `cardsPerTurn` from the bound machine is not passed to the floor
page. The station → machine join already exists in station admin but is not included in
the `currentAtStation` query.

**Effect on downstream**: `plastic_blister_count` in SEALING_COMPLETE payload is stored
but consumed by nothing in the projector. `count_total` in SEALING_COMPLETE (Path A) is
consumed by `units_yielded` accumulation at finalize and by the roll-segment hook for
BLISTER_COMPLETE — but that hook does **not** fire on SEALING_COMPLETE. So the current
value has no material derivation effect. Changing the input model does not break any
existing projector chain.

---

## 3. Existing correction / adjustment logic (do not overwrite)

| Location | What it does |
|---|---|
| `lib/projector/qc-events.ts` | Projects QC events: `SUBMISSION_CORRECTED` sets `has_correction=true` on `read_bag_state`, increments `corrections_total` in daily rollup |
| `lib/projector/material-reconciliation.ts` | Computes variance = received − finished − damaged − scrap − remaining. Uses `packs_remaining` and `cards_reopened` from event payloads |
| `SealingCompleteForm` fields `packsRemaining` / `cardsReopened` | Feed the reconciliation projector — must be preserved in any redesign of the sealing form |
| `lib/projector/material-consumption-hook.ts` | Fires on `BLISTER_COMPLETE` only; emits roll segment from `count_total`. **Not affected by sealing changes.** |
| `lib/floor-command/types.ts:106` `correctionsTotal` | Operator daily stat; surfaced in floor-command API |
| `lib/production/qc-review-loaders.ts` | Admin QC review; reads SUBMISSION_CORRECTED events |

The sealing counter redesign must continue to submit `packsRemaining` and
`cardsReopened` alongside the derived `count_total`. These fields are the operator's
reconciliation inputs; they are separate from the counter press mechanism.

---

## 4. Recommended implementation slices

### Slice A — STATION-TIMER-2: Station-scoped elapsed timer

**Goal**: Show sealing/packaging operators how long their station has been active on
this bag, not total bag age.

**Approach** (no schema migration needed — read from events on page load):

The page already queries `workflow_events` for `HANDPACK_BLISTER_COMPLETE` detection
(`page.tsx:272-282`). Extend that query pattern: for downstream stations (SEALING,
PACKAGING), fetch the most-recent `BAG_PICKED_UP` event for
`(workflowBagId, stationId)` from `workflow_events` and use its `occurredAt` as the
timer anchor.

Alternative (requires schema change): add `pickedUpAt` column to `read_station_live`.
The projector already writes this row on every event; adding the column and populating
it on BAG_PICKED_UP is a migration + projector change.

**Recommendation**: Use the event query approach (no migration) for the timer. The
page already does one extra query for `bagIsHandpacked`; a second query for
`stationPickedUpAt` is the same pattern. This is the smallest safe change.

The `pausedSecondsAccum` on `read_bag_state` is bag-global — it accumulates pauses
from ALL stations. For station-scoped elapsed, subtract only pauses that occurred after
`stationPickedUpAt`. This requires querying `workflow_events` for BAG_PAUSED /
BAG_RESUMED events with `occurredAt > stationPickedUpAt` and summing their deltas.

**Files to touch**:

| File | Change |
|---|---|
| `app/(floor)/floor/[token]/page.tsx` | Add station-pickup event query; compute `stationPausedSecondsAccum`; pass correct `startedAtMs` to `ElapsedTimer` |
| `app/(floor)/floor/[token]/elapsed-timer.tsx` | No change needed (already correct given right anchor) |
| `lib/projector/index.ts` | Add `HANDPACK_BLISTER_COMPLETE` to `stageBoundaries` list (one-line fix for finalized metrics bug) |

**Staging smoke**: With sealing station showing an active bag, confirm elapsed time
matches wall-clock minus handpack time. Confirm pause/resume still works correctly.

---

### Slice B — STATION-SEALING-COUNTER-1: Machine counter input + derivation

**Goal**: Replace "enter blisters sealed" with "enter machine counter presses" and
derive `total_sealed = counter_presses × machine.cardsPerTurn`.

**Data model summary** (no schema change needed):

`machines.cards_per_turn` is the correct field. It is already populated on all
production sealing machines (values 3–6). The floor page needs to know the bound
machine's `cards_per_turn` to render the derived total in real-time and to pass it to
the action.

**Page changes**:

The `currentAtStation` query in `page.tsx:95-107` joins `readStationLive → workflowBags
→ readBagState → products`. It does NOT join to `stations → machines`. Add that join:

```
station → machines (via station.machineId)
select { machine: { id, cardsPerTurn } }
```

Pass `cardsPerTurn` as a prop to `SealingCompleteForm` and `SealHandpackForm`.

**Form changes** (`SealingCompleteForm` and `SealHandpackForm`):

Replace the blister count / sealed count input with:

- "Machine counter presses" — integer input (what the operator reads off the physical counter)
- Real-time preview: `presses × cardsPerTurn = N cards sealed` shown below the input
- Submit: send `counterPresses` and `cardsPerTurn` in FormData; derive `count_total = counterPresses × cardsPerTurn` server-side

**Action changes** (`fireStageEventAction` and `sealHandpackBagAction`):

Both actions should:
1. Accept `counterPresses` (integer, required) and `cardsPerTurn` (integer, validated against DB machine value)
2. Derive and store `count_total = counterPresses × cardsPerTurn` in the SEALING_COMPLETE payload
3. Keep `packs_remaining` and `cardsReopened` inputs unchanged (reconciliation fields)
4. Remove `plasticBlisterCount` from `sealHandpackBagAction` (replaced by `counterPresses`)
5. Keep PACKAGING_MATERIAL_ISSUED emission in `sealHandpackBagAction` — use derived `count_total` as the qty

**Event payload structure after change** (SEALING_COMPLETE):

```json
{
  "counter_presses": 42,
  "cards_per_turn": 6,
  "count_total": 252,
  "packs_remaining": 3,
  "cards_reopened": 1
}
```

`count_total` is backward-compatible — existing projector consumers read `count_total`
and will continue to work. `counter_presses` and `cards_per_turn` are additive new
fields in the payload, safe to add.

**Files to touch**:

| File | Change |
|---|---|
| `app/(floor)/floor/[token]/page.tsx` | Add machine join; pass `cardsPerTurn` prop |
| `app/(floor)/floor/[token]/seal-handpack-form.tsx` | Replace `plasticBlisterCount` with `counterPresses`; show derivation preview |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | `SealingCompleteForm`: replace "Sealed count" with "Machine counter presses" + derivation |
| `app/(floor)/floor/[token]/actions.ts` | `fireStageEventAction` + `sealHandpackBagAction`: accept `counterPresses`, derive `count_total` |
| `app/(floor)/floor/[token]/stage-action-buttons.test.ts` | Update / add tests for new field names |

**Hard stops**: Do NOT change `packsRemaining` / `cardsReopened`. Do NOT change how
`PACKAGING_MATERIAL_ISSUED` is emitted. Do NOT modify BLISTER_COMPLETE path.

**Staging smoke**: Submit a sealing completion with `counterPresses=5`,
`cardsPerTurn=6`. Confirm SEALING_COMPLETE event payload has
`counter_presses=5, cards_per_turn=6, count_total=30`. Confirm no projector errors.

---

### Slice C — STATION-SEALING-TOOLS-1: Remove Rolls/PVC from sealing

**Goal**: Remove the Rolls supervisor tool link and `pvc_swap` pause reason from
SEALING stations. Preserve `machine_jam`.

**Root cause**: `FLOOR_ROLL_STATION_KINDS` in `floor-station-mobile-nav.ts:7` and
`STATION_PAUSE_REASON_MATRIX.SEALING` in `station-pause-reasons.ts:46`.

**Change A** — Remove Rolls tool from sealing:

```diff
// floor-station-mobile-nav.ts
export const FLOOR_ROLL_STATION_KINDS = new Set([
  "BLISTER",
  "COMBINED",
- "SEALING",
]);
```

**Change B** — Remove `pvc_swap` from SEALING pause reasons:

```diff
// station-pause-reasons.ts
+const SEALING_REASONS: readonly PauseReason[] = [
+  SHIFT_END,
+  MACHINE_JAM,
+  QA_CHECK,
+  OTHER,
+];

STATION_PAUSE_REASON_MATRIX: {
  BLISTER: [...MACHINE_BOUND_REASONS],
- SEALING: [...MACHINE_BOUND_REASONS],
+ SEALING: [...SEALING_REASONS],
  COMBINED: [...MACHINE_BOUND_REASONS],
  ...
}
```

This is the smallest safe change: no DB change, no projector change, no migration.
The `pvc_swap` value will remain in existing event payloads — the server still
accepts it (validation is UI-only).

**Files to touch**:

| File | Change |
|---|---|
| `lib/production/floor-station-mobile-nav.ts` | Remove "SEALING" from `FLOOR_ROLL_STATION_KINDS` |
| `lib/production/station-pause-reasons.ts` | New `SEALING_REASONS` constant; update matrix |
| `lib/production/station-kind-catalog.test.ts` | Add assertion: SEALING not in roll station kinds; SEALING pause reasons don't include pvc_swap |

**Note on roll projector**: `material-consumption-hook.ts` fires on `BLISTER_COMPLETE`
only. Removing SEALING from the UI roll tool has no effect on the projector. The
`roll-usage.ts` projector aggregates by machine/material, not station kind — also
unaffected.

**Staging smoke**: Open Sealing Station 1 floor page. Confirm no Rolls link. Open pause
menu, confirm options are Shift ending / Machine jam / QA check / Other.

---

### Slice D — Follow-up (defer until A/B/C are stable)

Only proceed if B surfaces a meaningful gap. The reconciliation projector
(`material-reconciliation.ts`) currently uses `packs_remaining` and `cards_reopened`
from the SEALING_COMPLETE payload. With the counter model, the operator still enters
these values — no change needed. However, verify after live testing that:

1. `packs_remaining` from sealing is interpreted correctly by the reconciliation math
   (it currently means "cards started but not completed into sealed output")
2. The derived `count_total` lands correctly in `unitsYielded` at finalize

---

## 5. Hard stops

- Do not modify `scan-card-form.tsx`.
- Do not modify pickup/overlap rules (`stage-progression.ts`, `STATION_PICKUP_FROM_STAGE`).
- Do not modify hand-pack auto-release work (separate branch in flight).
- Do not modify schema/migrations in slices A or C. Slice B also needs no migration.
- Do not push code from this audit.
- Do not assume existing code labels match the real floor process — the Rolls inclusion
  in SEALING is a confirmed code/domain mismatch.

---

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Station-scoped pause math is wrong (pause events at wrong station counted) | Medium | Query BAG_PAUSED/BAG_RESUMED with `stationId` filter or `occurredAt > pickedUpAt` filter |
| `cardsPerTurn` is stale for a machine (admin doesn't update after retooling) | Low | Show the derived total in real-time so operator can catch mismatches |
| Existing SEALING_COMPLETE events with `plastic_blister_count` have no `count_total` | Low | Projector already handles missing `count_total` gracefully (gap is logged, not fatal) |
| Removing SEALING from Rolls set breaks the `/floor/[token]/rolls` route for sealing | None | The route is never reached if the link is hidden; server guards on station kind |
| Metrics projector bug (handpacked `sealingSeconds`) emits wrong values | Low (data quality only) | Fix is one-line add to stageBoundaries in projector/index.ts |

---

## 7. File index by slice

```
A — Station timer
  app/(floor)/floor/[token]/page.tsx
  lib/projector/index.ts (stageBoundaries one-liner)

B — Sealing counter
  app/(floor)/floor/[token]/page.tsx        (machine join)
  app/(floor)/floor/[token]/seal-handpack-form.tsx
  app/(floor)/floor/[token]/stage-action-buttons.tsx  (SealingCompleteForm)
  app/(floor)/floor/[token]/actions.ts      (both actions)
  app/(floor)/floor/[token]/stage-action-buttons.test.ts

C — Remove Rolls/PVC from sealing
  lib/production/floor-station-mobile-nav.ts
  lib/production/station-pause-reasons.ts
  lib/production/station-kind-catalog.test.ts  (new assertions)
```

---

## 8. Confirmed no-code-change confirmations

- `lib/projector/material-consumption-hook.ts` — fires on BLISTER_COMPLETE only; no change needed
- `lib/projector/qc-events.ts` — correction/rework framework untouched
- `lib/projector/material-reconciliation.ts` — variance math untouched; relies on `packs_remaining` which stays
- `lib/production/stage-progression.ts` — pickup/overlap rules untouched
- `scan-card-form.tsx` — untouched
- DB schema — no migration required for any slice
