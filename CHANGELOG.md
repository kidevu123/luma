# Changelog

## [0.4.0] — 2026-05-27

### Added
- **Declared pill count on bag edit (RECEIVE-EDIT-2B-2):** Supervisors (`requireLead`) can correct a bag’s declared pill count from `/inbound/[receiveId]/bag/[bagId]/edit`. Updates `inventory_bags.declared_pill_count` only; live `pill_count` is unchanged. Audited under existing `inventory_bag.edit` with `declaredPillCount` in before/after snapshots. Bag edit history and `/reports/audit-log` show a readable “Declared pills” diff. Blocked when the bag is in production (notes-only policy).

### Tests added (RECEIVE-EDIT-2B-2)
- `lib/db/queries/bag-edits.test.ts` — production guard for declared pill count.
- `lib/receive/bag-edit-history.test.ts` — declared pills diff line.
- `app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.test.ts` — parsing and validation.
- `app/(admin)/inbound/[id]/bag/[bagId]/edit/bag-edit-form.test.ts` — structural guards (no `pill_count` writes).

## [0.3.9] — 2026-05-27

### Fixed
- **Floor product dropdown shows product names only (PRODUCT-DROPDOWN-1):** The product select shown after scanning a bag at a first-op station was rendering `{sku} — {name}` (e.g. `LUMA-fix-beyond-cocoa-cal-6Q2PS — FIX Beyond - Cocoa Calm`). Floor operators only need the product name. Also fixed the "Making:" chip on the active-bag panel which showed `Making: SKU — Name`. Both now show product name only. No filtering, scan, or QR lookup logic changed.
- **Build fix — Button variant (from RECEIVE-EDIT-2B-1):** `app/(admin)/inbound/[id]/page.tsx` used `variant="outline"` which is not a valid variant for the Luma Button component. Changed to `variant="secondary"`.

### Tests added (PRODUCT-DROPDOWN-1)
- `PRODUCT-DROPDOWN-1 · floor product select shows name only` — 2 structural tests.
- `PRODUCT-DROPDOWN-1 · floor Making chip shows name only` — 2 structural tests.

## [0.3.8] — 2026-05-27

### Added
- **Receive notes and open/close edit (RECEIVE-EDIT-2B-1):** Supervisors (`requireLead`) can edit receive-level notes and mark a receive open or closed from `/inbound/[id]/edit`. Only `receives.notes` and `receives.closed_at` are updated; PO, shipment, receive name, bags, and batches are unchanged. Changes are audited as `receive.edit` on target `Receive` with before/after snapshots of notes and closedAt. Receive detail page includes a secondary **Edit receive** link.

### Tests added (RECEIVE-EDIT-2B-1)
- `lib/db/queries/receive-edits.test.ts` — patch builder for notes and open/close.
- `app/(admin)/inbound/[id]/edit/page.test.ts` — structural guards (editable scope, requireLead).
- `app/(admin)/inbound/[id]/edit/actions.test.ts` — requireLead enforcement and delegation.
- `app/(admin)/inbound/[id]/page.test.ts` — Edit receive link on detail page.
- `lib/audit/audit-log-view.test.ts` — receive.edit display in audit log viewer.

## [0.3.7] — 2026-05-27

### Added
- **Admin audit log viewer (AUDIT-LOG-1):** Read-only `/reports/audit-log` page for supervisors (`requireLead`). Shows the latest 100 `audit_log` rows with time, actor, action, target, compact summary, and per-row details expansion (human-readable lines + collapsed before/after JSON). Optional filters: action substring, target type, actor email substring. Sidebar link under Reports.

### Tests added (AUDIT-LOG-1)
- `lib/audit/audit-log-view.test.ts` — summary formatting helpers.
- `app/(admin)/reports/audit-log/page.test.ts` — structural guards for page, filters, nav.

## [0.3.6] — 2026-05-27

### Fixed
- **PostgresError 22P02 crash on floor bag scan (FLOOR-SCAN-ERROR-2):** Scanning any bag QR whose `scanToken` is a slug (e.g. `bag-card-117`) caused a Server Components render error overlay (digest `2676337210`) after the camera decoded the code. Root cause: `lookupCardByTokenAction` used `or(eq(qrCards.scanToken, token), eq(qrCards.id, token))` unconditionally. When `token` is a slug, Drizzle passes it as the `$2` parameter to the UUID-typed `id` column, and PostgreSQL throws `invalid input syntax for type uuid: "bag-card-117"` (22P02). Fix: added a `UUID_RE.test(token)` guard — non-UUID tokens only hit `scanToken`; UUID-format tokens (legacy labels printed before QR-SCAN-PAYLOAD-1) continue to search both columns. Also wrapped the DB query in try-catch so any future unexpected DB error surfaces as an inline error rather than an RSC overlay.

### Tests added (FLOOR-SCAN-ERROR-2)
- `FLOOR-SCAN-ERROR-2 · non-UUID scan token does not hit UUID column` — 4 tests in `scan-card-form.test.ts`:
  - DB query wrapped in try-catch with `return { error }` (not rethrow).
  - Non-UUID slug returns `ok` when card found by `scanToken`.
  - Non-UUID slug returns not-found error when no card.
  - UUID-format token (legacy label) still resolves via both columns.
- Updated `QR-SCAN-PAYLOAD-1 · lookupCardByTokenAction dual lookup` test 1 to assert `UUID_RE.test(token)` gate instead of unconditional `.where(or(`.

## [0.3.5] — 2026-05-27

### Fixed
- **Server Components render error after floor scan (FLOOR-SCAN-ERROR-1):** Scanning a bag QR at the Blister Hand Pack Station (and any station that renders or imports the QC panel) showed the Next.js "An error occurred in the Server Components render" overlay immediately after a successful scan. Root cause: `qc-actions.ts` and `app/(admin)/qc-review/actions.ts` both exported `__testInternals` (a plain object) from a `"use server"` file. Next.js App Router validates "use server" module exports during RSC renders triggered by `router.refresh()` — any non-async export throws digest `2276167736` at runtime. The initial page load used a cached module evaluation that bypassed the check; `router.refresh()` (called after `scanCardAction` succeeds) performed a fresh RSC fetch that triggered the validation. Fix: removed both `__testInternals` const exports. The private `assertNoLinkedConflict`, `loadLinkedEventAccountability`, and `hasExistingResolution` functions remain in their respective files for internal use.

### Tests added (FLOOR-SCAN-ERROR-1)
- `FLOOR-SCAN-ERROR-1 · use-server file export guard` — 5 structural tests in `scan-card-form.test.ts`:
  - `qc-actions.ts` starts with `"use server"`.
  - `qc-actions.ts` does not export `__testInternals`.
  - `qc-actions.ts` does not export any plain `const` object.
  - `admin/qc-review/actions.ts` does not export `__testInternals`.
  - `admin/qc-review/actions.ts` does not export any plain `const` object.

## [0.3.4] — 2026-05-27

### Added
- **Per-bag edit history on receive detail (RECEIVE-EDIT-2A-1):** `/inbound/[id]` now loads `audit_log` rows for each inventory bag on the receive. The bags table shows an **Edits** column (`No edits` / `N edits` linking to history). Below the table, an **Edit history** section uses expandable panels per bag with timestamp, actor, action label, and readable before/after summaries (weight in kg, receipt #, QR token, notes, supplier lot). Related `qr_card.released_at_bag_edit` and `qr_card.reserved_at_bag_edit` rows are included when they match scan tokens from bag edits. Read-only — no change to edit behavior.

### Tests added (RECEIVE-EDIT-2A-1)
- `lib/receive/bag-edit-history.test.ts` — audit summarization and grouping.
- `app/(admin)/inbound/[id]/page.test.ts` — structural guards for audit fetch and history UI.

## [0.3.3] — 2026-05-27

### Improved
- **Receive detail post-save edit discoverability (RECEIVE-EDIT-AUDIT-1):** Confirmed bag edit workflow is fully implemented at `/inbound/[id]/bag/[bagId]/edit` (weight, notes, receipt #, QR scan token, supplier lot, edit reason, audit log). Receive detail bags table now includes a short helper explaining post-save edits, renames the row action to **Edit bag**, and labels the actions column. No backend or schema changes.

### Tests added (RECEIVE-EDIT-AUDIT-1)
- `app/(admin)/inbound/[id]/page.test.ts` — structural guards for edit route link, helper copy, kg display.

## [0.3.2] — 2026-05-27

### Fixed
- **Camera scan input blank after scan (FLOOR-SCAN-LIVE-1):** Two bugs caused the scan input to appear empty after a camera QR scan.
  1. `handleResolvedToken` had no `catch` block. If `lookupCardByTokenAction` threw (DB error, network failure, Next.js serialization error), the exception propagated silently — `setScanInput` never ran and no error was displayed. The form appeared unresponsive.
  2. `setScanInput` was only called *after* the server lookup completed. During the roundtrip (~100–500 ms) and on the auto-submit path (where `router.refresh()` fires immediately), the input showed only the placeholder text. Operators had no visible confirmation of what was scanned.
- **Fix:** Raw scan token is now set in the input immediately when the scan starts (before the server round-trip). On successful lookup, it is overwritten with the human-readable bag label and the green confirmation chip. On error, the raw token remains so operators can verify the QR payload.
- **`?debug=1` diagnostic mode:** Appending `?debug=1` to any floor station URL logs the raw camera-decoded QR value to the browser console (`[floor-scan] camera decoded: ...`). Use this to diagnose QR encoding issues in the field without polluting normal operation.

### Tests added (FLOOR-SCAN-LIVE-1)
- `handleResolvedToken sets scanInput to raw.trim() immediately — before lookup` (index-order guard).
- `handleResolvedToken has catch block` — confirms `} catch (err) {` exists within `handleResolvedToken` body and calls `setScanError`.
- `handleCameraResult logs decoded QR value to console when ?debug=1 is set in URL`.

## [0.3.1] — 2026-05-27

### Added
- **`npm run audit:product-zoho-readiness` (PRODUCT-MAP-3):** Runs the read-only `scripts/audit-product-zoho-readiness.ts` fleet audit. Requires `DATABASE_URL`.

### Improved
- **Zoho readiness banner copy (PRODUCT-MAP-3):** Product detail banner now uses compact labels (`Zoho ready`, `Zoho mapping incomplete`, `Zoho IDs missing`, `Inactive product`) via `zohoReadinessShortLabel`. Long-form labels remain in `zohoReadinessLabel` for tooling.
- **Audit script output (PRODUCT-MAP-3):** Lists product name, SKU, kind, and ID on every row; prints ready/inactive buckets; section headers match banner vocabulary.

### Tests added (PRODUCT-MAP-3)
- Long unit ID (>60 chars) in `zohoItemIdUnit` → READY (assembly columns accept 100 chars; legacy `zoho_item_id` back-sync limit does not affect readiness).
- `zohoReadinessShortLabel` compact copy (4 assertions).

No schema changes. No Zoho outbound write behavior changes. No floor/station/camera/QR scan changes.

## [0.3.0] — 2026-05-27

### Changed
- **Camera scan is now the primary floor workflow (FLOOR-SCAN-UX-2):** After a successful QR scan (camera or typed), the scan input now shows the bag card's human label (e.g., `bag-card-117`) instead of going blank. A green confirmation chip appears below showing the full resolved context: card label, PO number, bag number, and tablet type. Operators have immediate visual confirmation of what was scanned without touching the dropdown.
- **Dropdown is explicitly backup-only:** The dropdown comment and surrounding hint text clarify that physical QR scanning is the primary path. The dropdown exists for recovery scenarios only.
- **Enter-on-resolved-input submits:** After a camera or typed scan resolves a card, pressing Enter in the scan input submits the workflow (or shows a product-required error) rather than trying to re-scan the label text.
- **Typing invalidates resolved card:** If an operator edits the scan input after a resolved scan, the resolved state clears and the next Enter triggers a fresh lookup.

### Internal
- `lookupCardByTokenAction` now returns `cardLabel: string` (from `qrCards.label`) alongside `cardId`.
- Source-text guard tests added for the scan confirmation lifecycle and the `cardLabel` return value.

### Version rationale
v0.3.0 (not a patch): this completes the camera scan as the trusted primary production floor path. Without visual confirmation, operators default to the dropdown and camera scanning is not viable in practice. With it, camera scan is the production-validated primary workflow.

## [0.2.49] — 2026-05-26

### Fixed
- **QR label payload mismatch (QR-SCAN-PAYLOAD-1):** Printed bag QR labels were encoding `qrCards.id` (the UUID primary key), but `lookupCardByTokenAction` was matching by `qrCards.scanToken` (a separate column). Every physical scan — camera or USB/Bluetooth barcode scanner — silently returned "Bag QR not found." New labels now encode `qrCards.scanToken`, the correct lookup key. The floor scan lookup now also accepts `qrCards.id` as a backward-compatible fallback so labels printed before this fix continue to resolve (TODO: remove the id fallback once all legacy labels are retired/reprinted).
- **Floor station footer version metadata:** The station page footer now shows `v{version} · {sha} · {branch}`, matching the admin UI. Operators and supervisors can confirm which deployed version is running on floor tablets.

### Tests added (QR-SCAN-PAYLOAD-1)
- Source-text guard: `lookupCardByTokenAction` uses `or()` wrapping both `scanToken` and `id` clauses.
- Source-text guard: QR label page calls `renderQrSvg(r.card.scanToken)` — not `r.card.id`.

## [0.2.48] — 2026-05-26

### Added
- **Zoho product readiness helper (PRODUCT-MAP-3):** Pure `classifyProductZohoReadiness` in `lib/zoho/product-zoho-readiness.ts`. Classifies active products as READY / PARTIAL / MISSING based only on configured Zoho item IDs (`zohoItemIdUnit`, `zohoItemIdDisplay`, `zohoItemIdCase`). Floor readiness (tablet mapping) is a separate concern, not mixed into the Zoho level. `zohoReadinessLabel` and `zohoReadinessReasonLabel` provide UI copy.
- **Zoho readiness banner on product detail page (PRODUCT-MAP-3):** A compact `ZohoReadinessCard` banner appears inside the existing Zoho assembly mapping card on each product detail page, showing the product's Zoho readiness level, specific missing IDs, and a separate note if tablet mapping is absent. Supervisors can see at a glance whether a product can generate valid Zoho assembly payloads.
- **`scripts/audit-product-zoho-readiness.ts` (PRODUCT-MAP-3):** Read-only CLI script. Prints a grouped summary: total/active/ready/partial/missing/inactive counts, per-product missing Zoho IDs, floor readiness gaps, and BOM materials missing Zoho item IDs. Usage: `DATABASE_URL=postgres://... tsx scripts/audit-product-zoho-readiness.ts`. Run before enabling Zoho dry-run or live writes.

### Tests added (PRODUCT-MAP-3)
- `lib/zoho/product-zoho-readiness.test.ts` (13 tests): inactive early-return, unit-only READY/MISSING, unit+display PARTIAL/READY/MISSING, unit+display+case READY/PARTIAL/MISSING, tablet mapping separation, legacy field contract.

## [0.2.47] — 2026-05-26

### Fixed
- **Camera scanner stuck on spinner on HTTPS (CAMERA-SCAN-ROOTCAUSE-1):** The `<video>` element was rendered inside `{phase === "scanning" && ...}`, making `videoRef.current` null when the `getUserMedia` promise resolved during the "starting" phase. The `if (video)` check failed silently — the OS granted camera access but `.play()` was never called and `setPhase("scanning")` was never reached. Scanner stayed on the spinner forever even on HTTPS/public URL. Fixed by always rendering the video element in the DOM and toggling visibility via a CSS `hidden` class, so `videoRef.current` is non-null when the async stream arrives.

### Added
- **Camera diagnostics panel (CAMERA-SCAN-ROOTCAUSE-1):** When the camera fails to start, a compact diagnostics panel now appears inside the scanner error UI. Shows operator-friendly status for: HTTPS secure context, Camera API availability, camera permission (denied/granted), hardware BarcodeDetector support or jsQR fallback, and whether the camera stream started. Helps operators and supervisors identify whether the issue is HTTPS, permissions, or browser support.
- **`lib/floor/camera-diagnostics.ts`:** Pure helpers `classifyCameraCapabilities` (injectable, testable) and `getStaticCameraDiagnostics` (reads browser globals for React use).

### Tests added (CAMERA-SCAN-ROOTCAUSE-1)
- `lib/floor/camera-diagnostics.test.ts` (5 tests): HTTP context, HTTPS + all APIs, iOS Safari (no BarcodeDetector / jsQR handles), Android Chrome, always-true jsQrFallback invariant.
- Structural camera-scanner invariants (9 tests added to `scan-card-form.test.ts`): video DOM fix (CSS hidden, not conditional render), `setStreamStarted(true)`, `setPermissionDenied(true)`, `CameraDiagnosticsPanel` in error phase, HTTPS diagnostic label, camera permission label, stream-stop in BarcodeDetector path, stream-stop in jsQR path.

## [0.2.46] — 2026-05-22

### Fixed
- **Zoho item ID no longer requires double-entry (PRODUCT-MAP-2):** The product creation dialog was writing the "Zoho item ID (single unit)" value to `products.zoho_item_id` (legacy column) instead of `products.zoho_item_id_unit`. After creation, the mapping page pre-filled from the fallback with a "Save to confirm" hint, forcing supervisors to click Save a second time. Fixed by changing the dialog field `name` to `zohoItemIdUnit` and adding the same `zohoItemId` back-sync already present in `zoho-mapping-actions.ts`.

### Improved
- **Canonical Zoho item ID labels (PRODUCT-MAP-2):** The product creation dialog and Zoho mapping form now use consistent labels: "Zoho item ID — single unit", "Zoho item ID — display", "Zoho item ID — case". Removed the "display & case IDs coming soon" placeholder (both fields have been supported since ZOHO-ASSY-1).
- **Floor readiness card on product detail (PRODUCT-MAP-2):** A compact status banner now appears on every product detail page showing one of: "Ready for floor selection" (active + has at least one tablet mapping), "Missing tablet mapping — floor selection unavailable" (active + no mappings), or "Inactive — cannot be assigned to new production runs". Links supervisors to the BOM section when configuration is needed.

### Tests added (PRODUCT-MAP-2)
- Dialog field correctness (4 tests): `zohoItemIdUnit` field name, no stray `zohoItemId` input, fallback defaultValue for old products, correct label.
- `saveProductAction` back-sync (4 tests): derives legacy `zohoItemId` from `zohoItemIdUnit` — short value, >60 chars, null, and not-submitted.
- Mapping form canonical labels (4 tests): unit/display/case labels match spec.
- Floor readiness classification (3 tests): ready / missing-tablet / inactive states.
- Floor compatibility contract (6 tests): product with no tablet mapping excluded when type known, all products shown when type null, zero-match config error, single-match auto-select, multiple-match narrowed picker.

## [0.2.45] — 2026-05-22

### Fixed
- **Floor scan: `narrowProducts` test function corrected (FLOOR-SCAN-1):** The `narrowProducts` helper in `scan-card-form.test.ts` was testing a more permissive filter rule (treating `allowedTabletTypeIds=[]` as "accepts all tablet types") than the actual production code (`filteredProducts` excludes products with an empty `allowedTabletTypeIds` array — intentionally marked as incomplete configuration). The test function and the "shows unmapped product regardless of scanned tablet" assertion are corrected to match actual behavior, with an explanatory comment.

### Improved
- **Floor scan form wording (FLOOR-SCAN-1 Task 6):** Typed scan input placeholder changed from "Scan or type bag QR…" to "Scan bag QR…". Dropdown backup optgroup labels updated to "Received bags available for this station" and "Received bags available for this station — start new run".

### Tests added
- **FLOOR-SCAN-1 · downstream station fresh-bag guard** (4 tests): structural checks that `actions.ts` defines `FRESH_BAG_STATION_KINDS`, blocks non-first-op stations from starting fresh bags, rejects IDLE cards with "Receive Pills" message, and blocks RETIRED cards.
- **FLOOR-SCAN-1 · camera scanner HTTPS requirement** (5 tests): verifies `camera-scanner.tsx` checks `window.isSecureContext`, shows "Camera access requires HTTPS. This page is served over HTTP" on insecure context, shows browser-unsupported fallback, links to typed input, and routes camera decode result through the same `onResult` handler as typed scan.
- **FLOOR-SCAN-1 · typed scan flow structural guards** (5 tests): confirms `handleResolvedToken` narrows products by tablet type ID before auto-submit decision, verifies the scan-resolved card path (`resolvedCardId`, `scannedTabletTypeId`) works for cards not in the server-rendered dropdown, and confirms zero-product config error is shown (no silent no-op).

## [0.2.44] — 2026-05-22

### Improved
- **Legacy receive wizard title corrected (UI-POLISH-4):** The `/inbound/new` legacy wizard page title was "New receive", implying it is the normal receive entry point. Renamed to "Legacy receive wizard" with an updated description ("Supervisor fallback only. For normal tablet intake use Receive pills; for packaging use Receive packaging."). The amber warning banner and links to the correct pages were already in place from a prior fix; this aligns the page heading with that message.

### Audit findings (no further changes needed)
- "Pack-out" wording: only in code/JSX comments in `packaging-output/page.tsx`; all user-visible labels already say "Production output" or "Output queue".
- "Purchase orders" tab: already renamed "Receives".
- "Receive another batch" button: already navigates to `/receiving/raw-bags` via full page load.
- `/inbound/new` promotion: not linked from any sidebar, nav button, or CTA. `inbound/page.test.ts` asserts this.
- "cards" for PO line items: not found.

### Tests
- Added `UI-POLISH-4 · legacy wizard labeling` suite (4 tests) in `app/(admin)/inbound/new/page.test.ts`: pins wizard title as "Legacy receive wizard", confirms amber banner text, and verifies both fallback links.

## [0.2.42] — 2026-05-22

### Improved
- **PO line receive status on Receive Pills page (RECEIVE-LINE-STATUS-1):** Each PO line card on the Receive Pills page now shows an explicit local-status chip:
  - **Available** (green) — no Luma receive exists for this line.
  - **Received in Luma** (sky blue) — one or more Luma receives already exist for this line.
  Active (currently-being-received) lines show a **"Receiving now"** chip (brand color).
- **Prior-receive warning banner:** When an operator selects a PO line that already has Luma receives, an inline sky-colored note appears: "This line already has N receive(s) in Luma (M bags). A new receive will be added." This makes intentional multi-receive scenarios explicit rather than silent.
- Lines remain selectable regardless of prior-receive status. Multiple receives per PO line are intentionally supported by the schema (`receives.po_line_id` is nullable-per-line, totals are aggregated, not replaced). Blocking selection would require a schema-level constraint that is out of scope for this task.

### Data model note
- Zoho per-line receivable status (`to_be_received` / `partially_received` / `received`) is **not stored locally** in `po_lines`. Only PO-level status exists on `purchase_orders` (gated by `RECEIVABLE_PO_STATUSES = ["OPEN", "RECEIVING"]`). Per-line Zoho blocking is not implementable without a schema addition (`po_lines.zoho_line_status`). Noted for future work.

### Tests
- Added `classifyPoLineLocalStatus` unit tests (4): undefined total → available, receiveCount=0 → available, receiveCount=1 → received, receiveCount>1 → received.
- Added `poLineLocalStatusLabel` unit tests (6): available label, available ignores total, singular bag, plural bags, multiple receives label, graceful no-total fallback.

## [0.2.43] — 2026-05-22

### Improved
- **Machines & Stations page helper copy (STATION-2 T3):** The Machines & Stations admin page now includes inline explanatory copy distinguishing the station/machine model: stations are floor scan targets (each has an optional machine FK); machines are physical equipment with output/cycle characteristics. Starting stations (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED) require product selection; downstream stations receive bags already in-flight.

### Changed
- **Admin Start Production demoted (STATION-2 T4):** The Start Production admin page is now explicitly marked as a supervisor fallback path. Page description updated to "Supervisor fallback path — for day-to-day production, operators scan bag QRs at the floor station." Sidebar navigation reordered so the floor station scan path is the primary entry point.

### Fixed
- **HANDPACK_BLISTER missing from station creation Zod schema (STATION-2 T5):** Creating a station of kind `HANDPACK_BLISTER` through the admin UI returned a Zod validation error because the kind was absent from the server action's enum. Added `HANDPACK_BLISTER` to the `stationKindSchema` in `machines/actions.ts`. Floor guard in `floor/[token]/actions.ts` now has a citation comment referencing the full list of first-op station kinds. Added 6 guard-audit tests in `lib/production/first-op-product.test.ts` covering HANDPACK_BLISTER product-kind mapping and floor-eligibility boundaries.

## [0.2.40] — 2026-05-22

### Improved
- **Receives history page actions corrected (UI-POLISH-3):** The "+ New receive → /inbound/new" button has been removed from the Receives history page. It pointed to a legacy wizard that is not the correct entry point for tablet or packaging receiving. Replaced with two explicit CTAs: "Receive pills" (→ `/receiving/raw-bags`) and "Receive packaging" (→ `/inbound/packaging-materials`). Both the header actions and the empty-state now use these routes.
- **Legacy wizard banner:** `/inbound/new` (the old receive wizard) now displays a prominent amber info banner: "This is a legacy wizard — use it only as a supervisor fallback." with direct links to the correct receive pages, so any user who arrives there is immediately redirected.

### Tests
- Added `app/(admin)/inbound/page.test.ts` (RECEIVE-NAV-1): 7 assertions verifying the correct links are present, `/inbound/new` is not promoted as a primary CTA, correct icons are used, and empty-state mirrors the header actions.

## [0.2.39] — 2026-05-22

### Fixed
- **QR card sort order:** RAW_BAG cards now sort numerically by label suffix regardless of label format (`bag-card-N`, `Bag Card N`, mixed case/separator). The previous `localeCompare({ numeric: true })` was unreliable for mixed-format labels (e.g. hyphenated vs space-separated) and ICU-dependent in certain environments. Replaced with an explicit `numericSuffix` extractor that parses the trailing integer and sorts by integer value directly.
- **ASSIGNED RAW_BAG cards with no context:** Cards with status ASSIGNED but no linked inventory bag were silently displaying "Reserved at receive" with no further detail. Root cause: Drizzle left-join returns `intakeBag: { id: null, ... }` — a truthy object — when no matching bag row exists. Guard now checks `intakeBag?.id` rather than truthy-object. Three outcome paths: (1) bag found with context → "Reserved at receive · [receive] · Bag N · Receipt # · [tablet]"; (2) bag found but all detail fields null → amber "Reserved at receive · missing details"; (3) no bag at all → italic "Assigned — missing bag context".

- **HANDPACK_BLISTER station kind missing from admin dropdown (STATION-1):** The "Add a station" form in Machines & stations did not include `HANDPACK_BLISTER` as a selectable station kind, making it impossible to create hand-pack blister stations through the UI. Added to the dropdown with a "(no machine)" note distinguishing it from the machine-backed BLISTER kind.

### Improved
- Receiving tabs: "Purchase orders" tab renamed to "Receives" — the `/inbound` page shows receive history, not a PO list.
- Recall page: "Pack-out — N" section heading renamed to "Production output — N" for consistency with sidebar and page title.
- "Receive another batch" button now navigates to `/receiving/raw-bags` (full page load, clean form state) instead of manually resetting each React state field in-place.
- Station/machine model documented in `lib/production/first-op-product.ts`: station = floor scan target (optional machine FK), machine = physical equipment, starting stations (BLISTER/HANDPACK_BLISTER/BOTTLE_HANDPACK/COMBINED) require product selection, downstream stations receive bags already in-flight.

### Tests
- Added 5 `numericSuffix` unit tests covering hyphenated, spaced, zero-padded, large, and no-digit cases.
- Added 6 `sortQrRows` tests: "Bag Card N" title-case format, mixed hyphenated/spaced labels, bag-card-101 after bag-card-100, Bag Card 2 before Bag Card 10, bag-card-9 before bag-card-10 (explicit task requirements).

## [0.2.38] — 2026-05-22

### Fixed
- **Floor station typed/camera bag QR now advances the flow (FLOOR-START-5):** At first-op stations (Blister, Handpack Blister, Combined, Bottle Handpack), typing or scanning a bag QR previously resolved the token but then silently returned without submitting or showing the product picker. Root causes: (1) the product picker guard `isReceivedCardSelected` required the card to be in the server-rendered dropdown list — cards not yet visible in the dropdown caused a silent no-op; (2) single-product auto-submit was never wired. Now:
  - Typed/camera scan sets a `resolvedCardId` state that grants the same picker/submit access as a dropdown selection, regardless of whether the card is in the dropdown.
  - When exactly one product is compatible with the scanned bag's tablet type, the form submits automatically without requiring a button click.
  - When multiple products are compatible, the product picker appears immediately after the scan, and "Start production" submits via the programmatic path (not native form submit, which would use the wrong select value).
  - When zero products are configured for the tablet type, the config-error message now fires for scan-resolved cards too.
  - `explicitProductId` parameter added to `submitWithCardId` to avoid the stale-closure problem when auto-submitting before `setProductId` settles.

### Tests
- Added 18 tests covering FLOOR-START-5: structural invariants (resolvedCardId state, hasCardSelected derivation, auto-submit wiring, stale-closure fix), hasCardSelected pure-logic table (6 cases covering dropdown/scan/empty/stale-id paths), and auto-submit trigger conditions (single/multiple/zero product cases).

## [0.2.37] — 2026-05-22

### Improved
- QR Cards admin page is now a compact table instead of tall card rows, dramatically reducing scroll on pages with 100+ cards. Each row shows label + scan token, type badge, status badge, assignment context, and retire action.
- Numeric sort already in place (bag-card-1 … bag-card-200, not lexicographic). Summary tiles condensed to a 4-column grid.
- Search now matches receive name in addition to label, token, receipt #, lot, and product.

### Tests
- Added 3 unit tests for receive-name search in `matchesQrSearch`.

## [0.2.36] — 2026-05-22

### Fixed
- **New Receive PO dropdown regression:** The "New receive" wizard was showing all purchase orders instead of only open/receiving tablet POs. The `is_tablet_po = true` filter was dropped in a prior commit that restructured status filtering. Now uses `and(inArray(status, RECEIVABLE_PO_STATUSES), eq(isTabletPo, true))` matching the raw-bag intake page.
- Added empty-state note below the PO selector when no open tablet POs are available.

### Tests
- Added 9 regression tests in `app/(admin)/inbound/new/page.test.ts` guarding the PO filter: verifies `eq(isTabletPo, true)` present, `notInArray` not used, `RECEIVABLE_PO_STATUSES` referenced, and constant contains only OPEN/RECEIVING.

## [0.2.35] — 2026-05-22

### Fixed
- **Floor station crash (Start Production digest):** `revalidatePath` calls in `scanCardAction` were outside the try/catch; any throw produced a Next.js digest error instead of a user-visible message. Now wrapped in a defensive try/catch. Form action handler also gained a `catch` clause so uncaught server action exceptions show a message instead of the crash overlay.
- **Typed-token submit popup:** Clicking "Start bag" while a bag QR token was typed in the text input (without pressing Enter first) triggered the browser "Please select an item in the list" popup from the required `<select>`. Submit button now calls `handleResolvedToken` when the input is non-empty, bypassing native form validation.
- **Camera HTTPS message:** On HTTP deployments, `navigator.mediaDevices` is undefined (browsers block camera in non-secure contexts). The scanner now detects `window.isSecureContext` and shows "Camera access requires HTTPS — ask your IT team to enable HTTPS, or type the bag QR code manually" instead of the generic "not available" message.
- **Product picker narrowing:** At first-op stations (Blister, Handpack Blister, Combined, Bottle Handpack), the product dropdown now shows only products compatible with the scanned bag's tablet type via `product_allowed_tablets`. Products with no tablet mapping remain visible. Previously showed the full product catalog regardless of tablet type.
- **Auto-select product:** When a scanned bag's tablet type narrows the product list to exactly one option, it is auto-selected.
- Number inputs no longer change value on mouse-wheel scroll. The shared `Input` component now blurs on wheel when `type="number"`, preventing accidental increment/decrement across all admin forms (receiving, products, settings, BOM editor, batches, machines, packaging receipts, etc.).

### Improved
- Sidebar "Pack-out" label renamed to "Production output" to match the page title and reduce ambiguity with packaging materials.
- "Pack-out queue" section label on the Production output page renamed to "Output queue".
- Empty-state message updated from "No bags pending pack-out" to "No bags pending output".

## [0.2.34] — 2026-05-22

### Fixed
- QR conflict error at bag edit now includes receive and bag context: "This QR is already assigned to bag 2 in receive PO-001-R1. Choose another QR or resolve the existing assignment first." Previously showed a generic "assigned to another raw bag" message with no context.
- Receipt number uniqueness is now pre-checked with a friendly error before hitting the database unique constraint. Previously a duplicate receipt number would surface a raw Postgres error.
- Receipt number is now trimmed consistently (both in the uniqueness check and when writing to the database).

### Improved
- Extracted `shouldReleaseQrAtBagEdit` as a testable pure helper (returns true only for intake-reserved cards; never for IDLE, mid-production, or RETIRED cards).

### Tests
- Added 4 unit tests for `shouldReleaseQrAtBagEdit`.
- Added 11 unit tests for `editBagAction` covering weight kg→grams conversion, negative/NaN weight rejection, no-op unchanged fields, notes trim/blank→null, and error propagation.
- Added 8 DB-mocked integration tests for `editInventoryBag` covering: no-op same QR, QR conflict message format (with and without receive name), receipt# conflict, old-QR safe-release (intake-reserved only), and audit write.

## [0.2.33] — 2026-05-22

### Fixed
- Floor station raw-bag picker now shows **only received/intake-reserved bags** — IDLE pool QR cards (not yet linked to any inventory bag) are no longer visible in the dropdown. Previously, unlinked pool cards could appear and confuse operators.
- Scanning an IDLE QR card at a floor station now returns an actionable error: "This bag QR has not been linked to a received bag. Receive the bag first on the Receive Pills page."

### Improved
- Dropdown labels now include full context: QR label · PO number · Bag number · Tablet type · Receipt number (e.g., "B-001 · PO-00238 · Bag 2 · MIT B Green Apple · Receipt #352180").
- Empty state message shown when no received bags are available for the current station: "No received bags are currently available for this station. Use the Receive Pills page to receive bags and assign QR codes."
- Camera scanner now uses the native `BarcodeDetector` Web API on Chrome/Android (faster, no canvas overhead), with jsQR as fallback for Safari/Firefox.

## [0.2.32] — 2026-05-22

### Improved
- Floor station raw-bag picker now filters to bags whose tablet type is compatible with the station's product kinds. A BLISTER/COMBINED/HANDPACK_BLISTER station shows only CARD/VARIETY-compatible bags; BOTTLE_HANDPACK stations show only BOTTLE/VARIETY-compatible bags. Reduces the dropdown from ~200 items to the relevant subset. Cards with no linked inventory bag remain visible as a safety fallback.

## [0.2.31] — 2026-05-22

### Changed
- Receive detail bags table: added **Bag #** as the first column, showing the per-box bag ordinal operators use in the field (e.g., Bag 1, Bag 2). Receipt # retained alongside it.
- Receive history table: column renamed from "Tablet type" to "Tablet / Flavor". Multi-flavor receives now show "First Flavor + N more" instead of the raw comma-separated list.

### Improved
- QR card management: ASSIGNED raw-bag cards now show full assignment context — receive name, bag ordinal, receipt #, and tablet type (e.g., "Reserved at receive · PO-00238-R1 · Bag 2 · Receipt # 352180 · MIT B Green Apple"). Fallback "Assigned — no bag context found" for cards where the intake bag link is missing.

## [0.2.30] — 2026-05-22

### Fixed
- Product dialog no longer overwrites assembly Zoho IDs (`zohoItemIdUnit`, `zohoItemIdDisplay`, `zohoItemIdCase`) when saved — fields absent from the form are now skipped rather than nulled.
- Assembly mapping form pre-fills the unit Zoho ID field from the product's existing `zohoItemId` when the dedicated unit ID is not yet set, so operators aren't asked for the same value twice. Shows a "Pre-filled from product Zoho item ID. Save to confirm." hint.
- Saving the assembly mapping form now back-syncs `zohoItemId` (commercial trace column) from `zohoItemIdUnit`: syncs when <= 60 chars, clears when > 60 chars (to prevent stale divergence), clears when unit ID is cleared.

## [0.2.29] — 2026-05-22

### Fixed
- FLOOR-START-3: Added `BOTTLE_HANDPACK` to `FIRST_OP_STATION_KINDS`. Bottle hand-pack is a first-operation station — fresh bag scans now require product selection there, consistent with the existing floor UI behavior.
- `scanCardAction` server-side guard: rejects fresh-bag starts at downstream stations (SEALING, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER). Previously only the floor UI enforced this; a crafted POST could bypass it.
- Admin `startProductionForRawBagAction` now rejects non-first-op stations with a clear error message.
- Admin Start Production station dropdown now filters to first-op stations only (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED).

### Added
- Floor station page: context-aware no-bag message for downstream stations ("accepts bags released from a prior stage") and inline hint when no eligible pickups exist ("scan the bag QR when it arrives").
- Idle card dropdown placeholder updated to "Select a received bag QR…"; optgroup updated to "Received bags".
- Receives list: new Tablet type column shows distinct tablet type names for each receive (e.g. "MIT B Orange Citrus"), making multiple receives for the same PO distinguishable.

<!-- FUTURE: Machine vs station model cleanup
  Machines are physical equipment with output/cycle characteristics.
  Stations are floor scan locations / URLs.
  Hand-pack stations should probably be stations, not machines, unless
  they need machine-like output config. There is visible duplication on
  the Machines & stations admin page. This needs a future cleanup task.
-->

## [0.2.28] — 2026-05-22

### Added
- FLOOR-START-2: camera QR scanning via jsQR — "Open camera" button next to the scan input opens a modal that uses `getUserMedia` (rear-camera preferred), decodes frames via `jsQR` in a `requestAnimationFrame` loop, and fires the same `lookupCardByTokenAction` + `submitWithCardId` path as the typed-input scanner. Degrades gracefully if the Camera API is unavailable or permission is denied.
- Idle card dropdown now shows secondary info: internal receipt number and tablet type name (via LEFT JOIN to `inventory_bags` + `tablet_types`).
- Eligible-pickup dropdown now shows product SKU alongside bag stage (via LEFT JOIN to `workflow_bags` + `products`).

### Changed
- Dropdown placeholder updated from "Select an available bag QR…" to "Select an eligible bag QR…".
- Dropdown groups: idle cards group is "Start a new bag" when pickups are also present; pickup group is "Pick up released bag (same QR continues)".
- Helper text added above dropdown: "Scanning the physical bag QR above is preferred. Use the dropdown only as a backup."
- Submit button now reads "Start production" when the product picker is visible; "Start bag" otherwise.
- Installed `jsqr@1.4.0` as a runtime dependency.

## [0.2.27] — 2026-05-22

### Added
- FLOOR-START-1: floor station scanner now has a text input for wedge scanners. Typing or scanning a QR label token and pressing Enter validates the card via `lookupCardByTokenAction` and either starts the bag immediately or, at first-op stations requiring a product pick, populates the card selector and shows the product picker.
- `lookupCardByTokenAction` server action: resolves a physical QR scan token to a card ID with inline validation (not-found, wrong card type, retired card). Full eligibility check (stage, station kind) is deferred to `scanCardAction`.

### Changed
- `idleCards` query in `FloorStationPage` now filters to `cardType = 'RAW_BAG'` only. VARIETY_PACK, WORKFLOW_TRAVELER, and UNKNOWN cards no longer appear in the bag selector dropdown.
- `idleCards` now sorted numerically by label (bag-card-1, bag-card-2, …, bag-card-200) via `localeCompare({ numeric: true })`.
- Idle card picker is no longer shown at pickup-only stations (SEALING, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER). Only stations that can start fresh bags (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED) receive idle card options.
- `scanCardAction` now rejects non-RAW_BAG cards on the fresh-scan path: "Only bag QR cards (RAW_BAG type) can be used to start production."
- Floor scanner dropdown placeholder updated from "Pick an idle card…" to "Select an available bag QR…".
- Floor scanner submit button text updated from "Scan card" to "Scan bag QR".
- No-bag copy updated from "Scan a card to begin" to "Scan a bag QR or select one below."
- Idle cards optgroup label updated from "Idle cards" to "Available bag QRs".

### Tests
- 9 new tests in `scan-card-form.test.ts`: `lookupCardByTokenAction` invariants — empty token, not-found, VARIETY_PACK, UNKNOWN type, RETIRED status, valid IDLE RAW_BAG, valid intake-reserved ASSIGNED RAW_BAG, valid ASSIGNED pickup RAW_BAG, whitespace trimming. Total: 2228 tests.

## [0.2.26] — 2026-05-22

### Added
- VARIETY-2b: migration `0044_variety_qr_card_fk.sql` adds `variety_qr_card_id UUID REFERENCES qr_cards(id) ON DELETE SET NULL` to `variety_runs`. Backfills existing rows by matching `parent_scan_token` to `qr_cards.scan_token` where `card_type = 'VARIETY_PACK'`. Unmatched legacy rows remain null.
- `varietyQrCardId` field on `varietyRuns` Drizzle schema with partial index `variety_runs_qr_card_idx`.

### Changed
- `startOrResumeVarietyRunAction` now stores `varietyQrCardId = qrCard.id` when opening a new variety run, linking the run to the physical QR card record via FK.
- `closeVarietyRunAction` now prefers `varietyQrCardId` (FK path) for the QR release lookup; falls back to `parentScanToken` text scan for legacy rows where FK is null. Backward compatible.
- `variety_runs.parentScanToken` JSDoc updated: kept for display and legacy fallback; FK integrity now via `varietyQrCardId`.

### Tests
- 2 new tests in `variety-run-actions.test.ts`: "stores varietyQrCardId in the new run row" (verifies FK stored at insert via captured mock values), "uses varietyQrCardId (FK) to look up QR card when available" (verifies FK-preferred close path). Total: 2224 tests.

## [0.2.25] — 2026-05-22

### Fixed
- VARIETY-2a: `startOrResumeVarietyRunAction` now validates the parent scan token against `qr_cards`: rejects blank tokens, tokens not in the card pool, non-VARIETY_PACK card types, and RETIRED cards. On new run creation, the VARIETY_PACK card must be IDLE and is atomically set to ASSIGNED. On resume, the existing open run is returned without changing QR state.
- VARIETY-2a: `closeVarietyRunAction` now releases the parent VARIETY_PACK QR card back to IDLE inside the close transaction. Writes `VARIETY_QR_RELEASED` audit entry. Handles legacy runs with no QR card record gracefully (writes `VARIETY_QR_RELEASE_SKIPPED_LEGACY` audit, does not crash).
- VARIETY-2a: `closeAllocationSessionAction` now releases the source bag's RAW_BAG QR card to IDLE when the bag becomes EMPTIED (`endingBalanceQty = 0`). Writes `RAW_BAG_QR_RELEASED` audit entry. No release for partial bags (`endingBalanceQty > 0`) or non-RAW_BAG card types.
- VARIETY-2a: `markBagDepletedAction` now releases the source bag's RAW_BAG QR card to IDLE. Writes `RAW_BAG_QR_RELEASED` audit entry.

### Added
- 17 new unit tests: 12 in `variety-run-actions.test.ts` (QR validation and release scenarios) and 4 in new `bag-allocation-actions.test.ts` (RAW_BAG QR release for partial/depleted/wrong-type cases).

### Changed
- No DB migrations. All changes are code-only (VARIETY-2a minimum safe phase).

## [0.2.24] — 2026-05-22

### Added
- Variety parent/child QR workflow audit (VARIETY-1): documented two critical gaps — (1) `startOrResumeVarietyRunAction` accepts any string as `parentScanToken` with no `qr_cards` lookup; (2) VARIETY_PACK QR cards are never released because variety source bags have no `workflow_bag` and `BAG_FINALIZED` never fires. Chosen fix approach (VARIETY-2): code-only validation first (no migration), then optional `varietyQrCardId` FK on `variety_runs`.
- `docs/backlog.md` updated with VARIETY-1 findings: gap descriptions, chosen approach (Option B), minimum safe implementation phase, and known risks.

## [0.2.23] — 2026-05-22

### Added
- Available Partial Bags page (`/partial-bags`): shows AVAILABLE raw bags that have been through ≥1 production run, with remaining estimate, last used product/date, and a Start run link. No new DB status — derived from `rawBagAllocationSessions` ledger.
- `loadAvailablePartialBags()` DB query + `isAvailablePartialBag`, `hasOpenAllocationSession`, `deriveRemainingEstimate` pure helpers in `lib/production/partial-bags.ts`. 20 unit tests covering all spec cases.
- "Available Partial Bags" link added to Operations section of sidebar (after "Start production").

### Changed
- Start Production now blocks a bag if it has an OPEN allocation session (belt-and-suspenders guard — AVAILABLE status already blocks IN_USE bags, but this provides an explicit error message for any edge case).

## [0.2.22] — 2026-05-22

### Added
- `npm run verify:deploy` script (`scripts/verify-deploy.ts`): calls `/api/health` on the deployed host, compares the baked-in SHA against local `git rev-parse HEAD`, and reports whether the deploy is current. Host defaults to `http://192.168.1.134:3000`; override with `LUMA_HOST=<url>`.
- `docs/versioning.md`: documents the `0.MINOR.PATCH` version scheme, when to bump, the step-by-step bump procedure, how the systemd deploy timer works, and how build metadata (SHA/branch/date) reaches the footer.

### Changed
- Confirmed v0.2.21 container running after deploy completed (07:31 UTC). `BUILD_GIT_SHA` and `BUILD_GIT_BRANCH` now populate correctly in deployed containers — fix from CAPACITY-1 deploy-service update is confirmed working.

## [0.2.21] — 2026-05-22

### Changed
- "Purchase orders" tab in Receives/Inbound renamed to "Receives" to reflect that it shows receive history, not PO master records.
- "Receives" page (`/inbound`) title and description updated to match.
- Sidebar "Pack-out" nav entry renamed to "Production output" to match page title and avoid confusion with packaging materials.
- `/packaging-output` page title and per-bag breakdown section header renamed from "Packaging output" to "Production output".
- Zoho Operations page description now explicitly states "Dry-run validation only — live writes are disabled."
- Sidebar test updated to assert "Production output" label (was "Pack-out").

## [0.2.20] — 2026-05-22

### Changed
- QR Card Management: cards now sorted numerically (bag-card-1, bag-card-2, …, bag-card-49, …, bag-card-200) instead of lexicographically. Sort priority: RAW_BAG → VARIETY_PACK → WORKFLOW_TRAVELER/UNKNOWN.
- QR Card Management: search now matches receipt number and supplier lot in addition to label and scan token.
- QR Card Management: assigned-to display now shows clear "Active workflow" or "Reserved at receive" labels with context instead of bare truncated IDs.
- QR Card Management: print labels page now only prints idle RAW_BAG cards, matching the "Print idle raw bag labels" button label. Previously printed all idle cards regardless of type.

### Added
- `sortQrRows` and `matchesQrSearch` pure helpers in `lib/production/qr-sort.ts`. 19 unit tests.

## [0.2.19] — 2026-05-22

### Changed
- Start Production no longer asks the operator to select a QR card. The raw bag's QR card — reserved at receiving — is identified automatically from the bag's `bagQrCode` and activated when production starts. The "Confirm QR card" step is removed; Step 4 is now a single "Start run" button.
- Start Production page no longer queries or displays the idle/intake-reserved QR card count badge.
- Start Production server action now auto-derives the QR card from `qrCards.scanToken = bag.bagQrCode` instead of accepting a `qrCardId` input parameter.

### Added
- Comprehensive QR validation in `startProductionForRawBagAction`: explicit errors for no QR on bag, card not found, wrong card type, retired card, card already assigned to active workflow.
- `validateRawBagQrForStart` pure helper in `lib/production/start-production.ts`. 11 unit tests.

## [0.2.18] — 2026-05-22

### Changed
- Admin footer now shows accurate build metadata: SHA field shows "local" in dev (was "dev"); branch is always shown when deployed (was suppressed for main); BUILD_AT "unknown" is suppressed instead of displayed.
- Production Capacity page rows now sorted: rows with any meaningful inventory data (tablets on hand, runnable units/displays/cases > 0) appear first, rows with all-zero data appear last. Within each group, alphabetical by product name.

### Added
- `hasCapacityData` and `sortCapacityRows` pure helpers in `lib/production/capacity.ts`. 14 unit tests covering all sorting and data-presence edge cases.

## [0.2.17] — 2026-05-22

### Changed
- Start Production flow reordered: step 2 is now "Pick station" (moved from step 4). Product selection (step 3) uses the station type to narrow candidates before the operator sees them.
- Start Production: when the station type unambiguously resolves the product (exactly one CARD product for a CARD station, or exactly one BOTTLE product for a BOTTLE station), the product is auto-selected and shown as a read-only confirmation. The operator never sees the picker.
- Start Production: when multiple products remain after station filtering, only the compatible products are shown (e.g. only CARD products at a BLISTER station). If a station/product kind mismatch is detected (config error), a warning is shown alongside the full fallback list so production is never blocked.
- Start Production: COMBINED stations and unknown station types show all configured products without filtering.

### Added
- `resolveStartProductionProduct` pure helper in `lib/production/start-production.ts`. Station→product-kind mapping: BLISTER/SEALING/PACKAGING → CARD; BOTTLE_HANDPACK/BOTTLE_CAP_SEAL/BOTTLE_STICKER → BOTTLE; COMBINED → no filter. Returns `auto | choose | config_error` discriminated union. 19 unit tests.
- `docs/backlog.md` updated with two Start Production notes: server-side station/product validation and COMBINED station product grouping.

## [0.2.16] — 2026-05-22

### Added
- Receive Pills bag rows table now shows inline QR validation state without requiring a save attempt:
  - Red border + "Duplicate in this receive" label when the same QR token appears in two or more rows.
  - Amber border + "Not in idle RAW_BAG pool" label when a manually-entered token is absent from the IDLE RAW_BAG pool (covers: non-existent tokens, wrong card type, retired cards, and already-assigned cards).
  - Save button is disabled when any row has a duplicate QR conflict (hard error). Not-in-pool rows show a warning but do not block save — the server transactional validation remains authoritative.
- `validateQrTokens` pure helper added to `lib/production/raw-bag-intake.ts`. 11 unit tests covering all states and edge cases.
- `docs/backlog.md` updated with: README.md needed, architecture diagram needed (with full scope), QR Card Management table redesign note.

## [0.2.15] — 2026-05-22

### Fixed
- Bag edit QR reassignment: WORKFLOW_TRAVELER and UNKNOWN card types are now rejected with "Only RAW_BAG cards can be assigned to raw bags." Previously only VARIETY_PACK was explicitly checked.
- Bag edit QR reassignment: a card that is intake-reserved (ASSIGNED + null workflow bag) but already linked to a *different* inventory bag is now rejected with "This QR card is already assigned to another raw bag." Previously the DB unique index would catch the collision with a cryptic error message.

### Changed
- Receive detail page summary sidebar now shows aggregate "Weight (kg)" total across all bags that have a recorded weight.
- `validateQrCardForRawBag` extracted as an exported pure helper in `lib/db/queries/bag-edits.ts`. 7 unit tests added.

## [0.2.14] — 2026-05-22

### Added
- Receive detail page (`/inbound/[id]`): bags table below the boxes card. Columns: bag #, receipt number, QR code, supplier lot, weight (kg), status chip. Each row has an "Edit" link to the bag edit page.
- Bag edit page (`/inbound/[id]/bag/[bagId]/edit`): safe post-save edits for weight, notes, internal receipt number, QR code, and supplier lot. Sensitive field changes require an edit reason. Bags currently in production are locked to notes-only.
- QR card reassignment at bag edit: transactionally releases the old intake-reserved card to IDLE and assigns the new card. Validates that new cards are not RETIRED, not VARIETY_PACK, and not active in production. Both changes are written to the audit log.
- `validateBagEditFields` pure helper with 14 unit tests covering all guard conditions.
- Receive pills page: PO line cards now show local Luma receive counts alongside the PO quantity. Shows "Receiving" (active form), "N bags · N rcvs" (prior receives), or "None yet".
- Receive pills success panel: "View receive" primary button links directly to the new receive detail page.

## [0.2.13] — 2026-05-22

### Changed
- Start Production: step 3 renamed from "Assign a workflow QR card" to "QR card". Subtitle now explains that the QR card was reserved at receiving and is pre-selected automatically. All misleading "reusable floor badge" / "workflow QR" copy removed.
- Start Production page header: updated description to reflect the receive-first flow.
- Start Production step list: "Assign QR card" → "Confirm QR card".
- Start Production success panel body: updated to "The QR card is now active on this bag."

### Fixed
- Start Production: VARIETY_PACK cards are now excluded from the QR card dropdown and rejected by the server action with error "Variety pack cards cannot be used for raw bags."
- Receive pills page: "Receive another batch" button now resets all form state and calls `router.refresh()` so the QR card pool reflects the newly-assigned cards. Previously, soft navigation to the same route left stale client state.
- Receive pills page: "Start production" button in the success panel now links to `/production/start` (was incorrectly `/qr-cards`).
- Receive pills page: all `type="number"` inputs now blur on mouse-wheel scroll to prevent accidental value changes.

### Added
- QR Card Management: ASSIGNED cards now show contextual "Assigned to" information. Intake-reserved cards (ASSIGNED, no workflow bag yet) show "Assigned at intake: {receipt} · lot {supplier_lot}". Active production cards continue to show the workflow bag ID and product name.
- `docs/backlog.md`: backlog items captured for post-save editing, PO line status, Shipments rename, Production output rename, QR UX cleanup.

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
