# Pause / End-Shift Counter Procedure

**Slice:** PAUSE-ENDSHIFT-VALIDATION-1 (audit + procedure)  
**Date:** 2026-06-02  
**Live baseline:** v0.4.74 @ `ae8be60df0c60ed0133060bcf82f6a30b52645dd`  
**Companion:** `docs/BLISTER_ROOM_READINESS_CHECKLIST.md`, `docs/MANUAL_WORKFLOW_TEST_PACKET.md` (§ counter semantics)

---

## 1. Purpose

### What the counter snapshot represents

On **Blister Room** and **COMBINED** stations, the operator enters a **segment count**: the number of **good blisters/cards produced since the last physical machine counter reset** — not a lifetime machine total and not a running bag total unless it happens to be the only segment.

That value is used to:

1. Record **`ROLL_COUNTER_SEGMENT_RECORDED`** on **both** active rolls mounted on the machine (PVC + foil), when count &gt; 0.
2. Attribute material usage / roll yield learning for the active **workflow bag**.
3. Preserve an audit trail in **`BAG_PAUSED`** payload (`counter_snapshot_count`, unit `good_blisters_since_last_reset`).

### Why it matters

Roll and bag genealogy depend on segment sums. Missing segments under-count roll usage; double segments (after an unrecorded physical reset) over-count. Pause/end-shift discipline keeps PVC/foil segments aligned with physical production.

---

## 2. Code path map (audited)

| Flow | UI entry | Server action | Events emitted | Roll segments |
|------|----------|---------------|----------------|---------------|
| **Normal pause** (any reason) | Pause → reason → Confirm | `pauseBagAction` | `BAG_PAUSED` | Only if BLISTER/COMBINED + `machine_jam` or `shift_end` + count &gt; 0 |
| **End shift** (operator panel) | End shift → counter → Confirm | `pauseBagAction` (`shift_end`) then `endOperatorSessionAction` | `BAG_PAUSED` + session close | Same as shift_end pause when count &gt; 0 |
| **Machine jam pause** | Pause → Machine jam + counter | `pauseBagAction` | `BAG_PAUSED` | `PAUSE_SNAPSHOT` segments if count &gt; 0 |
| **Roll swap pause** | Pause → PVC/foil swap | `pauseBagAction` (no counter) | `BAG_PAUSED` | None until **Roll change** form |
| **Roll change** (while paused) | `RollChangeCard` | `changeRollAction` | `ROLL_DEPLETED` or `ROLL_UNMOUNTED` + `ROLL_MOUNTED` | `ROLL_CHANGE` on **both** active PVC+foil (count ≥ 1 required) |
| **Blister close-out** | Blister close-out form | `fireStageEventAction` (`BLISTER_COMPLETE`) | `BLISTER_COMPLETE` | `BAG_COMPLETE` via projector hook (`material-consumption-hook.ts`) if count &gt; 0 |
| **Resume** | Resume bag | `resumeBagAction` | `BAG_RESUMED` | None |
| **Sealing segment** | Record sealing segment | `fireStageEventAction` | `SEALING_SEGMENT_COMPLETE` | **Not** blister roll segments — uses sealing counter presses × cards/press |

### Key files

| File | Role |
|------|------|
| `lib/production/blister-counter-snapshot.ts` | When pause requires counter (`BLISTER`/`COMBINED` + `machine_jam`/`shift_end`) |
| `lib/production/station-pause-reasons.ts` | Pause reason dropdown per station kind |
| `app/(floor)/floor/[token]/actions.ts` | `pauseBagAction`, `recordBlisterCounterRollSegment` call |
| `app/(floor)/floor/[token]/operator-session-actions.ts` | `endOperatorSessionAction` — requires bag paused on blister if bag active |
| `app/(floor)/floor/[token]/operator-session-form.tsx` | End shift auto-pause + counter UI |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Pause UI, `RollChangeCard`, blister close-out |
| `app/(floor)/floor/[token]/roll-actions.ts` | `changeRollAction` — partial vs depleted roll end |
| `lib/production/blister-roll-segments.ts` | Shared segment writer for pause snapshots |
| `lib/projector/material-consumption-hook.ts` | `BAG_COMPLETE` segments on `BLISTER_COMPLETE` |

---

## 3. Audit answers

### Q1. Events on normal pause?

Always **`BAG_PAUSED`** with `payload.reason` (`pvc_swap`, `foil_swap`, `shift_end`, `machine_jam`, `qa_check`, `other`).

Counter fields in payload only when station is `BLISTER`/`COMBINED` and reason is **`machine_jam`** or **`shift_end`**.

### Q2. Events on end-shift pause?

Same **`BAG_PAUSED`** with `reason: "shift_end"`, `counter_snapshot_reason: "SHIFT_END_SNAPSHOT"`.

Then **`endOperatorSessionAction`** closes the operator session (audit `floor.operator_session_ended`).

The **End shift** button in the operator panel performs pause-then-end in one flow when a bag is active and not already paused.

### Q3. Where are counter snapshots recorded?

| Store | Content |
|-------|---------|
| `workflow_events` (`BAG_PAUSED`) | `counter_snapshot_count`, `counter_snapshot_unit`, `counter_snapshot_reason`, `counter_snapshot_source` |
| `material_inventory_events` (`ROLL_COUNTER_SEGMENT_RECORDED`) | When count &gt; 0 — one row per active PVC + foil roll on the machine |

### Q4. Snapshot ties to?

| Dimension | Linked? |
|-----------|---------|
| **Bag** | Yes — `workflow_bag_id` on segments |
| **Station** | Yes — `station_id` |
| **Machine** | Yes — via station `machine_id` |
| **Operator** | Yes — accountability fields on events (session or badge override) |
| **Active roll(s)** | Yes — both PVC + foil currently `IN_USE`/`ROLL_MOUNTED` on machine |
| **Paired rolls** | Same segment count applied to **each** active roll role |
| **Timestamp** | `occurred_at` on events |

### Q5. When does `ROLL_COUNTER_SEGMENT_RECORDED` happen?

| Trigger | `segment_reason` | Min count |
|---------|------------------|-----------|
| Pause (`machine_jam`) | `PAUSE_SNAPSHOT` | &gt; 0 to emit (0 stored on pause only) |
| Pause / end shift (`shift_end`) | `SHIFT_END_SNAPSHOT` | &gt; 0 to emit |
| Roll change | `ROLL_CHANGE` | ≥ 1 (required) |
| Blister complete | `BAG_COMPLETE` | &gt; 0 (projector hook; 0 skips) |

### Q6. Interactions

| Context | Behavior |
|---------|----------|
| **Partial roll swap** | Pause (optional) → `RollChangeCard` → `removed_partial` → segment + `ROLL_UNMOUNTED` (roll returns AVAILABLE) + mount new roll **without** inheriting prior count |
| **Depleted roll swap** | Same flow with `depleted` → segment + `ROLL_DEPLETED` |
| **Machine blister** | Full segment model (pause, roll change, blister close-out) |
| **Hand-pack blister** | No blister counter on pause (`HAND_WORK_REASONS` — no `machine_jam` counter path). Finished product deferred to sealing. |
| **Sealing** | Separate counter: **presses × cards/press** — not `good_blisters_since_last_reset` |

### Q7. Cumulative or segment?

**Segment since last physical reset.** Documented in `material-consumption-hook.ts` and pause UI copy. Bag/roll totals in segment payload are **sums of segments**, not machine lifetime readings.

### Q8. Does UI copy tell operators what to enter?

| Surface | Copy quality |
|---------|--------------|
| Pause (machine jam / shift end) | **Good** — "good blisters/cards made since the last reset" + reset after save |
| End shift panel | **Good** — "Save this count before ending shift" |
| Roll change card | **Partial** — "counter reading when the old roll stopped" but **no explicit reset reminder** |
| Blister close-out | **Weak** — label "Machine counter" only; no "since last reset" helper text |
| Client validation error on pause | **Bug/weak** — always says "machine jam" even when reason is `shift_end` |

### Q9. Does UI tell operator to reset physical counter?

| Surface | Reset guidance |
|---------|----------------|
| Pause snapshot | **Yes** — explicit |
| End shift | Implied ("machines may reset when powered off") |
| Roll change | **No** |
| Blister close-out | **No** |

### Q10. Forgot snapshot before physical reset?

The next segment will likely be **wrong** (too small or zero). System does not auto-detect reset. **Stop and call Sahil** — do not continue production. Recovery apply is not shipped.

### Q11. Snapshot twice?

- **Double pause without resume:** Blocked — "Bag is already paused."
- **Pause → resume → pause again:** Allowed — creates **another** segment if count &gt; 0. No duplicate-value guard.
- **End shift then manual pause:** Bag already paused; end shift path requires pause first.

### Q12. Pause without operator session?

Pause works with optional badge `operatorCode`. **`BLISTER_COMPLETE` requires** open operator session (or stable employee). End shift on blister with active bag requires pause first (auto-handled by End shift flow).

### Q13. Inactive station + end shift?

`endOperatorSessionAction` does **not** call inactive guard (by design). **`page.tsx` renders inactive stations without operator panel**, so operators deactivated mid-page cannot reach End shift from UI. Admin should reactivate or complete shift before deactivating.

### Q14. Safest manual recovery if snapshot wrong?

1. **Do not** edit DB or run repair scripts without PM approval.  
2. **Do not** use recovery apply (not shipped).  
3. Escalate to Sahil with bag card, station, roll numbers, and event timeline (`workflow_events` + `material_inventory_events`).  
4. Dry-run planner (`planMaterialChangeRecovery`) is code-only — not operator-facing.

---

## 4. Operator procedure

### Before starting a bag (Blister Room)

1. Open operator shift (pick employee — required before blister close-out).
2. Confirm PVC + foil rolls in UI match physical rolls.
3. Confirm machine counter is **reset to zero** (or team agrees on starting baseline).
4. Scan station → scan bag card.

### Normal pause (break, QA, other — no roll change)

1. Tap **Pause** → choose reason.
2. **No counter** unless reason is Machine jam (BLISTER/COMBINED only).
3. Confirm pause. Resume when ready.

### Machine jam pause (BLISTER / COMBINED)

1. Read machine counter (**good blisters since last reset**).
2. Pause → **Machine jam** → enter count → **Confirm pause**.
3. **Reset physical machine counter to zero** after save succeeds.
4. Fix jam → **Resume**.

### End-of-shift (BLISTER / COMBINED with active bag)

**Preferred path — operator panel:**

1. Tap **End shift** → **Confirm end shift**.
2. Enter **Machine counter at shift end** (same segment semantics).
3. System pauses bag with `shift_end` snapshot, then closes operator session.

**Alternate path — bag pause first:**

1. Pause → **Shift ending** → enter counter → confirm.
2. Then **End shift** on operator panel.

If count is **zero** at shift end: allowed — pause records zero; **no** roll segments emitted.

### Roll depleted change (mid-bag)

1. Pause → **PVC roll swap** or **Foil roll swap** (no counter on pause).
2. While paused, complete **Roll change required** card:
   - Enter **Machine counter when roll stopped** (segment since last reset).
   - Choose **Finished / depleted**.
   - Enter new roll number → submit.
3. **Reset physical machine counter** after successful roll change (trained procedure — UI does not remind).
4. **Resume** bag.

### Partial roll removal (material remaining)

Same as roll change but select **Removed with material remaining**. Old roll returns to available inventory; new roll mounts clean.

### Blister close-out (end of bag at blister)

1. Read machine counter (segment since last reset).
2. **Record blister close-out** → enter **Machine counter** → Save.
3. Projector emits `BAG_COMPLETE` segments to active PVC+foil if count &gt; 0.
4. **Reset physical machine counter** before next bag (trained procedure).

### Hand-pack station

- Pause/end shift: **no** blister counter snapshot required.
- Tablet context is read-only from lineage; finished product is saved at **sealing** (v0.4.74 Save product flow).

### Sealing station

- Uses **counter presses** and cards/press — different from blister roll segments.
- Save finished product before sealing segment/close-out.

---

## 5. Supervisor / admin procedure

### Pre-shift

- [ ] Health + `verify:deploy` green
- [ ] Auth smoke FAIL=0
- [ ] Active stations and rolls match physical setup
- [ ] Operators briefed on **segment vs lifetime** counter rule
- [ ] Confirm machine counters reset at shift start

### Before end shift

- [ ] Every active blister bag either paused with **shift_end** snapshot or released/completed appropriately
- [ ] No open roll-change cards left incomplete
- [ ] Operator sessions ended via **End shift** (not abandoned)

### Post-shift review

Inspect for each active bag / roll:

| Check | Where |
|-------|-------|
| Pause reasons and snapshot counts | `workflow_events` (`BAG_PAUSED`) |
| Segment reasons and sequences | `material_inventory_events` (`ROLL_COUNTER_SEGMENT_RECORDED`) |
| Roll mount/deplete/unmount chain | `ROLL_MOUNTED`, `ROLL_DEPLETED`, `ROLL_UNMOUNTED` |
| Bag stage progression | `read_bag_state` / workflow submissions |

**Double-count risk:** Two segments with overlapping physical production (reset without recording, then another segment).

**Missing-count risk:** Physical production with zero/null snapshot or skipped blister close-out segment.

---

## 6. Stop-the-floor rules

Stop blister production and call Sahil if:

1. Physical roll ≠ UI active roll
2. Physical machine counter was **reset before** snapshot was saved
3. Operator unsure whether count was recorded
4. Missing tablet/receipt/lineage on a live bag
5. Bag pinned at wrong station vs physical location
6. Duplicate or impossible segment (sum doesn't match physical output)
7. Any finalized/finished-lot correction needed
8. Any urge to manually edit the database

---

## 7. Recovery guidance

| Capability | Status |
|------------|--------|
| Material-change recovery **apply** | Not shipped |
| Dry-run planner | Code/tests only (`planMaterialChangeRecovery`) |
| DB repair scripts | PM-gated only |
| Operator self-correction | Not supported — stop floor |

---

## 8. First supervised shift validation checklist

### Pre-shift

- [ ] Admin completes blister-room pre-shift checks (`BLISTER_ROOM_READINESS_CHECKLIST.md`)
- [ ] Operator opens shift with real employee picker
- [ ] Rolls verified PVC + foil

### First bag start

- [ ] Machine counter reset agreed
- [ ] Scan station + bag card
- [ ] Timer running

### First pause (machine jam drill)

- [ ] Enter segment count → pause succeeds
- [ ] Segments appear on both rolls (if count &gt; 0)
- [ ] Physical counter reset
- [ ] Resume succeeds

### First roll change (if applicable)

- [ ] Pause with PVC or foil swap reason
- [ ] Roll change card completes
- [ ] Old roll status correct (depleted vs partial)
- [ ] New roll mounted in UI matches physical

### End shift

- [ ] End shift captures counter when bag still active
- [ ] Bag shows paused; operator session closed

### Post-shift review

- [ ] Admin reviews events for one bag + both rolls
- [ ] Segment sums plausible vs physical output
- [ ] Debrief operators on any copy confusion

---

## 9. Gap analysis (opinionated)

### Safe for launch now

- Counter snapshot **machinery is live** for pause/end-shift/roll-change/blister-complete.
- UI explains segment semantics on **pause** and **end shift** paths.
- Partial vs depleted roll swap is implemented and tested.
- Double-pause is blocked; end-shift requires snapshot when bag active on blister.

### Must be trained (not fully enforced in UI)

- **Physical counter reset** after pause snapshot, roll change, and blister close-out.
- Segment count ≠ lifetime machine reading.
- End shift sequence when bag active (use operator panel flow).
- Roll change only while paused with swap reason.
- Do not reset machine before saving count.

### Should be coded later (ranked)

1. **PAUSE-ENDSHIFT-COPY-1** — Unify counter helper text on roll change + blister close-out; fix pause client error to mention shift end; optional explicit reset confirmation checkbox.
2. **COUNTER-SNAPSHOT-GUARD-1** — Warn/block when new segment &lt; prior segment on same roll or duplicate snapshot within N minutes.
3. **RECOVERY-DRY-RUN-HARNESS-1** — CLI dry-run against real bag/roll IDs for PM review after incidents.
4. **SHIFT-REVIEW-1** — Admin post-shift segment timeline (read-only).
5. Inactive station **end-shift escape hatch** if deactivation mid-shift becomes common.

### Would block blister-room launch

**None from code alone** if first shift is **supervised** and operators follow this procedure.

Launch blocker becomes **real** if:

- Operators routinely reset machines before snapshot ( untrained ).
- Roll UI doesn't match physical rolls (data/process).
- Sahil unavailable during first dual-run weeks.

---

## 10. Open risks / PM decisions

| Item | Recommendation |
|------|----------------|
| Reset reminder on roll change / blister close-out | **PAUSE-ENDSHIFT-COPY-1** — train now, code next |
| Pause client error always says "machine jam" | Fix in COPY-1 slice |
| Zero-count shift end (no segments) | Allowed by design — confirm training covers "zero is OK" |
| Blister close-out label "Machine counter" | Clarify "since last reset" in COPY-1 |
| Inactive station cannot end shift from UI | Document; reactivate station if needed |
| Enforce reset in UI vs training only | **Train first**; enforce only if drift persists post-supervision |
| Sealing counter confusion | Keep separate section in training — not same as blister segments |

---

## Staging read-only spot check (2026-06-02)

| Check | Result |
|-------|--------|
| Health SHA | `ae8be60` ok |
| verify:deploy | pass |
| Auth smoke | FAIL=0 |
| Active bag | Card #61 @ Blister Room, STARTED, not paused, 0 pauses/segments |
| Active rolls | PVC-3, FOIL-2 IN_USE |

No mutations performed.

---

## Change log

| Date | Change |
|------|--------|
| 2026-06-02 | Initial procedure (PAUSE-ENDSHIFT-VALIDATION-1) |
