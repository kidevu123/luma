# Zoho live sync — implementation plan (ZOHO-0)

**Status.** Audit + plan only. No code, no DB writes, no live Zoho calls beyond a read-only `/organizations/{id}` probe.

**Authoring branch.** `production-intelligence-command-center`
**Authored.** 2026-05-14
**Replaces.** `docs/ZOHO_ITEM_SYNC_PLAN.md` (item sync only) — broader scope: items + customers + sales orders + purchase orders + finished-lot write-back. The earlier doc stays accurate for the item-sync piece; this doc is the umbrella.

This is the contract for the engineer who eventually wires the live Zoho sync. ZOHO-0 ends here — implementation lands in ZOHO-1 onward.

---

## 1. Current state audit

### 1.1 Code that exists today

| Path | Role | Status |
|---|---|---|
| `lib/zoho/client.ts` | Per-company OAuth client. `testConnection()` live (read `/organizations/{id}`); `createPurchaseReceive()` declared but throws "entity mapping not yet configured"; `refreshAccessToken()` live. | Foundation. Direct OAuth from app. |
| `lib/integrations/zoho/items.ts` | Contract for the Zoho items + inventory-snapshot sync. `listZohoItems()` / `listZohoInventorySnapshots()` throw `ZohoNotConfiguredError`. `upsertExternalItemMapping()` / `recordExternalInventorySnapshot()` / `mapZohoItemToLumaItem()` / `getZohoSystemId()` are live DB helpers. | Stubs + helpers. |
| `app/(admin)/settings/zoho/{page,form,actions}.tsx` | Owner-only credentials page (save + test). | Live; backed by `zoho_credentials` table. |
| `app/(admin)/settings/integrations/zoho-items/page.tsx` | Placeholder status page — counts on `external_item_mappings` + `external_inventory_snapshots`. | Live read-only page. |
| `lib/admin/snapshots.ts` | Includes `zoho_pushes` in the admin DB snapshot helper. | Live; metadata only. |
| `lib/db/queries/products.ts`, `packaging.ts`, `tablet-types.ts` | Surface `zoho_item_id` from master tables to admin pages. | Live; no writes back to Zoho. |
| Tests | `lib/production/product-structure.test.ts` asserts `listZohoItems` throws until live sync lands. | Green. |

### 1.2 Schema that exists today

**Credentials + push-status.**
- `zoho_credentials` (one row per company; columns: `organization_id`, `client_id`, `client_secret`, `refresh_token`, `access_token`, `access_token_expires_at`, `data_center`, `warehouse_id`, `is_active`).
- `zoho_pushes` (one row per finished-lot push; columns: `finished_lot_id`, `zoho_receive_id`, `zoho_overs_receive_id`, `status` (`PENDING|SUCCESS|FAILED|PARTIAL`), `pushed_at`, `last_error`, `attempts`, `amount_cents`).

**Inline external IDs on master tables.**
- `tablet_types.zoho_item_id text`
- `products.zoho_item_id text`
- `packaging_materials.zoho_item_id text`
- `purchase_orders.zoho_po_id text` + `purchase_orders` index `po_zoho_idx`
- `po_lines.zoho_line_item_id text`
- `customers.zoho_customer_id text` + partial index `customers_zoho_idx`

**Multi-system mapping foundation (preferred long-term home).**
- `external_systems` — registry; seeded with `ZOHO`, `PACKTRACK`, `NEXUS`, `QIP`.
- `external_item_mappings` — `(external_system_id, external_item_id) UNIQUE`; carries `luma_item_id` / `luma_product_id` / `material_item_id` / `mapping_type` (default `UNKNOWN`) / `payload jsonb` / `last_synced_at`.
- `external_inventory_snapshots` — append-only audit of what each upstream system reports.

**Items + conversions foundation (consumer of mappings).**
- `items` — polymorphic registry over `tablet_types` / `packaging_materials` / `products`, plus virtual `STANDALONE` items.
- `item_conversions` — generic "1 X contains N Y" ledger.

### 1.3 Environment variables

- `.env.example` defines `ZOHO_INTEGRATION_URL=http://192.168.1.190:9503`.
- `docker-compose.yml` passes `ZOHO_INTEGRATION_URL` through.
- `deploy/lxc/install.sh` mentions `ZOHO_INTEGRATION_URL`.
- **No TS code reads `process.env.ZOHO_INTEGRATION_URL`** (grep returns zero hits). The env var is currently dead.
- No `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` env vars — credentials live in `zoho_credentials`, not env.

### 1.4 What actually calls Zoho today

| Call | Used? | Endpoint |
|---|---|---|
| Token refresh | Yes, but only on demand when `testConnection` / `createPurchaseReceive` runs. | `${accounts}/oauth/v2/token` |
| `/organizations/{id}` (Test connection button) | Yes — admin can click "Test connection" on `/settings/zoho`. Read-only. | `${api}/organizations/{id}` |
| `createPurchaseReceive` | **Declared, never called.** Greps over `app/`, `lib/`, `scripts/` find no callers; the function throws "entity mapping not yet configured." | `${api}/purchasereceives` (planned) |
| Items / customers / sales orders / POs | **Not implemented.** Throws `ZohoNotConfiguredError`. | n/a |
| Periodic sync job (pg-boss) | **Not implemented.** No `zoho.*` handler in `lib/jobs/handlers/`. | n/a |

**Net.** Luma writes zero data to Zoho today. The only live traffic is the read-only `/organizations/{id}` probe from the owner-only "Test connection" button.

### 1.5 The `zoho-integration-service` (LXC 9503) question

CLAUDE.md states: *"Never bypass `zoho-integration-service` for Zoho calls."* `docs/phases.md` Phase 5 says push from a pg-boss job to that service.

**Reality:** the existing `lib/zoho/client.ts` does **direct OAuth** to Zoho's `accounts.zoho.com` and `zohoapis.com`. It does not go through LXC 9503. The `ZOHO_INTEGRATION_URL` env var is plumbed through docker-compose but unread.

This is the **single biggest open architectural question** for ZOHO-1. See §9 risks. Resolving it (direct OAuth vs LXC 9503 gateway) is a blocker before any live write phase.

### 1.6 What's already documented

- `docs/ZOHO_ITEM_SYNC_PLAN.md` — item-sync spec; correct but narrower than what ZOHO-2..6 will cover. Stays valid for the item-only piece.
- `docs/PRODUCT_STRUCTURE_AND_ZOHO_ITEMS.md` — explains the items / item_conversions / external_systems foundation. Useful for ZOHO-3.
- `docs/PACKTRACK_LUMA_INTEGRATION_PLAN.md`, `docs/PACKTRACK_SHORTAGE_RECOMMENDATIONS_PLAN.md`, `docs/ROLL_RECEIVING_AND_PACKTRACK_INTEGRATION.md` — PackTrack boundary; informs where Zoho-vs-PackTrack ownership lines fall for packaging POs.

---

## 2. Data ownership map

This phase clarifies who owns which object. Ownership = single source of truth. Other systems may cache or display, but never overwrite.

### 2.1 Zoho owns

- **Item catalog.** Every item Luma references — raw tablets, packaging materials, finished goods, sellable SKUs — has a canonical Zoho row. Item names, units of measure, item type, taxability, accounting links.
- **Customer master.** Customer code, billing/shipping address, payment terms, salesperson, custom fields.
- **Vendor master.** Vendor code, address, payment terms.
- **Sales orders.** SO number, customer, line items, dates, billing/shipping address, status.
- **Purchase orders for raw materials** (the tablet / pill side). PO number, vendor, line items, dates. *Status here is more nuanced; see §2.3.*
- **Inventory item IDs.** The opaque keys (`item_id`, `customer_id`, `salesorder_id`, `purchaseorder_id`) that Luma stores as foreign references.
- **Posted financial events.** Invoices, bills, receipts — these are Zoho-only by definition.

### 2.2 Luma owns

- **Production workflow.** workflow_events, workflow_bags, qr_cards, station_operator_sessions, stage progressions. *Zoho never sees these.*
- **Raw bag genealogy.** inventory_bags, finished_lot_raw_bags, internal_receipt_number, BAG-QR codes. *Receipt-pad codes are internal; never exposed to Zoho.*
- **Finished-lot trace codes** (FL-…). Customer-facing but minted by Luma; Zoho stores them only as a denormalised attachment / custom field if at all.
- **QC events.** PACKAGING_DAMAGE_RETURN, REWORK_SENT, SCRAP_RECORDED, SUBMISSION_CORRECTED, REWORK_RECEIVED. *Zoho-blind; QC drives Luma's internal yield/scrap math.*
- **Material consumption math.** Roll usage, BOM application, reconciliation buckets (PT-6), shortage recommendations (PT-7).
- **Read models + confidence metadata.** HIGH/MEDIUM/LOW/MISSING ladder, `confidence_*` fields, recall passport composition.
- **Internal item conversions.** `items` + `item_conversions` (cards-per-display, displays-per-case, pouches-per-case, etc).
- **OP-1 accountability.** entered_by_user_id vs accountable_employee_id. *Zoho has no concept of operator attribution.*

### 2.3 PackTrack owns

- **Packaging PO workflow** (the foil / PVC / shrink-film side, distinct from the tablet PO side that Zoho owns). PO creation, receiving boxes against PO lines, reorder approval workflow.
- **Operator-touched recommendation lifecycle** (acknowledge / dismiss / send).
- **Supplier-side roll metadata** that PackTrack manages directly (lot codes, mill dates).

**Boundary.** Zoho owns the *vendor record + the financial PO*; PackTrack owns the *receiving + reorder workflow against that PO*. The two systems referencing the same PO must use a stable shared key — the cleanest is `purchase_orders.po_number` (already unique in Luma) plus optional `zoho_po_id` + `packtrack_po_id` columns. *No automatic two-way sync between Zoho and PackTrack; Luma is the only system that joins them.*

### 2.4 Shared / read-mostly

- **`purchase_orders` table.** Luma is the read-mostly cache of Zoho's PO header for the tablet side, and the read-mostly cache of PackTrack's PO header for the packaging side. Luma writes `status` only when it changes through Luma's own lifecycle (CLOSED on full receipt); never overwrites Zoho's fields blindly.
- **`customers` table.** Luma writes `customer_code` (canonical) + reads `zoho_customer_id` / `nexus_customer_id` as external pointers. Customer name + address are denormalised from Zoho at sync time; Luma never edits them back.
- **`packaging_materials` / `products` / `tablet_types` `zoho_item_id` column.** Today this is the inline pointer to Zoho. Going forward, `external_item_mappings.luma_*` is the long-term home — but until live sync proves out, the inline column stays as a safety net.

### 2.5 Hard rules (enforced by code, not policy)

1. **Zoho NEVER overwrites Luma genealogy fields.** Workflow events, bag QR codes, internal receipt numbers, finished-lot trace codes, QC events — Zoho cannot touch these via sync. Period.
2. **Luma NEVER blindly overwrites Zoho master data.** Item names, customer addresses, vendor terms — if Luma needs them, it reads them and caches. Write-back is opt-in per-field, never bulk.
3. **Snapshots are immutable.** `external_inventory_snapshots` is append-only forever.
4. **Mapping defaults to UNKNOWN.** A new Zoho item arrives → it is *not* automatically linked to a Luma item. Admin must confirm.

---

## 3. Object mapping

### 3.1 Zoho Items → Luma

| Zoho field | Luma destination | Notes |
|---|---|---|
| `item_id` | `external_item_mappings.external_item_id` (system=ZOHO) | The opaque key Luma uses for every future lookup. |
| `sku` / `item_code` | `external_item_mappings.external_item_code` | Pretty key; may collide / change. Never the join key. |
| `name` | `external_item_mappings.external_item_name` | Cached for display. Updates on every sync. |
| `item_type` | `external_item_mappings.payload->>'item_type'` + drives `mapping_type` classifier | "inventory" + "sales" → SELLABLE_SKU; "inventory" → FINISHED_GOOD; "packaging" → PACKAGING_MATERIAL; "raw" → RAW_MATERIAL. Classifier is a *suggestion*, never authoritative. |
| `unit` | `external_item_mappings.payload->>'unit'` | Cached. |
| `is_taxable`, `tax_id`, accounting links | `external_item_mappings.payload` (verbatim jsonb) | Stored but never acted on. |
| (Luma admin maps to a `tablet_types` row) | `external_item_mappings.material_item_id` IS NULL + `luma_item_id` points at the `items` row whose `source_kind='TABLET_TYPE'` | Done in mapping UI. |
| (Luma admin maps to a `packaging_materials` row) | `external_item_mappings.material_item_id` = `packaging_materials.id` (+ `luma_item_id` for the parallel `items` row) | |
| (Luma admin maps to a `products` row) | `external_item_mappings.luma_product_id` = `products.id` (+ `luma_item_id` for the items row) | |

**Migration path for legacy inline `zoho_item_id` columns.** A one-off backfill copies every non-null `tablet_types.zoho_item_id` / `packaging_materials.zoho_item_id` / `products.zoho_item_id` into `external_item_mappings` with `mapping_type` pre-set to the appropriate value. Then code reads `external_item_mappings` and only falls back to the inline column for rows that haven't synced yet. Eventually (ZOHO-6+) the inline columns get dropped.

### 3.2 Zoho Customers → Luma

| Zoho field | Luma destination | Notes |
|---|---|---|
| `customer_id` | `customers.zoho_customer_id` | Already in schema. |
| `contact_name` | `customers.name` (insert-only; never overwrite if present) | Luma `customers` were seeded in LOT-1B; Zoho sync fills `zoho_customer_id` on existing rows by code match. |
| `display_name` / `company_name` | `customers.name` (fallback) | |
| `cf_*` custom fields (esp. supplier-lot-visibility opt-in) | `customers.supplier_lot_visible` IF a specific custom field is defined in Zoho | Optional, opt-in per Zoho org. |
| Billing/shipping address | cached in `external_item_mappings.payload` keyed by `zoho_customer_id` (no per-customer payload column today) | Future: dedicated `customer_external_snapshots` table if/when address sync is needed. *Out of scope for ZOHO-3.* |

**Match strategy.** First-pass match: Luma `customers.customer_code` ↔ Zoho `customer_code` (if Zoho has it as a custom field) or `display_name`. Admin reviews unmatched rows before any `zoho_customer_id` writes back to Luma.

### 3.3 Zoho Sales Orders → future demand / shipments

**Phase status:** ZOHO-4 only. Out of scope for ZOHO-1..3.

| Zoho field | Luma destination | Notes |
|---|---|---|
| `salesorder_id` | new column `shipments.zoho_sales_order_id text` (additive) | Tells Luma which SO each shipment was packed against. |
| `salesorder_number` | new column `shipments.zoho_sales_order_number text` (additive) | Display-only. |
| Line items (SKU + qty) | **No** Luma write. Demand surfaces in a read-only `/admin/demand` page driven directly off the latest Zoho SO snapshot. | Luma does not synthesise pay-period-style "demand records." |
| Customer | join via `customers.zoho_customer_id` | Already mapped in §3.2. |

**Why no demand table on Luma side:** keeping Zoho the single source of truth for "what we owe a customer" means there's nothing for Luma to drift on. Luma reads SOs at display time and shows them; it doesn't materialize them.

### 3.4 Zoho Purchase Orders → Luma purchase_orders / PackTrack

**Phase status:** ZOHO-4 only (read sync); write-back NEVER (see §4).

| Zoho field | Luma destination | Notes |
|---|---|---|
| `purchaseorder_id` | `purchase_orders.zoho_po_id` (already exists) | |
| `purchaseorder_number` | matched against `purchase_orders.po_number` for join (case-insensitive trim) | Conflict if Zoho PO number doesn't match an existing Luma PO. |
| `vendor_id`, `vendor_name` | denormalised into `purchase_orders.vendor_name` ONLY when Luma row has it null | Never overwrite an existing value. |
| `status` | `purchase_orders.status` (already exists) | **READ-ONLY into Luma.** Luma never pushes status back to Zoho. |
| Line items | `po_lines.zoho_line_item_id` (already exists) on a best-effort SKU/qty match. Unmatched lines surface as a "PO lines not reconciled" diagnostic on `/po-reconciliation`. | |

**PackTrack vs Zoho ownership.** A PO can be packaging-side (PackTrack handles receiving) or tablet-side (Zoho handles vendor relationship; Luma handles receiving). The decision is per-PO via an additional `purchase_orders.packtrack_managed boolean` flag (new, additive). When `true`, Zoho sync sees the PO but treats it read-only and renders a "PackTrack managed" badge. When `false`, the PO behaves like a normal Zoho-sourced raw-material PO.

### 3.5 Luma → Zoho write-back

**Default: nothing writes back.** Write-back is opt-in and gated by ZOHO-5.

Candidates (none implemented in ZOHO-0..4):
- **Finished-lot completion summary.** When a `finished_lots` row enters RELEASED, write a Zoho purchase_receive (against the Zoho finished-good item) so Zoho inventory reflects the produced quantity. Existing `zoho_pushes` table is built for this. *This is the original `createPurchaseReceive` use case.*
- **Finished-lot trace code as a Zoho custom field.** Stamp `finished_lots.trace_code` onto the corresponding Zoho purchase_receive row so customer-facing recall lookups work from inside Zoho.
- **Optional: finished-lot PDF attachment.** Attach the recall-passport PDF to the Zoho purchase_receive.

Strictly **not** in scope for any phase, ever:
- Pushing operator names, scrap counts, or QC events to Zoho.
- Updating Zoho item master from Luma (overriding names, units, types).
- Updating Zoho customer master from Luma.
- Deleting anything in Zoho.

---

## 4. Sync directions

### 4.1 Read from Zoho

| Object | Cadence | Persistence | Phase |
|---|---|---|---|
| Items | Hourly job; on-demand "Sync now" button | `external_item_mappings` upsert (no overwrite of non-null Luma refs) | ZOHO-2, ZOHO-3 |
| Inventory snapshots | Hourly | `external_inventory_snapshots` append-only | ZOHO-2 (dry-run), ZOHO-3 (apply) |
| Customers | Daily; on-demand "Sync now" button | `customers.zoho_customer_id` upsert on matching code/name | ZOHO-3 |
| Sales orders | On-demand initially; daily once stable | **No persistence** — live read against Zoho at display time. Optional cache via `external_item_mappings.payload` only if rate-limit becomes a concern. | ZOHO-4 |
| Purchase orders (tablet-side) | Daily | `purchase_orders.zoho_po_id` + `po_lines.zoho_line_item_id` upsert on PO-number match | ZOHO-4 |

### 4.2 Write to Zoho

**Default: NEVER.** Every write is opt-in per object, gated by ZOHO-5, behind a "Send to Zoho" button (no auto-push), with an idempotency key (Luma-side recommendation/finished-lot id passed as `x-luma-*` header), audit-logged, and reversible on the Luma side (set `zoho_pushes.status = 'FAILED'` and clear `zoho_receive_id` to allow retry).

| Object | When | Phase |
|---|---|---|
| Finished-lot purchase_receive | When `finished_lots.status` flips to RELEASED, admin clicks "Push to Zoho" | ZOHO-5 |
| Finished-lot trace code as Zoho custom field | Same trigger as above | ZOHO-5 |
| Finished-lot PDF attachment | Same trigger; admin-controlled checkbox | ZOHO-5 (optional, lower priority) |

**No automatic writes.** No CRON-driven Zoho mutations. Every write is operator-initiated.

---

## 5. ID strategy

### 5.1 Storage rules

For every Zoho-tracked object, Luma stores the opaque Zoho ID, never the display name as a key.

| Luma table | External ID column | Rule |
|---|---|---|
| `items` (via `external_item_mappings`) | `external_item_mappings.external_item_id` | Mandatory; unique with `external_system_id`. |
| `tablet_types` | `zoho_item_id` (legacy inline, plus `external_item_mappings.luma_item_id` going forward) | Keep both until ZOHO-6 cutover. |
| `packaging_materials` | `zoho_item_id` (legacy) + `external_item_mappings.material_item_id` | Same. |
| `products` | `zoho_item_id` (legacy) + `external_item_mappings.luma_product_id` | Same. |
| `customers` | `zoho_customer_id` | Already canonical. |
| `purchase_orders` | `zoho_po_id` | Already canonical. |
| `po_lines` | `zoho_line_item_id` | Already canonical. |
| `shipments` | new: `zoho_sales_order_id` + `zoho_sales_order_number` | Added in ZOHO-4. |
| `finished_lots` | new: `zoho_receive_id` (via `zoho_pushes`) — already exists | Used by ZOHO-5. |

### 5.2 Joins

- **All joins use the Zoho ID, never the SKU or name.** SKU as key fails when Zoho-side renames happen.
- **Mapping lookups go through `external_item_mappings` first**; only fall back to inline `zoho_item_id` if no mapping row exists yet (transitional path).
- **Conflict detection compares names + SKUs as a *diagnostic*, not as a join key.** If Zoho `item_id=X` was previously linked to Luma `material_item_id=Y` and now arrives with a totally different SKU + name, surface a "Zoho item renamed" warning rather than silently re-binding.

### 5.3 Provenance

Every row in `external_item_mappings` / `customers.zoho_customer_id` / `purchase_orders.zoho_po_id` carries a `last_synced_at`. Stale mappings (last_synced_at > 30 days ago) surface as "Stale mapping — Zoho item may have been deleted" warnings on the `/settings/integrations/zoho-items` page.

---

## 6. Conflict strategy

### 6.1 Per-event behaviour

| Event | Behaviour |
|---|---|
| **Zoho item renamed.** A row with the same `item_id` arrives with a new `name`. | Update `external_item_name` in the mapping. Do NOT touch the Luma master row's name. Log a `zoho.item.renamed` audit entry. |
| **SKU changed.** A row with the same `item_id` arrives with a new `sku`. | Update `external_item_code`. If the Luma side relies on inline `zoho_item_id` + a separate SKU match, surface a "SKU drift" diagnostic. |
| **Duplicate SKU.** Two Zoho items arrive with the same SKU (Zoho doesn't enforce SKU uniqueness universally). | Both get their own `external_item_mappings` row by `item_id`. Surface a duplicate warning so admin can reconcile inside Zoho. Luma does not pick a winner. |
| **Missing SKU.** A Zoho item has no SKU at all. | Mapping row still created (`external_item_code = NULL`). Mapping UI shows it; admin can decide to map or skip. Never silently drop. |
| **Inactive item.** Zoho `status = 'inactive'`. | Set `external_item_mappings.is_active = false`. Do not touch the Luma master row's `is_active` flag — Luma's activity is independent. |
| **Luma product already configured (legacy inline `zoho_item_id`).** Zoho sync arrives, finds the legacy id. | First sync creates the `external_item_mappings` row pointing to the existing Luma product. After that, the inline column is read-mostly until ZOHO-6 cutover. |
| **material_code mismatch.** Luma `packaging_materials.sku = "FOIL-25"` but Zoho `item_code = "FOIL25"`. | No automatic match. Admin maps manually via the UI. |
| **Customer duplicate.** Two Zoho customers with the same `customer_code`. | Both get their own row in some external snapshot table; Luma `customers` matches the first by alphabetic `display_name` and surfaces a "Customer duplicate in Zoho" warning. Manual reconcile. |
| **Sync failure (single object).** Network error for one item, success for the rest. | Skip the failed item, log the error, continue. `external_item_mappings.last_synced_at` does NOT advance for that row. Surface in a "Last sync had partial failures" notice. |
| **Sync failure (whole run).** Zoho returns 5xx or auth fails. | Mark the run as failed in the new `zoho_sync_runs` audit table (see ZOHO-1). Do not update any `last_synced_at` field. Production code keeps using the last successful sync. |
| **Refresh-token expired.** OAuth flow fails because refresh token was revoked. | Surface a banner on `/settings/zoho`: "Zoho refresh token expired — re-authorize." Owner re-pastes via the existing form. |
| **Rate limit (HTTP 429).** Zoho returns 429. | Honour `Retry-After`; back off exponentially. If three consecutive runs hit 429, mark the integration as `rate_limited` in the status page. |

### 6.2 Idempotency

- Every read sync is idempotent: re-running with no Zoho-side changes results in zero writes (because `last_synced_at` is the only column that updates and we can compare incoming timestamps).
- Every write sync is idempotent on a Luma-side key: the `x-luma-finished-lot-id` header (or equivalent for other write types). Re-sending the same payload produces the same Zoho row (Zoho-side dedup) and updates the same `zoho_pushes` row.

---

## 7. Safety rules

These are non-negotiable for the live phases:

1. **Dry-run first.** ZOHO-2 ships the read sync in *log only* mode — no writes to `external_item_mappings`, snapshots, or master tables. Admin reviews the proposed diff via `/settings/integrations/zoho-items`. ZOHO-3 flips the write switch only after the dry-run dataset is hand-validated against the live Zoho org.
2. **Idempotent sync.** Every sync run is re-runnable. No row is written twice; no row is silently mutated.
3. **No destructive deletes.** Zoho-side deletions never propagate into Luma. A Zoho item that disappears keeps its mapping row with `is_active = false` and a `deleted_in_zoho_at` flag (new column, additive in ZOHO-1).
4. **No blind overwrites.** Master-table fields (`tablet_types.name`, `packaging_materials.sku`, `products.name`, `customers.name`) are NEVER overwritten by sync. The mapping row carries the Zoho name; Luma master keeps its own.
5. **Full audit log.** Every sync run writes a `zoho.sync.start` / `zoho.sync.complete` / `zoho.sync.failed` row to `audit_log`. Every write-back (ZOHO-5) writes `zoho.finished_lot.push.start` / `zoho.finished_lot.push.success` / `zoho.finished_lot.push.failed`.
6. **Clear admin preview before applying.** Mapping UI shows: "Map this Zoho item to Luma product [SKU]?" with a confirmation button. No bulk auto-apply.
7. **`last_synced_at` everywhere.** Mapping rows, customer rows, PO rows. Stale (>30d) surfaces a warning.
8. **Confidence + source labels everywhere data is consumed.** A page reading `external_inventory_snapshots.quantity_on_hand` shows it with `MEDIUM` confidence (Zoho is a source of truth, but Luma can't verify the count) and a "Source: Zoho · last seen <date>" caption.
9. **Vault-quality storage for credentials.** `zoho_credentials.client_secret` + `refresh_token` are plaintext at rest today, protected by Postgres ACLs + audit log + mode-0600 `/etc/luma/.env`. ZOHO-1 evaluates whether to move them under the existing AES-GCM vault (`lib/crypto/vault.ts` in payroll-rebuild) — pending owner decision.
10. **No payload leakage in logs.** OAuth tokens, refresh tokens, and customer PII (addresses, emails) must never appear in OpenTelemetry traces, app logs, or Sentry payloads. Headers are redacted before logging.

---

## 8. Proposed phases

### ZOHO-0 — Audit + plan only (this document)

**Scope.** Document everything. No code. No live Zoho writes beyond the read-only `testConnection` probe.

**Deliverable.** This file.

**Stop condition.** File committed. Owner reviews and approves the boundary decisions in §2 before ZOHO-1 starts.

### ZOHO-1 — Config + status page + connectivity check

**Scope.**
- Decide the **direct-OAuth vs. LXC 9503 gateway** question (§9). Implementation differs significantly: gateway means `lib/zoho/client.ts` becomes a thin HTTP client to `${ZOHO_INTEGRATION_URL}/...`; direct OAuth means the current `lib/zoho/client.ts` stays.
- Add a `/settings/integrations/zoho` (note: distinct from existing `/settings/zoho` credentials page) status dashboard surfacing: connection state, last sync run, last sync errors, items/customers/POs counts, rate-limit status, refresh-token age.
- Add new tables (additive only):
  - `zoho_sync_runs` (id, kind enum `ITEMS|CUSTOMERS|SALES_ORDERS|PURCHASE_ORDERS`, started_at, finished_at, success, rows_synced, errors jsonb).
  - `zoho_sync_state` (singleton per kind; last_synced_at, next_due_at, paused boolean).
- Add a `deleted_in_zoho_at` timestamptz column on `external_item_mappings` (additive).
- New env var **only if** gateway path is chosen: `ZOHO_INTEGRATION_URL` becomes load-bearing. If direct OAuth wins, the env var stays dead and §1.3 documents that.
- Owner-only "Connection check" button on the new status page.

**Tests.** Unit tests for `zoho_sync_runs` writers + `zoho_sync_state` upsert. No live Zoho calls in tests.

**Stop condition.** New tables migrated on staging. Status page reachable. Owner confirms which gateway path lives in code.

### ZOHO-2 — Item + customer read sync (dry-run)

**Scope.**
- Implement `listZohoItems()` live.
- Implement a "list customers" helper (new file `lib/integrations/zoho/customers.ts` — does not yet exist).
- Add pg-boss handler `zoho.items.sync` and `zoho.customers.sync`. **Dry-run mode** writes nothing; logs the proposed upserts to `zoho_sync_runs.errors` (renamed `details` jsonb in ZOHO-1 or kept; tbd at implementation).
- Mapping UI on `/settings/integrations/zoho-items` shows the dry-run diff: "Would create N mappings, update M, leave K unchanged."
- Owner clicks "Run dry-run sync" to fire the job on demand.

**Tests.** Mock Zoho responses; assert the diff is computed correctly. No DB writes outside the audit table.

**Stop condition.** Dry-run produces a sensible diff against a real Zoho org (production owner runs it once on staging via the LXC). Owner reviews + signs off.

### ZOHO-3 — Apply item + customer sync with mapping review

**Scope.**
- Flip dry-run off. Live writes to `external_item_mappings` + `external_inventory_snapshots` + `customers.zoho_customer_id`.
- Mapping UI grows search, filter-by-mapping_type, "Map to Luma item" picker, "Mark as inactive" action.
- Customer UI on `/customers` (existing or new) shows linked Zoho customers + lets admin attach Zoho customers to Luma customers (the case where Luma has a customer Zoho doesn't, or vice versa).
- Background sync schedule turned on (items hourly, customers daily).

**Tests.** Idempotency tests (re-sync same data → no rows written). Overwrite-protection tests (admin sets `luma_product_id`; re-sync doesn't clear it).

**Stop condition.** Items and customers are syncing. Staging shows non-zero `external_item_mappings.mapped` count. Auth smoke 47/47.

### ZOHO-4 — Sales order + purchase order read sync

**Scope.**
- Implement `listZohoSalesOrders()` (new file `lib/integrations/zoho/sales-orders.ts`).
- Implement `listZohoPurchaseOrders()` (new file `lib/integrations/zoho/purchase-orders.ts`).
- Add a read-only `/admin/demand` page surfacing open SOs by product (live read, not materialised).
- Reconcile incoming POs against existing Luma `purchase_orders.po_number`. Surface unmatched PO numbers as diagnostic.
- Add `shipments.zoho_sales_order_id` + `shipments.zoho_sales_order_number` columns. Backfill is *blank* — only future shipments fill these (admin selects the SO when releasing a shipment).
- Add `purchase_orders.packtrack_managed boolean` to mark which POs are packaging-side (PackTrack workflow) vs tablet-side (Zoho/Luma workflow).

**Tests.** Mock SO + PO responses; assert reconciliation logic; assert no overwrite of `purchase_orders.status` when Luma side has CLOSED already.

**Stop condition.** Open Zoho SOs visible on `/admin/demand`. Recent POs linked to Luma rows.

### ZOHO-5 — Optional finished-lot write-back (purchase_receives + attachment)

**Scope.**
- Implement `createPurchaseReceive()` (replace the stub in `lib/zoho/client.ts`).
- Add `sendFinishedLotToZohoAction` — gated by acknowledged / status=RELEASED / mapping present / dry-run-passed / config present.
- Persist `zoho_pushes` row on success/failure (existing table).
- On `/finished-lots/[id]` add a "Push to Zoho" button (admin-only, with confirmation modal).
- Optional: PDF attachment of the recall passport (uses LOT-1E's payload).
- Idempotency header `x-luma-finished-lot-id` on every POST; same one re-sent does not duplicate the Zoho receive.

**Tests.** Mock receiver in-container (like `scripts/verify-pt7f.ts`). Happy path + 500 failure (preserves prior success) + duplicate-send (no Zoho duplicate).

**Stop condition.** A staging finished lot pushed end-to-end; `zoho_pushes.status = SUCCESS`; Zoho-side row visible to admin (manual check).

### ZOHO-6 — Staging verification + closeout

**Scope.**
- In-container harness (`scripts/verify-zoho.ts`) that exercises every sync direction against a mock Zoho receiver (no real org).
- Cutover of the inline `zoho_item_id` reads in `app/(admin)/products/`, `app/(admin)/tablet-types/`, `app/(admin)/packaging/` to read from `external_item_mappings` first, inline column as fallback.
- Drop the inline `zoho_item_id` columns once every read path has migrated (later PR).
- Closeout docs land in `docs/CURRENT_PHASE_STATUS.md` + `docs/CLAUDE_BUILD_QUEUE.md`.

**Stop condition.** Verify script exits 0. Auth smoke 47/47. Closeout doc committed.

---

## 9. Risks + open questions

### 9.1 Architectural risks (blockers — must resolve before ZOHO-1)

| # | Risk | Decision needed |
|---|---|---|
| 1 | **Direct OAuth vs. LXC 9503 gateway.** CLAUDE.md says go through the gateway; the actual code does direct OAuth and the `ZOHO_INTEGRATION_URL` env var is dead. | Pick one path before any live write phase. If gateway: rewrite `lib/zoho/client.ts` to be a thin HTTP shim; the `ZOHO_INTEGRATION_URL` becomes load-bearing. If direct: update CLAUDE.md to reflect reality and document why. |
| 2 | **Which Zoho org/entity to sync.** Owner may have multiple Zoho entities (Haute Nutrition Inc., separate consumer-facing brand, separate operating company). Sync today assumes a single org per Luma `companies` row. | Owner names the canonical Zoho organization_id. Multi-entity is out of scope for ZOHO-1..6. |
| 3 | **Credential storage.** `client_secret` + `refresh_token` are plaintext in `zoho_credentials`. Sufficient for now; the AES-GCM vault from payroll-rebuild exists but isn't ported. | ZOHO-1 decides whether to port the vault or accept the current posture (Postgres ACL + .env mode 0600 + audit log on every credential read). |

### 9.2 Trust risks (should resolve before any write phase)

| # | Risk | Decision needed |
|---|---|---|
| 4 | **Trust Zoho inventory quantities?** Zoho `quantity_on_hand` for packaging materials may be stale relative to Luma's PackTrack-managed counts. Luma should never use Zoho quantities for production planning. | Hard rule: Luma's PT-6 reconciliation reads only Luma's own counts. Zoho `quantity_on_hand` is informational on `/settings/integrations/zoho-items`. |
| 5 | **PackTrack remains the packaging PO owner.** ZOHO-4 reads POs from Zoho; PackTrack does too. Risk of double-reading the same PO. | The `packtrack_managed boolean` flag in §3.4 + §ZOHO-4 resolves this: ZOHO sync sees the PO but treats it read-only. |
| 6 | **Should Luma ever write production results back to Zoho automatically?** | No. ZOHO-5 only adds a *button*. No CRON-driven write. Confirmed in §4.2. |
| 7 | **Multiple companies / entities.** Schema has `companies` as a tenancy ready field, but no Luma org is multi-company today. | Out of scope for ZOHO-1..6. Schema accommodates it; sync code stays single-company. |

### 9.3 Operational risks

| # | Risk | Mitigation |
|---|---|---|
| 8 | **Refresh token gets revoked silently.** Sync starts failing; banner not seen. | Status page banner + (optional) email/push alert to owner via existing notification channels (payroll has push; Luma doesn't yet). |
| 9 | **Zoho API rate limits change.** Today's 100 req/min is documented; could change tier. | Conservative pagination + exponential backoff; cap sync runs at 50/min to leave headroom. |
| 10 | **Mapping drift over time.** Admin maps 500 items; six months later 30% are stale because Zoho-side SKUs got renamed. | `last_synced_at` + "Stale mapping" warning in the mapping UI surfaces this. |
| 11 | **A bad mapping silently corrupts a finished-lot push.** Wrong `zoho_item_id` → Zoho receive against the wrong item. | ZOHO-5 only fires after explicit owner click; the modal shows the resolved Zoho item name + SKU. Idempotency header allows reversal. |
| 12 | **Sync failures during owner's payroll-style "5-minute-a-week" workflow.** A failed Zoho sync should never block the rest of Luma. | Sync runs in its own pg-boss queue; failure does not block projector, finished-lot creation, or the floor PWA. |

### 9.4 Open questions (need owner input before ZOHO-1 starts)

1. **Direct OAuth or LXC 9503 gateway?** *(Blocker. The single highest-impact decision.)*
2. **Which Zoho organization_id is canonical for Haute Nutrition?** *(Owner provides at credential-save time; documented here for the record.)*
3. **Are packaging-material POs already in Zoho, or only in PackTrack?** If Zoho has them too, ZOHO-4 needs the `packtrack_managed` flag from day 1.
4. **Does the owner want push-to-Zoho automation, or only a manual button?** *(This doc assumes manual; confirm.)*
5. **Should `zoho_credentials.client_secret` + `refresh_token` move under the AES-GCM vault?** *(Affects ZOHO-1 scope.)*
6. **Are sales-order line items needed for production planning, or is the SO header enough?** *(Affects ZOHO-4 scope.)*
7. **Recall-passport PDF attachment to Zoho purchase_receive — yes or skip?** *(Affects ZOHO-5 scope; optional.)*

---

## 10. Stop condition for ZOHO-0

This document committed. Owner reviews §2 (ownership), §9.1 (architectural blockers), and §9.4 (open questions). Decisions on #1 (gateway vs. direct) and #2 (Zoho org) before ZOHO-1 kicks off.

No code lands in ZOHO-0. No `external_item_mappings` rows written. No `zoho_pushes` rows written. No Zoho API calls beyond the existing read-only `/settings/zoho` test button.
