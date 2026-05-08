# PackTrack ↔ Luma packaging-receipt integration

> **Status:** future-phase. Document the contract and confirm the
> Luma material model supports declared vs counted vs confidence vs
> box-level receipts. Live PackTrack sync is **not** built in this
> phase. Same shape as `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md`
> and `docs/PRODUCT_SELECTION_AND_ROUTE_BINDING_PLAN.md` — phased
> implementation, marked as cutover-aware.

## Business rule (non-negotiable)

> We do not always physically count packaging when it arrives. Often
> we trust the supplier box label.
>
> Receiving must support **declared quantity** (printed on the box,
> trusted but not verified) AND **counted quantity** (operator-counted,
> verified). Inventory math must reflect the difference via a
> confidence label. Production reconciliation must never silently treat
> a supplier-declared count as if it were measured truth.

## System boundaries

| Concern | Owner |
|---|---|
| Packaging procurement, supplier POs, packaging PO status | **PackTrack** |
| Packaging receiving / box-by-box receipt | **PackTrack** (with optional Luma-side manual receipt) |
| Production consumption / material burn | **Luma** |
| Material reconciliation / shortage projection | **Luma** |
| Production genealogy | **Luma** |
| Sending received packaging lots → Luma | **PackTrack → Luma payload** |
| Receiving shortage recommendations | **PackTrack consumes Luma signal** |

**Critical rule:** PackTrack and Luma must NOT both subtract inventory
independently. PackTrack is the source of truth for "what arrived";
Luma is the source of truth for "how it was burned during production".
Any reconciliation correction is an explicit event, never a silent
overwrite.

## Confidence rules

| Confidence | Trigger |
|---|---|
| `HIGH` | `counted_quantity` was entered by a receiver |
| `MEDIUM` | only `declared_quantity` from the supplier box label |
| `LOW` | imported legacy quantity, or partial / fuzzy receipt |
| `MISSING` | no usable quantity entered yet |

**Accepted quantity rule** — the figure Luma uses for inventory math:

```
accepted_quantity =
  COALESCE(counted_quantity, declared_quantity)

confidence =
  counted_quantity IS NOT NULL ? 'HIGH'
  : declared_quantity IS NOT NULL ? 'MEDIUM'
  : 'MISSING'
```

Reports must always surface declared vs counted side-by-side when they
differ; reconciliation flags `declared - counted` as a separate
"vendor-vs-counted variance" line, not as loss.

## Required data model

### Per-lot fields (per packaging receipt box / lot)

| Field | Today | Plan |
|---|---|---|
| `material_item_id` | ✓ via `packaging_lots.packaging_material_id` | reuse |
| `packtrack_po_id` | ✗ | new column on `packaging_lots`, nullable text/uuid |
| `packtrack_receipt_id` | ✗ | new column, nullable text |
| `supplier` | ✓ `packaging_lots.supplier` text | reuse |
| `supplier_lot_number` | ✗ on packaging_lots (✓ on `inventory_bags.batch_id` for raw) | new column on `packaging_lots`, nullable |
| `box_number` | ✗ on packaging_lots (✓ on `workflow_bags.box_number` for raw) | new column on `packaging_lots` (text — supplier box labels can be alphanumeric) |
| `declared_quantity` | ✗ (only `qty_received` integer NOT NULL) | new column, nullable integer |
| `counted_quantity` | ✗ | new column, nullable integer |
| `accepted_quantity` | partial — `qty_received` is the de-facto accepted | rename / repurpose `qty_received` as `accepted_quantity` (or add the new column and keep the old as a generated column for back-compat). Decision: add `accepted_quantity` as a new column populated by trigger / rebuild; keep `qty_received` for back-compat |
| `unit_of_measure` | ✗ on packaging_lots (✓ via `material_inventory_events.unit_of_measure`) | reuse via the event row; or add to `packaging_lots` for display |
| `confidence_level` | ✓ `packaging_lots.confidence` text default 'HIGH' | reuse — values already match HIGH/MEDIUM/LOW/MISSING contract |
| `received_at` | ✓ `packaging_lots.received_at` | reuse |
| `received_by` | ✗ | new column, nullable uuid → users.id |
| `source_system` | ✗ | new column, text → `packaging_receipt_source` enum |
| `notes` | ✓ `packaging_lots.notes` | reuse |

### `packaging_receipt_source` enum

```
PACKTRACK
MANUAL_LUMA
ZOHO
IMPORT
```

### External-system reference (already exists)

PackTrack itself is registered as a row in `external_systems` (table
already exists). Per-item / per-receipt cross-system mapping uses
`external_item_mappings` (table already exists, with
`materialItemId` → `packaging_materials.id`). Use the
`external_item_mappings.payload` JSONB to capture historical
PackTrack receipt IDs without schema churn.

## Event vocabulary

All on `material_inventory_events` (existing table). The event_type
enum needs five new values via additive migration (Drizzle ALTER TYPE
gotcha — isolate in own migration):

| Event | Meaning | Payload (additive to existing material event payload) |
|---|---|---|
| `PACKAGING_RECEIPT_IMPORTED` | Bulk import of historical receipts (legacy → confidence=LOW) | `{source: 'IMPORT', batch_id, declared_quantity, notes}` |
| `PACKAGING_BOX_RECEIVED` | New box arrived; declared from label | `{box_number, declared_quantity, supplier_lot_number, packtrack_po_id, packtrack_receipt_id, source_system}` |
| `PACKAGING_BOX_COUNTED` | Receiver physically counted the box | `{box_number, counted_quantity, prior_declared_quantity, variance, counted_by}` |
| `PACKAGING_RECEIPT_ADJUSTED` | Cycle-count or correction (signed delta, not a silent overwrite) | `{adjustment, prior_accepted, new_accepted, reason, adjusted_by}` |
| `PACKAGING_VARIANCE_RECORDED` | Variance flagged for review (counted ≠ declared by > tolerance) | `{declared_quantity, counted_quantity, variance, variance_pct, severity}` |

Existing `MATERIAL_RECEIVED` (line 111 of the enum) stays — it's the
generic raw-material receipt event. Packaging-specific receipts use
the new event types so the audit trail shows which path each lot
came from.

## Integration behavior — flow

```
1. PackTrack receives a packaging PO and accepts a delivery.
2. Receiver enters box number + declared_quantity from the label.
3. (Optional) Receiver counts the box; enters counted_quantity.
4. PackTrack POSTs the receipt payload to Luma's webhook.
5. Luma:
   a. Resolves material_item_id via external_item_mappings
      (or surfaces "Mapping missing — supervisor must map").
   b. INSERT INTO packaging_lots (declared_quantity,
      counted_quantity, accepted_quantity = COALESCE(counted, declared),
      confidence = HIGH if counted else MEDIUM, box_number,
      supplier_lot_number, packtrack_po_id, packtrack_receipt_id,
      source_system = 'PACKTRACK', received_at, received_by).
   c. INSERT INTO material_inventory_events
      (event_type = PACKAGING_BOX_RECEIVED, packaging_lot_id, payload).
   d. If counted_quantity was provided: also fire
      PACKAGING_BOX_COUNTED with the variance.
   e. If counted_variance > tolerance: also fire
      PACKAGING_VARIANCE_RECORDED at severity HIGH/MEDIUM/LOW.
6. Luma uses accepted_quantity for inventory availability + shortage
   projection.
7. Luma production consumption later reduces qty_on_hand on the lot
   based on production usage. PackTrack does NOT touch qty_on_hand.
8. Cycle-count adjustments fire PACKAGING_RECEIPT_ADJUSTED with a
   signed delta + reason — no silent overwrite of declared/counted.
```

## Webhook contract — PackTrack → Luma

```json
{
  "source_system": "PACKTRACK",
  "packtrack_po_id": "PT-PO-12345",
  "packtrack_receipt_id": "PT-RCPT-67890",
  "material_code": "PVC-123",
  "material_name": "PVC Roll 0.25mm",
  "supplier": "Acme Packaging",
  "supplier_lot_number": "SUP-LOT-A1",
  "box_number": "BOX-001",
  "declared_quantity": 1000,
  "counted_quantity": null,
  "unit_of_measure": "EACH",
  "received_at": "2026-05-08T14:30:00Z",
  "received_by": "user@example.com"
}
```

Luma response:
```json
{
  "ok": true,
  "luma_packaging_lot_id": "uuid",
  "accepted_quantity": 1000,
  "confidence": "MEDIUM",
  "events_emitted": ["PACKAGING_BOX_RECEIVED"]
}
```

Or rejection (mapping missing, etc.):
```json
{
  "ok": false,
  "error": "external_item_mappings missing for material_code=PVC-123 — operator must map"
}
```

## Current Luma material-model coverage (audit)

| User-spec field / behavior | Luma supports today? |
|---|---|
| `material_item_id` link | **yes** — `packaging_lots.packaging_material_id` |
| `confidence` text on lot | **yes** — `packaging_lots.confidence` (default 'HIGH', accepts HIGH/MEDIUM/LOW/MISSING strings) |
| `supplier` on lot | **yes** — `packaging_lots.supplier` |
| `received_at` | **yes** — `packaging_lots.received_at` (timestamptz) |
| Single quantity field | **yes (partial)** — `packaging_lots.qty_received` integer NOT NULL. Cannot carry separate declared + counted today |
| `declared_quantity` separate column | **no** — must be added |
| `counted_quantity` separate column | **no** — must be added |
| `accepted_quantity` separate column | **no** — `qty_received` is the de-facto accepted. Plan: keep `qty_received` for back-compat, add `accepted_quantity` as the new authoritative column |
| `box_number` on packaging lot | **no** — must be added (other tables already use `box_number`, just not packaging_lots) |
| `supplier_lot_number` on packaging lot | **no** — must be added |
| `packtrack_po_id` / `packtrack_receipt_id` | **no** — can be modeled either as direct columns OR via `external_item_mappings.payload`. Plan: add direct nullable columns for query speed |
| `source_system` enum (PACKTRACK / MANUAL_LUMA / ZOHO / IMPORT) | **no** — must add `packaging_receipt_source` enum |
| `received_by` user FK | **no** — must add |
| `external_systems` table | **yes** — exists (PackTrack registers as a row) |
| `external_item_mappings` for material → PackTrack item | **yes** — `external_item_mappings.materialItemId` already supports this |
| `material_inventory_events` ledger | **yes** — already the source-of-truth for material flow |
| `MATERIAL_RECEIVED` event | **yes** — line 111 of enum, used for raw materials |
| `PACKAGING_RECEIPT_IMPORTED` / `PACKAGING_BOX_RECEIVED` / `PACKAGING_BOX_COUNTED` / `PACKAGING_RECEIPT_ADJUSTED` / `PACKAGING_VARIANCE_RECORDED` | **no** — must add to material event-type enum (additive, isolated migration per the Drizzle ALTER TYPE gotcha) |

**Summary:** the foundation is right (lot status lifecycle,
confidence text column already exists, external-system mapping table
already exists, material event log already exists). Five fields
need to be added to `packaging_lots`, one new enum
(`packaging_receipt_source`) needs to be added, and five new
material event-types need to be added to the material event enum.

## Phased implementation plan

### Phase PT-1 — schema additions (small, isolated)
- Migration `00XX_packaging_receipt_fields.sql` adds:
  - `packaging_lots.declared_quantity integer NULL`
  - `packaging_lots.counted_quantity integer NULL`
  - `packaging_lots.accepted_quantity integer NULL` (with backfill
    from `qty_received` for existing rows)
  - `packaging_lots.box_number text NULL`
  - `packaging_lots.supplier_lot_number text NULL`
  - `packaging_lots.packtrack_po_id text NULL`
  - `packaging_lots.packtrack_receipt_id text NULL`
  - `packaging_lots.source_system text NULL` (text-with-CHECK over
    the enum to avoid a separate type — or formal enum)
  - `packaging_lots.received_by_user_id uuid NULL` → users.id
- New `packaging_receipt_source` enum (or text + CHECK)
- Migration is purely additive, no breaking changes; existing
  `qty_received` column stays for back-compat

### Phase PT-2 — material event vocabulary
- Migration adds 5 enum values to `material_event_type` (isolated
  migration per the journal-timestamp + ALTER TYPE rules)
- TS enum updated in schema.ts
- No emission paths yet (consumers can opt in later)

### Phase PT-3 — Luma webhook receiver
- New route `app/api/integrations/packtrack/receipts/route.ts`:
  - HMAC signature validation against a configured PackTrack secret
  - Resolve material via `external_item_mappings`; reject with
    "Mapping missing" when not found
  - Insert/update packaging_lots row; compute confidence per the
    rule
  - Emit `PACKAGING_BOX_RECEIVED` (always) + `PACKAGING_BOX_COUNTED`
    (if counted_quantity present) + `PACKAGING_VARIANCE_RECORDED`
    (if counted ≠ declared by > tolerance)
- Outbound webhook is OUT OF SCOPE for this phase

### Phase PT-4 — admin / floor surfacing
- `/admin/packaging-receipts` admin page lists incoming PackTrack
  receipts grouped by PO / supplier; shows declared vs counted vs
  accepted with confidence badge
- Receiver can edit `counted_quantity` post-receipt (fires
  `PACKAGING_BOX_COUNTED`)
- Cycle count tool → `PACKAGING_RECEIPT_ADJUSTED` (signed delta +
  reason)

### Phase PT-5 — outbound shortage signal
- Luma exposes `/api/integrations/packtrack/shortage-recommendations`
  read endpoint (PackTrack pulls; Luma never pushes)
- Returns per-material projected runout date + recommended reorder
  qty + confidence
- Driven by existing `read_roll_usage.projected_remaining_grams` +
  packaging-material par levels

### Phase PT-6 — reconciliation rewrite
- `derivePoRawMaterialReconciliation` and PO-level rollups now
  separate `vendor_declared - counted` variance from
  `counted - consumed` variance from `consumed - finished_output`
  variance. Three labelled variance lines, never collapsed
- `read_material_reconciliation` view extended with
  declared/counted/accepted columns

### Phase PT-7 — tests
| # | Behavior |
|---|---|
| 1 | Receipt with only `declared_quantity` → confidence=MEDIUM, accepted=declared |
| 2 | Receipt with `counted_quantity` → confidence=HIGH, accepted=counted |
| 3 | Receipt with neither → confidence=MISSING (rejected at webhook) |
| 4 | `declared_quantity ≠ counted_quantity` triggers `PACKAGING_VARIANCE_RECORDED` |
| 5 | Cycle count emits `PACKAGING_RECEIPT_ADJUSTED` with signed delta — never overwrites declared/counted columns |
| 6 | Webhook with missing `external_item_mappings.materialItemId` returns 422 with clear "Mapping missing" |
| 7 | `box_number` is non-unique within a PO (boxes are physical units, multiple per receipt) |
| 8 | `accepted_quantity` is what `read_material_lot_state` reports for availability |
| 9 | Luma never decrements `qty_on_hand` from a webhook — only production consumption does |
| 10 | Reconciliation reports `vendor_declared - counted` and `counted - consumed` as separate variance lines, not summed |

## Production-readiness blocker

Cutover **may not** happen while:
- Luma `packaging_lots` cannot distinguish declared vs counted vs
  accepted (today's flat `qty_received` collapses them)
- `MATERIAL_RECEIVED` is the only receipt event (no
  `PACKAGING_BOX_COUNTED` / `PACKAGING_VARIANCE_RECORDED` audit
  trail)
- The webhook receiver doesn't exist (manual data entry only path)
- Reconciliation can't separate vendor-vs-counted from
  counted-vs-consumed variance

PT-1 + PT-2 + PT-3 are the cutover-critical slice. PT-4 / PT-5 / PT-6
can ship post-cutover if the manual-receipt UX covers it.

## What this plan does NOT do

- Does NOT implement the live PackTrack sync. Documents the contract
  and confirms the Luma data model supports it after PT-1's small
  additive schema migration.
- Does NOT change today's `packaging_lots` rows. Existing
  `qty_received` stays; new columns are nullable additions.
- Does NOT define the PackTrack-side receipt UI or the PackTrack
  → Luma transport security. Both are the PackTrack team's call.
- Does NOT touch Zoho. Zoho live sync is a separate doc
  (`docs/ZOHO_ITEM_SYNC_PLAN.md`).
