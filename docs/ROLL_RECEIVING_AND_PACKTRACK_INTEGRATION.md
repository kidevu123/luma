# Roll receiving + PackTrack integration guardrail

**Status:** Decisions only. PackTrack integration is **not** implemented in code. This doc is the contract every future PackTrack-touching feature must respect.
**Scope:** PVC / foil / shrink rolls, packaging materials, and the Luma ↔ PackTrack ↔ Zoho data boundary.

This document is the integration spec for two systems that frequently want to overwrite each other:

- **PackTrack** — the packaging-procurement source of truth (suppliers, POs, reorder).
- **Luma** — the physical production / material-genealogy source of truth (lots, weights, consumption, variance).

The rules below exist so that every future feature lands on the same side of every boundary.

---

## 1. Roll receiving workflow

Every PVC / foil / shrink roll arrives at Luma as a *unique material lot* with the following fields. None of these can be invented; receiving must capture each one or the lot is incomplete.

| Field | Required | Source |
|---|---|---|
| `roll_number` (QR) | yes | label printed at receive |
| `material_type` (`PVC_ROLL` / `FOIL_ROLL` / `SHRINK_BAND` / future) | yes | scanned material catalog |
| `supplier` | yes | vendor on the receiving doc |
| `supplier_lot` | yes (when present on label) | vendor's printed lot |
| `packtrack_po_ref` | nullable for now | future PackTrack sync |
| `receipt_number` | yes | sequential per receive (e.g. `PO123-R1`) |
| `gross_weight_grams` | yes | scale at receive |
| `tare_weight_grams` (core / tube weight) | yes | spec sheet or scale |
| `net_weight_grams` (usable) | derived | `gross − tare` (HIGH confidence) or directly entered (MEDIUM) |
| `weight_unit` | yes | `g` (canonical), `kg`, or `lb` accepted |
| `width_mm` | yes | spec |
| `thickness_microns` (gauge) | yes | spec |
| `material_spec` | yes | grade / barrier rating |
| `location` | yes | warehouse bin / rack |
| `status` | yes | `AVAILABLE` on receive |

**Existing schema mapping:** `packaging_lots` already carries every column above (Phase H foundation: `roll_number`, `gross_weight_grams`, `tare_weight_grams`, `net_weight_grams`, `current_weight_grams_estimate`, `weight_unit`, `width_mm`, `thickness_microns`, `material_spec`, `core_weight_grams`, `supplier`, `location`, `scan_token`, `status`). The receiving form at `/inbound/packaging-materials` already enforces these on the roll-receive flow.

**Employee workflow:**

1. The **receiving team** creates the roll lot in `/inbound/packaging-materials` (count receive vs roll receive). The form refuses to mix kinds (a count flow rejects roll materials and vice versa) and writes a `MATERIAL_RECEIVED` event.
2. The **floor employee** scans / confirms the roll number when mounting at `/floor/<token>/rolls`. Mounting writes a `ROLL_MOUNTED` event with `roll_role` (`PVC` or `FOIL`), `starting_weight_grams`, and lot status flips to `IN_USE`.
3. The **employee does not calculate usage.** The system computes it.
4. **Luma estimates usage** from production output via the H.x3 BLISTER_COMPLETE projector hook, using configured-or-learned grams-per-blister. Estimated events are tagged `MATERIAL_CONSUMED_ESTIMATED`.
5. **Luma learns actual usage** from weigh-back. When the operator unmounts with a final weight (or runs `weighRollAction` mid-run), the rebuilder computes empirical grams-per-blister, the learning read model aggregates samples, and confidence climbs (LOW → MEDIUM → HIGH at ≥5 samples).
6. **Luma labels estimated vs actual clearly.** Every consumption event carries `payload.standard_source ∈ {CONFIGURED, LEARNED, MISSING}` and `payload.confidence`. The UI surfaces these — no number is ever shown as exact when it isn't.

---

## 2. Roll ledger rules

A roll is a **balance ledger**, not a single-shot consumed flag. Lifecycle states and their valid transitions:

```
RECEIVED (status=AVAILABLE)
  → MOUNTED (status=IN_USE)
      → PARTIALLY USED (consumption events accumulate; status unchanged)
      → UNMOUNTED (status=AVAILABLE if remaining > 0; status=DEPLETED if ≤ 0)
      → WEIGHED (mid-run; status unchanged)
      → MOUNTED AGAIN (after AVAILABLE → IN_USE on a different machine / different production run)
      → DEPLETED (status=DEPLETED, no further transitions)

Out-of-band:
  → HELD (status=HELD; cannot be mounted; QA hold)
  → SCRAPPED (status=SCRAPPED; cannot be mounted; written off)
  → ADJUSTED (signed correction; status unchanged)
  → VOIDED (writes off without scrap)
```

**Do not model a roll as one-time-use only.** Two events drive the multi-mount semantics:

- `ROLL_UNMOUNTED` flips the lot to `AVAILABLE` (when remaining > 0) so it can be re-mounted on a different machine for a different production run later.
- `ROLL_MOUNTED` checks the lot status and refuses if `HELD`, `SCRAPPED`, `DEPLETED`, or already `IN_USE` — the next mount must follow an unmount.

`material_inventory_events` is append-only. The current weight estimate is derived by reducing the event stream:

```
remaining = (latest ROLL_WEIGHED.quantity if any)
         OR (starting_weight - sum(MATERIAL_CONSUMED_ESTIMATED.quantity_grams) since mount)
         OR (lot.net_weight_grams as fallback, MEDIUM confidence)
```

Adjustments and reweighs are events, never overwrites of historical data.

---

## 3. PackTrack integration ownership

PackTrack and Luma each own a clean piece of the truth. Code may *read* the other system's data through the integration boundary, but never *write* across it.

| Concern | Source of truth |
|---|---|
| Packaging suppliers (vendor catalog) | **PackTrack** |
| Packaging POs (orders placed) | **PackTrack** |
| Expected inbound quantities | **PackTrack** |
| Reorder recommendations | **PackTrack** |
| Reorder approvals | **PackTrack** |
| Actual receiving (the lot at the dock) | **Luma** |
| Material lots (the unique roll) | **Luma** |
| Roll weights (gross / tare / net / current) | **Luma** |
| Material consumption events | **Luma** |
| Production burn rate | **Luma** |
| Remaining inventory (live) | **Luma** |
| Material variance (configured vs actual) | **Luma** |
| Finished-lot genealogy back to roll | **Luma** |

**Why Luma owns "actual" even though PackTrack owns "expected":** the dock scale lands in Luma's receiving form. The floor scans the roll into Luma. Production-time consumption events come from Luma's projector. PackTrack would not see most of this if Luma did not record it. So the *physical* world enters the system through Luma; PackTrack has the *paper* world (POs, agreements with suppliers).

---

## 4. Future PackTrack → Luma sync

When the integration lands, PackTrack will push these to Luma per packaging PO:

| Field | Notes |
|---|---|
| `packtrack_po_id` | external id; idempotency key |
| `supplier` | maps to `purchase_orders.vendor_name` |
| `expected_materials` | one or more rows; each maps to a `packaging_materials` SKU (or a hint when unmapped) |
| `expected_quantity` | per material |
| `expected_roll_count` | for roll kinds |
| `expected_delivery_date` | ETA |

Luma uses these to **prepare** for receive:

- Create or update a `purchase_orders` row whose `parent_po_number` references PackTrack. Don't auto-create a Zoho PO from this; the existing Zoho push is finished-lot-driven, not PO-driven.
- Optionally create empty `packaging_lots` placeholders for expected rolls (status = `AVAILABLE`, weights null until the dock fills them in).
- Generate a receiving checklist the dock team uses to confirm what physically arrives.

Luma never **fakes** receipt. The lot weights remain null until physical receive captures them. The receiving form refuses to "receive" what hasn't been measured.

---

## 5. Future Luma → PackTrack sync

When the integration lands, Luma will push these to PackTrack so packaging-procurement has live ground truth:

| Field | Source helper |
|---|---|
| `actual_received_quantity` | sum of `packaging_lots.qty_received` for the PO |
| `received_roll_numbers` | `packaging_lots.roll_number` per roll kind |
| `actual_net_weights` | `packaging_lots.net_weight_grams` (HIGH/MEDIUM tagged) |
| `material_usage_by_day` | `read_material_consumption_daily` |
| `estimated_remaining_inventory` | `derivePackagingInventory` + per-roll `read_roll_usage.projected_remaining_grams` |
| `actual_remaining_after_weighback` | only when `ROLL_WEIGHED` exists; HIGH confidence |
| `shortage_risk` | `derivePackagingShortageRisk` |
| `projected_runout_date` | `deriveRollRunoutProjection` |
| `variance_or_spoilage` | `deriveMaterialVariance` per roll |

Push policy:

- **Append-only.** Each push is a snapshot. PackTrack stores the snapshot history; Luma never edits a prior push.
- **Confidence-tagged.** Every numeric value sent carries `confidence ∈ {HIGH, MEDIUM, LOW}`. Receiving systems must reject HIGH-only filters when no rows qualify.
- **Honest empty states.** When Luma has no data, the field is `null` with a `missing_inputs` array. PackTrack must render "no data" rather than zero.
- **Cadence.** Daily for usage / inventory rollups; on-event for ROLL_WEIGHED so weigh-back propagates fast.

---

## 6. Integration safety rules

These are the cross-system invariants every PackTrack-touching feature must enforce. Violating any of them creates a vendor-dispute or genealogy-loss risk that may not surface for weeks.

1. **No double receiving.** A `packtrack_po_id` + `roll_number` pair receives **exactly once**. The `external_item_mappings` partial-unique already enforces this on the Zoho side; a parallel constraint applies on PackTrack-keyed receives.
2. **No duplicate material lots.** `packaging_lots.roll_number` is unique among active lots. The receive form already rejects duplicate roll numbers.
3. **Every synced object carries `external_system_id` + `external_id`.** Use the H.x0.5 `external_systems` registry (`PACKTRACK`, `ZOHO`, `NEXUS`, `QIP` are seeded). Sync writes go through `external_item_mappings` and `external_inventory_snapshots` — never inline columns on master tables.
4. **Sync is idempotent.** Re-running a sync with the same payload produces zero schema changes. Implementation: `ON CONFLICT (external_system_id, external_item_id) DO UPDATE` semantics with `COALESCE(EXCLUDED.luma_*, existing.luma_*)` — never `nullify` a non-null Luma reference.
5. **PackTrack cannot overwrite Luma production genealogy.** Genealogy = `workflow_events`, `material_inventory_events`, `raw_bag_allocation_events`, `finished_lot_inputs`. PackTrack writes never reach those tables.
6. **Zoho cannot overwrite Luma production genealogy.** Same rule, restated for clarity. Zoho writes go to `external_inventory_snapshots` (append-only).
7. **Luma consumption events are append-only.** `MATERIAL_CONSUMED_ESTIMATED`, `MATERIAL_CONSUMED_ACTUAL`, `ROLL_*` events are inserted; never updated. Corrections happen via new events (`ADJUSTED`, `VOIDED`) with audit.
8. **Adjustments require an audit trail.** `RAW_BAG_ADJUSTED` requires a non-empty `reason` (already enforced). Any future PackTrack-driven adjustment must produce an `ADJUSTED` event with a `payload.source = 'PACKTRACK_SYNC'` flag and a non-empty reason.

---

## 7. H.x7 implication

Read-only material panels (the next phase to ship) must surface integration-source fields whenever they're present. The metric API helpers already return these in their MetricResult payloads or as named columns; H.x7 panels just need to render them honestly.

Required column / field set for every roll-or-lot-level row in H.x7:

| UI field | Source |
|---|---|
| `source_system` | from the lot's last `external_item_mappings` row (or `LUMA_RECEIVE` when none) |
| `external_po_id` | `external_item_mappings.external_item_code` (PackTrack) or `purchase_orders.zoho_po_id` |
| `supplier` | `packaging_lots.supplier` |
| `receipt_number` | `purchase_orders.po_number` + `receives.receive_name` |
| `material_lot_id` | `packaging_lots.id` (UUID; truncated to 8 chars in UI for density) |
| `confidence` | `read_roll_usage.confidence` or per-row metric confidence |
| `estimated vs actual` | label: "Estimated (configured standard)" / "Estimated (learned)" / "Actual (weigh-back)" — derived from `payload.standard_source` and presence of `ROLL_WEIGHED` |

H.x7 panels must:

- Show `confidence` next to every numeric field. Render the canonical empty-state label (`Roll usage standard missing`, `No mounted roll on machine`, etc.) when MISSING.
- Distinguish "Estimated" from "Actual" with a small badge or text suffix — never mix them in the same totals column.
- Surface `source_system` so an admin can tell at a glance which row came from PackTrack vs Zoho vs Luma direct receive.
- Include a **"Last synced from PackTrack"** timestamp once that integration lands; until then, render "Not synced yet" / "Local only".

H.x7 panels must **not**:

- Aggregate HIGH and LOW confidence values into the same total.
- Show "0" when the underlying data is MISSING — show the empty-state label instead.
- Trigger any sync action. H.x7 is read-only. Sync admin actions land in a future integration phase.
- Auto-fill an unmapped Zoho or PackTrack item to a Luma item — that's an explicit admin choice in the mapping UI.

---

## Open items deferred to future phases

- Live PackTrack OAuth client (mirroring `lib/zoho/client.ts`).
- `lib/integrations/packtrack/items.ts` parallel to `lib/integrations/zoho/items.ts`.
- Cron job that pushes daily roll-up snapshots to PackTrack.
- Mapping UI that lets an admin link a PackTrack PO to a Luma `purchase_orders` row.
- Receiving checklist generated from a PackTrack expected-delivery push.
- A "Sync history" admin page showing the last N PackTrack pushes/pulls with status + missing-input flags.

None of these block H.x7. H.x7 builds the read-only panels against the already-deployed metric API; integration writes / pulls land later.
