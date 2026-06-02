# SEALING-FLOW-CLARITY-1 — Hand-pack vs machine sealing UI audit

**Date:** 2026-05-28  
**Status:** Audit only — no implementation  
**Live baseline:** v0.4.22 / `32c6099` (SEALING-COUNTER-1 deployed)  
**PM question:** Should SEALING stations always use the machine counter UI, even when the bag came from `HANDPACK_BLISTER`?

---

## 1. Current decision tree for sealing completion UI

```
SEALING station + bag at station
│
├─ page.tsx queries workflow_events for HANDPACK_BLISTER_COMPLETE on bag
│     └─ bagIsHandpacked = (event exists)
│
├─ bagIsHandpacked === true
│     ├─ stage-action-buttons.tsx: filter out SEALING_COMPLETE from stage buttons
│     │     (no "Sealing complete" → no SealingCompleteForm)
│     └─ page.tsx: render SealHandpackForm
│           └─ sealHandpackBagAction
│                 • field: plasticBlisterCount ("blisters sealed")
│                 • payload: { plastic_blister_count }
│                 • also: PACKAGING_MATERIAL_ISSUED (BLISTER_CARD lot, reason handpack_seal)
│
└─ bagIsHandpacked === false  (machine-blistered bag)
      └─ stage-action-buttons.tsx: "Sealing complete" opens SealingCompleteForm
            └─ fireStageEventAction(SEALING_COMPLETE)
                  • field: counterPresses
                  • payload: { count_total, counter_presses, cards_per_press, packs_remaining?, cards_reopened? }
                  • no PACKAGING_MATERIAL_ISSUED
```

**Derivation of `bagIsHandpacked`** (`app/(floor)/floor/[token]/page.tsx:273–286`):

- Only evaluated when `station.kind === "SEALING"` and a bag is pinned.
- Single query: any `workflow_events` row with `event_type = 'HANDPACK_BLISTER_COMPLETE'` for that `workflow_bag_id`.
- Does **not** inspect upstream station kind, product, or blister source — only event history.

**UI suppression** (`stage-action-buttons.tsx:151–155`):

- When `bagIsHandpacked && stationKind === "SEALING"`, `SEALING_COMPLETE` is removed from `allStages`, so the machine-counter form never opens.

---

## 2. Event payload differences

| Aspect | Machine path (`fireStageEventAction`) | Hand-pack path (`sealHandpackBagAction`) |
|---|---|---|
| **Operator input** | Counter presses | Plastic blister count |
| **Primary payload** | `count_total`, `counter_presses`, `cards_per_press` | `plastic_blister_count` only |
| **Reconciliation fields** | `packs_remaining`, `cards_reopened` (optional) | None |
| **Material side-effect** | None | `PACKAGING_MATERIAL_ISSUED` + direct `packaging_lots.qty_on_hand` decrement |
| **Material qty source** | — | `min(plasticBlisterCount, lot.qty_on_hand)` |
| **Lot selection** | — | FIFO oldest AVAILABLE `BLISTER_CARD` / `MATERIAL` |
| **Stage advance** | `SEALING_COMPLETE` → `SEALED` (projector) | Same |
| **Auth / guards** | Stage progression, pause, machine config | Same + requires AVAILABLE blister lot |

Both paths emit the same event type (`SEALING_COMPLETE`) but with **incompatible payload shapes**.

---

## 3. Downstream / reporting impact

### Projector (`lib/projector/index.ts`)

| Consumer | Reads from SEALING_COMPLETE | Hand-pack path today |
|---|---|---|
| Stage → `SEALED` | Event type only | Works |
| `sealingSeconds` (cycle time) | Event timestamp | Works |
| `bags_sealed` throughput column | Event type only | Works (bag count +1, not unit count) |
| `plastic_blister_count` | **Not read** | Stored only |
| `count_total` | **Not used at finalize** for yield | **Missing** on hand-pack path |

### Flow overlap readiness (`lib/production/flow-overlap-readiness.ts`)

- `sealedOutputUnits` sums `payload.count_total` on `SEALING_COMPLETE`.
- Hand-pack sealing events contribute **0 sealed units** because they only set `plastic_blister_count`.

### Admin workflow submissions (`app/(admin)/workflow-submissions/workflow-table.tsx`)

- SEALING row displays **Sealed = `count_total`**, Remaining = `packs_remaining`.
- Hand-pack events show **blank/zero Sealed** in admin UI.

### Finalize / PO reconciliation (`read_bag_metrics.units_yielded`)

- Derived from **packaging** counts (`master_cases`, `displays_made`, `loose_cards`) at finalize — not from sealing count.
- Sealing `count_total` does not directly drive `units_yielded` today for either path.

### Material inventory

- Hand-pack path is the **only** place that consumes pre-made `BLISTER_CARD` lots at sealing.
- Machine-blistered bags consume PVC/foil at blister machine (roll hook on `BLISTER_COMPLETE`), not at sealing.

### Planned QC / correction (not built — do not touch in this slice)

- `docs/QC_SUBSYSTEM_IMPLEMENTATION_PLAN.md` — future `SUBMISSION_CORRECTED` for count typos on `SEALING_COMPLETE`.
- `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md` — future `count_source=SEALING_COUNTER` vs packaging-verified counts.
- Neither exists in code today; unifying the UI does not require opening these workstreams.

---

## 4. Is the hand-pack sealing path a real business rule or legacy workaround?

### Original design intent (2026-05-21 handpack blister spec)

The split was **intentional**, but for **material accounting**, not operator UX:

> When a sealing operator scans a bag with `HANDPACK_BLISTER_COMPLETE` in history, show **Plastic blisters sealed** … When present, emit `PACKAGING_MATERIAL_ISSUED` deducting from the pre-made blister lot.

Rationale in spec §5: hand-pack does not consume blister cards at the hand-pack station (timed step only). Consumption was deferred to sealing, with the operator entering how many pre-made blister **cards** were used.

### PM / floor reality (2026-05-28)

- Downstream sealing is still a **sealing machine** with a physical counter.
- SEALING-COUNTER-1 already configured `cardsPerTurn` on linked machines (live: 6 / 3 / 6).
- Asking the operator for a separate “plastic blister count” at the same machine station is **confusing** and **duplicates** the count the machine already tracks.
- The hand-pack path also ** omits `count_total`**, creating silent gaps in overlap readiness and admin visibility.

### Verdict

The hand-pack sealing **UI split is a legacy material-consumption workaround**, not evidence that hand-packed bags bypass the machine counter. The **material side-effect** (consume `BLISTER_CARD` lot) is the part worth keeping; the **separate count UI** is not aligned with how sealing stations actually run.

---

## 5. Recommendation

### Recommended: **Option B — machine counter for all SEALING station completions**

**Principle:** Station kind drives operator UI. `SEALING` always behaves like a sealing machine. Upstream source (`HANDPACK_BLISTER` vs `BLISTER`) affects **server-side side-effects**, not which form the operator sees.

| Option | Summary | Fit |
|---|---|---|
| **A — Keep as-is** | Hand-pack bags → `SealHandpackForm` / plastic blister count | Technically works; **confusing**; leaves `count_total` empty |
| **B — Unified counter UI** | All SEALING completions use `SealingCompleteForm` + counter × cardsPerPress | **Matches PM bias and floor process** |
| **C — Hybrid / clearer naming** | Keep two forms but rename + show both counter and blister count | Still two mental models; does not fix missing `count_total` |

**Option B server behavior:**

1. Always use `fireStageEventAction(SEALING_COMPLETE)` with counter presses (existing SEALING-COUNTER-1 path).
2. When bag history contains `HANDPACK_BLISTER_COMPLETE`, **also** emit `PACKAGING_MATERIAL_ISSUED` for `BLISTER_CARD` using **`count_total`** (derived sealed cards) — same FIFO lot logic currently in `sealHandpackBagAction`.
3. Deprecate `plastic_blister_count` on new events (optional: keep reading old events in admin).
4. Remove `bagIsHandpacked` UI branching; keep detection only for the material-issuance hook if needed.

**Why not Option A:** Bag Card 117 at Sealing station 1 demonstrates the confusion — config is correct (`sealingCardsPerPress: 6`) but operators see “blisters sealed” instead of counter presses.

**Why not Option C:** Two count fields at one machine station invites mismatch; reconciliation plans already treat sealing counter as process throughput, packaging as finished output.

---

## 6. Smallest safe implementation slice (Option B)

**Scope:** UI unification + server material hook — no schema, no stage progression, no overlap pickup changes.

### Step 1 — Floor UI (single form)

- Remove `SealHandpackForm` render branch from `page.tsx`.
- Remove `bagIsHandpacked` filter in `stage-action-buttons.tsx` (always show `Sealing complete` → `SealingCompleteForm`).
- Optionally delete `seal-handpack-form.tsx` or leave as dead code briefly (prefer delete in same PR).

### Step 2 — Server (one completion path)

- In `fireStageEventAction`, after computing `count_total` for `SEALING_COMPLETE`:
  - If bag has prior `HANDPACK_BLISTER_COMPLETE`, run the existing blister-lot FIFO + `PACKAGING_MATERIAL_ISSUED` + lot decrement logic (extract from `sealHandpackBagAction`).
  - Use `count_total` as `qty_issued` (not a separate operator-entered blister count).
- Mark `sealHandpackBagAction` deprecated / remove if unused.
- Keep `packs_remaining` / `cards_reopened` on machine path unchanged.

### Step 3 — Tests

- Update structural tests that assert hand-pack path unchanged.
- Add test: hand-pack bag at SEALING still gets material issuance when `count_total > 0`.
- Add test: UI no longer references `SealHandpackForm` / `plasticBlisterCount` on floor page.

### Out of scope (explicit)

- QC correction / reconciliation inaccuracy workflow
- FLOW-OVERLAP-2B partial lane events
- `scan-card-form.tsx`, `stage-progression.ts`, pickup rules
- Packaging completion behavior
- Retroactive migration of existing `plastic_blister_count` events

---

## 7. Files that would change (Option B)

| File | Change |
|---|---|
| `app/(floor)/floor/[token]/page.tsx` | Remove `SealHandpackForm` import/render; keep or inline `bagIsHandpacked` query only if server needs it client-side (prefer server-only) |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Remove `bagIsHandpacked` prop + SEALING_COMPLETE suppression |
| `app/(floor)/floor/[token]/seal-handpack-form.tsx` | **Delete** (or gut) |
| `app/(floor)/floor/[token]/actions.ts` | Extend `fireStageEventAction` with hand-pack material hook; remove or thin `sealHandpackBagAction` |
| `app/(floor)/floor/[token]/actions.test.ts` | Replace hand-pack preservation test with unified-path tests |
| `app/(floor)/floor/[token]/stage-action-buttons.test.ts` | Assert no hand-pack UI branch |
| `CHANGELOG.md` / `package.json` | Patch bump |

**Not touched:** `scan-card-form.tsx`, `stage-progression.ts`, schema/migrations, projector (unless optional admin display of legacy `plastic_blister_count`).

---

## 8. Test plan

### Automated

- `npm run typecheck`
- `npm test` — focus:
  - `stage-action-buttons.test.ts`
  - `actions.test.ts`
  - `sealing-counter.test.ts` (unchanged math)
- `npm run build`

### New tests to add

1. Structural: no `SealHandpackForm` on SEALING page when `bagIsHandpacked`.
2. Structural: `fireStageEventAction` references hand-pack material issuance helper.
3. Unit/integration (if feasible): mock transaction — `HANDPACK_BLISTER_COMPLETE` history → `SEALING_COMPLETE` emits `PACKAGING_MATERIAL_ISSUED` with `qty_issued === count_total`.

### Manual staging (after implement)

1. Configure sealing machine cards per press (e.g. 6 on Sealing Machine 1).
2. Pick up **hand-packed** bag (Bag Card 117 or fresh) at Sealing station 1 @ `BLISTERED`.
3. Confirm UI: **Counter presses**, not “plastic blister count”.
4. Enter 25 presses → preview 150 sealed cards (25 × 6).
5. Complete → verify events:
   - `SEALING_COMPLETE`: `counter_presses: 25`, `cards_per_press: 6`, `count_total: 150`
   - `PACKAGING_MATERIAL_ISSUED`: `qty_issued: 150`, `reason: handpack_seal`
6. Admin workflow submissions: **Sealed = 150** (not blank).
7. Machine-blistered bag: same counter UI; **no** `PACKAGING_MATERIAL_ISSUED` for `BLISTER_CARD`.
8. Scan/start/pickup/release unchanged.

---

## 9. Risks and rollback

| Risk | Severity | Mitigation |
|---|---|---|
| `count_total` ≠ physical blister cards consumed for hand-pack | Medium | PM accepts machine counter as sealing-station truth; material issues use same derived count |
| No AVAILABLE `BLISTER_CARD` lot blocks completion | Low (existing) | Same as today on hand-pack path — clear error before submit |
| Legacy events with only `plastic_blister_count` | Low | Read-only history; admin can show both fields for old rows |
| Removing `sealHandpackBagAction` breaks bookmarked clients | Very low | Floor PWA loads from deploy; no external API consumers |
| Double material issuance if hook runs twice | Medium | Keep idempotency via same transaction; do not call from two actions |

**Rollback:** Revert PR; restore `SealHandpackForm` branch. No migration to undo. Existing events unaffected.

---

## 10. Audit confirmations

| Hard stop | Status |
|---|---|
| Code modified in this audit | **No** |
| DB modified | **No** |
| `scan-card-form.tsx` touched | **No** |
| `stage-progression.ts` touched | **No** |
| Schema/migrations | **No** |

**Validation run on audit branch (main @ 32c6099, no local code edits):**

- `npm run typecheck` — pass  
- `npm test` — 2718 passed  
- `npm run build` — pass  

---

## 11. PM summary — next action before testing sealing

**Today (v0.4.22):** Machine counter UI works only for **machine-blistered** bags. Bag Card 117 shows the hand-pack form **by design**, not because config is wrong.

**Before meaningful counter testing on station 1:** Either use a machine-blistered bag, **or** implement Option B so hand-packed bags also get the counter form.

**If implementing Option B:** Preserve hand-pack **material consumption** server-side; drop the separate plastic blister count UI.
