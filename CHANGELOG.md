# Changelog

## [0.2.12] — 2026-05-21

### Fixed
- Receive pills page: Zoho readiness banner no longer shows `NEEDS_REAUTH` from the old direct-OAuth gateway. Readiness is now based solely on whether `ZOHO_SERVICE_BEARER_SECRET` and `ZOHO_SERVICE_BASE_URL` (or `ZOHO_INTEGRATION_URL`) are configured. Three-tier banner: "not configured" / "synced data available" / "no tablet POs yet".
- `validateAssemblyServiceConfig` now accepts `ZOHO_SERVICE_BASE_URL` as the preferred env var name, with `ZOHO_INTEGRATION_URL` as a backward-compatible fallback. Existing `.env` files using `ZOHO_INTEGRATION_URL` continue to work without changes.
- Dead `zohoReadiness` prop removed from `RawBagIntakeForm` (was received but never used).

## [0.2.11] — 2026-05-21

### Fixed
- Sidebar tests: updated 20 stale expectations from `1ce88c1` Settings hub restructure. Section names updated to "Operations" / "Oversight" / "Configure"; labels updated ("Pack-out", "Workflows", "Find lot / batch"); removed routes no longer in sidebar (/qr-cards, /standards, /workflow-validation, /settings/users); invoice allocations and Workflows placement assertions corrected. All 2093 tests pass.

## [0.2.10] — 2026-05-21

### Changed
- Raw bag intake PO sync now uses tablet-filtered endpoint (`?luma_tablet_only=true`). Only tablet POs are synced, stored, and shown in the intake dropdown.
- Intake PO dropdown badge updated to "N tablet POs" (was "N open/receiving POs").
- Sync banner: "Synced N tablet POs · N details · N lines" with anomaly flag count when any POs lack the `is_tablet_po` flag.

### Added
- `is_tablet_po` boolean column on `purchase_orders` (migration 0042, additive nullable). Set to `true` for all POs from the tablet-filtered endpoint; old POs remain null and are excluded from raw bag intake.
- `extractIsTabletPo()` pure helper in `inventory-service-client.ts` — reads `app_flags.luma.is_tablet_po`.
- `tabletOnly: boolean` option on `listInventoryPurchaseOrders()` — appends `?luma_tablet_only=true`.
- `nonTabletFlagged` counter in `PoSyncResult` — counts contract anomalies (POs from filtered endpoint without the flag set to true).
- 13 new unit tests: tabletOnly URL routing, extractIsTabletPo semantics, tablet-filtered po-sync behavior (2096 total).

## [0.2.9] — 2026-05-21

### Added
- Raw bag intake: per-row supplier lot number column. Each generated bag row inherits the setup-level supplier lot; operators can override individual rows before saving. Rows with a lot that differs from the setup lot get an amber highlight.
- Multi-batch intake: when rows have different supplier lot numbers, a separate `batches` row is upserted per unique lot. Each `inventory_bag` links to its lot's batch. No schema migration required.
- 8 new unit tests: `generateBagRowSeed` lot seeding + trimming + default; Zod schema per-row lot acceptance/rejection; `preflightRawBagIntake` row mapping (2083 total).

## [0.2.8] — 2026-05-21

### Fixed
- Zoho readiness banner: three-tier status model. Offline Zoho with local POs shows neutral "Using synced PO data from Luma" info message instead of alarming warning. Warning only appears when Zoho is offline AND no local POs exist.
- PO dropdown: removed `[OPEN]`/`[RECEIVING]` status tag from main option label — PO number + vendor is sufficient.
- Helper copy: "Pick a PO to choose the tablet line item being received." (was: "Pick a PO to see its line items as receive cards.")
- Zero-line empty state: improved copy — now mentions all three resolution options (sync, different PO, manual reference).
- Stale server action: `handleSave` and `SyncPoButton` now catch thrown errors and show "App updated — please refresh" instead of hanging indefinitely.

### Added
- Raw bag intake: per-row Remove (x) button. Removing an unsaved row frees its QR code from the pending submission; pool exhaustion warning updates automatically.
- Start Production: when a raw bag is looked up and has a QR card reserved at intake, that card is auto-selected in the QR picker and labelled "QR card assigned at intake for this bag." If the reserved card is unavailable, a warning is shown.
- 6 new QR edge-case unit tests: 10-row unique assignment, row removal QR freeing, pool exhaustion threshold, empty-pool null-fill (2072 total).

### Removed
- Section 3 bag rows title no longer shows duplicate "(N generated, N unsaved)" — now shows just the current count.

## [0.2.7] — 2026-05-21

### Added
- Raw bag intake: "Declared total" field replaces "Declared count per bag" — enter the total count across all bags; it is distributed evenly (remainder to first bags) via `distributeDeclaredTotal`.
- Raw bag intake: QR code auto-assignment from available `RAW_BAG IDLE` pool when generating rows (`assignQrCodesFromPool`). If the pool is smaller than the bag count, remaining rows have null QR and a warning banner is shown.
- Raw bag intake: weight per row entered in kilograms (stored as grams in DB). Column header changed to "Weight (kg)".
- Raw bag intake: QR cards are atomically reserved (`status = ASSIGNED`, `assignedWorkflowBagId = null`) within the same transaction as bag creation. Validation rejects non-RAW_BAG, non-IDLE, and unknown cards. Audit log entries written per reserved card.
- QR lifecycle: ASSIGNED+null workflowBagId is now treated as "intake-reserved" across floor scanner (`page.tsx`, `actions.ts`) and admin production-start (`page.tsx`, `actions.ts`), so intake-reserved cards proceed to production without requiring a status reset.
- `retireQrCard` now allows retiring intake-reserved (ASSIGNED+null workflowBagId) cards; only genuinely mid-production cards are blocked.
- `revalidatePath("/qr-cards")` added to `createRawBagIntakeAction` so QR Card Management immediately reflects reserved cards after a successful receive.
- 11 new unit tests: 6 for `assignQrCodesFromPool` (pool assignment, partial pool, empty pool, no-mutation) + 5 for kg/grams conversion contract.

### Removed
- "Default weight per bag (grams)" field from Supplier lot setup section — weight is now entered per-row in kg.

## [0.2.6] — 2026-05-21

### Added
- QR card type classification: new `qr_card_type` enum (`RAW_BAG`, `VARIETY_PACK`, `WORKFLOW_TRAVELER`, `UNKNOWN`) and `card_type` column on `qr_cards` (migration 0040). Existing cards with `bag-card-*` tokens are backfilled to `RAW_BAG`; `variety-pack-*` tokens to `VARIETY_PACK`.
- `scripts/repair-qr-inventory.ts` — idempotent script to seed physical card inventory: bag-card-1..200 (RAW_BAG) + variety-pack-1..5 (VARIETY_PACK). Run via `npm run repair:qr-inventory`.
- QR validation helpers in `lib/db/queries/qr-cards.ts`: `listAvailableRawBagQrCards`, `listAvailableVarietyPackQrCards`, `getNextAvailableRawBagQrCard`, `validateQrCardUsableForRawBag`, `validateQrCardUsableForVarietyPack` — each enforces type + status eligibility rules with exact rejection reasons.
- 14 unit tests for QR card validation helpers.

### Improved
- QR Card Management UI: per-type summary tiles (Raw bag / Variety pack), new filter tabs (All / Raw bag / Variety pack / Assigned / Idle / Retired / Unknown), type badge on each row, scan token shown in row, search includes scan token, print button scoped to idle raw bag cards.

## [0.2.5] — 2026-05-21

### Fixed
- PO line sync: `upsertLines` now skips lines whose Zoho status is `received`, `not_receivable`, or any unknown value. Only `to_be_received` and `partially_received` lines are inserted/updated in `po_lines`.
- Sync POs banner now shows full detail: "N POs · N details · N lines synced" so operators can confirm detail fetches and line upserts at a glance.

### Added
- TODO comment in po-sync.ts marking where `is_tablet_po` scoping will plug in once Zoho Integration exposes the normalized field.

## [0.2.4] — 2026-05-21

### Fixed
- PO sync now fetches line items: `syncPurchaseOrdersFromZoho()` calls the Zoho detail endpoint for every OPEN/RECEIVING PO and upserts `po_lines` rows keyed on `zohoLineItemId`. Lines auto-match to local `tabletTypeId` via `tablet_types.zoho_item_id`; unmatched lines store the Zoho item name + id in `notes`. Sync result now reports `lineUpserted`, `lineSkipped`, and `detailsFetched`.
- Raw-bag intake: empty-state message now directs users to the Zoho sync button rather than the inbound page.

## [0.2.3] — 2026-05-21

### Improved
- Packaging output page: MetricCard now supports `variant="light"` for the admin UI. All metric cards on the Packaging output page now use white/light-surface cards with proper contrast instead of dark `bg-slate-900` tiles. Floor-board MetricCards unchanged (still `variant="dark"` by default).
- Packaging output page: "Unknown" product label replaced with muted "—" dash in queue tables.
- Packaging output page: Added conditional note in queue section header when product name is blank (bag not yet mapped via PRODUCT_MAPPED event).
- Packaging output page: Removed spurious italic from empty-state text and null dash spans.

## [0.2.2] — 2026-05-21

### Added
- Zoho Integration inventory read client (`lib/zoho/inventory-service-client.ts`) — four GET functions: list purchase orders, get PO detail, search items, list warehouses. Injectable env/fetchImpl/timeoutMs; 32 tests.
- PO sync service (`lib/zoho/po-sync.ts`) — `syncPurchaseOrdersFromZoho()` upserts `purchase_orders` from Zoho via SELECT-then-INSERT/UPDATE. Terminal-status guard (RECEIVED/CLOSED/CANCELLED rows never downgraded). Duplicate zohoPoId guard. 17 tests.
- Receive-eligible status mapping: Zoho `issued`→`OPEN`, `partially_received`→`RECEIVING`, `received`→`RECEIVED`, `draft`→`DRAFT`, `cancelled`→`CANCELLED`.
- Admin sync action (`syncPurchaseOrdersFromZohoAction`) on the raw-bags receiving page — admin-gated, revalidates PO list on success.
- "Sync POs from Zoho" button in the raw-bags badge strip — shows fetched/upserted counts and errors inline.

## [0.2.1] — 2026-05-21

### Fixed
- PO dropdown in raw bag intake now sorts newest-first (`openedAt` desc) so most recent POs appear at the top.

### Improved
- PO option labels include vendor name and status badge for clarity.
- Badge strip shows count of open/receiving POs and a hint that draft/closed/cancelled POs are hidden.

## [0.2.0] — 2026-05-19

### Fixed
- PO dropdown in raw bag intake now filters out CLOSED and CANCELLED purchase orders.
- Machines & stations page: renamed "Cards / turn" column to "Units / cycle" to be accurate across all machine kinds (blister, bottle, sticker, sealing, packaging).

### Improved
- QR cards management: added status breakdown stat tiles (idle / assigned / retired counts), live search by label or UUID, and status filter tabs.
- Finished lots genealogy section: improved table layout and readability.
- Reports page: material burn section visual improvements including totals row.
- Admin footer: now shows semver version (`v0.2.0`) alongside git SHA and build date.

## [0.1.0] — 2026-05-18

Initial live-testing release.
