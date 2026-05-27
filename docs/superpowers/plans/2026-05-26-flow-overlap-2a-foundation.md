# FLOW-OVERLAP-2A — Overlap foundation (helper + plan)

**Date:** 2026-05-27  
**Status:** Foundation landed on branch `cursor/flow-overlap-2a-foundation`  
**Base main:** `40a3ea8` / v0.4.10

---

## Purpose

Provide a **pure readiness model** for overlapping station work without changing floor scan, complete, or global stage progression. Prevents the anti-pattern of allowing `SEALING` pickup at `STARTED` while `SEALING_COMPLETE` and reporting still assume serial semantics.

---

## What was added

| Artifact | Role |
|---|---|
| `lib/production/flow-overlap-readiness.ts` | Lane WIP fold + proposed vs current readiness booleans |
| `lib/production/flow-overlap-readiness.test.ts` | Required scenarios + insufficient-data cases |
| This memo | 2B scope and hard stops |

**Not changed:** `stage-progression.ts`, `actions.ts`, `scan-card-form.tsx`, schema, projector behavior.

---

## What can be derived today (no schema change)

From **`workflow_events` payloads** (fold only):

| Signal | Source events | Caveat |
|---|---|---|
| `blisterOutputUnits` | Sum `count_total` on `BLISTER_COMPLETE`, `HANDPACK_BLISTER_COMPLETE` | Firing these events **always** sets global stage to `BLISTERED` in the projector today |
| `sealedOutputUnits` | Sum `count_total` on `SEALING_COMPLETE` | Implies global `SEALED` once fired |
| `packagedOutputUnits` | Sum on `PACKAGING_COMPLETE` / `PACKAGING_SNAPSHOT` | Implies global `PACKAGED` once fired |

From **`read_bag_state`** (passed in as `globalStage`, `isPaused`, `isFinalized`):

| Signal | Use |
|---|---|
| `stage` | Current serial pickup (`STATION_PICKUP_FROM_STAGE`) and complete (`EVENT_STAGE_PREREQ`) |
| `is_paused` | Blocks all begin/complete in helper when true |
| `is_finalized` | Blocks all begin/complete when true |

From **`read_station_live`** (not yet consumed by helper):

| Signal | Use in 2B |
|---|---|
| `current_workflow_bag_id` per station | Detect multi-station pin; session open/close |
| Multiple stations same bag id | Possible today; not forbidden server-side |

---

## What cannot be derived today

1. **Partial blister output while global stage remains `STARTED`**  
   No event type records blister units without advancing to `BLISTERED`. Any `BLISTER_COMPLETE` in the log means the bag is already globally `BLISTERED`.

2. **Partial sealed output while global stage remains `BLISTERED`**  
   Same for `SEALING_COMPLETE` → global `SEALED`.

3. **“Enough output to start downstream” thresholds**  
   Ops may use units, trays, or %. Product rules are not in DB yet.

4. **Per-station pause / elapsed time**  
   Pause is on `read_bag_state` per bag, not per station session.

5. **Lane closed vs lane in progress**  
   No `BLISTER_LANE_CLOSED` / `SEALING_LANE_CLOSED` events; only whole-lane complete events.

The helper exposes `dataGaps[]` when `globalStage === STARTED` and `blisterOutputUnits === 0` without an explicit `hasPartialBlisterSignal` override (for tests and future wiring).

---

## What is needed for safe overlap (2B+)

### Sealing may begin while blister still running

**Minimum:** record blister output **without** advancing global stage.

| Approach | Event / field | Notes |
|---|---|---|
| **Preferred** | New event `BLISTER_WIP_RECORDED` with `{ count_total, cumulative? }` | Projector does **not** map to `BLISTERED`; increments `read_bag_lane_wip.blister_units` (new read column or table) |
| Alternative | `BLISTER_COMPLETE` with `lane_mode: "partial"` + projector change | Risky — easy to confuse with close-out |
| Read-model only | `read_bag_state.blister_units_total` maintained by projector from partial events | Additive migration |

**Pickup rule (proposed, in helper):** `canSealingBeginOverlap` when `blisterOutputUnits > 0` OR `hasPartialBlisterSignal`.

**Complete rule (stay strict initially):** `SEALING_COMPLETE` still requires global `BLISTERED` until lane-close semantics exist.

### Packaging may begin while sealing still running

**Minimum:** record sealed output without requiring global `SEALED`.

| Approach | Event / field |
|---|---|
| **Preferred** | `SEALING_WIP_RECORDED` with `count_total` |
| Read-model | `read_bag_state.sealed_units_total` or lane WIP table |

**Pickup rule:** `canPackagingBeginOverlap` when `sealedOutputUnits > 0` OR partial sealed signal.

**Complete rule:** `PACKAGING_COMPLETE` still requires global `SEALED` until defined otherwise.

---

## Pause / resume and multi-station overlap

**Today:** `BAG_PAUSED` / `BAG_RESUMED` update **`read_bag_state`** only (global per bag). If blister pauses, sealing cannot complete and should not fire stage events while `is_paused`.

**Assumption:** Multi-station overlap **does not work fairly** with global pause until 2B/2C introduce **station-scoped sessions** (optional per-session pause later).

**Not one active station per bag in DB:** Multiple `read_station_live` rows can reference the same `workflow_bag_id` if pickup rules allow it. There is no exclusivity lock.

---

## Proposed vs current (helper API)

`evaluateFlowOverlapReadiness()` returns per lane:

| Field | Meaning |
|---|---|
| `canBeginOverlapWork` | Proposed overlap pickup (WIP-based) |
| `canCompleteStation` | Current `checkStageProgression` for complete events |
| `canBeginUnderCurrentSerialRules` | `STATION_PICKUP_FROM_STAGE` equality |
| `canCompleteUnderCurrentSerialRules` | Same as complete today |

**Invariant tested:** `canBeginOverlapWork` can be true while `canCompleteStation` is false (STARTED + partial blister signal).

---

## FLOW-OVERLAP-2B — recommended first changes

1. **Schema/read model (additive)**  
   - Add `blister_units_total`, `sealed_units_total` to `read_bag_state` OR `read_bag_lane_wip` table.  
   - Projector updates from new partial events only (no change to existing complete semantics yet).

2. **New event types (migration)**  
   - `BLISTER_WIP_RECORDED`, `SEALING_WIP_RECORDED` (enum + projector).  
   - Floor UI to emit on interim counts (separate from close-out forms).

3. **`scanCardAction` pickup guard**  
   - Replace `allowedStages.includes(stage)` with `evaluateFlowOverlapReadiness(...).sealingLane.canBeginOverlapWork` (and packaging analog).  
   - **Do not** only add `"STARTED"` to `STATION_PICKUP_FROM_STAGE`.

4. **`page.tsx` eligible pickups**  
   - Same helper; query may need WIP columns or event fold server-side.

5. **Tests**  
   - Integration tests on scan pickup with partial WIP seeded.

### Explicitly NOT in 2B first PR

- `scan-card-form.tsx` (unless pickup API contract frozen and tested separately)
- Changing `EVENT_STAGE_PREREQ` for complete without ops sign-off
- Auto-advancing global stage on partial WIP
- Removing `BAG_RELEASED` handoff without replacement session model

### Suggested 2B branch name

`cursor/flow-overlap-2b-pickup-wip`

---

## Do not do this (recap)

- Allow `STATION_PICKUP_FROM_STAGE.SEALING` to include `STARTED` only.
- Fire `BLISTER_COMPLETE` early to “unblock” sealing.
- Fold-on-read in UI.
- Downgrade global `read_bag_state.stage`.

---

## Merge safety

- **Low risk:** New lib + tests + docs only; no runtime behavior change.
- **2B** is medium risk; should follow this helper’s rules and extend projector first.
