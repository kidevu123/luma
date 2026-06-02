# MATERIAL-ROLL-CHANGE-AUDIT-1 — PVC/Foil roll change workflow audit

**Date:** 2026-05-27  
**Status:** Audit complete — no implementation in this task  
**Base:** `origin/main` @ `1660297` · **v0.4.34** (BLISTER-MACHINE-COUNTER-1 integrated)

---

## Executive summary

Sahil’s observation is correct: selecting **PVC roll swap** or **Foil roll swap** as a pause reason only writes `BAG_PAUSED` with a text reason. **No material lot is recorded, no roll is mounted/unmounted, and no counter segment is allocated.**

However, a **substantial roll-management subsystem already exists** on BLISTER/COMBINED stations. It is reachable via a collapsed **Supervisor tools → Rolls** link (`/floor/{token}/rolls`) and implements mount, unmount, weigh, and mid-bag change with full audit trail in `material_inventory_events`. The gap is **discoverability and workflow wiring**: pause reasons imply a roll change happened, but the app never routes the operator to the roll actions that actually record it.

**Recommended near-term slice:** UX integration only (no schema migration, no consumption math changes). Replace or augment pause-with-swap with an inline **Change PVC roll** / **Change Foil roll** flow that calls existing `changeRollAction` / `mountRollAction` / `unmountRollAction`.

---

## 1. Current behavior

### 1.1 Pause flow

| Aspect | Behavior |
|---|---|
| **Where created** | `pauseBagAction` in `app/(floor)/floor/[token]/actions.ts` |
| **Event type** | `BAG_PAUSED` via `projectEvent` |
| **Scope** | **Bag-scoped** — requires `workflowBagId`, `stationId`, station token auth |
| **Payload** | `{ reason, operator_code?, notes? }` only |
| **pvc_swap / foil_swap** | Valid enum values on server (`pauseSchema`) and in UI dropdown (`lib/production/station-pause-reasons.ts`) |
| **Material side effects** | **None** — pause does not touch `packaging_lots`, `material_inventory_events`, or roll read models |
| **Resume** | `resumeBagAction` → `BAG_RESUMED`; projector accumulates pause seconds on bag |
| **While paused** | Stage events refused by `checkStageProgression`; bag stays pinned at station in `read_station_live` |

UI entry: `stage-action-buttons.tsx` → **Pause bag** → reason `<select>` (station-filtered via `getPauseReasonsForStation`) → **Confirm pause**.

Default pause reason for BLISTER/COMBINED is **`pvc_swap`** (first option in matrix).

### 1.2 What operators experience today

1. Operator taps **Pause bag**, picks **PVC roll swap** or **Foil roll swap**.
2. Bag shows **Bag is paused**; timer stops.
3. Operator physically swaps the roll.
4. Operator taps **Resume bag**.
5. **Nothing in the system records which roll was removed or installed.** Counter segments for the old roll are not closed unless the operator separately visits the Rolls page and submits **Change roll mid-bag**.

### 1.3 Roll management (already built, disconnected)

| Capability | Location | Notes |
|---|---|---|
| **Rolls page** | `app/(floor)/floor/[token]/rolls/page.tsx` | BLISTER/COMBINED only |
| **Nav link** | `lib/production/floor-station-mobile-nav.ts` → `floorSupervisorToolsForStation` | Collapsed **Supervisor tools** panel on main station page |
| **Mount** | `mountRollAction` | Between bags or at shift start; optional `workflowBagId` |
| **Unmount** | `unmountRollAction` | Partial roll removal with optional ending weight |
| **Weigh** | `weighRollAction` | In-place weight estimate |
| **Mid-bag change** | `changeRollAction` | Requires active bag; records counter segment, depletes old roll, mounts new roll |
| **Active roll query** | `lib/production/active-rolls.ts` → `getActiveRollsForMachine` | Latest-event-per-lot pattern on `material_inventory_events` |
| **Read model** | `lib/projector/roll-usage.ts` → `read_roll_usage` | Rebuilt after roll mutations |

**SEALING, HANDPACK_BLISTER, PACKAGING, BOTTLE_*** do not get the Rolls link. SEALING pause reasons correctly exclude `pvc_swap` / `foil_swap`.

### 1.4 Material consumption on BLISTER_COMPLETE

| Aspect | Behavior |
|---|---|
| **Trigger** | `emitMaterialConsumedFromBlister` in `lib/projector/material-consumption-hook.ts`, called from projector on `BLISTER_COMPLETE` |
| **`count_total` meaning** | **Machine counter segment** for the final segment of the bag — operator resets physical counter between segments; value entered at close-out is **not** a lifetime or bag-total counter |
| **Emission** | One `ROLL_COUNTER_SEGMENT_RECORDED` per **active** PVC and FOIL roll on the station’s **machine** |
| **Skip rules** | No `count_total` or ≤ 0 → skip silently; no active roll for role → skip that role |
| **Weight consumption** | **Not emitted here** — segments are counter ledger only; grams derived later via `blister_material_standards` or net-weight ÷ yield on depletion |
| **Product coupling** | Hook reads `workflow_bags.productId` but does **not** require it for segment emission; product-at-sealing (v0.4.33+) means BLISTER bags may have `productId = null` at blister close-out |

Mid-bag roll changes use the same segment event with `segment_reason = 'ROLL_CHANGE'` (from `changeRollAction`), allocated to both active PVC and FOIL rolls.

### 1.5 BLISTER_COMPLETE gating vs active rolls

**No policy today requires active PVC/FOIL rolls to submit BLISTER_COMPLETE.** If rolls are missing, segment emission is skipped silently for that role; the stage event still succeeds.

---

## 2. Existing relevant tables / files / routes

### 2.1 Database (read-only audit — no migration in this slice)

| Table / enum | Role |
|---|---|
| `packaging_materials` | Master data; kinds `PVC_ROLL`, `FOIL_ROLL`, `BLISTER_FOIL` |
| `packaging_lots` | Roll inventory lots (`roll_number`, weights, status: AVAILABLE / IN_USE / DEPLETED / HELD / SCRAPPED) |
| `material_inventory_events` | Append-only roll ledger: `ROLL_MOUNTED`, `ROLL_UNMOUNTED`, `ROLL_WEIGHED`, `ROLL_DEPLETED`, `ROLL_COUNTER_SEGMENT_RECORDED` |
| `blister_material_standards` | Configured + learned grams-per-blister by product/tablet |
| `read_roll_usage` | Per-lot yield, variance, confidence (projector) |
| `workflow_events` | Production truth including `BAG_PAUSED`, `BLISTER_COMPLETE` |
| `stations` / `machines` | Station bound to machine; rolls are **machine-scoped** |
| `product_packaging_specs` | BOM includes roll kinds for packaging close-out display; blister UI notes “PVC/foil tracked via roll counter” |

There is **no separate “active roll assignment” table**. Active state is derived from the latest `material_inventory_events` row per lot where event = `ROLL_MOUNTED` on a given `machine_id`.

There is **no “roll session” table** with explicit start/end timestamps beyond mount/unmount/deplete events.

### 2.2 Floor routes & actions

| Path / file | Purpose |
|---|---|
| `/floor/[token]` | Main station — pause/resume, blister close-out |
| `/floor/[token]/rolls` | Roll mount / unmount / weigh / change |
| `app/(floor)/floor/[token]/actions.ts` | `pauseBagAction`, `resumeBagAction`, `fireStageEventAction` |
| `app/(floor)/floor/[token]/roll-actions.ts` | All roll server actions |
| `app/(floor)/floor/[token]/rolls-forms.tsx` | Client forms with pending/error/success |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Pause UI (hard stop — do not modify in implementation without explicit approval) |
| `lib/production/station-pause-reasons.ts` | Station → pause reason matrix |
| `lib/production/floor-station-mobile-nav.ts` | Gates Rolls link to BLISTER/COMBINED |
| `lib/projector/material-consumption-hook.ts` | BLISTER_COMPLETE → segment ledger |
| `lib/projector/roll-usage.ts` | `read_roll_usage` rebuilder |

### 2.3 Admin / inbound routes

| Path | Purpose |
|---|---|
| `/inbound/packaging-materials` | Receive count materials + **rolls** (`receiveRollAction`) |
| `/packaging-inventory` | Lot inventory listing (roll numbers visible) |
| `/packaging-receipts/[lotId]/adjust` | Lot weight/qty corrections |
| `/settings/blister-standards` | Learned vs configured g/blister; roll inventory summary |
| `/settings/packaging-bom` | Product BOM including roll kinds |
| `/packaging-output` | Material burn report — **explicitly excludes** roll kinds (rolls tracked via counter) |

**No admin page** today shows machine-mounted rolls, roll-change history, or a “correct roll assignment” workflow. That lives entirely on the floor Rolls page + event ledger.

### 2.4 Tests & battle evidence

- `lib/production/active-rolls.test.ts` (32 tests)
- `lib/production/roll-segment-ledger.test.ts` (25 tests)
- `docs/MANUAL_WORKFLOW_TEST_PACKET.md` — VALIDATION-2C live test: mount PVC + Foil, mid-bag `changeRollAction` at counter 15238, complete bag, math reconciled
- `docs/CURRENT_PHASE_STATUS.md` — documents all four roll actions

---

## 3. What is missing

| Gap | Impact |
|---|---|
| **Pause reason ≠ roll change** | Operators believe swap is recorded; it is not |
| **Rolls page buried in supervisor tools** | Easy to miss on a production tablet |
| **No inline roll change on main station** | Extra navigation during a time-sensitive physical swap |
| **No link from `BAG_PAUSED` reason to roll events** | Audit trail has pause reason text but no lot IDs |
| **Partial-roll swap path unclear** | `changeRollAction` always marks old roll **DEPLETED**; partial removal needs **unmount** + **mount**, not change |
| **No active-roll banner on main station** | Operator may complete BLISTER without knowing rolls are unmounted (segments silently skipped) |
| **No admin roll-change history view** | Reconciliation requires SQL or future admin slice |
| **Between-bag roll swap** | Use mount/unmount, not change — not surfaced in pause flow |

---

## 4. Recommended workflow (smallest safe floor UX)

### 4.1 Principles

1. **Roll change is a material action, not a pause reason.** Keep pause for true stoppages (jam, QA, shift end).
2. **Reuse existing server actions** — do not duplicate ledger logic.
3. **Do not block BLISTER_COMPLETE** on roll presence in slice 1 (current behavior); optionally warn if no active roll.
4. **Mid-bag vs between-bag** must be explicit in UX.

### 4.2 Proposed operator flow (BLISTER / COMBINED)

**Primary actions on main station page** (new, alongside pause):

| Button | When | Action |
|---|---|---|
| **Change PVC roll** | Active bag at station | Open inline panel → role pre-selected PVC → counter segment + new lot → `changeRollAction` |
| **Change Foil roll** | Active bag at station | Same, role FOIL |
| **Mount PVC / Foil roll** | No active bag OR first mount of shift | `mountRollAction` |
| **Remove roll** | Roll swap with partial material left | `unmountRollAction` with ending weight |

**Pause behavior:**

- **Remove** `pvc_swap` / `foil_swap` from the default pause dropdown **or** replace them with “Go to roll change” that opens the roll panel instead of pausing.
- Optional: auto-pause bag when roll-change panel opens; auto-resume on successful submit (policy decision — see UX section).

**After successful roll change:**

- Show confirmation with old roll # → new roll # and segment count recorded.
- Bag remains in prior pause state unless auto-resume is chosen.

### 4.3 Event audit trail (no new schema needed)

A complete mid-bag PVC swap already produces (via existing `changeRollAction`):

1. `ROLL_COUNTER_SEGMENT_RECORDED` × 2 (PVC + FOIL roles, `segment_reason: ROLL_CHANGE`)
2. `ROLL_DEPLETED` (old roll)
3. `ROLL_MOUNTED` (new roll, `mounted_via: ROLL_CHANGE`)
4. `audit_log` entries from roll actions

Optional slice-1 addition: emit `BAG_PAUSED` / `BAG_RESUMED` or a lightweight `workflow_events` note linking `segment_group_id` — **only if** supervisors need pause timeline correlation. Not required for reconciliation.

---

## 5. Data model options

### Option A — Event-only roll change payload on `workflow_events` (no schema)

Extend pause or add `ROLL_CHANGE_REQUESTED` workflow event with `{ role, old_lot_id?, new_lot_id?, counter_segment }`.

| | |
|---|---|
| **Pros** | Visible in bag timeline; no migration |
| **Cons** | Duplicates `material_inventory_events`; two sources of truth unless workflow event is just a pointer |
| **Risk** | Drift if workflow event written but roll action fails |
| **Reconciliation** | Weak alone — still need material ledger |
| **Migration** | No |
| **Near-term safe?** | Only as a **link/pointer** to existing material events, not as primary ledger |

### Option B — Active machine material assignment table

New table: `(machine_id, role, packaging_lot_id, mounted_at, …)`.

| | |
|---|---|
| **Pros** | Fast query; explicit “what’s on the machine now” |
| **Cons** | Redundant with latest-event-per-lot pattern already in `active-rolls.ts` and roll actions; must stay in sync |
| **Risk** | Dual-write bugs if projector/action miss an update |
| **Reconciliation** | Good if kept authoritative — but existing event ledger already supports this |
| **Migration** | Yes |
| **Near-term safe?** | **No** — unnecessary for slice 1 given existing infrastructure |

### Option C — Full material roll session table

Sessions: `(machine_id, packaging_lot_id, role, started_at, ended_at, starting_weight, ending_weight, workflow_bag_id?, …)`.

| | |
|---|---|
| **Pros** | Clean time windows for reconciliation; supports partial sessions |
| **Cons** | Largest build; overlaps mount/unmount/deplete events |
| **Risk** | Migration + backfill; session boundaries must match event semantics |
| **Reconciliation** | Best long-term reporting ergonomics |
| **Migration** | Yes |
| **Near-term safe?** | **Defer** — existing events + `read_roll_usage` already encode sessions implicitly |

### Recommendation

**Use existing `material_inventory_events` as source of truth (current design).** Slice 1 = UX wiring only. Revisit Option C in **MATERIAL-ROLL-ADMIN-1** if admin reporting queries become painful.

---

## 6. Recommended implementation slices

### MATERIAL-ROLL-CHANGE-1 — UI / action / event skeleton

**Goal:** Operator can change PVC/Foil roll from main station without discovering supervisor tools.

**Scope:**

- Add **Change PVC roll** / **Change Foil roll** entry points on main station page (BLISTER/COMBINED only).
- Inline panel reusing fields from `ChangeRollForm` (role, counter segment, new lot select/scan).
- Wire to existing `changeRollAction`.
- Show **active rolls** summary on main station (read-only, from `getActiveRollsForMachine`).
- Deprecate or redirect `pvc_swap` / `foil_swap` pause reasons to roll-change flow.
- Tests: page gating, form wiring, no new server logic unit tests unless extracting shared schema.

**Out of scope:** schema, consumption math, BLISTER_COMPLETE gating.

### MATERIAL-ROLL-CHANGE-2 — Between-bag mount/unmount UX

**Goal:** Clear path when no active bag (shift start, end-of-roll between bags).

**Scope:**

- Inline **Mount roll** / **Remove roll** on main station when no active bag or via explicit mode toggle.
- Document when to use unmount (partial roll) vs change (depleted mid-bag).
- Optional: scan roll barcode instead of dropdown only.

### MATERIAL-ROLL-CONSUMPTION-1 — Connect roll usage to blister counter (later)

**Goal:** Weight reconciliation, alerts, learned standards refinement.

**Scope:**

- Admin/floor visibility of segment totals vs weigh-back variance.
- Optional policy: warn on BLISTER_COMPLETE if no active roll (not hard block).
- Product-less blister bags: segment ledger works; g/blister learning may lack product dimension until sealing maps product.

**Hard stop:** do not change consumption math in this track without explicit approval.

### MATERIAL-ROLL-ADMIN-1 — Admin correction / history (later)

**Goal:** Supervisors review roll changes, fix mis-mounts, see machine timeline.

**Scope:**

- Admin page: machine → active rolls → event history from `material_inventory_events`.
- Correction flow: supervised unmount/remount with audit reason.
- Possibly Option C session table if query complexity warrants it.

---

## 7. Specific UX recommendation

### Button labels (main station, BLISTER/COMBINED)

| Label | Visible when |
|---|---|
| **Change PVC roll** | Active bag + active PVC roll mounted |
| **Change Foil roll** | Active bag + active Foil roll mounted |
| **Mount roll** | Missing role OR no active bag |
| **Remove roll** | Active roll mounted (partial removal) |

Keep **Pause bag** for: Shift ending, Machine jam, QA check, Other.

### Required fields — mid-bag change (matches existing `ChangeRollForm`)

| Field | Required |
|---|---|
| Role (PVC / Foil) | Yes — pre-filled from button |
| Counter when roll stopped | Yes — same semantics as BLISTER machine counter |
| New roll lot | Yes — dropdown and/or roll # scan |
| Notes | Optional |

### Optional fields

| Field | When |
|---|---|
| Starting weight of new roll | If receive weight unknown |
| Operator override code | Existing accountability pattern |

### Scan vs select

- **Slice 1:** dropdown of AVAILABLE roll lots (existing pattern).
- **Slice 2:** add roll # text field / barcode scan (server already supports `newRollNumber` in `changeSchema`).

### Pause vs roll change

| Concern | Recommendation |
|---|---|
| **Separate concerns** | Yes — roll change is not a pause reason |
| **Auto-pause on roll change open** | **Yes** — physical swap requires hands off the line; matches operator expectation from TabletTracker-era “pause for swap” |
| **Auto-resume on success** | **Yes** — if pause was auto-triggered for swap; manual pause (jam) unaffected |
| **Remove pvc_swap / foil_swap from pause list** | **Yes** — replace with dedicated roll buttons |

### What operator sees after change

```
PVC roll changed
Old: R-2024-0412 (depleted · 15,238 blisters this roll)
New: R-2024-0517 mounted
Segment 15,238 recorded on Bag Card 199
[Resume bag]  (if auto-paused)
```

### Active roll banner (main station)

```
Machine rolls: PVC R-2024-0517 · Foil R-2024-0099
[Change PVC] [Change Foil]
```

If missing: honest empty state — **“No PVC roll mounted — mount before close-out for consumption tracking.”** (warning, not block).

---

## 8. Risks / blind spots

| Risk | Detail | Mitigation |
|---|---|---|
| **Wrong lot consumption** | Segment goes to whatever roll is “active” on machine at BLISTER_COMPLETE / change | Active-roll banner; mount validation (one role per machine) |
| **Roll change during active bag without counter** | Operator swaps physically but skips form | Auto-pause + require counter on change; supervisor audit |
| **`changeRollAction` always DEPLETES old roll** | Preemptive swap with partial roll left is wrong path | UX: “Removing partial roll?” → unmount flow; document in operator training |
| **Bag-scoped vs station-scoped time** | Rolls are **machine-scoped**; bag pause is **bag-scoped** | Segments carry `workflow_bag_id`; mount can omit bag between bags |
| **Machine shared across stations** | Unlikely today but schema binds rolls to `machine_id` | If multi-station-per-machine ever happens, active-roll query must filter by station |
| **Partial roll usage** | Unmount with weight vs change-with-deplete | Two distinct UX paths |
| **Rework / re-run cards** | Segments tied to `workflow_bag_id` | Rework bags get their own segment allocation; verify card re-scan behavior in slice 1 tests |
| **No product at BLISTER** (product-at-sealing) | Segment emission **does not require product**; g/blister learning may lag | Document: roll yield is machine/tablet-level until product mapped at sealing |
| **PVC/Foil usage without final product** | Counter segments are **blister presses**, not SKU-specific | Reconciliation uses roll yield + optional standards; product linkage comes later |
| **Silent skip on BLISTER_COMPLETE** | No roll → no segment, event still succeeds | Warning banner; future optional hard gate (policy) |
| **Operator discovers Rolls page inconsistently** | Supervisor tools collapsed | Main-station integration in slice 1 |
| **Double-pause corruption** | Second `BAG_PAUSED` breaks projector | Roll-change auto-pause must check `isPaused` first |

---

## 9. Exact files likely to change in next slice (MATERIAL-ROLL-CHANGE-1)

| File | Change |
|---|---|
| `app/(floor)/floor/[token]/page.tsx` | Active roll banner; fetch `getActiveRollsForMachine` |
| `app/(floor)/floor/[token]/roll-change-panel.tsx` (new) | Inline change form extracted from rolls-forms pattern |
| `app/(floor)/floor/[token]/rolls-forms.tsx` | Optional: extract shared field components |
| `lib/production/station-pause-reasons.ts` | Remove pvc_swap/foil_swap from pause matrix |
| `lib/production/station-pause-reasons.test.ts` | Update matrix expectations |
| `app/(floor)/floor/[token]/actions.ts` | Possibly shared pause helper for auto-pause/resume around roll change |
| `app/(floor)/floor/[token]/page.test.ts` | Gating + banner tests |
| `package.json` / `CHANGELOG.md` | Version bump |

**Explicitly NOT in slice 1 (hard stops):**

- `scan-card-form.tsx`
- `stage-progression.ts`
- `stage-action-buttons.tsx` (unless Sahil approves — pause reason removal may alternatively live in `station-pause-reasons.ts` only, with stage-action-buttons consuming the slimmer matrix automatically)
- `lib/db/schema.ts` / migrations
- `lib/projector/material-consumption-hook.ts`
- `lib/projector/roll-usage.ts` math

---

## 10. Hard stops honored (this audit)

| Stop | Status |
|---|---|
| No changes to `scan-card-form.tsx` | Honored |
| No changes to `stage-progression.ts` | Honored |
| No schema/migrations | Honored |
| No material consumption math changes | Honored |
| No product-at-sealing behavior changes | Honored |
| No packaging auto-finalize changes | Honored |
| No sealing counter flow changes | Honored |
| No floor actions submitted / no live DB mutation | Honored |
| No git push | Honored |

---

## 11. Validation run

Executed on audit base `1660297` / v0.4.34:

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | Pass — 126 files, 2832 tests |
| `npm run build` | Pass |

---

## 12. Decision requested before implementation

1. **Auto-pause + auto-resume** on roll change — approve?
2. **Remove pvc_swap / foil_swap from pause dropdown** entirely — approve?
3. **BLISTER_COMPLETE warning** (not block) when no active roll — include in slice 1 or defer?
4. **Implement inline on main page** vs **promote Rolls link** to primary nav — preference?

Once approved, proceed with **MATERIAL-ROLL-CHANGE-1** only.
