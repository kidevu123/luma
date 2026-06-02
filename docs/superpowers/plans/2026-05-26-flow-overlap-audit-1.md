# FLOW-OVERLAP-AUDIT-1 — Overlapping station work on the same bag

**Date:** 2026-05-27  
**Status:** Audit complete — design only, no implementation  
**Repo at audit:** `40a3ea8` / v0.4.10 (read-only)

---

## 1. Executive answer

**Can overlap be supported with a small guard change?**  
**No.** The blocker is not a single mistyped constant. The system models **one global lifecycle stage per `workflow_bag`** (`read_bag_state.stage`). Downstream pickup and downstream **complete** events both require that global stage to have advanced past the upstream station’s work.

**Recommended path:** **Option B (medium)** — add **per-station / per-lane WIP state** derived from events (or a small read model), keep `workflow_events` append-only, relax pickup and complete guards to use **WIP thresholds** instead of “whole bag is BLISTERED.” Option C is the correct long-term shape if you also need partial counts, genealogy per tranche, and independent pause per station.

---

## 2. Current model summary

### Source of truth

| Artifact | Role |
|---|---|
| `workflow_bags` | One row per physical traveler (QR card journey). `started_at`, optional `product_id`, `finalized_at`. |
| `workflow_events` | Append-only event stream. **All production truth.** |
| `qr_cards` | Physical badge; `ASSIGNED` + `assigned_workflow_bag_id` while in production. |
| `read_bag_state` | **One row per bag.** Denormalized `stage`, pause flags, product display fields. |
| `read_station_live` | **One row per station.** `current_workflow_bag_id` = bag currently at that station UI. |

### Global bag stage (linear)

Projector maps completion events to a **single** `read_bag_state.stage` (`lib/projector/index.ts`):

| Event | Sets stage to |
|---|---|
| `CARD_ASSIGNED` | `STARTED` |
| `BLISTER_COMPLETE` / `HANDPACK_BLISTER_COMPLETE` | `BLISTERED` |
| `SEALING_COMPLETE` | `SEALED` |
| `PACKAGING_*` | `PACKAGED` |
| `BAG_FINALIZED` | `FINALIZED` |

Stage rank is monotonic (`STAGE_RANK`: STARTED=1 … FINALIZED=5). The projector **never downgrades** stage on conflict.

**What `STARTED` means today:** The bag has been assigned to production (`CARD_ASSIGNED`) but **no** upstream stage-complete event has fired yet. Blister/handpack may be actively working.

**What moves to `BLISTERED`:** A single `BLISTER_COMPLETE` or `HANDPACK_BLISTER_COMPLETE` on that bag — treated as “blister path done for the whole bag,” not “first tray ready.”

### Station presence vs bag stage

- **First-op stations** (`BLISTER`, `HANDPACK_BLISTER`, `BOTTLE_HANDPACK`, `COMBINED`): scan creates `workflow_bag` + `CARD_ASSIGNED` → stage `STARTED`; pins this station in `read_station_live`.
- **Downstream stations** (`SEALING`, `PACKAGING`, …): scan same QR while `ASSIGNED` → `BAG_PICKED_UP` if global stage ∈ `STATION_PICKUP_FROM_STAGE[kind]`; pins **this** station in `read_station_live`.
- **`BAG_RELEASED`:** Clears **only** the releasing station’s `read_station_live` row. Does **not** change global stage. Intended handoff: blister releases → sealing scans traveler.

### Intended travel (as coded + tested)

`lib/production/stage-progression.test.ts` documents the invariant:

1. Blister fires `BLISTER_COMPLETE` → bag `BLISTERED` → may **release** from blister.
2. Sealing **pickup** requires `BLISTERED` (not `STARTED`).
3. Sealing fires `SEALING_COMPLETE` → `SEALED` → may release.
4. Packaging pickup requires `SEALED`.

So the product **serializes** blister → seal → pack at the **bag** level. Overlap is **not** supported.

### One bag, one workflow row

Yes: one `workflow_bags` row per traveler. Partial-bag **resume** creates a **new** `workflow_bags` row (see `scanCardAction` partial-bag path) — that is a different product concept (raw tablets left in inventory), not parallel stage overlap.

### Multi-station at once (today)

- `read_station_live` is **per station**, so **multiple stations could pin the same `workflow_bag_id`** if pickup were allowed — there is **no** server guard in `scanCardAction` that refuses pickup when another station still holds the bag.
- `read_bag_state.is_paused` is **global per bag** — pause at blister blocks stage completes everywhere.
- Floor page shows “current bag” from **this station’s** `read_station_live` only (`page.tsx`).

---

## 3. Root cause of the SEALING block

### Error string

```text
SEALING station expects bag at BLISTERED (bag is STARTED).
```

### Exact location

**File:** `app/(floor)/floor/[token]/actions.ts`  
**Function:** `scanCardAction`  
**Lines:** ~410–418 (ASSIGNED-card / downstream pickup branch)

```typescript
const allowedStages = STATION_PICKUP_FROM_STAGE[station.kind] ?? [];
if (!state?.stage || !allowedStages.includes(state.stage)) {
  const list = allowedStages.length === 0 ? "no pickup stages defined" : allowedStages.join(" or ");
  throw new Error(
    `${station.kind} station expects bag at ${list} (bag is ${state?.stage ?? "unknown"}).`,
  );
}
```

### Config that drives it

**File:** `lib/production/stage-progression.ts`  
**Constant:** `STATION_PICKUP_FROM_STAGE`

```typescript
SEALING: ["BLISTERED"],
PACKAGING: ["SEALED"],
```

Bag is still `STARTED` because blister has not fired `BLISTER_COMPLETE` / `HANDPACK_BLISTER_COMPLETE`.

### Secondary blockers (if pickup were opened)

Even if scan succeeded at `STARTED`, **sealing could not complete**:

| Guard | Location | Rule |
|---|---|---|
| `EVENT_STAGE_PREREQ` | `stage-progression.ts` | `SEALING_COMPLETE` requires `currentStage === "BLISTERED"` |
| `checkStageProgression` | `actions.ts` → `fireStageEventAction` | Same check server-side |
| `STATION_RELEASE_FROM_STAGE` | `releaseBagAction` | Sealing release requires `SEALED` (after complete) |

UI pickup list on station page (`page.tsx` ~234–261) also filters `eligiblePickups` with `read_bag_state.stage ∈ pickupStages` — same `BLISTERED`-only rule.

---

## 4. Core modeling question

| Question | Answer |
|---|---|
| One global workflow status per bag? | **Yes** — `read_bag_state.stage`. |
| One `workflow_bags` row per traveler? | **Yes** (except partial-bag resume = new row). |
| Must blister fully complete before sealing starts? | **Effectively yes** — stage must be `BLISTERED`; that requires `*_COMPLETE` for whole bag. |
| Must sealing fully complete before packaging starts? | **Yes** — same pattern with `SEALED`. |
| Does event log support multiple stations? | Events are per `station_id`, but **read models collapse** to one stage. |
| Can append-only events express overlap cleanly? | **Yes**, if you add **granular events** (partial WIP, station sessions) and **project** them into lane-aware read models — not if you only widen `STATION_PICKUP_FROM_STAGE`. |

**Verdict:** Overlap is a **workflow/session model** problem, not a one-line pickup fix.

---

## 5. Design options (ranked)

### Option A — Minimal patch (pickup-only widening)

**What changes**

- Add `"STARTED"` to `STATION_PICKUP_FROM_STAGE.SEALING` (and possibly `PACKAGING` ← `"BLISTERED"` / `"SEALED"`).
- Maybe allow `BAG_PICKED_UP` without upstream `BAG_RELEASED`.

**What you get**

- Sealing can **scan** and show the bag at the sealing station while blister is still on `STARTED`.
- Operators still **cannot** fire `SEALING_COMPLETE` until `BLISTER_COMPLETE` (prereq unchanged).
- Packaging still blocked until `SEALED`.

**Risks**

- **Misleading UX** — bag “at sealing” but cannot seal (looks broken).
- **Dual station pin** — blister + sealing both show active bag; global pause affects both.
- **Throughput/metrics** — `read_daily_throughput` still counts one `bags_blistered` at complete; no partial credit.
- **Traceability** — events are truthful but read model still says `STARTED` until blister closes entire bag.
- **No migration** if only TS constants + guards.

**Files touched (if pursued)**

- `lib/production/stage-progression.ts`
- `stage-progression.test.ts`
- Possibly `page.tsx` eligible pickup query only

**Audit/history:** Still trustworthy; semantics become ambiguous.

**Recommendation:** **Insufficient** for stated ops requirement (“start sealing before blister fully closed”). Only useful as a spike.

---

### Option B — Medium refactor (recommended): lane WIP + relaxed guards

**What changes**

1. **New pure helpers / read projection** (no schema required initially):
   - Derive per-bag, per-lane WIP from events, e.g.:
     - `blister_units_complete` (sum `count_total` from `BLISTER_COMPLETE` / handpack analog)
     - `sealed_units_complete` (from `SEALING_COMPLETE`)
     - `packaged_units` (from packaging events)
   - Or explicit new events: `BLISTER_WIP_ADDED`, `SEALING_WIP_ADDED` with qty.

2. **Pickup rules** replace stage equality:
   - Sealing pickup allowed when `blister_wip >= threshold` OR `stage >= BLISTERED` OR blister station released with partial flag.
   - Packaging pickup when `sealed_wip >= threshold` OR `stage >= SEALED`.

3. **Complete rules**
   - `SEALING_COMPLETE` allowed when `blister_wip > 0` and not exceeding sealed cumulative (validation).
   - Global `read_bag_state.stage` advances on **lane close** events (e.g. `BLISTER_LANE_CLOSED`) or keep current complete as “lane done” while allowing partial completes.

4. **Station sessions** (lightweight):
   - Extend `read_station_live` or add `read_station_bag_sessions` (bag_id, station_id, opened_at, closed_at, status ACTIVE|RELEASED).
   - Pickup opens session; release closes session; multiple ACTIVE sessions per bag allowed with explicit rules.

5. **Pause**
   - Prefer **per-station session pause** or document that global bag pause remains (simpler v1).

**Migration**

- **Phase 1:** Read models + projector only (additive columns / new table).
- **Phase 2:** Optional backfill from `workflow_events` for in-flight bags.

**Risks**

- Must define **thresholds** (units, %, or supervisor override) to avoid sealing with zero blister output.
- Genealogy / finished lots must consume **cumulative** counts consistently.
- Floor board “where is this bag?” needs multi-station display.

**Files likely touched**

- `lib/production/stage-progression.ts` (+ new `lane-wip.ts` or similar)
- `lib/projector/index.ts` (project WIP columns / sessions)
- `lib/db/schema.ts` + migration (if persisting WIP/session rows)
- `app/(floor)/floor/[token]/actions.ts` — `scanCardAction`, `fireStageEventAction`, `releaseBagAction`
- `app/(floor)/floor/[token]/page.tsx` — eligible pickups, active bag display
- `stage-action-buttons.tsx` — prereq display (not `scan-card-form.tsx` unless pickup UX requires it)
- Tests: `stage-progression.test.ts`, new projector tests, floor structural tests

**Audit:** Strengthened if each WIP increment is an event with accountability.

**Counts / output:** Stay correct only if complete payloads reference WIP deltas and reconciliation rules are updated.

---

### Option C — Long-term: explicit station work sessions + inventory buffers

**What changes**

- First-class `station_bag_sessions` (or `workflow_lane_runs`) table:
  - `workflow_bag_id`, `station_id`, `lane` (BLISTER|SEAL|PACK), `status`, `opened_at`, `closed_at`, `output_qty`, pause accumulators.
- QR traveler stays one bag; **each station records work in its session**.
- Global `read_bag_state.stage` becomes a **derived summary** (max lane progress) for reporting, not the gate for pickup.
- Optional **buffer lots** between lanes (WIP totes) if physical trace requires moving partial output off the blister table before seal.

**When needed**

- Independent pause/timer per station.
- Different operators accountable per lane simultaneously.
- Physical separation of partial blister output from raw bag weight reconciliation.
- Nexus/recall needs “which tranche” not just bag-level stage.

**Migration:** Required. Backfill strategy for active travelers.

**Risks:** Highest build cost; clearest ops match.

---

## 6. Comparison table

| Criterion | Option A | Option B | Option C |
|---|---|---|---|
| Supports seal before blister done | Scan only | Yes (with thresholds) | Yes |
| Supports pack before seal done | No | Yes (with thresholds) | Yes |
| Schema migration | No | Likely additive | Yes |
| Traceability | Weak | Good | Best |
| Pause/timer per station | No (global) | Partial | Full |
| Effort | Hours | 1–2 weeks | Multi-week |
| Breaks existing tests | Few | Many | Many |

---

## 7. Challenge to “station sessions only” instinct

Your instinct is **correct** for production reality. The existing **event** model can support it **if**:

- Events record **lane-level facts** (partial output, session open/close), and
- The projector maintains **parallel state** instead of one `stage` enum.

The current model **already** has `station_id` on every event and `BAG_PICKED_UP` / `BAG_RELEASED` for handoff — it is **halfway** to sessions but **gates** on global `read_bag_state.stage`, which encodes “previous lane 100% done.”

---

## 8. Do not do this

| Shortcut | Why it corrupts traceability |
|---|---|
| Add `STARTED` to sealing pickup **only** | Operators see bag at sealing but cannot work; hides real requirement. |
| Fire `BLISTER_COMPLETE` early with partial count | Marks **entire bag** `BLISTERED`; packaging/sealing rules think blister lane is done; counts lie. |
| Let `SEALING_COMPLETE` fire at `STARTED` without WIP checks | Sealed output with no blister genealogy. |
| Skip `BAG_RELEASED` and rely on scan only | Loses audit trail of intentional handoff; board state ambiguous. |
| Allow two stations without session rows | Cannot answer “who owns this bag?” for accountability. |
| Downgrade global stage for overlap | Projector forbids downgrades; breaks monotonic reporting. |
| Fold-on-read at UI | Violates Luma architecture (`workflow_events` + projectors only). |
| Duplicate `workflow_bags` per station | Breaks one-traveler-one-journey; QR card can only point to one bag. |

---

## 9. Recommended design

**Ship Option B in slices:**

### Next implementation slice: `FLOW-OVERLAP-2A` — Design + read-model spike (no floor UX yet)

1. Document **threshold rules** with ops (minimum blister units before seal scan; minimum sealed before pack).
2. Add `lib/production/lane-wip.ts` — pure fold over `workflow_events` payload shapes.
3. Add projector fields (additive migration): e.g. `read_bag_state.blister_units_total`, `sealed_units_total` OR `read_bag_lane_wip` table.
4. Unit tests on historical event sequences (blister partial → seal start).

### `FLOW-OVERLAP-2B` — Pickup + complete guards

1. `scanCardAction`: replace `allowedStages.includes(stage)` with `canPickupAtStation({ kind, stage, wip })`.
2. `fireStageEventAction`: `SEALING_COMPLETE` when `blister_wip > 0` even if `stage === STARTED` (or after first partial blister event).
3. `page.tsx` eligible pickups query uses same helper.

### `FLOW-OVERLAP-2C` — Station sessions + floor board

1. Session open on pickup, close on release.
2. Floor board shows multiple active stations per bag.
3. Per-session pause (optional).

**Hard stops for 2B/2C (from product owners):**

- Do not change `scan-card-form.tsx` until pickup API contract is stable.
- Avoid editing `actions.ts` in the same PR as unrelated station UX.
- No schema change without `luma-drizzle-migration` skill review.

---

## 10. Packaging / sealing expectations (today)

| Station | Pickup requires (`read_bag_state.stage`) | Complete requires |
|---|---|---|
| SEALING | `BLISTERED` | `BLISTERED` → `SEALING_COMPLETE` |
| PACKAGING | `SEALED` | `SEALED` → `PACKAGING_COMPLETE` |

**Operational desire:**

| Station | Should start when |
|---|---|
| SEALING | Enough blister/card output exists (WIP > 0), blister may still be `STARTED` |
| PACKAGING | Enough sealed output exists, sealing may still be `BLISTERED` or partial `SEALED` |

---

## 11. Related code map (read-only)

| Concern | Primary files |
|---|---|
| Pickup stages | `lib/production/stage-progression.ts` |
| Scan / pickup guard | `app/(floor)/floor/[token]/actions.ts` (`scanCardAction`) |
| Stage complete guard | `actions.ts` (`fireStageEventAction`), `checkStageProgression` |
| Release handoff | `actions.ts` (`releaseBagAction`), `BAG_RELEASED` in projector |
| Global stage projection | `lib/projector/index.ts` (`STAGE_FOR_EVENT`, `STAGE_RANK`) |
| Station pin | `read_station_live` in projector |
| UI pickup list | `app/(floor)/floor/[token]/page.tsx` |
| Tests documenting serial flow | `lib/production/stage-progression.test.ts` |

---

## 12. Audit metadata

- **Code changed:** Only this plan file (`docs/superpowers/plans/2026-05-26-flow-overlap-audit-1.md`).
- **Pushed:** No.
- **Hard stops honored:** `scan-card-form.tsx`, `actions.ts`, schema, floor logic — **not modified**.
