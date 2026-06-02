# SEALING-PRODUCT-PERSIST-1 — Audit

**Status:** Plan-only audit (no implementation)  
**Date:** 2026-05-27  
**Priority:** P1 traceability correctness  
**Related:** `docs/LAUNCH_CONTROL.md` (P1 #1), `docs/PRODUCT_SELECTION_AND_ROUTE_BINDING_PLAN.md`

---

## 1. Current behavior summary

At **SEALING** and **COMBINED** stations, card/blister bags may arrive with `workflow_bags.product_id = null` (product deferred from blister/hand-pack per `PRODUCT-SELECTION-AT-SEALING-1`).

When unmapped, the floor UI shows a **finished product dropdown**. The operator must pick a SKU before recording the first sealing segment. Server-side validation enforces product on `SEALING_SEGMENT_COMPLETE` when the bag is still unmapped.

**What works today after first segment submit:**

- `workflow_bags.product_id` is updated in the DB.
- A `PRODUCT_MAPPED` event is appended with `source: "SEALING_SELECTION"`.
- Page refresh shows the product via SSR join (`hasProductMapped = true`, green "Making: …" banner).
- Server rejects a **different** `productId` on later sealing actions.

**What is unsafe today before first segment submit:**

- The dropdown selection lives in **React `useState` only**.
- It is **not** written to the server until the operator submits **Record sealing segment** (or COMBINED sealing complete with product).
- **Page refresh clears the selection** while `workflow_bags.product_id` remains null.
- Operator code uses `sessionStorage`; product selection does **not**.

Finished product identity is production lineage. Depending on browser state between selection and segment submit is unacceptable for sealing close-out discipline.

---

## 2. Root cause of refresh-loss

| Factor | Detail |
|--------|--------|
| **Client state** | `selectedSealingProductId` in `StageActionButtons` — `useState("")` with no persistence layer |
| **Duplicate client state** | `SealingSegmentForm` maintains its own `selectedProductId` initialized from `preselectedProductId` prop; also lost on refresh |
| **No draft API** | No server action, cookie, or `sessionStorage` for in-progress product pick |
| **Deferred persist design** | `fireStageEventAction` only writes `workflow_bags.product_id` inside the **segment/complete transaction**, not on dropdown change |
| **SSR truth** | `page.tsx` sets `hasProductMapped` from `workflow_bags.product_id` join — null until segment submit |

Contrast with operator badge code (`stage-action-buttons.tsx` lines 193–214): persisted to `sessionStorage` per station. Product selection was intentionally coupled to segment submit, not to durable save.

---

## 3. Current code path map

```
FloorStationPage (app/(floor)/floor/[token]/page.tsx)
├── Load bag: readStationLive → workflowBags → products (productId join)
├── hasProductMapped = currentProductId != null
├── If unmapped + SEALING/COMBINED: resolveWorkflowBagTabletTypeId
│   └── filterSealingProductsByTabletType → sealingProductOptionsForForm
└── StageActionButtons
    ├── selectedSealingProductId (useState) — inline picker when !hasProductMapped
    ├── sealingProductReady gates "Record sealing segment" button
    ├── SealingSegmentForm
    │   ├── selectedProductId (useState) — duplicate picker inside form
    │   └── submit → fireStageEventAction(SEALING_SEGMENT_COMPLETE, productId?)
    └── SealingFinalConfirmForm (pure SEALING)
        └── submit → fireStageEventAction(SEALING_COMPLETE, lane_close only, NO productId)

fireStageEventAction (app/(floor)/floor/[token]/actions.ts)
├── Guards (lines ~719–738): require product on segment when unmapped;
│   reject product change when already set
├── Transaction (lines ~764–818): if unmapped + productId present:
│   validateSealingProductPick → UPDATE workflow_bags.product_id
│   → projectEvent(PRODUCT_MAPPED, source=SEALING_SELECTION)
├── Then projectEvent(SEALING_SEGMENT_COMPLETE | SEALING_COMPLETE)
└── Pure SEALING final: requires ≥1 prior segment; no productId in FormData

validateSealingProductPick (lib/production/sealing-product.ts)
├── filterSealingProductsByTabletType — narrows CARD/VARIETY by tablet lineage
└── Validates active product + allowed tablet mapping

first-op deferral (lib/production/first-op-product.ts)
├── BLISTER / HANDPACK_BLISTER / COMBINED defer product to sealing
└── BOTTLE_HANDPACK maps at start (PRODUCT_MAPPED FIRST_OPERATION_SELECTION)

projectEvent (lib/projector/index.ts)
├── PRODUCT_MAPPED — NOT in STAGE_FOR_EVENT (does not advance stage)
├── SEALING_SEGMENT_COMPLETE — NOT in STAGE_FOR_EVENT
└── SEALING_COMPLETE → stage SEALED; read_bag_state.product_id COALESCE from workflow_bags
```

### Key file references

| File | Role |
|------|------|
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | `selectedSealingProductId`, inline picker, `SealingSegmentForm`, `SealingFinalConfirmForm` |
| `app/(floor)/floor/[token]/page.tsx` | `hasProductMapped`, sealing product options load |
| `app/(floor)/floor/[token]/actions.ts` | `fireStageEventAction` — persist + guards |
| `lib/production/sealing-product.ts` | Validation, tablet filter, banner copy |
| `lib/production/first-op-product.ts` | Defer-to-sealing station kinds |
| `lib/production/stage-progression.ts` | Stage prereqs for sealing events |
| `lib/projector/index.ts` | Read-model projection rules |
| `lib/db/schema.ts` | `workflow_bags.product_id`, `workflow_events`, `read_bag_state` |

### Tests (existing)

| File | Coverage |
|------|----------|
| `lib/production/sealing-product.test.ts` | Validation + tablet filter |
| `app/(floor)/floor/[token]/actions.test.ts` | Segment requires product; remapping rejected; PRODUCT_MAPPED ordering |
| `app/(floor)/floor/[token]/stage-action-buttons.test.ts` | Picker visibility, FormData productId, gating |
| `app/(floor)/floor/[token]/page.test.ts` | Options load, hasProductMapped wiring |

**Gap:** No test for refresh persistence of **pre-segment** selection (because it is not implemented). Stale comment in `actions.test.ts` (~line 370) claims PRODUCT_MAPPED only on `SEALING_COMPLETE`; code emits on segment **or** final when unmapped.

---

## 4. Current data model map

### Where product can live today

| Location | Canonical? | When set | Survives refresh? |
|----------|------------|----------|-------------------|
| `selectedSealingProductId` (React) | No | Operator dropdown | **No** |
| `selectedProductId` in segment form (React) | No | Operator dropdown in form | **No** |
| FormData `productId` | No | Submit only | N/A |
| **`workflow_bags.product_id`** | **Yes** | First segment/complete with pick | **Yes** |
| `workflow_events` `PRODUCT_MAPPED` payload | Audit log | Same transaction as bag update | **Yes** |
| `SEALING_SEGMENT_COMPLETE` payload | No product fields | Per-machine output | N/A |
| `SEALING_COMPLETE` payload (pure SEALING) | `{ lane_close: true }` only | Lane close | N/A |
| `read_bag_state.product_id` / `product_name` | Denormalized read model | Stage events (`SEALING_COMPLETE` → SEALED) | Yes after lane close |
| `finished_lots.product_id` | Downstream output | Finished-lot issuance (separate flow) | Yes |

### Canonical source of truth

**`workflow_bags.product_id`** is the durable bag-level product identity. The projector comment and COALESCE logic treat the bag row as authoritative; `read_bag_state` may lag until a stage-changing event.

### UI-only / payload-only

- Pre-submit dropdown state (browser only).
- Sealing event payloads do **not** carry `product_id`; segment/complete actions must not be used to infer product independently of the bag row.

---

## 5. Answers to audit questions

### Q1. Where does the selected finished product currently live?

**Before segment submit:** browser `useState` only (`selectedSealingProductId` + form-local `selectedProductId`).

**After segment submit:** `workflow_bags.product_id` + `PRODUCT_MAPPED` event (`source: "SEALING_SELECTION"`).

### Q2. At what point is product persisted today?

| Trigger | Persists? |
|---------|-----------|
| Dropdown change | **No** |
| Explicit save action | **No such action** |
| `SEALING_SEGMENT_COMPLETE` (unmapped bag) | **Yes** — bag row + PRODUCT_MAPPED |
| `SEALING_COMPLETE` on COMBINED (unmapped) | **Yes** — same path |
| `SEALING_COMPLETE` on pure SEALING | **No product in request** — assumes prior segment already mapped |
| Finalization / packaging | Inherits existing bag product; packaging blocked if null |

### Q3. Why does refresh lose the selected product?

Selection is never sent to the server until segment/complete submit. SSR re-renders from `workflow_bags.product_id`, which is still null.

### Q4. What should be the canonical durable product field?

**`workflow_bags.product_id`** (already exists). Audit trail: **`PRODUCT_MAPPED`** with `source: "SEALING_SELECTION"` (initial) and a future **`PRODUCT_REASSIGNED`** or equivalent for supervised changes (enum does not include `PRODUCT_REASSIGNED` today).

### Q5. Persist immediately on selection, or explicit "Save product"?

**Recommendation: explicit server action on selection** (either dedicated **Save product** button or save-on-change with debounce — PM decision below). Do **not** wait until segment submit.

Rationale: matches operator mental model ("I chose the SKU"), survives refresh, decouples lineage commit from production counts, allows read-only lock before counter entry.

### Q6. Once product is saved, what should be locked?

- Floor dropdown → read-only display ("Making: {name}").
- `fireStageEventAction` must ignore/reject conflicting client `productId` (partially implemented today).
- Segment/complete actions re-read `workflow_bags.product_id` server-side; do not require client to resend product once saved.

### Q7. Who can change it?

**Recommendation:**

| Actor | Initial set at sealing | Change after save |
|-------|------------------------|-------------------|
| Floor operator | Yes (once persist action exists) | **No** |
| OWNER/ADMIN | Yes | Yes, via explicit **supervised change flow** later |
| Supervisor floor session | Defer | Future slice |

Aligns with `docs/PRODUCT_SELECTION_AND_ROUTE_BINDING_PLAN.md` ("Product can change midstream only via explicit supervisor correction event").

### Q8. What audit/event for selection or change?

| Event | When |
|-------|------|
| `PRODUCT_MAPPED` | Initial sealing selection (`source: "SEALING_SELECTION"`) — **already used** |
| `PRODUCT_REASSIGNED` (new) | Supervised change after lock — **not in enum today**; defer to change slice or overload PRODUCT_MAPPED with `source: "SEALING_REASSIGNMENT"` + reason payload |

Every persist/change must write `audit_log` per existing mutation patterns.

### Q9. Does selected product affect downstream systems?

| Consumer | Uses product from |
|----------|-------------------|
| Sealing segment recording | Requires product when unmapped; counts only in segment payload |
| Sealing close-out (pure SEALING) | Assumes product already on bag |
| Packaging | `checkPackagingPrereqs` — blocked if `bag.productId` null |
| Finished lots | Separate `finished_lots.product_id` at issuance |
| Workflow submissions | `LEFT JOIN products ON workflow_bags.product_id` |
| Metrics / read models | `read_bag_state` COALESCE from bag row on stage events |
| Zoho production output | Downstream of finished lot; out of scope for this slice |

### Q10. Historical bags with product only in payload?

Normal path updates bag row and event atomically. Edge cases:

- **Legacy bags** started before sealing product picker may have `product_id` null until sealing — expected.
- **`read_bag_state.product_id`** may be null between first segment (bag row set) and `SEALING_COMPLETE` (stage event) — consumers should prefer `workflow_bags.product_id` for post-segment truth.
- No evidence of product living **only** in segment payload (payloads have no product fields).

---

## 6. Proposed persistence model (target)

1. Operator selects finished product at sealing.
2. **New server action** persists immediately (`workflow_bags.product_id` + `PRODUCT_MAPPED`).
3. Refresh/reload shows saved product from DB (read-only banner).
4. Dropdown hidden/disabled after save; no casual re-selection.
5. Supervised change flow deferred (separate slice); floor cannot overwrite.
6. `fireStageEventAction` for segment/complete:
   - If bag already has product → use bag row; reject conflicting client `productId`.
   - If bag unmapped → reject segment (force persist action first).
7. Finished product remains a **sealing-stage** decision (not hand-pack).
8. Tablet filter (`filterSealingProductsByTabletType`) continues to **narrow options only** — never auto-guess SKU.

### Save timing

**On explicit persist action** — not bundled with segment counter submit.

### Lock behavior

UI read-only after successful persist. Server guards already reject remapping at sealing actions; extend to new persist action (idempotent re-save of same product OK).

### Change behavior (future)

OWNER/ADMIN-only `PRODUCT_REASSIGNED` (or documented PRODUCT_MAPPED variant) with reason + audit. Block if packaging complete, finalized, or finished lot issued — PM to confirm exact gates.

### Audit behavior

Reuse `PRODUCT_MAPPED` for initial save; add structured payload fields: `product_id`, `product_name`, `station_kind`, `source`, optional `reason_code` for changes.

---

## 7. Safety rules

| Rule | Implementation note |
|------|---------------------|
| **No silent overwrite** | Server rejects `productId !== bag.productId` when bag already mapped |
| **No client-only trust** | Segment/complete ignore client product when bag row set; require persist action before segment if null |
| **No product guessing** | Only validated picks from allowed products; tablet filter narrows list |
| **No change after downstream events without repair** | Block product change after `PACKAGING_COMPLETE`, `BAG_FINALIZED`, or finished-lot issuance (elevated repair path only) |
| **No migration of truth via segment payload** | Sealing events stay count-only |

---

## 8. Implementation recommendation — SEALING-PRODUCT-PERSIST-1 (narrow)

**Do not implement in this audit slice.** Recommended coding scope:

### New behavior

1. **`saveSealingProductAction`** (name TBD) in `app/(floor)/floor/[token]/actions.ts`:
   - Auth station + bag at station guards (mirror existing floor actions).
   - Assert `workflow_bags.product_id IS NULL` (or idempotent same-id re-save).
   - `validateSealingProductPick` (reuse).
   - Transaction: UPDATE `workflow_bags` → `projectEvent(PRODUCT_MAPPED)` → `writeAuditLog`.
2. **UI** (`stage-action-buttons.tsx`, possibly `page.tsx`):
   - Replace "select then segment" coupling with **Save product** (or auto-save on change — PM pick).
   - After save: read-only product display; hide editable dropdown.
   - Segment form no longer primary place for first product pick (may show read-only confirmation only).
3. **`fireStageEventAction` adjustments:**
   - When bag mapped: never apply client `productId`; optional — stop accepting `productId` in FormData entirely once saved.
   - When bag unmapped: segment returns error directing operator to save product first (stricter than today).
4. **Optional projector improvement (small):** On `PRODUCT_MAPPED`, upsert `read_bag_state.product_id` / `product_name` without waiting for `SEALING_COMPLETE`. Improves admin lists; not strictly required if all readers use bag row.

### Files likely touched

| File | Change |
|------|--------|
| `app/(floor)/floor/[token]/actions.ts` | New save action; tighten segment guards |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Persist UX, remove duplicate pre-segment state |
| `app/(floor)/floor/[token]/page.tsx` | Possibly surface saved product earlier |
| `lib/production/sealing-product.ts` | Helper for idempotent save / banner copy |
| `lib/projector/index.ts` | Optional PRODUCT_MAPPED read-model update |
| `app/(floor)/floor/[token]/actions.test.ts` | Save action, refresh persistence, no overwrite |
| `app/(floor)/floor/[token]/stage-action-buttons.test.ts` | Lock UI, segment without prior save rejected |

### Tests to add

- Save action persists `workflow_bags.product_id` + emits PRODUCT_MAPPED.
- Second save with different product rejected.
- Segment after save succeeds **without** FormData productId (server reads bag row).
- Segment before save rejected with clear error.
- Idempotent re-save same product OK.
- Source-shape guards for new action.

---

## 9. Migration assessment

**No migration required for core persist slice.**

- `workflow_bags.product_id` column exists.
- `PRODUCT_MAPPED` is already in `workflow_event_type` enum.
- `product_allowed_tablets` supports tablet filtering.

**Future migration possibly needed** if PM chooses a distinct `PRODUCT_REASSIGNED` event type for supervised changes (enum ALTER — follow `luma-drizzle-migration` skill, split enum from table DDL).

---

## 10. Backfill / historical assessment

| Scenario | Recommendation |
|----------|----------------|
| Bags in progress with null product at sealing | Normal — operator uses new save flow |
| Bags with product already on row | No backfill; show read-only |
| `read_bag_state.product_id` null but bag row set | Optional projector fix; **read-only** COALESCE query fallback acceptable short-term |
| Legacy unmapped bags at packaging | Already blocked; repair remains PM-gated (separate procedure) |

**No write backfill** in SEALING-PRODUCT-PERSIST-1.

---

## 11. Open PM decisions

1. **Save UX:** Dedicated **"Save product"** button vs **auto-save on dropdown change**?  
   - Recommendation: explicit button first (clearer audit moment, fewer accidental saves).

2. **Projector:** Update `read_bag_state` on `PRODUCT_MAPPED` in same slice, or defer?  
   - Recommendation: include if small; improves workflow-submissions consistency mid-sealing.

3. **Supervised change:** Same slice or follow-up?  
   - Recommendation: **follow-up slice** — keep PERSIST-1 narrow; server lock + floor read-only is sufficient for launch.

4. **COMBINED station:** Same save action path as pure SEALING?  
   - Recommendation: **yes** — shared `SEALING_STATION_KINDS` validation.

5. **Block product change after which event?** Packaging complete vs first segment vs sealing complete?  
   - Recommendation: lock permanently at first save for floor operators; admin change only before `PACKAGING_COMPLETE`.

6. **CHANGELOG note:** Prior changelog (0.4.72 area) says PRODUCT_MAPPED fires at SEALING_COMPLETE; code fires on segment. Update changelog when implementing for accuracy.

---

## 12. Recommended next coding task

**SEALING-PRODUCT-PERSIST-1** — narrow slice:

> Add explicit server action to save selected finished product for the current sealing bag. Persist to `workflow_bags.product_id`. Show saved product read-only after save. Require persist before segment recording. Existing sealing segment/complete actions re-read saved product server-side. Tests for refresh persistence, lock behavior, and no silent overwrite.

**Out of scope for PERSIST-1:**

- PRODUCT_REASSIGNED / admin change UI
- Broad sealing flow rewrite
- Zoho / finished-lot changes
- Hand-pack tablet behavior (already lineage-based)

---

## Change log

| Date | Change |
|------|--------|
| 2026-05-27 | Initial audit (plan-only) |
