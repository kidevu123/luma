# Luma workflow validation plan

**Status:** Plan only — execution lives in `/workflow-validation` and the QA seed/cleanup scripts.
**Scope:** End-to-end staging validation before any PillTracker cutover.
**Source of truth for state:** `/workflow-validation` page renders the live readiness of every workflow group below.

This doc describes *what* we test and *how* the system is shaped to make those tests safe and repeatable. The supporting tooling lives in:

- `scripts/seed-staging-validation-data.ts` — creates `QA_TEST_*` seeds
- `scripts/cleanup-staging-validation-data.ts` — removes them
- `app/(admin)/workflow-validation/page.tsx` — read-only readiness board

The seed script is **environment-gated** (`NODE_ENV !== "production"` OR `ALLOW_STAGING_QA_DATA=true`). It creates only records prefixed `QA_TEST_` or marked with a `STAGING_VALIDATION` flag in the appropriate jsonb payload. The cleanup script deletes only records matching those markers.

---

## Station token blocker (audited 2026-05-07)

All 8 staging stations use the legacy `kind-prefixed-hex` token format (`seal-…`, `blister-…`, `bottle-…`). The new floor mutation actions (`mountRollAction`, `unmountRollAction`, `weighRollAction`, `openAllocationSessionAction`, `closeAllocationSessionAction`, `returnRawBagAction`, `markBagDepletedAction`, `adjustRawBagAction`) — and the existing `scanCardAction`, `fireStageEventAction`, etc. — all check `UUID_RE` before accepting a token.

**Effect:** mutation calls from `/floor/<token>/...` against legacy stations return `Invalid station token.` The page itself renders fine (page query doesn't enforce the regex); only mutations are rejected. **This is a pre-existing constraint inherited from the existing scan flow, not introduced by H.x4 / H.x3.6.**

**Resolution paths (do not change behavior silently):**

1. **Admin rotation (recommended on staging).** Open `/machines`, click *Rotate token* per station. The existing `rotateTokenAction` generates `crypto.randomUUID()` and persists. After rotation, all mutation actions accept the new token. The /machines admin page also exposes the floor URL with a copy button so test devices can be configured against the rotated token.

2. **Targeted rotation script** (preferred for QA: rotates only stations the seed script has flagged with `STAGING_VALIDATION`). The QA seed script offers a `--rotate-tokens` flag that rotates QA-flagged stations only. Production tokens are never rotated. The flag is documented in `scripts/seed-staging-validation-data.ts`.

3. **Relax the regex (NOT recommended).** Removing the UUID gate would weaken the mutation API's defense against brute-force token enumeration. Production already has UUID tokens (the legacy hex tokens are seed data only). If staging mirrors production via a DB restore, rotation is the only honest fix.

**The validation page surfaces the token-format blocker per workflow group.** Workflows that require mutation actions show *Blocked — token rotation needed* until the relevant station is rotated.

---

## Workflow groups

Each group has its own section in `/workflow-validation` with a status badge:

| Status | Meaning |
|---|---|
| `Not started` | No QA data and no live activity for this workflow yet. |
| `Ready to test` | Prerequisites are present; admin can begin manual testing. |
| `Passed` | At least one expected event of the right shape has been observed. |
| `Failed` | An expected event is malformed or missing inputs surfaced. |
| `Blocked` | A prerequisite is missing (e.g. token format, no roll standard). |
| `Missing configuration` | The supporting config (BOM / standard / structure) hasn't been entered. |

The page is read-only. There is no "run test" button — the page shows the state of the database; humans drive the actions through the floor UI and admin pages.

### 1. Admin setup

Goal: configure every catalog row needed before production can run end-to-end.

| Step | Action | Location | Verifies |
|---|---|---|---|
| 1.1 | Create material item | `/settings/materials` | `packaging_materials` row, kind ∈ valid enum |
| 1.2 | Create product structure | `/settings/product-structure` | `item_conversions` rows, refuses zero qty / same parent==child |
| 1.3 | Create packaging BOM | `/settings/packaging-bom` | `product_packaging_specs` row, valid scope |
| 1.4 | Create blister material standard | `/settings/blister-standards` | `blister_material_standards` row with role + qty basis |
| 1.5 | Create raw item weight standard | `/settings/raw-item-weights` | `raw_item_weight_standards` row, supersede pattern works |
| 1.6 | Create product route assignment | (deferred — wire-up phase) | `product_route_assignments` row with `is_default = true` |
| 1.7 | Configure variety pack components | (admin SQL or future UI) | `product_component_requirements` rows per role |

**Empty-state vocabulary:** every one of these surfaces explicit MISSING labels (`Packaging BOM missing`, `Roll usage standard missing`, `Unit weight standard missing`, `Variety pack component requirements missing`) until configured.

### 2. Receiving

Goal: prove the receive flows write material lots correctly and never fake a count or weight.

| Step | Action | Verifies |
|---|---|---|
| 2.1 | Receive raw bag (count) | `/inbound/packaging-materials` count flow rejects roll kinds |
| 2.2 | Record vendor declared count | `inventory_bags.pill_count` populated; bag tied to PO via small_box → receive |
| 2.3 | Record received weight | `inventory_bags.weight_grams` populated |
| 2.4 | Assign QR (vendor barcode) | `inventory_bags.vendor_barcode` |
| 2.5 | Receive display boxes | count flow; lot in `AVAILABLE` |
| 2.6 | Receive master cases | count flow |
| 2.7 | Receive PVC roll | roll flow rejects non-roll material; `gross−tare` net weight or direct net |
| 2.8 | Receive foil roll | same as PVC; partial-unique enforces no duplicate active roll number |
| 2.9 | Verify material lot state | `read_material_lot_state` populated after rebuild |

### 3. Roll workflow

Goal: prove the four roll actions and the BLISTER_COMPLETE consumption hook behave honestly.

| Step | Action | Verifies |
|---|---|---|
| 3.1 | Mount PVC roll | `/floor/<token>/rolls`; ROLL_MOUNTED event; lot status → IN_USE |
| 3.2 | Mount foil roll | second active role per machine allowed |
| 3.3 | Complete blister operation | BLISTER_COMPLETE event with `payload.machine_count` |
| 3.4 | Verify MATERIAL_CONSUMED_ESTIMATED | one event per active role; payload includes `standard_source`, `confidence`, `missing_inputs` |
| 3.5 | Weigh roll | ROLL_WEIGHED event; `current_weight_grams_estimate` updated |
| 3.6 | Unmount roll | ROLL_UNMOUNTED event; status → AVAILABLE (positive remaining) or DEPLETED (≤0) |
| 3.7 | Verify roll variance | `read_roll_usage` shows configured/expected/actual |
| 3.8 | Verify learned standard starts | `read_material_usage_learning` row appears once a roll has a weigh-back |

### 4. Card / blister workflow

Goal: end-to-end card production with all stages firing in order.

| Step | Action | Verifies |
|---|---|---|
| 4.1 | Scan station | `/floor/<token>` page resolves the station |
| 4.2 | Scan bag (card) | CARD_ASSIGNED event; QR card status → ASSIGNED |
| 4.3 | Start blister | (no separate event — implicit on first BLISTER_COMPLETE) |
| 4.4 | Pause | BAG_PAUSED event |
| 4.5 | Resume | BAG_RESUMED event |
| 4.6 | Complete with counter | BLISTER_COMPLETE with `payload.machine_count` |
| 4.7 | Release to staging | (advance to SEALING_QUEUE on stage progression) |
| 4.8 | Heat seal | SEALING_COMPLETE event |
| 4.9 | Package | PACKAGING_COMPLETE event |
| 4.10 | Finalize | BAG_FINALIZED event; `read_bag_metrics` row written; finished_lot tied via finished_lot_inputs |

### 5. Bottle workflow

Goal: same raw bag should be reusable across two products / two routes.

| Step | Action | Verifies |
|---|---|---|
| 5.1 | Same raw bag used for bottle | open a second `raw_bag_allocation_session` after the first is closed/returned |
| 5.2 | Bottle filling | BOTTLE_HANDPACK_COMPLETE event |
| 5.3 | Sticker | BOTTLE_STICKER_COMPLETE event |
| 5.4 | Induction seal | BOTTLE_CAP_SEAL_COMPLETE event |
| 5.5 | Packaging | PACKAGING_COMPLETE event |
| 5.6 | Finalization | BAG_FINALIZED |
| 5.7 | PO split usage updates | `derivePoSplitUsageReport` shows two product rows for the same PO |

### 6. Raw bag allocation

Goal: the multi-mount ledger holds across return/reopen cycles.

| Step | Action | Verifies |
|---|---|---|
| 6.1 | Open bag allocation | RAW_BAG_OPENED event; one OPEN session per bag (partial-unique) |
| 6.2 | Partially consume | RAW_BAG_PARTIAL_CONSUMED event with `quantity_source` |
| 6.3 | Return to stock | RAW_BAG_RETURNED_TO_STOCK; bag status → AVAILABLE |
| 6.4 | Reopen for another product | second session with different `product_id` / `route_id` |
| 6.5 | Deplete bag | RAW_BAG_DEPLETED; bag status → EMPTIED |
| 6.6 | Verify PO report | bag appears under multiple products in section 5 of `/po-reconciliation/[poId]` |

### 7. Variety pack

Goal: multi-component reconciliation with variance flagged when actual ≠ expected.

| Step | Action | Verifies |
|---|---|---|
| 7.1 | Configure component requirements | `product_component_requirements` rows per role (FLAVOR_A/B/C) |
| 7.2 | Open multiple raw bags | three concurrent sessions with `component_role` set |
| 7.3 | Assign component roles | role recorded on session + propagated to events |
| 7.4 | Produce variety pack lot | finished_lot row + finished_lot_inputs link |
| 7.5 | Verify component variance | `deriveVarietyPackComponentUsage` returns expected/actual/variance per role |

### 8. PO reconciliation

| Step | Verifies |
|---|---|
| 8.1 | Vendor declared count | top of /po-reconciliation/[poId] |
| 8.2 | Received weight | `received_net_weight_total` MetricResult |
| 8.3 | Internal estimate | needs `raw_item_weight_standards` row |
| 8.4 | Finished output | sum of finished_lot_inputs |
| 8.5 | Known loss | damage / rework events |
| 8.6 | Remaining inventory | from inventory_bags.status |
| 8.7 | Unknown variance | residual; null when any input missing |
| 8.8 | Supplier settlement | source = `ACCOUNTED_OUTPUT` / `VENDOR_DECLARED` / `MANUAL_REVIEW` |
| 8.9 | CSV export | downloadable; sections 1–7 present |

### 9. Material dashboards

| Step | Verifies |
|---|---|
| 9.1 | Packaging inventory | `/packaging-inventory` reflects received lots |
| 9.2 | Active rolls | `/active-rolls` reflects mounted rolls |
| 9.3 | Roll variance | `/roll-variance` flags rolls > 5% variance |
| 9.4 | Material alerts | `/material-alerts` lists shortages + runouts + held + stale allocations |
| 9.5 | Learned standards | `read_material_usage_learning` populated after weigh-back |
| 9.6 | Shortage risk | `derivePackagingShortageRisk` with par-level inputs |

### 10. Negative tests (guardrails)

These prove the system fails *honestly*:

| Step | Configuration removed | Expected result |
|---|---|---|
| 10.1 | BOM | `derivePackagingAndMaterialRequirements` → "Packaging BOM missing" |
| 10.2 | Product structure | `deriveProductStructure` → "Product structure missing" |
| 10.3 | Roll standard | BLISTER_COMPLETE hook skips emission; UI shows "Roll usage standard missing" |
| 10.4 | No mounted roll | hook skips; metric API returns "No mounted roll — cannot estimate consumption" |
| 10.5 | No counter | hook skips when `payload.machine_count` is null/0 |
| 10.6 | Open allocation | `classifyBagConfidence` returns LOW |
| 10.7 | Product missing route | `getRouteForProduct` returns `MISSING` |
| 10.8 | Variety pack missing component req | `deriveVarietyPackComponentUsage` returns MISSING |
| 10.9 | Stale roll not weighed back | `read_material_usage_learning` does not include this roll as a sample; confidence stays MEDIUM |

---

## How to use this plan

1. **Seed:** run `npm run staging:seed` (calls `tsx scripts/seed-staging-validation-data.ts`). The script refuses to run unless `NODE_ENV !== "production"` OR `ALLOW_STAGING_QA_DATA=true`. It writes `QA_TEST_*` rows.
2. **Audit readiness:** open `/workflow-validation`. Sections without prerequisites display *Missing configuration*; sections blocked by token format display *Blocked*.
3. **Drive workflows:** an operator opens `/floor/<token>/rolls` (after rotating the station's token) and runs each step.
4. **Re-audit:** refresh `/workflow-validation`; status badges advance.
5. **Cleanup:** when validation is complete (or to reset state), run `npm run staging:cleanup`. The cleanup deletes only `QA_TEST_*` records; legacy data is untouched.

The seed/cleanup pair is idempotent: re-running seed when QA data already exists is a no-op; cleanup followed by seed gives a fresh test bed without disturbing anything else.

---

## Out of scope for this phase

- PillTracker cutover or any write to TabletTracker / PillTracker.
- PackTrack live integration. (Doc-only contract lives in `docs/ROLL_RECEIVING_AND_PACKTRACK_INTEGRATION.md`.)
- Live Zoho item sync. (Doc-only plan in `docs/ZOHO_ITEM_SYNC_PLAN.md`.)
- Visual polish on any panel.
- Removing legacy enums.
- Migration to the route_operations write side (still on legacy enums).
