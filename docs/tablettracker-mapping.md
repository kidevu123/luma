# TabletTracker → Luma data mapping

Source: `~/dumps/tt-latest.db.gz` on PythonAnywhere → fetched by Luma's
legacy-import job → unpacked into `/data/legacy-imports/tt-export.db`
on LX122. SQLite (1.1 MB), 27 tables, ~5,000 rows total.

## Counts (from the live dump)

| Legacy table | Rows | Disposition |
|---|--:|---|
| purchase_orders | 83 | → `purchase_orders` (1:1, field renames) |
| po_lines | 239 | → `po_lines` (1:1) |
| tablet_types | 34 | → `tablet_types` (1:1, `category` flattened to text) |
| product_details | 54 | → `products` (1:1) |
| product_allowed_tablet_types | 59 | → `product_allowed_tablets` (1:1) |
| categories | 8 | drop — Luma's `tablet_types.category` is free-text |
| machines | 8 | → `machines` (1:1, `compressor_json` stays as JSON) |
| compressors | 4 | → stash as `legacy_compressors` for now (compressor table not yet in Luma) |
| workflow_stations | 8 | → `stations` (1:1, scan tokens preserved verbatim) |
| qr_cards | 104 | → `qr_cards` (1:1) |
| employees | 6 | → `employees` (1:1, `password_hash` preserved but not used by Luma's auth) |
| roles | 4 | drop — Luma uses an enum |
| app_settings | 7 | stash as `legacy_app_settings` for traceability |
| shipments | 0 | → `shipments` (1:1, currently empty) |
| receiving | 49 | → `receives` (1:1) |
| small_boxes | 308 | → `small_boxes` (1:1) |
| bags | 884 | → `inventory_bags` (1:1; `packaged_count` denorm preserved + reconciled) |
| receiving_flavor_batches | 26 | denorm into `inventory_bags.batch_number` (already populated) — drop |
| workflow_bags | 63 | → `workflow_bags` (1:1, `created_at` ms epoch → timestamptz) |
| workflow_events | 591 | → `workflow_events` (with event-type translation map) |
| warehouse_submissions | 1767 | stash as `legacy_warehouse_submissions` (Phase 2: synthesize Luma events) |
| machine_counts | 984 | stash as `legacy_machine_counts` (Phase 2: synthesize BLISTER/SEALING events) |
| submission_bag_deductions | 58 | stash as `legacy_submission_bag_deductions` |
| po_damage_closeout_lines | 6 | stash as `legacy_po_damage_closeout` |
| blister_material_rolls | 4 | stash as `legacy_blister_rolls` (Phase 2 metric input) |
| alembic_version | 1 | drop |
| sqlite_sequence | 19 | drop (SQLite-internal) |

## ID-mapping discipline

Legacy uses integer auto-increment PKs; Luma uses UUIDs. Each
import populates `legacy_tt_id_map` rows of shape
`(tt_table TEXT, tt_id INTEGER, luma_table TEXT, luma_id UUID)`
so foreign keys can be rewritten as we walk the dependency chain.

Walk order (each step depends on rows already mapped above it):

1. `companies` (singleton — one per install, used as FK target)
2. `tablet_types` ← (legacy) tablet_types
3. `products` ← product_details (uses tablet_type_id from step 2)
4. `product_allowed_tablets` ← product_allowed_tablet_types
5. `machines` ← machines
6. `stations` ← workflow_stations (machine_id from step 5)
7. `qr_cards` ← qr_cards
8. `employees` ← employees
9. `purchase_orders` ← purchase_orders
10. `po_lines` ← po_lines (po_id from step 9)
11. `shipments` ← shipments (po_id from step 9; empty in seed)
12. `receives` ← receiving (po_id, shipment_id)
13. `small_boxes` ← small_boxes (receiving_id from step 12)
14. `inventory_bags` ← bags (small_box_id, tablet_type_id)
15. `workflow_bags` ← workflow_bags (product_id, inventory_bag_id)
16. `workflow_events` ← workflow_events (workflow_bag_id, station_id, user_id)
17. `legacy_*` stash tables (warehouse_submissions, machine_counts, etc.)

## Field-by-field mapping

### `purchase_orders` → `purchase_orders`

| TT field | Luma field | Notes |
|---|---|---|
| id | — | only via `legacy_tt_id_map` |
| po_number | `po_number` | direct |
| zoho_po_id | `zoho_po_id` | direct |
| tablet_type | drop | denormalized; rebuild from po_lines |
| zoho_status | `zoho_status` | text |
| ordered_quantity | `ordered_quantity` | int |
| current_good_count | `current_good_count` | int |
| current_damaged_count | `current_damaged_count` | int |
| remaining_quantity | drop | derived |
| closed | `closed` | boolean |
| internal_status | `internal_status` | enum-text |
| parent_po_number | `parent_po_number` | text — for "-OVERS" children |
| machine_good_count | `machine_good_count` | int |
| machine_damaged_count | `machine_damaged_count` | int |
| vendor_id | `vendor_id` | text |
| vendor_name | `vendor_name` | text |
| created_at | `created_at` | timestamptz |
| updated_at | `updated_at` | timestamptz |

### `bags` → `inventory_bags`

| TT field | Luma field | Notes |
|---|---|---|
| id | — | id map only |
| small_box_id | `small_box_id` | UUID-rewritten |
| bag_number | `bag_number` | int |
| bag_label_count | `bag_label_count` | int |
| pill_count | `pill_count` | int (manual override) |
| status | `status` | text — Luma accepts free text |
| tablet_type_id | `tablet_type_id` | UUID-rewritten |
| zoho_receive_pushed | `zoho_receive_pushed` | bool |
| zoho_receive_id | `zoho_receive_id` | text |
| zoho_receive_overs_id | `zoho_receive_overs_id` | text |
| reserved_for_bottles | `reserved_for_bottles` | bool |
| batch_number | `batch_number` | text |
| batch_source | `batch_source` | text — provenance enum |
| bag_weight_kg | `bag_weight_kg` | float |
| estimated_tablets_from_weight | `estimated_tablets_from_weight` | int |
| created_at | `created_at` | timestamptz |
| (none in TT) | `packaged_count` | derived from `submission_bag_deductions` (Phase 2 reconciliation) |

### `workflow_events` → `workflow_events`

TT stores `event_type` as free-text strings. Luma uses an enum.
The translation map (additive — unmapped types pass through verbatim
into payload):

| TT `event_type` | Luma `event_type` | Notes |
|---|---|---|
| `Card assigned` | `CARD_ASSIGNED` | direct |
| `Product mapped` | `PRODUCT_MAPPED` | additive enum |
| `Bag claimed` | `BAG_CLAIMED` | additive enum |
| `Station resumed` | `BAG_RESUMED` | direct |
| `Pause: <reason>` | `BAG_PAUSED` | reason → payload.reason |
| `Blister` | `BLISTER_COMPLETE` | direct |
| `Sealing` | `SEALING_COMPLETE` | direct |
| `Packaging` | `PACKAGING_SNAPSHOT` | direct |
| `Bottle handpack` | `BOTTLE_HANDPACK_COMPLETE` | direct |
| `Bottle sticker` | `BOTTLE_STICKER_COMPLETE` | direct |
| `Bottle cap seal` | `BOTTLE_CAP_SEAL_COMPLETE` | direct |
| `Variety Sources Assigned` | `VARIETY_SOURCES_ASSIGNED` | additive |
| `BAG_FINALIZED` | `BAG_FINALIZED` | already enum-shape |

`occurred_at` is a Unix-ms integer in TT; converts to Postgres
`timestamptz` via `new Date(ms)`. `payload` is JSON-text in TT; parses
as-is and stays JSON in Luma.

## Safety guarantees

1. **Idempotent.** Running the importer twice produces the same Luma
   state — no duplicate rows. Implementation: `legacy_tt_id_map` is
   the gate; existence of `(tt_table, tt_id)` skips re-insert and
   preserves the original UUID.
2. **Reversible.** Importer takes a Luma `pg_dump` snapshot first
   (via the existing snapshot infrastructure) before any writes. If
   the result looks wrong: restore the snapshot, fix the mapper, run
   again.
3. **Owner-gated.** Only `OWNER` role can trigger.
4. **Audited.** Every mapped row gets an `audit_log` entry with
   action `legacy_import.row` and the legacy table+id in
   `target_id`.

## Open questions deferred

- **Synthesized events from `warehouse_submissions`/`machine_counts`.**
  The 2,751 rows in those two tables ARE the real production history.
  Phase 1 stashes them verbatim; Phase 2 synthesizes Luma
  `workflow_events` from them so the read models (per-day throughput,
  per-operator productivity) light up against historical data. Until
  Phase 2 ships, the only metrics that rebuild from history are the
  ones that walk `workflow_events` directly.
- **Compressors as a real Luma table.** Currently `machines.kind`
  doesn't have a compressor relationship. Phase 2 adds a sidecar
  table.
- **Free-text `employee_name` on legacy submissions.** Maps to a
  Luma employee FK by exact-match name; mismatches stay as text in
  the stash table.
