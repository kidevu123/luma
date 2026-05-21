# QC subsystem — live damage / rework / scrap / supervisor-correction

> **Phase:** QC-0 (plan only).
> **Status:** drafted 2026-05-12. No code shipped. No migrations created.
> **Predecessors complete:** OP-1 (accountability), PT-6 (8-bucket reconciliation), H.x7 (material panels).
> **Companion doc:** `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md` (count-confidence ladder + sealing/packaging form changes). This plan is the *implementation contract* on top of that companion's vocabulary.

This document is the contract for QC-1 through QC-6. Anything QC-1+ does that diverges from this file is wrong; if reality forces a divergence, edit this file in the same commit.

---

## 1. Why this exists now

Today the floor can record a damaged card by typing a number into the `damagedPackaging` field on the packaging-complete form (`app/(floor)/floor/[token]/actions.ts:735`). That number lands in the `PACKAGING_COMPLETE` payload and **nowhere else**. It does not emit `PACKAGING_DAMAGE_RETURN`, does not emit `SCRAP_RECORDED`, does not move material inventory, does not show up in operator productivity, and cannot be traced back to the operator who entered it (no `accountable_employee_id`).

Five event types are reserved in `workflowEventTypeEnum` but have **no live emission path**:

- `PACKAGING_DAMAGE_RETURN`
- `REWORK_SENT`
- `REWORK_RECEIVED`
- `SCRAP_RECORDED`
- `SUBMISSION_CORRECTED`

OP-1 has built the accountability rails (`projectEvent` accepts `enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`; admin actions resolve via `resolveAdminAccountability`; floor actions via `resolveStationAccountability`). PT-6 has built the 8-bucket reconciliation read model (`read_material_reconciliation_v2`). H.x7 has built the read-only material panels. QC is the wiring that turns these rails into a live workflow.

The QC subsystem is a **cutover blocker**: real production cannot ship behind a model that silently collapses damage / rework / scrap into one flat `known_loss`.

---

## 2. Hard constraints (do not relax)

These are the rules every QC phase must respect:

1. **OP-1 accountability is mandatory on every QC event.** No anonymous QC events. `employeeId` + `userId` + `accountability_source` + `accountable_employee_name_snapshot` must be present (or the action refuses).
2. **Append-only events.** No QC action overwrites an existing event. Corrections emit `SUBMISSION_CORRECTED` linking to the prior event ID — the original event stays untouched in `workflow_events`.
3. **Damage is not automatically scrap.** A `PACKAGING_DAMAGE_RETURN` is a return for inspection. Becoming scrap requires an explicit `SCRAP_RECORDED` event.
4. **Rework sent is not automatically rework received.** Each direction is its own event with its own accountable employee. The receiving station's operator owns `REWORK_RECEIVED`.
5. **Variance subtypes never collapse.** The PT-6 four-bucket variance model (`RECEIPT_VARIANCE`, `CYCLE_COUNT_VARIANCE`, `CONSUMPTION_VARIANCE`, `UNKNOWN_VARIANCE`) stays intact. QC events feed `scrappedOrDamaged` and `consumptionVariance` — never `receiptVariance` or `cycleCountVariance`.
6. **No event renames.** The five enum values above are stable. Existing `MATERIAL_CONSUMED_ACTUAL` / `MATERIAL_CONSUMED_ESTIMATED` lifecycle is untouched.
7. **No new bag identities for rework.** Rework flows through the same `workflow_bag_id`. A bag's `stage` may regress (`PACKAGED → SEALED`) on rework — the projector gets one explicit branch for this, separate from the forward-only `EVENT_STAGE_PREREQ` rule.
8. **No emoji. No mock data. No silent fabrication.** Missing config is labeled explicitly; confidence is banded (`HIGH`/`MEDIUM`/`LOW`/`MISSING`).

---

## 3. The five events — full contract

### 3.1 `PACKAGING_DAMAGE_RETURN`

| Field | Value |
|---|---|
| Business purpose | A packaging-station operator pulls one or more units off the line because the *packaging* is wrong (damaged card, bad print, label crooked, foil torn). The bag returns to inspection; whether those units become scrap or rework is decided later by a supervisor. |
| Who can submit | Operators at any active packaging station, supervisors, admins. |
| Where submitted | Floor — *QC quick action* button on packaging station overlay. Admin — *Supervisor QC review* page (rare; intended for retroactive entry from notes). |
| Required payload | `workflow_bag_id` (route param), `station_id`, `quantity` (int ≥ 1), `unit` (`cards` \| `displays` \| `units`), `reason_code` (enum, see §3.6), `affects_packaging_material: true`, `affects_raw_product: boolean`. |
| Optional payload | `machine_id`, `notes` (text), `photo_keys` (array of upload IDs; QC-3+), `material_item_id` + `material_lot_id` when the operator can name the specific lot. |
| Validation | `quantity` ≥ 1, `reason_code` ∈ enum, route must be in a packageable stage (`SEALED` or `PACKAGED`), accountability fields must be present, idempotency `client_event_id` required from floor. |
| Accountable employee | Resolved via `resolveStationAccountability({ stationId })` — the active station operator session. Override path supported (supervisor-on-behalf), recorded as `SUPERVISOR_OVERRIDE`. |
| Entered-by user | The logged-in user from the floor JWT (always present on the floor PWA). `null` only on legacy synthesizer rows. |
| Material impact | None at emit time. A return is *not* loss yet. Only when a downstream `SCRAP_RECORDED` is emitted against this same return (linked via `linked_event_id`) does inventory move. |
| Batch/genealogy impact | One row on the bag's genealogy timeline. Affected quantity displayed; status `RETURNED`. |
| Operator metrics impact | Counts toward the packaging operator's *damage events* column (count, not unit quantity — one entry = one event). Does not penalize *good output*. |
| Reconciliation impact | None at emit time. (When converted to scrap below, the scrap event drives reconciliation.) |
| Nexus/QIP future hook | Carries the bag's product/route/raw-lot lineage through `workflow_bag_id`; a customer claim against a finished lot can later be traced back to this return through the bag genealogy chain. |

### 3.2 `REWORK_SENT`

| Field | Value |
|---|---|
| Business purpose | A packaging-station operator sends a subset of a bag back to sealing (typical: bad seal discovered post-blister). Units are *work-in-progress*, **not scrap**. The bag's stage regresses to `SEALED`. |
| Who can submit | Operators at the originating station (typically packaging), supervisors, admins. |
| Where submitted | Floor — *QC quick action → Send to rework*. Admin — *Supervisor QC review*. |
| Required payload | `workflow_bag_id`, `from_station_id`, `to_stage` (one of `SEALED` \| `BLISTERED` — pulldown), `quantity`, `unit`, `reason_code`, `linked_event_id` (FK to the originating `PACKAGING_DAMAGE_RETURN` if any; nullable for direct rework). |
| Optional payload | `machine_id`, `notes`, `photo_keys`, `target_station_id` (hint only — receiving station may differ). |
| Validation | `quantity` ≥ 1, `to_stage` ∈ allowed regression, bag must currently be in a forward-of-`to_stage` stage, accountability required, idempotency required. |
| Accountable employee | Originating-station operator (`resolveStationAccountability(fromStationId)`). |
| Entered-by user | Logged-in floor user. |
| Material impact | **None.** Rework is WIP — packaging material is held against the bag; raw product is held against the bag. No consumption write-back. The 8-bucket `consumedActual` is not yet incremented. |
| Batch/genealogy impact | Bag stage regresses (`PACKAGED → SEALED` typical). New `rework_pending` flag on `read_bag_state`. Genealogy timeline shows the regression. |
| Operator metrics impact | Counts toward originating operator's *rework sent* column. Cycle time math subtracts rework round-trip time so the operator is not penalized. |
| Reconciliation impact | The bag's contribution to `consumedActual` is *deferred* until either (a) the bag re-finalizes through packaging and emits its normal consumption, or (b) it's explicitly scrapped. Variance does not move. |
| Nexus/QIP future hook | Rework pattern (frequency, station-pair) is the highest-signal predictor of future complaint clusters — captured for the future quality model. |

### 3.3 `REWORK_RECEIVED`

| Field | Value |
|---|---|
| Business purpose | The receiving station (typically sealing) accepts the rework batch. Marks the start of the rework work. Cycle-time math uses this as the regression start. |
| Who can submit | Operators at the receiving station, supervisors, admins. |
| Where submitted | Floor — *Rework queue at receiving station* (a new surface; not the QC quick action — it's a normal stage action). Admin — *Supervisor QC review*. |
| Required payload | `workflow_bag_id`, `station_id` (receiving), `linked_event_id` (FK to the originating `REWORK_SENT`), `quantity` (must equal the linked send's quantity unless `partial=true`), `unit`. |
| Optional payload | `machine_id`, `notes`, `partial: boolean`. |
| Validation | A matching unreceived `REWORK_SENT` must exist for this bag with the same `to_stage`, accountability required, idempotency required. |
| Accountable employee | Receiving-station operator (`resolveStationAccountability(receivingStationId)`). **Distinct** from the originating operator on `REWORK_SENT`. |
| Entered-by user | Logged-in floor user. |
| Material impact | None. WIP continues. |
| Batch/genealogy impact | Bag's `rework_pending` flag flips to `rework_in_progress`. Genealogy shows the receive. |
| Operator metrics impact | Counts toward receiving operator's *rework received* column. |
| Reconciliation impact | None. |
| Nexus/QIP future hook | Pair (sent operator, received operator, station-pair, reason_code) feeds the future quality model. |

### 3.4 `SCRAP_RECORDED`

| Field | Value |
|---|---|
| Business purpose | Confirmed final loss. Units leave the system permanently — they cannot become finished output. Drives the `scrappedOrDamaged` bucket of PT-6 reconciliation and decrements inventory. |
| Who can submit | Supervisors and admins. **Operators cannot submit scrap directly** — they raise `PACKAGING_DAMAGE_RETURN` or `REWORK_SENT`; supervisor decides if/when those become scrap. |
| Where submitted | *Supervisor QC review* page (admin route). The convert-to-scrap action on a `PACKAGING_DAMAGE_RETURN` row is the most common entry; an ad-hoc scrap form exists for raw-product loss not tied to a packaging return. |
| Required payload | `workflow_bag_id`, `quantity`, `unit`, `reason_code`, `affects_raw_product: boolean`, `affects_packaging_material: boolean`, `linked_event_id` (nullable — points to the `PACKAGING_DAMAGE_RETURN` it resolves, if any). |
| Optional payload | `material_item_id` + `material_lot_id` (required when `affects_packaging_material=true` so material inventory can move precisely), `notes`, `photo_keys`. |
| Validation | `quantity` ≥ 1, at least one of `affects_raw_product` / `affects_packaging_material` must be true, accountability must resolve to a `SUPERVISOR_OVERRIDE` / `LOGGED_IN_USER` (admin role) source, idempotency required. |
| Accountable employee | The originating operator (carried forward from the linked `PACKAGING_DAMAGE_RETURN` when present) — *not* the supervisor. The supervisor is `entered_by_user_id`. When there is no linked return (ad-hoc scrap), the supervisor picks the accountable operator explicitly via the employee picker. |
| Entered-by user | The logged-in admin/supervisor. Always non-null. |
| Material impact | **Yes.** When `affects_packaging_material=true`, emits a paired `MATERIAL_SCRAPPED` event against the named `material_lot_id` so `read_material_lot_state` decrements honestly. When `affects_raw_product=true`, decrements the bag's raw-tablet consumption ledger (PT-6 `scrappedOrDamaged` bucket increments). |
| Batch/genealogy impact | Genealogy entry tagged "Scrap". Affected quantity, accountable employee, supervisor, reason all visible. |
| Operator metrics impact | Counts toward originating operator's *scrap* column (the accountable employee, not the supervisor). |
| Reconciliation impact | Increments PT-6 `scrappedOrDamagedValue` bucket (with `MEDIUM`/`HIGH` confidence depending on whether material_lot_id was named). **Never** moves `receiptVariance` or `cycleCountVariance`. Reduces `consumptionVariance` only if scrap explains a previously unexplained gap. |
| Nexus/QIP future hook | Confirmed scrap is the ground-truth signal that lets a future Nexus/QIP model train against actual defect patterns. |

### 3.5 `SUBMISSION_CORRECTED`

| Field | Value |
|---|---|
| Business purpose | A supervisor amends an incorrect operator submission (typically a count typo on `PACKAGING_COMPLETE` / `SEALING_COMPLETE`, or a misclassified damage entry). The original event stays in `workflow_events`; this event records the correction *and links to it*. |
| Who can submit | Supervisors and admins only. |
| Where submitted | *Supervisor QC review* page → "Correct submission" action on any event row. |
| Required payload | `workflow_bag_id`, `linked_event_id` (FK to the event being corrected — required), `correction_reason` (enum: `TYPO`, `WRONG_BUCKET`, `WRONG_QUANTITY`, `WRONG_DAMAGE_TYPE`, `WRONG_OPERATOR`, `OTHER`), `original_values` (JSON snapshot of what was corrected), `corrected_values` (JSON snapshot of the new state). |
| Optional payload | `notes`, `photo_keys`. |
| Validation | `linked_event_id` must exist and belong to the same bag, `corrected_values` must be schema-valid for the linked event type, accountability must resolve to admin role, idempotency required. |
| Accountable employee | **Original event's accountable employee** — preserved exactly. The supervisor never replaces the operator on the audit chain. (See §4 for the strict rule.) |
| Entered-by user | The supervisor. Always non-null. |
| Material impact | If the original event drove material movement (e.g. `MATERIAL_CONSUMED_ACTUAL`), the correction emits a paired material-adjustment event reversing the original's delta and applying the new one. **No silent overwrite of `material_inventory_events`** — both events live in the log. |
| Batch/genealogy impact | Genealogy renders the original event with a "Corrected" badge linking to the correction event; the correction shows both `original_values` and `corrected_values` side-by-side. |
| Operator metrics impact | Counts toward originating operator's *corrections* column (so persistent typists are visible). Does **not** retroactively change the original event's contribution — the metrics layer reads the *corrected* value through the link, with `data_confidence='MEDIUM'` on any rollup that includes a corrected event. |
| Reconciliation impact | Re-runs PT-6 reconciliation for the bag/scope with the corrected value. The 8-bucket sheet shows the corrected number; the variance attribution may shift; a `warnings[]` entry on `read_material_reconciliation_v2` flags "X submission(s) corrected". |
| Nexus/QIP future hook | Corrections are themselves a data-quality signal; sustained correction rates predict operator/training issues. |

### 3.6 Reason codes (shared payload enum)

A single reason-code vocabulary across all five events. Payload-only (no DB enum — kept flexible for fast iteration):

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
LABEL_ISSUE
OTHER
```

The shared vocabulary lets the supervisor review page surface "all events with `reason_code=BAD_SEAL`" across event types.

---

## 4. Accountability rule (the OP-1 contract)

Every QC event MUST go through `projectEvent` (`lib/projector/index.ts:111`) with these fields populated:

| Field | Source for damage/rework | Source for scrap/correction |
|---|---|---|
| `employeeId` (FK) | `resolveStationAccountability({ stationId })` → active session's `employeeId` | Originating operator's `employeeId` (preserved from linked event) |
| `userId` (FK) | Logged-in floor user from JWT | Logged-in supervisor / admin |
| `payload.accountability_source` | `STATION_OPERATOR_SESSION` (typical), or `SUPERVISOR_OVERRIDE` (override path) | `SUPERVISOR_OVERRIDE` for the entered-by user; original's source preserved for `accountable_employee` |
| `payload.accountable_employee_name_snapshot` | Frozen at event time from `station_operator_sessions.employee_name_snapshot` | Carried from linked event; or resolved from picker on ad-hoc scrap |

**Strict rule for supervisor-submitted scrap / corrections:**

```
On SCRAP_RECORDED with linked_event_id != null:
  workflow_events.employee_id = (SELECT employee_id FROM workflow_events WHERE id = linked_event_id)
  workflow_events.user_id     = currentUser.id
  payload.accountability_source = (SELECT payload->>'accountability_source' FROM linked event)
  payload.accountable_employee_name_snapshot = (SELECT payload->>'accountable_employee_name_snapshot' FROM linked event)
  payload.correction_actor_user_id = currentUser.id
  payload.correction_actor_employee_id = currentUser.employeeId

On SUBMISSION_CORRECTED:
  workflow_events.employee_id = (SELECT employee_id FROM workflow_events WHERE id = linked_event_id)
  workflow_events.user_id     = currentUser.id
  -- name snapshot + source same rule as above
```

This guarantees:

- The audit chain points at the original operator forever.
- The supervisor's identity is captured as the actor, not the accountable.
- Operator metrics roll up correctly — the operator who typed wrong owns the correction count; the supervisor doesn't get false-positive damage credit.

A test in QC-2 enforces this: any `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` with non-null `linked_event_id` whose `employee_id` differs from the linked event's `employee_id` is a hard failure.

---

## 5. Data-honesty rules

Recap, with QC-specific clauses:

1. **Damage ≠ scrap.** `PACKAGING_DAMAGE_RETURN` records observation. `SCRAP_RECORDED` records confirmed loss. Material inventory moves only on (b).
2. **Rework sent ≠ rework received.** Two events, two operators, two cycle-time impacts.
3. **Scrap must name what it affects.** `affects_raw_product` and `affects_packaging_material` flags are required; at least one must be true. Inventory write paths key off these flags.
4. **Correction never overwrites.** `SUBMISSION_CORRECTED` is additive. Both events stay in `workflow_events`; the metric layer reads the corrected value through the link with `data_confidence` banded down to `MEDIUM`.
5. **Variance subtypes never collapse.** QC events feed only `scrappedOrDamaged` (and indirectly `consumptionVariance`). They never feed `receiptVariance` / `cycleCountVariance`. The PT-6 invariant scanner already enforces the wording; QC reuses the same banned-phrase list (no "production loss" on a receipt variance; no "supplier shortage" on a cycle-count variance).
6. **Confidence banding.** Every QC event carries:
   - `count_source` (operator-entered = `OPERATOR_ENTERED`, supervisor-corrected = `SUPERVISOR_CORRECTION`).
   - `count_confidence` (`HIGH` if station has an open operator session; `MEDIUM` for free-text fallback; `LOW` for legacy synthesized rows; `MISSING` is never permitted on a new event — the action refuses).
7. **No emoji, no fake placeholders.** Reason codes are typed enums; UI labels are full words; missing config is labeled "no data" not "—".

---

## 6. Screens (UI surfaces)

### 6.1 Floor QC quick action

**Where:** New collapsible panel on the packaging-station overlay (and a slimmed version on the sealing-station overlay). Slot: below the main stage-completion buttons, above the "Pause" controls.

**Trigger button:** "Report QC issue". Tapping opens a sheet (mobile-friendly; the floor PWA is tablet-first).

**Quick-action options** (each is a separate sub-action, not a free-form form):

- *Damaged packaging* → emits `PACKAGING_DAMAGE_RETURN` with `affects_packaging_material=true`, `affects_raw_product=false`, `reason_code` picker default `DAMAGED_PACKAGING`.
- *Ripped cards* → same as damaged packaging, `reason_code` default `DAMAGED_CARD`.
- *Bad seal* → emits `PACKAGING_DAMAGE_RETURN` with `reason_code=BAD_SEAL`. UI prompts "Send back to sealing?" — if yes, additionally emits `REWORK_SENT` (`to_stage=SEALED`) linked by `linked_event_id`.
- *Label issue* → `PACKAGING_DAMAGE_RETURN` with `reason_code=LABEL_ISSUE`.
- *Count issue* → opens a count-correction form (operator submits revised count; the form emits a new `PACKAGING_COMPLETE` ONLY when bag is still open, else emits nothing and shows "Ask supervisor to correct"). Operator-driven corrections are limited to in-flight bags; finalized-bag corrections go through the supervisor path.
- *Send to rework (no damage row)* → emits a standalone `REWORK_SENT` (rare path; supervisor-discouraged).

**Required entries on every action:** `quantity` (number stepper, 1–999), `notes` (optional textarea), photo capture (optional; QC-3+ uses an existing upload helper, no new backend).

**Accountability:** Pulled silently from the active station operator session. If no session is open, the action shows a station-session opener inline (matches the existing OP-1 pattern). No anonymous QC events ever leave the floor.

### 6.2 Supervisor QC review

**Route:** new `/qc-review` admin page. Sidebar slot: under *Production* group, between *Genealogy* and *Operator productivity*.

**Three sections:**

1. **Pending QC actions** — list of `PACKAGING_DAMAGE_RETURN` events with no downstream `SCRAP_RECORDED` *or* `REWORK_SENT` *and* no resolved-from-rework chain back. Filters: today / this week / station / reason. Each row: bag link, accountable operator, quantity, reason, time, "Convert to scrap" / "Send to rework" / "Mark resolved (no action)" buttons.
2. **Rework in flight** — `REWORK_SENT` events without a paired `REWORK_RECEIVED`. Lets a supervisor see stuck rework that no station has picked up.
3. **Recent QC events** — last 7 days of all five event types, with a *Correct submission* button on each row (opens the correction form).

**Correction form** (modal):
- Pre-fills with the linked event's current `payload`.
- Operator can edit any number/category field.
- `correction_reason` dropdown required.
- `notes` textarea required.
- On submit, emits `SUBMISSION_CORRECTED` (preserving accountability per §4) plus, when relevant, a paired material-adjustment event.

**Scrap form** (modal, ad-hoc):
- Required: `workflow_bag_id` picker, `quantity`, `unit`, `reason_code`, `affects_raw_product` + `affects_packaging_material` toggles, accountable operator picker (employee picker — required, no free-text fallback), `notes`.
- On submit, emits `SCRAP_RECORDED` and (when packaging material is affected) a paired `MATERIAL_SCRAPPED`.

### 6.3 Bag genealogy QC section

**Where:** Extend the existing `/genealogy/[bagId]` timeline.

**Render:** Each QC event is a row in the existing timeline, styled with a `Reject`/`Rework`/`Scrap`/`Correction` chip. Columns:
- Event type
- Time
- Affected quantity + unit
- Reason code
- Accountable employee (name snapshot from payload)
- Submitted by (entered-by user — clearly distinguished from accountable employee when they differ)
- Status (`OPEN`, `CONVERTED_TO_SCRAP`, `REWORK_PENDING`, `REWORK_RESOLVED`, `CORRECTED`)
- Material impact (qty + lot if applicable)

**Correction rendering:** Original event keeps its row but gets a "Corrected" badge; clicking opens a diff view showing original vs corrected payload. The correction event itself is its own row directly below.

### 6.4 Operator productivity QC columns

**Where:** Extend `/operator-productivity`.

**New columns** (drop into the table per operator-day):
- *Damage events* — count of `PACKAGING_DAMAGE_RETURN` with that employee as accountable.
- *Rework sent* — count of `REWORK_SENT`.
- *Rework received* — count of `REWORK_RECEIVED`.
- *Scrap (units)* — sum of `quantity` from `SCRAP_RECORDED` where they were the accountable employee.
- *Corrections* — count of `SUBMISSION_CORRECTED` events whose linked event had that employee as accountable.

**Confidence column:** Each row already carries a `data_confidence` from OP-1F; rows with `count_confidence=LOW` (free-text fallback) any QC event display the band consistently. No "0" is fabricated — operators with no QC events show `—` not `0`, so "zero damage" reads as honest.

### 6.5 Material reconciliation impact

**Where:** Extend `/material-reconciliation` (the PT-6 8-bucket page).

**Behavior:**
- `scrappedOrDamagedValue` bucket already exists from PT-6. QC events feed it; the row's `scrappedOrDamagedSource` is `QC_SCRAP_EVENTS` (new source label).
- `scrappedOrDamagedMissingInputs` flags any `SCRAP_RECORDED` with `affects_packaging_material=true` but null `material_lot_id` — labels it "Lot not named — material loss imprecise".
- A new "Rework pending (WIP)" *informational* row appears between bucket 6 (`ON_HAND`) and bucket 7 (`RECEIPT_VARIANCE`). It is **not** a bucket — it shows `REWORK_SENT - REWORK_RECEIVED - REWORK_RESOLVED` for context but is excluded from the reconciliation arithmetic. Confidence label: "WIP — does not affect variance".
- `warnings[]` array gets a new entry whenever a corrected event participated in a scope's reconciliation: "Includes N corrected submission(s)".

No new reconciliation buckets. PT-6's 8-bucket model is preserved exactly.

---

## 7. Schema changes

**Goal:** the smallest possible schema delta. Reuse existing tables aggressively; lean on `workflow_events.payload` for QC-specific fields.

### 7.1 No new tables required

The model fits cleanly into existing tables:

- `workflow_events` — already accepts arbitrary `payload`. All five events land here.
- `material_inventory_events` — already has `MATERIAL_SCRAPPED`. Scrap on packaging material uses it.
- `read_material_reconciliation_v2` — already has `scrappedOrDamagedValue`. QC feeds it.
- `read_operator_daily` — already has `damageCountTotal`. Extend with three more columns (see below).
- `read_sku_daily` — already has `damages`, `rework`, `scrap` columns hardcoded to 0. Populate from QC events.
- `read_station_quality_daily` — already has `rejectUnits`, `scrapUnits`, `reworkUnits`, `damagedUnits`. Populate from QC events.

### 7.2 Migration `0024_qc_subsystem.sql` (QC-1)

```sql
-- 1. Add three columns to read_operator_daily for QC rollups.
ALTER TABLE read_operator_daily
  ADD COLUMN rework_sent_total integer NOT NULL DEFAULT 0,
  ADD COLUMN rework_received_total integer NOT NULL DEFAULT 0,
  ADD COLUMN scrap_units_total integer NOT NULL DEFAULT 0,
  ADD COLUMN corrections_total integer NOT NULL DEFAULT 0;

-- 2. Add an index for fast "events linked to event X" lookups —
--    used by the correction / scrap-from-damage chain queries.
CREATE INDEX workflow_events_linked_event_idx
  ON workflow_events ((payload->>'linked_event_id'))
  WHERE payload ? 'linked_event_id';

-- 3. Add a partial unique to prevent double-resolving a damage
--    return: one PACKAGING_DAMAGE_RETURN can only have one
--    SCRAP_RECORDED or one REWORK_SENT directly linked.
CREATE UNIQUE INDEX workflow_events_linked_event_resolution_unique
  ON workflow_events ((payload->>'linked_event_id'), event_type)
  WHERE event_type IN ('SCRAP_RECORDED', 'REWORK_SENT')
    AND payload ? 'linked_event_id';

-- 4. Add a new accountability_source value if we adopt
--    SUPERVISOR_CORRECTION as its own label (rather than
--    overloading SUPERVISOR_OVERRIDE). Stored as text in
--    payload — no enum change. (Documented here so the
--    helper update is not forgotten.)
```

**Drizzle-journal note:** the migration timestamp must strictly exceed the last applied `when` (per `memory/drizzle-journal-timestamp-gotcha.md`). No enum changes in this migration → no ALTER TYPE rollback risk (per `memory/drizzle-alter-type-gotcha.md`).

### 7.3 No `workflowEventTypeEnum` change

All five event types are already in the enum (`lib/db/schema.ts:189–248`). This is deliberate — keeps QC-1 a low-risk migration.

If QC-2 implementation discovers we *need* an enum addition (e.g. a separate `REWORK_RESOLVED` value), it ships as its own isolated migration per the ALTER TYPE rule.

---

## 8. Event payload schemas (TypeScript contracts)

To live in a new `lib/production/qc-events.ts` (QC-1). Pure types, no DB writes:

```ts
export type ReasonCode =
  | "MIS_PRESS" | "EMPTY_RUN" | "MISSED_PILLS" | "BAD_SEAL"
  | "DAMAGED_CARD" | "DAMAGED_PILL" | "DAMAGED_PACKAGING"
  | "WRONG_COUNT" | "COUNTER_MISMATCH" | "RETURNED_FROM_PACKAGING"
  | "OPERATOR_ERROR" | "MACHINE_SETUP" | "LABEL_ISSUE" | "OTHER";

export type QcUnit = "cards" | "displays" | "units" | "blisters" | "bottles";

type BaseQcPayload = {
  client_event_id: string;            // floor-supplied UUID
  quantity: number;                   // int >= 1
  unit: QcUnit;
  reason_code: ReasonCode;
  notes?: string;
  photo_keys?: string[];
};

export type PackagingDamageReturnPayload = BaseQcPayload & {
  affects_packaging_material: true;   // tautological — by definition
  affects_raw_product: boolean;
  material_item_id?: string;
  material_lot_id?: string;
};

export type ReworkSentPayload = BaseQcPayload & {
  from_station_id: string;
  to_stage: "BLISTERED" | "SEALED";
  linked_event_id?: string;
  target_station_id?: string;
};

export type ReworkReceivedPayload = BaseQcPayload & {
  linked_event_id: string;            // required — pairs with a REWORK_SENT
  partial?: boolean;
};

export type ScrapRecordedPayload = BaseQcPayload & {
  affects_raw_product: boolean;
  affects_packaging_material: boolean;
  linked_event_id?: string;
  material_item_id?: string;
  material_lot_id?: string;
  correction_actor_user_id: string;   // who entered (supervisor)
  correction_actor_employee_id?: string;
};

export type SubmissionCorrectedPayload = {
  client_event_id: string;
  linked_event_id: string;
  correction_reason:
    | "TYPO" | "WRONG_BUCKET" | "WRONG_QUANTITY"
    | "WRONG_DAMAGE_TYPE" | "WRONG_OPERATOR" | "OTHER";
  original_values: Record<string, unknown>;
  corrected_values: Record<string, unknown>;
  notes?: string;
  photo_keys?: string[];
  correction_actor_user_id: string;
  correction_actor_employee_id?: string;
};
```

Zod schemas live alongside (`qcEventPayloadSchemas`) and are the only path actions use to validate.

---

## 9. Read models / metrics affected

| Read model | Change | Source events |
|---|---|---|
| `read_operator_daily` | Add `rework_sent_total`, `rework_received_total`, `scrap_units_total`, `corrections_total`. Increment in `operator-daily-attribution` projector. | All five QC events. |
| `read_sku_daily` | Populate existing `damages`, `rework`, `scrap` columns from QC events (today they are hardcoded 0). | `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `SCRAP_RECORDED`. |
| `read_station_quality_daily` | Populate existing `rejectUnits`, `scrapUnits`, `reworkUnits`, `damagedUnits` columns. | All five QC events. |
| `read_material_reconciliation_v2` | `scrappedOrDamagedValue` += scrap value; `scrappedOrDamagedSource` = `'QC_SCRAP_EVENTS'`; `warnings[]` += corrections seen. | `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`. |
| `read_material_lot_state` | Decrement `qty_on_hand` for the named lot when `SCRAP_RECORDED.affects_packaging_material=true` and `material_lot_id` is present. Confidence drops to MEDIUM. | `SCRAP_RECORDED`. |
| `read_bag_state` | Add `rework_pending: boolean`, `rework_received: boolean` flags. | `REWORK_SENT`, `REWORK_RECEIVED`. |
| `metrics.ts` derive helpers | Update `deriveDamagePerBag`, `deriveReworkRate`, `deriveCorrectionRate` to read real events (today they return MISSING). | All five. |

No new read models required.

---

## 10. Future Nexus / QIP hook

Nexus/QIP is the (future) customer-facing quality complaint surface. The QC subsystem's job is to leave a complete trace from a customer complaint about a finished lot back through every QC event that touched the bags in that lot.

**What this plan reserves but does not implement:**

1. **`finished_lots` already carries the bag chain.** When a finished lot is released, its component `workflow_bag_id`s are linked in genealogy. QC events on those bags are reachable by `workflow_bag_id` filter on `workflow_events`.
2. **Reason-code vocabulary is stable across Luma and future Nexus.** The 14 codes in §3.6 are the same codes a customer-facing complaint form would map to (with a smaller user-visible subset). Sharing the vocabulary means Luma can correlate complaint patterns to QC patterns without a lookup table.
3. **`accountable_employee_name_snapshot` survives forever in payload.** This is what Nexus would render to a quality engineer: "Bad seal on Lot 4291 was returned by Maria L. at packaging station P2 on 2026-04-12, converted to scrap by supervisor John S. on 2026-04-13."
4. **No new tables in QC for Nexus.** When Nexus lands, it adds its own `nexus_complaints` table that references `finished_lots.id` and joins through to the bag's `workflow_events` for trace. The QC subsystem does not pre-build that table — premature scaffolding violates the "no features the spec doesn't ask for" rule.

**Explicit out of scope for QC-0..QC-6:**
- Customer-facing complaint intake.
- Push to / from any external QIP system.
- Probabilistic defect-prediction model.

These are future-Nexus territory. The QC subsystem only guarantees the trace is **possible** when the day comes.

---

## 11. Phase split (the recommended order)

| Phase | Scope | Files (estimate) | Days |
|---|---|---|---|
| **QC-0** | Plan only — this document. | 1 doc | 0.5 |
| **QC-1** | Schema migration `0024`. `lib/production/qc-events.ts` payload contracts + Zod. Pure helper `lib/production/qc-mutations.ts` (build event input objects; emit-side helper does not exist yet). Unit tests for payload validation + accountability preservation rules (§4). | 3 new files, 1 migration, ~20 tests | 1 |
| **QC-2** | Server actions: `reportPackagingDamageAction`, `reworkSentAction`, `reworkReceivedAction`, `scrapRecordedAction`, `submissionCorrectedAction`. Each writes to `workflow_events` through `projectEvent` with full OP-1 accountability. Material-side write paths (`MATERIAL_SCRAPPED`) wired. Tests: per-action happy path, accountability preservation, idempotency, refusal on missing accountability. | 5 new actions, ~30 tests | 2 |
| **QC-3** | Floor UI — *Report QC issue* quick-action panel on packaging + sealing station overlays. Rework queue on receiving stations. Photo capture path reuses the existing upload helper (no new backend). Tests: action wiring, station-session-required guard. | 4–6 new UI components, ~10 tests | 2 |
| **QC-4** | Admin UI — `/qc-review` page with pending damage, rework-in-flight, recent events. Correction modal. Ad-hoc scrap modal. Tests: form validation, supervisor-only access, accountability preservation through correction. | 1 new route + actions + 3 modals, ~15 tests | 2 |
| **QC-5** | Read-model projectors — extend `operator-daily-attribution`, populate `read_sku_daily` QC columns, populate `read_station_quality_daily`, hook `read_material_reconciliation_v2` for scrap, hook `read_material_lot_state` for material decrement, add `rework_pending` / `rework_received` to `read_bag_state`. Genealogy page extensions. Operator productivity column extensions. PT-6 page "Rework pending (WIP)" informational row. Tests: rollup correctness, confidence-banding, correction-aware reads. Replay test: rebuild from raw events reproduces the same read-model state. | 6–8 projector edits, 3 page edits, ~25 tests | 2 |
| **QC-6** | Staging verification — fresh DB load, manual TEST D-QC packet exercise, auth smoke pass on all new routes, full Vitest pass, full `next build`, push, deploy, curl-verify, update `docs/CURRENT_PHASE_STATUS.md` + queue checkbox. | 0 new files (test packet edits only) | 0.5 |

**Total estimate:** 10 working days for a focused implementer. Not attempted as a quick fix.

**Phase QC-1 readiness:** ✅ Yes — the predecessors (OP-1, PT-6, H.x7) are complete, the enum is already in place, the read models exist, and this plan defines the schema delta + payload contracts QC-1 needs.

---

## 12. Tests required (acceptance bar)

| # | Layer | Behavior |
|---|---|---|
| 1 | helpers | Each of the five payload Zod schemas accepts a valid example and rejects each required-field omission. |
| 2 | helpers | `accountable_employee_id` preservation rule (§4): correction/scrap on a linked event with `employee_id=X` cannot land with `employee_id != X`. |
| 3 | helpers | `quantity ≥ 1` enforced on every payload. |
| 4 | helpers | `affects_raw_product || affects_packaging_material` enforced on SCRAP_RECORDED. |
| 5 | action | `reportPackagingDamageAction` from an open station session emits one `PACKAGING_DAMAGE_RETURN` with `employee_id` = session employee, `user_id` = logged-in user, `accountability_source = STATION_OPERATOR_SESSION`. |
| 6 | action | Same action with a `SUPERVISOR_OVERRIDE` employee picker pins `accountability_source = SUPERVISOR_OVERRIDE`. |
| 7 | action | Idempotency: same `client_event_id` retried is a no-op (one row in `workflow_events`). |
| 8 | action | `reworkSentAction` regresses bag stage `PACKAGED → SEALED` and sets `read_bag_state.rework_pending=true`. |
| 9 | action | `reworkReceivedAction` requires a matching unreceived `REWORK_SENT`; refusal otherwise. |
| 10 | action | `scrapRecordedAction` from an operator role is refused (admin/supervisor only). |
| 11 | action | `scrapRecordedAction` with `linked_event_id` preserves the linked event's `employee_id`. |
| 12 | action | `scrapRecordedAction` with `affects_packaging_material=true && material_lot_id=null` is accepted but flags `MEDIUM` confidence and warns "Lot not named". |
| 13 | action | `scrapRecordedAction` with `material_lot_id` emits a paired `MATERIAL_SCRAPPED` against that lot and decrements `read_material_lot_state.qty_on_hand`. |
| 14 | action | `submissionCorrectedAction` cannot change `employee_id` of the linked event. |
| 15 | action | `submissionCorrectedAction` with `correction_reason='WRONG_QUANTITY'` re-runs PT-6 reconciliation; the 8-bucket sheet shows the new value and `warnings` includes "1 submission corrected". |
| 16 | projector | `read_sku_daily.damages` / `rework` / `scrap` populate from real events (previously hardcoded 0). |
| 17 | projector | `read_operator_daily.damage_count_total` / `rework_sent_total` etc. increment correctly per accountable employee. |
| 18 | projector | Replay: rebuild read models from raw events produces the same state as live projection. |
| 19 | metrics | `deriveDamagePerBag`, `deriveReworkRate`, `deriveCorrectionRate` return real values (not MISSING) when QC events exist. |
| 20 | metrics | Confidence drops to MEDIUM on any rollup that includes a `SUBMISSION_CORRECTED` link. |
| 21 | invariant | Banned-phrase scanner (PT-6F continuation): no QC event uses "production loss" for a damage return, "supplier shortage" for a cycle-count variance, or any of the PT-6-banned phrases. |
| 22 | invariant | Every QC event row in `workflow_events` has both `employee_id` and `user_id` non-null (or `accountability_source IN ('LEGACY_TEXT','MANUAL_TEXT')` with name snapshot set). |
| 23 | auth-smoke | `/qc-review` returns 200 for OWNER/ADMIN, 403 for OPERATOR. |
| 24 | UI | Floor QC quick-action sheet refuses to submit when no station session is open (shows the inline session opener). |
| 25 | UI | Genealogy page renders all five event types with chip styling + accountable-vs-entered-by distinction. |

---

## 13. Risks / open questions

1. **Photo-capture upload path.** QC-3 assumes an existing upload helper. If none exists, QC-3 grows by ~1 day for an `R2`/local-disk upload route. Owner direction: defer photos to QC-3.5 if the helper is missing — text-only notes ship first.
2. **`REWORK_RESOLVED` event.** The companion plan (`QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md`) introduces a `REWORK_RESOLVED` event for completing rework at the receiving station before sending forward again. The current enum does **not** include it. **Decision (this plan):** treat the next forward-stage event from the receiving station (e.g. a fresh `SEALING_COMPLETE`) as the implicit "resolved" signal — no new enum value. If later experience proves this insufficient, QC-5.1 can add `REWORK_RESOLVED` as a follow-up isolated-enum migration.
3. **Reason-code vocabulary drift.** The 14 codes are payload-only (no DB enum). Easy to add; harder to remove. The validation enum lives in `qc-events.ts` and is the only source of truth.
4. **Material decrement on raw-product scrap.** Scrap with `affects_raw_product=true` should decrement the bag's raw-tablet consumption ledger. Today `MATERIAL_CONSUMED_ACTUAL` writes against `inventoryBags`, not against an explicit ledger row per bag. QC-5 must decide whether to (a) emit a paired `MATERIAL_CONSUMED_ACTUAL` adjustment, or (b) write directly to `read_material_reconciliation_v2.scrappedOrDamagedValue` without a paired material event. **Recommendation:** (a) — keep event-sourcing pure; reconciliation is downstream.
5. **Partial rework receive.** §3.3 allows `partial=true`. Open: what happens if 50 cards were sent and only 30 are received? Recommendation: emit `REWORK_RECEIVED` with `quantity=30, partial=true`; the unreceived 20 stay on the rework-in-flight list and a supervisor can ad-hoc-scrap them. QC-2 to confirm.
6. **Operator metrics regression on legacy bags.** Bags finalized before QC events were live have no QC rows — the new operator-productivity columns will show `—` for those days, not `0`. Confirm this is acceptable (it is, per the data-honesty rule).
7. **Concurrency on the "linked event resolution unique" index.** Two supervisors converting the same damage return to scrap simultaneously will race; the partial-unique catches it and the second loses with a clean error. QC-4 must surface that race gracefully.
8. **Spec gap (not for QC):** customer-facing complaint intake (Nexus). Documented as out of scope. Do not build.

---

## 14. Definition of done (subsystem-wide)

When QC-6 closes, all of the following must be true:

- All five event types emit through `projectEvent` with full OP-1 accountability — no anonymous QC rows in `workflow_events`.
- Floor operators can report damage, rework, ripped cards, bad seal, label issue, count issue from the packaging-station overlay; sealing operators can receive rework.
- Supervisors can convert damage to scrap, send/receive rework on behalf of an operator, correct any submission, and add ad-hoc scrap — all from `/qc-review`.
- `/genealogy/[bagId]` shows every QC event with accountable employee + entered-by user + status + material impact.
- `/operator-productivity` shows damage / rework sent / rework received / scrap / corrections columns populated from real events.
- `/material-reconciliation` (PT-6 page) shows the `scrappedOrDamagedValue` bucket fed by QC, the "Rework pending (WIP)" informational row, and corrected-submission warnings.
- All tests in §12 pass. `npx tsc --noEmit` clean. `npx next build` clean. Auth-smoke passes on all new routes.
- The cutover go-live checklist's QC line item is signed off.

---

*End of QC-0 plan. Next phase: QC-1 (schema + payload helpers).*
