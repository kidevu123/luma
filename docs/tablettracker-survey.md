# TabletTracker (legacy) — survey

Read-only reconnaissance of `https://sahilk1.pythonanywhere.com` performed
2026-05-05/06 with the temporary `admin` / `admin` credentials. **Nothing was
modified.** All data shown here was rendered to the admin user that creds are
gated for; admin sub-pages (`/admin/employees`, `/admin/config`,
`/admin/settings/machines`) require an additional in-app "admin unlock"
password and were not reachable.

---

## Stack guess

| Signal | Inference |
|---|---|
| `Server: PythonAnywhere`, `X-Clacks-Overhead: GNU Terry Pratchett` | Flask on PythonAnywhere (Werkzeug + uWSGI) |
| `<title>TabletTracker - Login</title>`, `meta name="csrf-token"`, hidden `<input name="csrf_token">`, session cookie name `session` with `itsdangerous`-style timestamp signature (e.g. `…afq17Q.L3lUMEzBToeOiGT7xOk_…`) | Flask + Flask-WTF (CSRF). Session cookie is the standard Flask `SecureCookieSession` (signed JSON, not server-side). |
| `/health` returns `{"status":"ok"}`; `/version` returns `{"title":"TabletTracker","version":"4.25.19","description":"Tablet manufacturing intake, warehouse submissions, Zoho integration, QR workflow, and PDF reporting (Docker / PythonAnywhere; CSRF, rate limits, migrations)."}` | Self-described stack. "migrations" + the verbose schema visible in JSON strongly imply **SQLAlchemy + Alembic** with a relational DB. Description says *Docker / PythonAnywhere* — both are supported targets. |
| `htmx.org@1.9.10` from unpkg, Tailwind v3-style classes (`text-[var(--wc-primary)]`), Lucide-ish SVG sprites, `chart.js@4.4.1` (only on `/reports`), `IBM Plex Mono` + `Inter` fonts, no Bootstrap, no jQuery | Modern hand-rolled UI: Flask-rendered Jinja templates + htmx for in-place fragment swaps + a fair amount of vanilla JS (the bottle-reservation, modal, scanner, repack-allocator code lives in inline `<script>` blocks). |
| Static asset URLs include `?v=4.25.19` cache-busting, and there is `/static/js/api-client.js`, `/static/js/modal-manager.js` | Single Flask app, no SPA bundler. Probably PythonAnywhere webapp deployment with a `static_files` mapping. |
| Inventory-side fields like `inventory_item_id: "5254962000004758398"` and `zoho_po_id`, `zoho_receive_id`, `zoho_receive_overs_id`, `zoho_receive_pushed`, plus settings buttons "Test Zoho Connection" / "Sync Zoho POs" / "Clear synced PO data" on `/admin` | First-class **Zoho Inventory** integration. POs and bag receives mirror Zoho item/po/receipt IDs. |
| CSP `script-src` allows `cdn.jsdelivr.net` + `unpkg.com` only | Vanilla Jinja with explicit, narrow CSP — no third-party SDKs (no Sentry, GA, etc. detected). |
| `console.error("Error toggling reservation")` and similar JS error handling, `csrfFetch()` helper | Hand-built DX — no framework like Vue/React in the browser. |

**DB guess:** can't see it directly (no `/admin/config` access), but the API
returns plain-integer primary keys, fully nested objects (PO → Receive → Box →
Bag → Submission), and a `/version` description that names "migrations" — this
is SQLAlchemy with **either MySQL (the PythonAnywhere default) or SQLite**. The
sheer schema size (15+ obvious tables, JSON-string columns like
`raw_materials_json`, `compressor_json`, `repack_bag_allocations`, `pill_count`)
and the fact that the app is also runnable in Docker per `/version` makes
**MySQL most likely** — PythonAnywhere's free/hobby tier ships MySQL by
default, and `MEDIUMTEXT` + JSON columns map well to what we see.

App version: **4.25.19** (visible on every page: `TabletTracker v4.25.19`).

---

## URL map

```
/login                                  Login form (POST same path)
/logout                                 Sign out
/                                       Redirects to /command-center

# Top nav (employee role = admin)
/production                             Manual data-entry forms (Full run / Bag Count / Bottles / Repack)
/receiving                              Shipments-received management (PO → receive → box → bag)
/submissions                            All submissions (auto-redirects to view=workflow)
  ?view=workflow                          Per-receipt workflow rows + history (default)
  ?view=warehouse                         Per-receipt collapsed warehouse rows
    &tab=packaged_machine                   Default tab (machine + packaging combined)
    &tab=bag                                Bag/blister submissions
    &tab=bottle                             Bottle submissions
    &show_archived=true                     Includes archived
    &sort_by=…&sort_order=…                 Sort-only
    &date_from=…&date_to=…&tablet_type_id=…&tablet_type_id_group=…&submission_type=…&receipt_number=…
                                            Filter
  /export                                 GET — text/csv attachment "submissions_<ts>.csv" (122 KB / 681 rows in seed)

/reports                                Reports & Analytics dashboard (single page; tabs swap client-side)
                                          Sections: Purchase order detail · Top flavors (packed displays in range) ·
                                          Selected flavor — daily packed displays · Packed vs received (by day) ·
                                          Packaging loss — ripped cards by flavor · Packaging loss trend ·
                                          Throughput (bag start → final output) · Counter error
                                          (sealing, blister, vs packed) · Workstation productivity from scan history

/command-center                         Live ops dashboard (status of every machine, current bags, etc.)
  ?tools=assign                           Tools panel: assign QR card to a bag
  ?tools=stations                         Tools panel: workflow station table + add/edit form
  ?tools=cards                            Tools panel: QR card table (state machine: idle/assigned/staged/active)
  ?tools=machines                         Tools panel: machine list (also editable here? not confirmed)
/command-center/ops-tv                  TV-mode dashboard ("Pill packing command center")
  ?tab=overview|blister|card|bottle|packaging|machines|bags|inventory|staging|alerts|analytics|team|materials
                                          (URL controls SSR-default tab; client-side JS swaps without reload)
/command-center/ops-tv/api/snapshot     GET JSON — full ops dashboard payload (552 KB; see "Reports / exports")

/workflow/staff/new-bag?return_to=command_center
                                        Form to assign a bag to a card by scanning
/workflow/station/<scan_token>          Kiosk view for a single station (operator UI). Tokens enumerated:
                                          seal-f0934efmlk3sf       (Sealing Station 1, machine 1)
                                          seal-57k4i4f31f89j23     (Sealing Station 2, machine 2)
                                          seal-57f02af31f89327a    (Sealing Station 3, machine 3)
                                          blister-adwe0b2c7ed0450  (Blister Room, machine 4)
                                          seal-13bf207b2e145ac7    (Packaging Station — yes, a packaging station re-uses the seal- prefix; station_id=5, no machine link)
                                          bottle-handpack-04ff…    (Bottle Packing Station, station_id=8)
                                          bottle-sticker-0e85…     (Bottle Stickering, station_id=10, Sticker Machine)
                                          bottle-seal-cecc…        (Bottle Sealer, station_id=9, "bottle sealer" machine)

/admin                                  Settings landing tile page
                                          Tiles: Employee Management · Product Configuration · Machine Settings
                                          Plus buttons: "Test Zoho Connection", "Sync Zoho POs", "Clear synced PO data"
/admin/employees                        REQUIRES admin-unlock password (separate from login). Not reached.
/admin/config                           REQUIRES admin-unlock password. Not reached.
/admin/settings/machines                REQUIRES admin-unlock password. Not reached.

# JSON APIs (read-only ones probed; all GET except where noted)
/api/csrf-token                         GET — { csrf_token }
/api/machines                           GET — array of machines with role, area, components, compressors, raw_materials
/api/tablet_types                       GET — flat list of 36 tablet types
/api/tablet_types/categories            GET — same, grouped by category
/api/bottle-products                    GET — bottle SKUs (subset of products)
/api/bags/reserved-for-bottles          GET — bags flagged for hand-pack
/api/po/<po_id>/receives                GET — full PO → receives → boxes → bags tree
/api/receive/<receive_id>/details       GET — single receive detail (boxes_view + products + shipment_batch_defaults + receive)
/api/submission/<id>/details            GET — single submission with bag_deductions[]
/api/submission/<id>/available_pos      GET — POs the submission could be re-assigned to
/api/submission/warehouse-edit-unlock-status  GET — {success, unlocked, needs_unlock, seconds_remaining}
/api/submissions/repack/eligible-pos    GET — open POs that can receive repack output
/health                                 GET — {status:"ok"}
/version                                GET — {title, version, description}

# JSON APIs that exist but are POST-only (probed → 405)
/api/submissions/machine-count          POST  (Full run / machine-count form)
/api/submissions/packaged               POST  (Bag Count form, packaging stage)
/api/submissions/bottles                POST  (Bottles form)
/api/submissions/repack                 POST  (Repack form)
/api/submissions/repack/preview         POST  (live allocation preview)
/api/submissions/production-combined    POST  (Full run alternate)
/api/submission/<id>/edit               POST  (admin warehouse edit)
/api/submission/<id>/admin_reassign     POST  (move submission to a different PO)
/api/submission/warehouse-edit-unlock   POST  (unlock 15-min admin edit window with password)
/api/bag/<id>/reserve-bottles           POST  (toggle reserved_for_bottles)
/api/bag/<id>/close                     POST  (close/reopen bag)
/api/bag/<id>/batch                     POST  (set batch_number)
/api/bag/<id>/weight                    POST  (set bag_weight_kg)
/api/bag/<id>/label-count               POST  (set bag_label_count)
/api/bag/<id>/push_to_zoho              POST  (Zoho receive sync)
/api/receiving/<id>/batch_info          POST  (set shipment-default batch numbers)
/api/purchase_orders/<id>               POST  (PO action — likely close/reopen)
/api/machine-count/by-receipt           GET — { receipt=… } query (returned 400 without)
/submit_count                           POST  (legacy quick-submit endpoint, still wired)
/admin/workflow-qr/station              POST  (add/edit/delete station)
/admin/workflow-qr/add-card             POST  (add QR card)
/admin/workflow-qr/edit-card-token      POST  (rename a card's scan token)
/admin/workflow-qr/release              POST  (release a card from its bag)
/admin/workflow-qr/remove-card          POST  (delete an idle card)
```

---

## Entities (inferred data model)

Names below are **legacy table-name guesses** with confidence; the JSON returned
by `/api/po/<id>/receives` and `/api/submission/<id>/details` exposes most
column names verbatim, so these are nearly authoritative.

### `purchase_order` (a.k.a. PO)
PO is the top-level intake unit. Synced from Zoho Inventory.

| Field | Type | Example |
|---|---|---|
| `id` | int PK | 76 |
| `po_number` | varchar | `"PO-00206"`, `"PO-00207-OVERS"` (suffix means a parent-PO returns/overage child) |
| `vendor_name` | varchar | `"CamDex LLC"`, `"Konig"`, `"Zenith DBA CSSD"`, `"TOPC"`, `"RMSD Group"`, `"Nabeel Vira"` (Nabeel is owner; OVERS POs are issued internally) |
| `internal_status` | enum | `"Issued" | "Partially Received" | "Received" | "Closed"` |
| `closed` | bool | computed; UI shows "Show closed POs (61)" |
| `ordered` | int | tablets ordered, e.g. 3,000,000 for PO-00206 |
| `damaged` | int | running damage tally |
| `good` | int | running good count (can go negative on OVERS POs!) |
| `remaining` | int | derived |
| `zoho_po_id` | varchar | `"5254962000003181057"` |

POs carry a `parent_po_id` for "-OVERS" children (visible in the
`zohoPushOvers.parent_po_id` JS payload).

### `receiving` (a.k.a. receive / shipment)
A single physical inbound shipment for a PO. A PO may have many receives; the
UI shows them under headings like `PO-00222 (3 receives)`.

| Field | Example |
|---|---|
| `id` | 65 |
| `po_id` → purchase_order.id | 76 |
| `po_number` (denormalized) | `"PO-00206"` |
| `receive_name` | `"PO-00206-1"` (auto-generated `<po>-<shipment#>`) |
| `shipment_id` | nullable |
| `received_date` | `"2026-04-24 12:15:29"` |
| `received_by` | `"System Administrator"` |
| `notes` | `"Updated: 65 box(es)"` |
| `delivery_photo_path` | local file path |
| `delivery_photo_zoho_id` | Zoho file id |
| `total_small_boxes` | 65 |
| `closed` | 0/1 |
| `status` | `"published" | "draft"` (UI verb "Move to draft") |
| `created_at` | timestamp |

### `small_box` (a.k.a. box)
Sub-unit of a receive. Each box has its own batch number default and a stack of
bags inside.

| Field | Example |
|---|---|
| `id` | 1111 |
| `receiving_id` → receiving.id | 65 |
| `box_number` | 1 (1-based, scoped to the receive) |
| `bag_count` | 2 (declared) |
| `total_bags` | 2 (computed) |
| `batch_number_default` | `"CA4GR16"` (nullable; falls through to bag-level) |
| `notes` | nullable |
| `created_at` | timestamp |

### `bag` (table likely `bags`)
The atom of inventory. Each bag of bulk tablets is the unit that gets weighed,
labeled, blistered/sealed/packaged, and finally drained. Bag IDs go up to
3149+ and are global.

| Field | Example |
|---|---|
| `id` | 3019 |
| `small_box_id` → small_box.id | 1111 |
| `box_number` (denorm) | 1 |
| `bag_number` | 1 (1-based, scoped to the receive's flat bag list — same flavor's bag 27 may live in box 6) |
| `tablet_type_id` → tablet_type.id | 21 |
| `tablet_type_name` (denorm) | `"Hyroxi Mit A - Purple Haze"` |
| `inventory_item_id` (Zoho) | `"5254962000002266140"` |
| `bag_weight_kg` | 6.26 |
| `estimated_tablets_from_weight` | 12274 (derived from weight × density) |
| `bag_label_count` | 20000 (the printed-on-the-bag declared count) |
| `pill_count` | nullable (manual override) |
| `original_count` | 20000 (snapshot) |
| `packaged_count` | 19784 (running tally; consumed by submissions) |
| `remaining_count` | 124 (derived; surfaced in `/api/bags/reserved-for-bottles`) |
| `batch_number` | `"CA4GR16"` |
| `batch_source` | `"shipment_default" | "box_default" | "bag_specific"` (provenance for the batch number) |
| `status` | `"Available" | …` (others not observed; `closed` flag ≠ status) |
| `reserved_for_bottles` | bool (set via `/api/bag/<id>/reserve-bottles`) |
| `closed` | bool (set via `/api/bag/<id>/close`) |
| `flavor_bag_number` | int (sequence-within-flavor, used in receiving form) |
| `zoho_receive_id`, `zoho_receive_overs_id`, `zoho_receive_pushed` | Zoho push state |
| `created_at` | timestamp |

`(box_number, bag_number)` is shown in receipts as `"PO-00206-1-23-21"` (po-receive-box-bag).

### `tablet_type`
The *raw bulk tablet*, before display/blister format. 36 known.

| Field | Example |
|---|---|
| `id` | 21 |
| `tablet_type_name` | `"Hyroxi Mit A - Purple Haze"`, `"FX MIT - Pineapple"`, `"FIX Energy 12ct"`, `"Pseudo Orange Madness"` |
| `category` | `"Hyroxi MIT A"`, `"FIX MIT"`, `"FIX MAX"`, `"FIX Energy"`, `"FIX Focus"`, `"FIX Relax"`, `"Hyroxi Regular"`, `"Hyroxi XL"` (and a Bottle/Variety category not in the GROUPS json) |
| `inventory_item_id` (Zoho) | `"5254962000002266140"` |
| `is_bottle_only` | 0/1 (e.g. FIX Energy 12ct is bottle-only) |
| `is_variety_pack` | 0/1 |
| `tablets_per_bottle` | nullable int |
| `bottles_per_pack` | nullable int |

### `product` (UI calls them "products")
A *finished* SKU. Maps to Zoho product. `/api/bottle-products` returns the
bottle-shaped subset; the Submissions CSV mixes blister and bottle products
under the same `product_name`. Card+blister products vs. bottle products are
distinguished by `is_bottle_product`.

| Field | Example |
|---|---|
| `id` | 43 |
| `product_name` | `"FIX MIT - Blue Magic 12ct"`, `"Hyroxi MIT A - Pineapple Express"`, `"FIX Energy 12ct"` |
| `tablet_type_id` → tablet_type.id | 34 |
| `tablet_type_name` (denorm) | `"FIX MIT - Blue Razz"` |
| `is_bottle_product` | 0/1 |
| `is_variety_pack` | 0/1 |
| `tablets_per_bottle` | 12 |
| `bottles_per_display` | 6 |
| `tablets_per_package` | (in submission detail) 4, 12, 20, etc. |
| `packages_per_display` | 12, 20 |
| `displays_per_case` | 20 |
| `variety_pack_contents` | nullable (string blob; format not directly observed but referenced) |
| `inventory_item_id` (Zoho) | `"5254962000004758398"` |

### `machine`
Physical equipment on the floor.

| Field | Example |
|---|---|
| `id` | 4 |
| `machine_name` | `"Blister Machine"`, `"Sealing Machine 1/2/3"`, `"Sticker Machine"`, `"bottle sealer"` |
| `machine_role` | `"sealing" | "blister" | "stickering" | "bottle"` (and possibly more) |
| `machine_category` | nullable |
| `area_name` | `"Blister Room" | "Production Room" | "Bottle Room"` (nullable) |
| `cards_per_turn` | int — drives blister/sealing output math (2, 3, 6) |
| `compressor` / `compressor_json` / `assigned_compressors` | array of `{id, compressor_name, status}` (e.g. `"Hart 2"`, `"Hyper Tough"`, status `"working"`) |
| `components` / `components_json` | array (empty in seed) |
| `raw_materials` / `raw_materials_json` | `["PVC","Foil"]` for the blister machine |
| `is_active` | 0/1 |
| `created_at`, `updated_at` |  |

There is also a separate `compressor` table inferred from the nested objects
(id, name, status). It is many-to-one to machine.

### `workflow_station` (a.k.a. station)
A *role-on-the-floor* attached to a machine (or unattached, like the bottle
hand-pack). Has its own scan token used to load the kiosk page.

| Field | Example |
|---|---|
| `id` | 1 |
| `label` | `"Sealing station 1"`, `"Blister Room"`, `"Packaging Station"`, `"Bottle Packing Station"`, `"Bottle Stickering"`, `"Bottle Sealer"` |
| `station_code` | `"M1" | "M2" | "M3"` etc., optional |
| `station_kind` | enum: `sealing | blister | packaging | bottle_handpack | bottle_stickering | bottle_cap_seal` |
| `station_scan_token` | unique string with prefix matching kind: `seal-…`, `blister-…`, `packaging-…`, `bottle-handpack-…`, `bottle-seal-…`, `bottle-sticker-…` (note: token prefix is **kind**-derived, but legacy data shows the Packaging Station with prefix `seal-13bf2…` — the prefix gate is enforced going forward, not on existing rows) |
| `machine_id` → machine.id (nullable) | 1 |
| `is_active` | inferred |

### `qr_card` (a.k.a. card / blister-card / bag-card)
A laminated/printed QR code that travels with a bag through the floor. The
"Card" here is a tracking artifact, not a sellable card-pack.

| Field | Example |
|---|---|
| `id` | 1 |
| `label` | `"Card 1"`, `"Test Card 1"` |
| `scan_token` | `"bag-card-1"`, `"test-code-1"` |
| `status` | `"idle" | "assigned" | "Sealing Station 3 · paused" | "Staging · before packaging"` (free-form display string composed from the assigned `workflow_bag_id`'s state) |
| `workflow_bag_id` → workflow_bag.id (nullable when idle) | 34 |
| `created_at` | inferred |

### `workflow_bag`
This is the **session/run** entity that ties a QR card to a physical bag and a
product mapping for the duration of a workflow. **Distinct from `bag`** — a
single physical bag can spawn multiple workflow_bags over time (claim → finish
→ later resume), and a workflow_bag is what the QR card "is" while it's
assigned.

| Field | Example |
|---|---|
| `id` | 63 |
| `bag_id` → bag.id | 3019 |
| `qr_card_id` → qr_card.id (nullable) | 1 |
| `product_id` → product.id | 43 |
| `tablet_type_id` → tablet_type.id (effective) | 21 |
| `receipt_number` | `"1893-30"` (auto-incrementing global; from the warehouse "receipt #" column) |
| `bag_name` | `"PO-00206-1-23-21"` (denormalized address) |
| `current_stage` | `"blister" | "sealing" | "packaging" | "bottle_handpack" | "bottle_stickering" | "bottle_cap_seal" | "staging" | "out_cards" | "out_boxes" | "finalized"` (mirrors flow.pipeline IDs) |
| `is_hand_packed` | bool (set when card-assigning a bottle bag) |
| `created_at`, `claimed_at`, `started_at` |  |
| `repack_bag_allocations` | JSON blob (see Submission below) |

### `submission`
The recorded **count event** at one stage. The CSV export and the
`/api/submission/<id>/details` JSON together expose ~70 columns. There is a
single `submissions` table that *unions* machine/blister/bag-count/packaging/
bottle/repack events via `submission_type`, with many columns being
mode-specific (most NULL for any given row). Rows are identified by a
sequential `id` (max ~1100 in seed) and surface as a "row" inside a workflow
bag.

`submission_type` ∈ `{"machine", "packaged", "bottle", "production", "repack"}`
(observed). The CSV uses `submission_type` directly; the legacy "Bag Count"
button likely produces type `production` per old code paths.

`count_status` ∈ `{"under", "match", "over", "no_bag"}` ("Under" / "Match" /
"Over" / "No Bag Label" in CSV).

Columns (loosely grouped):

- **Identity:** `id`, `created_at`, `submission_date`, `employee_name` (free text!), `submission_type`, `is_qr_synced`
- **Bag/PO link:** `assigned_po_id`, `po_number` (denorm), `receive_id`, `receive_name`, `received_date`, `bag_id`, `bag_number`, `box_number`, `receipt_number`, `shipment_number`, `po_closed`, `po_assignment_verified`, `po_verified`
- **Product link:** `product_name`, `tablet_type_id`, `tablet_type_used_name`, `bag_tablet_type_name`, `submission_tablet_type_name`, `category`, `inventory_item_id`, `vendor_name`, `zoho_po_id`
- **Bag label/measurements:** `bag_label_count`, `estimated_count_by_weight`, `tablets_per_package`, `tablets_per_package_final`, `packages_per_display`, `displays_per_case`
- **Machine (blister/sealing) outputs:** `machine_id`, `machine_name`, `machine_role`, `machine_cards_per_turn`, `cards_per_turn`, `cards_made`, `cards_remaining`, `press_count` (= `displays_made` for machine type), `tablets_pressed_into_cards`, `machine_blister_tablets_total`, `machine_sealing_tablets_total`, `machine_tablets_total`, `machine_good_count`, `machine_count_label` (label varies: "Presses" for blister, "Cards" for seal)
- **Bag-count / production:** `displays_made`, `packs_remaining`, `loose_tablets`, `loose_display_count`, `cards_reopened`, `singles_remaining`, `total_displays_made`
- **Bottles:** `bottles_made`, `bottles_remaining`, `bottle_sealing_machine_count`
- **Packaging:** `case_count`, `cases_made_total`, `packaged_tablets_total`
- **Repack:** `repack_machine_count`, `repack_vendor_return_notes`, `repack_bag_allocations` (JSON), `repack_allocation_version`
- **Aggregates:** `total_tablets`, `individual_calc`, `tablet_difference`, `bag_submission_tablets_total`
- **Workflow timing:** `bag_start_time`, `bag_end_time`, `station_start_time`, `station_end_time`
- **Status / flags:** `count_status`, `discrepancy_flag`, `needs_review`, `admin_notes` (free-text, multi-line — heavily used for tribal context)

`bag_deductions[]` (separate sidecar table, likely `submission_bag_deductions`)
holds the line-items when a packaging/repack submission consumes from multiple
source bags. Columns observed via the wire: bag_id, allocated_count, etc.
(empty for the seed submissions probed; structure inferred from `<h5>"Bag
deductions (${bagDeductions.length} bags used)"</h5>`).

### `workflow_event` / `submission_history`
Everything in the `/submissions?view=workflow` "Workflow history" table is
clearly stored — this is an event log keyed to `workflow_bag_id`. Observed
event types:

- `Card assigned`
- `Variety Sources Assigned`  (variety packs)
- `Product mapped`
- `Bag claimed`              (per station — same workflow_bag can be claimed by multiple stations concurrently!)
- `Station resumed`           (Resume)
- `Pause: <reason>`           (reason ∈ `end of day`, `material change`, `paused end of day`, `handoff`, `out of packaging hold`, `taken for delivery`, `operator change`)
- `Sealing` / `Blister` / `Packaging` / `Bottle sticker` / `Bottle cap seal` (Submit — i.e. counts entered)
- `Bag claimed → Sealing/Sealing/Packaging` etc.

Per-event columns observed: `occurred_at` (ms epoch in some places, ISO in
display), `event_kind`, `pause_reason`, `material` (e.g. `pvc`, `foil`,
`cards`, `boxes`), `station_id`, `station_label`, `count`, `cases`, `loose
displays`, `packs remaining`, `cards reopened`, `employee` (free text again).

### `employee`
Implied. Used as free text in submission and workflow_event rows
(`"Heimy"`, `"Jenifer"`, `"Joana"`, `"Athziri 🧚🏿‍♀️"`, `"Asly"`, `"Melissa"`,
`"Elvia"`, `"Cristy"`, `"Erika"`, `"Hilda"`, `"Jhakelin"`, `"Juan"`,
`"Raquel"`, `"Jessica"`, `"Jenny"`, `"seri"`, `"System Administrator"`,
`"Admin"`). Whether this resolves to an `employee` table or is just a string
is not observable from the UI; given there's a tile `Employee Management`
under `/admin`, there *is* an employees table. **Risk:** legacy submissions
store `employee_name` as a string, not a FK — names will need fuzzy matching
on import.

### `compressor`
Many-to-one to machine. `{id, compressor_name, status}` with `status ∈
{"working"…}`.

### `pause_reason` / `material` (likely just enums or settings rows)
Materials are free-form-ish (`"pvc"`, `"foil"`, `"cards"`, `"boxes"` observed)
but the UI offers preset buttons "Material change → pvc/foil/cards/boxes",
so likely an enum or a small lookup.

### `setting` / `app_config`
The `/admin/config` page exists (gated). Observed config buttons:
"Test Zoho Connection", "Sync Zoho POs", "Clear synced PO data" → there is
a settings table holding Zoho API credentials, possibly also the admin-unlock
password (which is checked via `/api/submission/warehouse-edit-unlock`).

### `audit_log`
Implied by the existence of admin-unlock with a 15-minute window and the
"Notes" panel that appears next to "Edit Submission". Structure not
observed.

### `zoho_*` mirror tables
Likely a `zoho_sync` table or columns for: po push state, receive push state,
overs push state, item id mapping. Already enumerated as denormalized columns
on `bag` and `purchase_order`.

### Relationship summary

```
purchase_order   1 ─── n   receiving
receiving        1 ─── n   small_box
small_box        1 ─── n   bag
bag              1 ─── n   workflow_bag      (via reuse over time)
workflow_bag     1 ─── n   submission        (one per stage event)
workflow_bag     1 ─── n   workflow_event    (claim/pause/resume/submit log)
workflow_bag     n ─── 1   qr_card           (a card is on at most one bag at a time;
                                              QR card has a release/reassign cycle)
workflow_bag     n ─── 1   product           (product_id = the SKU shape)
bag              n ─── 1   tablet_type
product          n ─── 1   tablet_type
workflow_station n ─── 1   machine           (nullable)
machine          1 ─── n   compressor
submission       n ─── 1   workflow_bag
submission       n ─── m   bag               (via submission_bag_deductions for repacks/multi-source)
```

---

## Workflows

### Card-driven workflow ("QR workflow")

This is the **primary** mode going forward. The Production page even says:
*"Use Full run on this page or the QR workflow for station-driven tracking."*

Observed end-to-end on receipt **1893-22** (PO-00206, box 1, bag 24, "Hyroxi
MIT A - Pineapple Express", labeled bag, 5000 tablets per bag... wait, total
27,208 → it's a 30k bag yielding 1,628 displays):

```
Time (UTC)            Event                Station                                Details
2026-05-05 18:24:49   Card assigned        —                                      QR card → workflow_bag
2026-05-05 18:38:53   Product mapped       Blister Room (blister)                 Product chosen
2026-05-05 18:38:53   Bag claimed          Blister Room (blister)                 Operator scans into station
2026-05-05 18:55:42   Blister              Pause: material change                 count: 479, employee: Heimy, material: pvc
2026-05-05 18:56:00   Station resumed      Blister Room (blister)
2026-05-05 19:15:05   Blister              Pause: material change                 count: 167, employee: Heimy, material: foil
2026-05-05 19:15:20   Station resumed      Blister Room (blister)
2026-05-05 20:13:58   Blister              Submit                                 count: 772, employee: Heimy   ← total presses 1,418
2026-05-05 20:58:55   Bag claimed          Sealing station 1 (sealing)            (parallel — same workflow_bag picked up by 2 sealers)
2026-05-05 21:00:58   Bag claimed          Sealing Station 3 (sealing)
2026-05-05 21:31:53   Bag claimed          Packaging Station (packaging)          (and packaging starts before sealing finishes!)
2026-05-05 21:53:00   Sealing              Pause: end of day                      count: 47,  employee: Jenifer
2026-05-05 21:56:42   Sealing              Pause: end of day                      count: 364, employee: Joana
2026-05-05 22:20:53   Packaging            Pause: paused end of day               cases: 3, loose displays: 15, packs remaining: 0,
                                                                                  cards reopened: 0, employee: Melissa
```

Key observations:

1. **A single workflow_bag is "claimed" by multiple stations concurrently.**
   The blister station pushes blister cards → those cards flow physically to
   the sealing stations and the packaging table; the same QR card is the
   identity for all of them. Pause/resume/submit events are scoped per
   `(workflow_bag_id, station_id)`.

2. **"Submit" closes a stage's count but doesn't end the bag.** A bag can keep
   flowing into the next stage. There's no single "complete" flag visible.
   When all stages have submitted, the receipt's `Stage` column simply shows
   the highest stage reached (`Packaging` for 1893-22, `Blister` for the
   blister-only 1893-30).

3. **Pauses carry semantic reasons.** `material change`, `end of day`, `out of
   packaging hold`, `paused end of day` (separate from `end of day`!),
   `handoff`, `taken for delivery`, `operator change` — all observed on the
   kiosk button row: *"Resume / Pause / End run / Taken for delivery / Out of
   Packaging hold / Operator change / Material change / End run · finish bag /
   Pause · handoff / Scan bag QR / Confirm verification"*.

4. **Counts are per pause/resume cycle, not cumulative.** Every Submit/Pause
   event records the count entered since the last Resume. The workflow row's
   "Entered Counts" column shows e.g. `claimed×4, blister×3, seal×2, pkg×1` —
   a histogram of event types, not a single total.

5. **The "+ row" UI on the warehouse view is also writable.** "Edit
   Submission" modal lets an admin (after warehouse-edit-unlock) re-enter
   counts retroactively. Any edit goes to a 15-min window per browser.

6. **Variety packs** have their own claim event: `Variety Sources Assigned`.
   The variety pack form (`/workflow/staff/new-variety-run`) takes
   `source_card_tokens` as a textarea — an operator scans the source bag QRs
   that fed the variety. Bag deductions are recorded against the variety
   workflow_bag.

### Bottle workflow (3-stage parallel)

Observed on receipt **1893-36** (Hyroxi MIT A - Variety Pack):

```
14:48:43  Card assigned         —
14:48:43  Variety Sources Assigned  —
14:56:27  Bag claimed           Bottle Packing Station (bottle_handpack)
14:56:57  Bag claimed           Bottle Stickering (bottle_stickering)
14:57:13  Bag claimed           Bottle Sealer (bottle_cap_seal)
15:14:38  Bottle sticker        Pause: end of day               employee: Athziri
15:15:12  Bottle cap seal       Pause: end of day               count: 1, employee: Athziri
16:01:12  Station resumed       Bottle Stickering
…
```

Three bottle stations in series (handpack → stickering → cap-seal). Counts
recorded only at cap-seal in this trace (`bottle seal 1, 461, 528, 1079`).

### Manual ("Production page") workflow

Independent of QR. The `/production` page hosts four forms (tabs), each posting
to its own `/api/submissions/<kind>` endpoint:

| Tab | Endpoint | Inputs |
|---|---|---|
| Full run | `POST /api/submissions/production-combined` (or `/api/submissions/machine-count`) | machine_id, count_date, product_id, bag_number, box_number, receipt_number, bag_start_time, bag_end_time, displays_made (= presses), packs_remaining, damaged_tablets, tablets_pressed_into_cards, machine_admin_notes, packaged_admin_notes |
| Bag Count | `POST /api/submissions/packaged` | employee_name, tablet_type_id_group, tablet_type_id, box_number, bag_number, actual_count, admin_notes |
| Bottles | `POST /api/submissions/bottles` | employee_name, product_id, bag_number, box_number, displays_made, bottles_remaining, bottle_sealing_machine_count, receipt_number, admin_notes |
| Repack | `POST /api/submissions/repack` (preview via `/api/submissions/repack/preview`) | employee_name, po_id, receipt_number, repack_machine_count, repack_vendor_return_notes, submission_date, plus N "lines" each with category/product and a quantity (the JS allocates counts back across source bags via `repack_bag_allocations` JSON) |

The Repack preview endpoint exists separately (`/api/submissions/repack/
preview`) so the operator sees the proposed bag deduction before committing.

### Receiving workflow

`/receiving` lists POs grouped by Active vs Closed, expandable:

```
PO-00222 (3 receives)  TOPC
  PO-00222-3   [Move to draft] [Change PO] [Close] [Delete]
    Boxes: 1...N  → bags inside (clickable to view bag detail)
  PO-00222-2   …
  PO-00222-1   …
```

The "Add Receives" button drops a giant nested form whose `name` attributes
follow the pattern `box_<n>_bag_<n>_<field>` and `box_<n>_batch_number`,
posting to `/api/save_receives` (action url referenced in HTML). Per-bag
fields editable in the form: `tablet_type_group`, `tablet_type`, `bag_count`
(legacy column for "tablets in this bag"), `bag_specific_batch_number`,
`bag_weight_kg`, `flavor_bag_number`. The `box_N_batch_number` is the
shipment-default fallback. Per-bag actions after the receive is published:
**Batch**, **Weight**, **Label qty**, **Push to Zoho** (per bag); receive-level
**Push to Zoho receives** also exists.

### Inventory deduction

Yes. Confirmed by `/api/bags/reserved-for-bottles` which shows
`packaged_count` and `remaining_count` per bag, both moving with each
submission. The Repack flow's `repack_bag_allocations` JSON column is what
ties a single submission to N source bag deductions; for normal packaging
submissions, the JS uses `bag_deductions` array on the submission detail.

The deduction math is **denormalized into `bag.packaged_count`** and the
`workflow_bag` carries through-and-through totals. There is no
double-entry/event-sourced ledger — it's an upsert on bag.packaged_count plus
a row in `submission_bag_deductions` for traceability.

---

## Reports / exports

**CSV — `/submissions/export`** (no params required; honors current
filter/sort/tab if passed). Returns `text/csv; Content-Disposition:
attachment; filename="submissions_<YYYYMMDD_HHMMSS>.csv"`. 22 columns:

```
Submission Date, Created At, Employee Name, Product Name, Submission Type,
Machine, Tablet Type, PO Number, PO Closed, Box Number, Bag Number,
Displays Made, Packs Remaining, Bottle Sealing Machine Count, Loose Tablets,
Cards re-opened, Total Tablets (Individual), Cumulative bag (packaged),
Bag Label Count, Count Status, PO Assignment Verified, Admin Notes
```

Seed export contains 681 rows from 2025-09-02 to 2026-05-05.

**JSON — `/command-center/ops-tv/api/snapshot`** (552 KB). Aggregated dashboard
payload — *not* the raw row store but a precomputed view with everything
needed for the live TV: `kpis`, `flow.pipeline`, `flow.bottleneck`, `machines`
(per-machine session/bag/product/output/cycle), `bar_by_station`, `chart_*`
(24-hour series), `flavor_breakdown`, `idle_pct_by_station`, `highlights`
(`best_station`, `lowest_output_station`), `pill_board` (OEE donut, lifelines,
inventory of 508 entries, downtime, cycle_analysis), `mes` (lanes, alerts,
metrics_inputs, KPIs).

This snapshot is the **only realtime aggregation endpoint reachable**. It
includes a full `inventory[]` with every available bag's `(po_number, sku,
quantity, units, status, vendor_name, workflow_bag_id, bag_id)` plus
`inventory_po_options` enumerating 23 active POs.

**Charts on `/reports`** (Chart.js): Top flavors (packed displays in range);
Selected flavor — daily packed displays; Packed vs received (by day);
Packaging loss — ripped cards by flavor; Packaging loss trend — ripped cards
by day; Throughput (bag start → final output); Counter error
(sealing/blister vs packed) — table with columns `Step | Tablets (error) |
Error % (tablets) | Blisters/cards (error) | Error % (cards)`; Workstation
productivity from scan history. **No "Download CSV/PDF" button visible on
/reports** — these tabs are screen-only. `/version` mentions PDF reporting
though, so a PDF endpoint likely exists but is not linked from the admin
seed account.

**No `/admin` exports** observed because the admin sub-pages were locked.

---

## Open questions for the owner

1. **Admin unlock password.** All Settings drilldowns (Employee Management /
   Product Configuration / Machine Settings / Zoho config) require an in-app
   password separate from `admin/admin`. Without it I can't see the canonical
   employee table, product CRUD, or the Zoho connection settings page. Need
   that password (one-time, will rotate after) **or** a DB dump.

2. **DB engine.** MySQL or SQLite? PythonAnywhere supports both, the schema
   would migrate cleanly either way, but row counts (681 submissions, 3,000+
   bags) suggest the live system might still fit in SQLite. We need a copy of
   `tablettracker.db` or a `mysqldump`.

3. **Machine vs Station.** The data says they're separate tables (a station
   can be unlinked from any machine — e.g. "Bottle Packing Station" has no
   machine_id) but operators on the floor probably use them interchangeably.
   Should Luma collapse them, or preserve both?

4. **`employee_name` is a string.** Submission rows store names like `"Heimy"`,
   `"Athziri 🧚🏿‍♀️"`, `"seri"`. Is there a real `employee` table to FK back to?
   The `/admin/employees` tile says yes. Need confirmation that legacy
   string-name rows can be matched to real employee IDs (likely fuzzy/manual
   for the 50-ish historical rows).

5. **`receipt_number` (1893-22, 6340-9, etc.) — what is the prefix?** Looks
   like `<global_seq>-<bag_seq_within>`, but I see both `1893-30` (modern QR
   workflow) and `6340-9` (older) — different prefixes might be different
   counters (PO-scoped? Machine-scoped?). Need clarity.

6. **Variety packs.** `is_variety_pack=1` products and the `Variety Sources
   Assigned` event imply a join table holding the consumed source bags for a
   variety run. The column `variety_pack_contents` exists on product but is
   null for everything in the seed. Is the "what's in this variety" defined
   on the product or recorded per-run?

7. **OVERS POs (`PO-00207-OVERS`, `PO-00195-OVERS`).** These are issued to
   vendor `"Nabeel Vira"` (the owner) with parent_po references. They're a
   Zoho push-back for overage. Do they need to flow through Luma the same
   way, or are they a Zoho-only artifact?

8. **`submission_type` enum.** I observed `machine`, `packaged`, `bottle`,
   `production`, `repack`. Are there others (`bag_count`, `qr_event`)?
   Sealing seems to use `machine` with `machine_role=sealing`; blister also
   uses `machine` with `machine_role=blister`. The column is doing double
   duty.

9. **Pause reasons.** Free text or enum? Observed: `material change`,
   `end of day`, `paused end of day` (distinct from `end of day`),
   `out of packaging hold`, `handoff`, `operator change`, `taken for
   delivery`. Owner's intended set?

10. **Compressor table.** Needs confirmation as a real table vs a JSON
    column on machine. The API exposes both `compressor_json` (string) and
    `compressor[]` (parsed) and `assigned_compressors[]`, suggesting the
    column is JSON but there *is* a separate `compressor` table the
    `assigned_compressors` are joined from.

11. **Submission `tablet_type_id`.** On many submissions this is `null` even
    though `submission_tablet_type_name` is populated (a denormalized string).
    Migration target: derive `tablet_type_id` from the name when null.

12. **PDF reporting.** `/version` description mentions PDF reporting, but no
    PDF link was findable in the UI for the admin user. Does the owner
    actually use PDFs or is it dead code?

---

## Migration risks

1. **Counts can be retroactively edited under a 15-minute admin-unlock
   window.** That means the historical rows in the seed are *not* immutable.
   Any importer that snapshots once will potentially miss late corrections.
   Either drop the unlock feature in Luma or design Luma's import as a
   diff-replay rather than one-shot.

2. **The `submissions` table is a wide union.** ~70 nullable columns, mode-
   specific. Mapping cleanly into Luma's likely-event-sourced model means we
   have to fan it out into one table per event type (`blister_event`,
   `seal_event`, `packaging_event`, `bottle_event`, `repack_event`) — or
   mirror the union in Luma. Either way, expect **lots of NULLs and a hard
   choice early**.

3. **Free-text employee_name.** ~20 distinct names, some with emojis
   (`"Athziri 🧚🏿‍♀️"`). If we FK to a real `employees` table, we'll need a
   per-row mapping that the owner blesses. Several rows have *no* employee
   recorded; some have `"Admin"` / `"System Administrator"` as catch-alls.

4. **Free-text `admin_notes` and pause reasons.** Heavily used for tribal
   info: `"machine count missing or got deleted - packaging count already
   exists"`, `"receive 156-2-1-5 system will not assign to receive since it
   has been closed."`, `"start bag 2"`, `"1 damage"`, name-tag prefixes
   (`"1/27 Heimy"`). Cannot be discarded; preserve verbatim.

5. **`receipt_number` collisions across counter regimes.** The data has
   `receipt_number` like `1893-30` (modern), `6340-9` (mid-era), `247`
   (oldest). These are not naturally globally unique under any single rule;
   you'll need to compose a synthetic primary key
   `(po_id, shipment, box, bag)` and keep `receipt_number` as a label.

6. **Workflow_bag identity is not 1:1 with bag.** A physical bag can be
   re-claimed multiple times (after a card release, etc.). Luma's bag-state
   model needs to support multiple "sessions" per bag.

7. **Multiple stations claim the same workflow_bag concurrently.** The
   sealing+packaging stations all hold the same workflow_bag at once. The
   data model is `workflow_bag.claims[]` (or join table workflow_bag_claim);
   "current_stage" is a derived rollup, not a single field.

8. **`packaged_count` denormalized on bag.** The legacy app updates
   `bag.packaged_count` directly on each submission. If Luma uses a clean
   ledger, the import has to *both* (a) seed the ledger from
   submission_bag_deductions, (b) reconcile the resulting balance against
   `bag.packaged_count` and surface any drift to the owner. Drift will exist.

9. **Zoho IDs are mandatory glue.** `inventory_item_id`, `zoho_po_id`,
   `zoho_receive_id`, `zoho_receive_overs_id`, `zoho_receive_pushed`,
   `delivery_photo_zoho_id` are denormalized into many tables. We must
   preserve all of them or the next Zoho push will create duplicates.

10. **JSON-blob columns.** `repack_bag_allocations`, `compressor_json`,
    `components_json`, `raw_materials_json`, `variety_pack_contents`. These
    are SQL strings in the legacy schema. Validate-and-typecheck on import.

11. **Stations' scan tokens are immutable in URLs.** The kiosk page is
    `/workflow/station/<token>`. The Packaging Station's token starts with
    `seal-` (legacy mismatch with its real `station_kind=packaging`). The
    UI's `Edit` form even warns that prefixes must match going forward — so
    we can keep legacy tokens but new tokens get prefix-validated.

12. **No cascade-aware delete in legacy.** There are `Delete` buttons on
    submissions, bags (under "Remove" on idle cards), receives. They almost
    certainly soft-delete (status flag) rather than hard-delete; behaviour
    not verified. Importer needs to honor a `deleted_at` / `is_archived`
    column if one exists, otherwise we'll resurrect ghost rows.

13. **Time zones.** `bag start (Eastern)` is in the warehouse view header,
    but the workflow_event timestamps come back as `… UTC` and the
    submission `Created At` strings are naive (`"2026-04-24 12:15:29"`, no
    TZ). Almost certainly stored as UTC and rendered in `America/New_York`
    on the front-end. Pin this on import.

14. **`PO-00207-OVERS` and similar negative-`good` POs** indicate the
    overs-PO accounting can produce arithmetic that doesn't balance against
    received quantities. Need a reconciliation pass on import.

15. **Admin sub-pages not crawled.** Anything held under `/admin/employees`,
    `/admin/config`, `/admin/settings/machines` is invisible. Treat the
    inferred employee/setting/machine schemas as best-effort until we get
    DB access or the unlock password.
