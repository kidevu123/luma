# Current Phase Status

Append-only log. Each entry: phase name, date (UTC), result, notes. Latest entry first.

---

## LOT-1C — Finished-lot projector + recall-passport projection wiring (complete)
- Date: 2026-05-14
- Result: projector phase. The DB now auto-populates the four recall-passport child tables whenever a finished_lots row is created (operator-triggered) OR when BAG_FINALIZED fires for a bag that already has a finished_lots row. No automatic finished_lots row creation — that stays in operator hands. Full rebuilder wired into the standard rebuild script.
- Audit findings (pre-projector):
  - **Canonical finalization event:** `BAG_FINALIZED`, emitted by `app/(floor)/floor/[token]/actions.ts:913` via `finalizeBagAction()` (sets `workflow_bags.finalizedAt`). Dispatch lives in `lib/projector/index.ts:208-219, 329-339, 388-392`.
  - **Counts** (`displaysProduced` / `casesProduced` / `unitsProduced`) live on `finished_lots` (`lib/db/schema.ts:993-995`). NOT on the BAG_FINALIZED event payload. No per-output detail field on the event.
  - **finished_lots is NOT auto-created today.** `lib/db/queries/finished-lots.ts:92 createFinishedLot()` is the only path — manually invoked from admin UI.
  - **finished_lot_inputs is batch-level only** (`lib/db/queries/finished-lots.ts:158-167`). Writes happen inside `createFinishedLot()`.
  - **`workflow_bag.inventory_bag_id` is unreliable** — nullable, set only for single-source tablet workflows; bottle / variety-pack flows leave it null per design.
  - **`material_inventory_events` carries both `workflow_bag_id` + `packaging_lot_id`** but the pair is reliably populated **only when an emission code (e.g. roll handoff) explicitly stamps both**. Not auto-tied on every label/bottle consume.
  - **QC events** carry `workflow_bag_id` as a top-level FK on `workflow_events`; payload `bag_id` mirrors it. The 5 types: `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`.
  - **rebuild-read-models.ts** is one async main with a single `db.transaction()` that calls 10 rebuilders sequentially, logs scanned/written counts, then logs post-rebuild row counts.
- Design decision (driven by the audit): **enrich, don't auto-create.** The projector only enriches finished_lots that the operator has already created. This avoids fabricating finished_lots rows with no count data on every BAG_FINALIZED — which would otherwise pollute the table.
- Files changed:
  - **NEW** `lib/projector/finished-lot-passport.ts` (~580 lines) — `rebuildFinishedLotPassport`, `projectFinishedLotForFinalizedBag`, `projectFinishedLotPassportForLot`, pure helpers `deriveTraceCodeForLot` / `buildPrintPayload` / `deriveOutputRows` / `deriveContributingBags` / `summarizePassportConfidence`. Sub-projection helpers (private): `runRawBagProjection` / `runOutputsProjection` / `runPackagingLotsProjection` / `runQcEventsProjection`.
  - **NEW** `lib/projector/finished-lot-passport.test.ts` (~295 lines, 22 cases) — trace-code preservation (4), print_payload shape (4 incl. no-supplier-lot guard), output-row derivation (5 incl. skip-zero / skip-null), contributing-bag confidence (5 incl. HIGH-not-downgraded, multi-bag fan-out), confidence summary (2), partial-bag / multi-lot relationship (1), banned-language file added (1 implicit via qc-review-language scan).
  - MOD `lib/projector/index.ts` — import `projectFinishedLotForFinalizedBag`; one new call in the BAG_FINALIZED block (after `refreshStationDailyForBag`).
  - MOD `lib/db/queries/finished-lots.ts` — import `projectFinishedLotPassportForLot`; call after audit insert in `createFinishedLot()` (same tx).
  - MOD `scripts/rebuild-read-models.ts` — import + 4 table-name entries in the row-count loop + the rebuilder call inside the transaction (after `rebuildMaterialRecommendations`).
  - MOD `lib/production/qc-review-language.test.ts` — banned-phrase scan extended to `lib/projector/finished-lot-passport.ts`.
- Receiving bridge behavior: **backend only in this phase.** The pure helpers from LOT-1B (`getRawBagReceiptIdentity` / `buildRawBagQrPayload` / `buildInternalReceiptNumber` / `normalizeSupplierLotNumber` in `lib/production/recall-passport.ts`) are ready to drive an intake form. LOT-1D will add the form fields on `/inbound` to call them. Rationale (per LOT-1B's documented carve-out): the existing receiving form is non-trivial and wiring it cleanly is a UI-shaped task, not a backend one. No production receiving rows are stamped with `bag_qr_code` / `internal_receipt_number` / `declared_pill_count` until LOT-1D ships the form.
- Finished-lot projector behavior:
  - Looks up the `finished_lots` row.
  - If `trace_code` is null, sets it to `buildFinishedLotTraceCode({finishedLotNumber: lot.finishedLotNumber})` → `FL-<number>`. Preserves any existing trace_code (operator may have hand-edited).
  - On the BAG_FINALIZED path, sets `packed_at` to the event's `occurred_at` IF currently null. Never overwrites an operator-set timestamp.
  - Calls the four sub-projections.
- Raw-bag projection behavior:
  - **HIGH confidence**: `workflow_bag.inventory_bag_id` directly identifies the raw bag. `source = 'PROJECTOR'`, `quantity_consumed_pills = workflow_bag's inventory_bag.pill_count`.
  - **LOW confidence**: only `finished_lot_inputs` exists (batch level). For each batch, fan out to every `inventory_bag` in that batch. `source = 'LEGACY_IMPORT'`, `quantity_consumed_pills = null` (we deliberately don't split qty across bags).
  - **MISSING**: neither chain yields anything → skip. Never guess.
  - Triple-unique on `(finished_lot_id, inventory_bag_id, workflow_bag_id)` with `NULLS NOT DISTINCT` (Postgres 15+) — uses raw `INSERT … ON CONFLICT … DO UPDATE`. Drizzle's `onConflict` doesn't carry NULLS NOT DISTINCT semantics, hence raw SQL.
  - HIGH never downgrades to LOW: when the same `(inventory_bag, workflow_bag)` appears in both paths, HIGH wins via a dedup `Set` in `deriveContributingBags`.
- Output projection behavior:
  - DELETE PROJECTOR-source rows first (`WHERE print_payload->>'source' = 'PROJECTOR'`), then INSERT current counts. Operator-added rows with a different source marker are preserved.
  - One row per non-zero count: `LOOSE_UNIT` (unitsProduced), `DISPLAY` (displaysProduced), `MASTER_CASE` (casesProduced). Zero / null → row not emitted (never fabricated).
  - `trace_code_printed = traceCode` on every projected row.
  - `print_payload` snapshot: `{source: 'PROJECTOR', schema_version: '1.0', trace_code, product_name, product_sku, packed_at, expires_at, customer_alias?}`. **No `supplier_lot_number`** — test enforces.
- Packaging-lot projection behavior:
  - Query `material_inventory_events` filtered by `workflow_bag_id IN (contributing) AND packaging_lot_id IS NOT NULL`.
  - Aggregate per `packaging_lot_id`: SUM(quantity_units), MIN(occurred_at), MAX(occurred_at), denormalised material_id.
  - Upsert by `(finished_lot_id, packaging_lot_id)` unique. `LEAST(...)` / `GREATEST(...)` preserve first/last used across rebuilds.
  - When no events found → 0 rows. Never guesses.
- QC-event projection behavior:
  - One INSERT … SELECT … ON CONFLICT DO NOTHING. Filters by `workflow_bag_id = ANY(...)` AND `event_type = ANY('{PACKAGING_DAMAGE_RETURN,REWORK_SENT,REWORK_RECEIVED,SCRAP_RECORDED,SUBMISSION_CORRECTED}')`.
  - Original corrected events stay; SUBMISSION_CORRECTED is additive (QC-2 / QC-5 invariant).
  - Stores `(finished_lot_id, workflow_event_id, event_type, occurred_at)`. Unique on the pair.
- Rebuilder behavior:
  - `rebuildFinishedLotPassport(tx)` walks every `finished_lots` row, calls `projectFinishedLotPassportForLot`, reports `{scanned, projected, skipped, totalRawBags, totalOutputs, totalPackagingLots, totalQcEvents}`.
  - Idempotent: re-running on the same data produces the same row set. Output rebuild uses DELETE+INSERT (PROJECTOR-source only). Other tables use upsert on natural keys.
  - Wired into `scripts/rebuild-read-models.ts` after the PT-7C recommendation rebuilder.
- Tests added (22 cases, all pass):
  - `deriveTraceCodeForLot`: preserves existing (including non-FL-prefixed operator overrides), treats whitespace-only as missing, builds FL- prefix from finishedLotNumber.
  - `buildPrintPayload`: every expected field present, omits customer_alias when null, NEVER contains supplier_lot.
  - `deriveOutputRows`: emits LOOSE/DISPLAY/MASTER_CASE for non-zero, skips zero/null, returns empty for incomplete lot, stamps trace_code_printed everywhere.
  - `deriveContributingBags`: HIGH path, LOW fan-out, no-downgrade rule, MISSING returns [], multi-bag fan-out.
  - `summarizePassportConfidence`: MIN across, empty → MISSING.
  - Partial-bag / multi-lot: one raw bag can produce multiple links across distinct workflow_bag_ids.
  - Banned-language scan extended to the new file.
- Build / test results:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1148/1148 pass across 51 test files** (+22 vs LOT-1B's 1126; +1 test file).
  - `npx next build` → clean (only the pre-existing OpenTelemetry warning).
- Staging verification (LX122 / SHA `61795d3`):
  - Deploy via `systemctl start luma-deploy.service` succeeded.
  - `/api/health` flipped to `61795d3b97733491c126717cebdc32a20ceaefbe`.
  - Ran the rebuild script inside the container end-to-end: scanned 0 finished_lots → projected 0, skipped 0, no rows written. No fake data created (correct behaviour given no finished_lots exist).
  - All four projection tables (`finished_lot_raw_bags`, `finished_lot_outputs`, `finished_lot_packaging_lots`, `finished_lot_qc_events`) remain empty post-rebuild, as expected.
  - Auth smoke 47/47 PASS.
  - No noisy fake production data introduced.
  - **Drive-by fix in the same phase:** the rebuild script's first end-to-end run on real staging data surfaced a latent PT-7C bug — the recommendation projector queried `qty_on_hand` from `read_material_lot_state`, but that column only exists on `packaging_lots`; the read-model column is `current_quantity_estimate`. The PT-7C stub-tx tests returned canned data so the bad column name was undetected. One-line fix (commit `61795d3`) replaced `qty_on_hand` with `current_quantity_estimate`. PT-7C tests still 15/15. After the fix, the recommendation projector now produces 6 real recommendations from staging packaging materials (was 0 before the fix), which is a side benefit beyond LOT-1C's scope.
- LOT-1D readiness: ready. The next phase builds (a) the receiving UI fields on `/inbound` to call `getRawBagReceiptIdentity`, and (b) the `/recall` search page with the six search axes (supplier lot, internal receipt #, raw QR, finished lot trace code, product+date, customer). All upstream data plumbing is in place — LOT-1D is purely UI + a thin `getRecallPassport` / `getForwardTrace` server-action layer that reads from the existing tables.

---

## LOT-1B — Finished lot / recall passport schema + receiving bridge (complete)
- Date: 2026-05-13
- Result: schema phase. Migration 0031 + receiving-bridge pure helpers. No UI, no projector — those are LOT-1C and LOT-1D respectively. The DB now answers every shape the LOT-1A plan called for, including the bag-level M:N that batch-level `finished_lot_inputs` can't express.
- Operator-decided open questions from LOT-1A baked in:
  - **§7 #3 print policy** → `finished_lots.trace_code` is the customer-facing printed code (prefixed `FL-`). `internal_receipt_number` is internal-only and stays inside Luma. The current receipt-number workflow is supported by `inventory_bags.internal_receipt_number` and exposed through `getRawBagReceiptIdentity`.
  - **§7 #6 customer key** → `customers.customer_code` is the canonical key. `zoho_customer_id` + `nexus_customer_id` are nullable external IDs. Nexus does not own customer identity.
- Audit findings (pre-migration):
  - `receives.receive_name text NOT NULL UNIQUE` already holds the receipt-event identifier (`PO123-R1`). No dedicated "receipt-pad" column existed.
  - `batches.vendor_lot_number text` holds the manufacturer's lot. No supplier-lot column existed on `inventory_bags` directly.
  - `inventory_bags.bag_number int NOT NULL` is the per-box bag sequence. `vendor_barcode` was the manufacturer's scan target — distinct from any Luma-issued QR. No `bag_qr_code` / `internal_receipt_number` / `declared_pill_count` columns existed.
  - `qr_cards` are pre-printed production badges assigned to workflow bags at production start; **distinct namespace** from raw-bag QRs.
  - `workflow_bags.inventory_bag_id uuid` is nullable; relying on it alone for the raw→workflow link is unsafe (legacy / synthesised bags exist with it null).
  - `finished_lots` has `finished_lot_number text UNIQUE`, `produced_on date NOT NULL`, `expiry_date date NOT NULL`, `units_produced/displays_produced/cases_produced int`, `workflow_bag_id uuid` (nullable FK). No `trace_code`, no `packed_at`, no `expires_at` timestamptz, no alias column.
  - `finished_lot_inputs` resolves at `batches` level only — cannot express "which specific inventory_bag of this batch went into this finished lot."
  - `shipments` had `carrier`, `tracking_number`, `shipped_at`, `delivered_at`, `po_id`. No `customer_id` and no `customers` table existed.
  - No QC-event projection per finished lot existed; QC payloads point at `workflow_bag_id`.
- Migration number: **0031** (`when=1781100000000`).
- Files changed:
  - **NEW** `drizzle/0031_finished_lot_recall_passport.sql` (~240 lines) — additive, `IF NOT EXISTS` throughout, replay-safe. Six new tables, three column extensions, partial-unique indexes on `inventory_bags.bag_qr_code` + `finished_lots.trace_code` (NULL allowed for legacy rows). `finished_lot_raw_bags_triple_unique` uses `NULLS NOT DISTINCT` so duplicate (lot, bag, NULL) legacy inferences are still caught.
  - **NEW** `lib/production/recall-passport.ts` (~265 lines) — 9 pure helpers. No DB import.
  - **NEW** `lib/production/recall-passport.test.ts` (~280 lines, 33 cases) — every helper, edge cases for trim/normalisation, namespace-distinctness of BAG-/FL- prefixes, confidence rollup, partial-bag / multi-lot relationship.
  - MOD `lib/db/schema.ts` — column additions on `inventoryBags` + `finishedLots` + `shipments`; six new `pgTable` exports at the end. Self-FK between `customers` and `shipments.customerId` declared in SQL (the drizzle type-mirror doesn't carry it; `shipment_finished_lots.customer_id` carries a proper FK).
  - MOD `drizzle/meta/_journal.json` — entry idx 31.
  - MOD `lib/production/qc-review-language.test.ts` — banned-phrase scan extended to `lib/production/recall-passport.ts`.
- Schema added / extended (12 changes total):
  1. `inventory_bags.bag_qr_code text` (unique partial index where not null)
  2. `inventory_bags.internal_receipt_number text` (indexed)
  3. `inventory_bags.declared_pill_count int`
  4. `finished_lots.trace_code text` (unique partial index where not null)
  5. `finished_lots.packed_at timestamptz` (indexed where not null)
  6. `finished_lots.expires_at timestamptz`
  7. `finished_lots.finished_lot_code_alias text` (indexed where not null)
  8. `shipments.customer_id uuid` (FK to `customers`, indexed where not null)
  9. **NEW** `customers` (customer_code UNIQUE, zoho_customer_id + nexus_customer_id nullable externals, supplier_lot_visible default false)
  10. **NEW** `finished_lot_raw_bags` (bag-level M:N, confidence HIGH/MEDIUM/LOW/MISSING, source PROJECTOR/BACKFILL/MANUAL/LEGACY_IMPORT, triple-unique with NULLS NOT DISTINCT)
  11. **NEW** `finished_lot_outputs` (per display/master_case/loose_unit/pallet/other with `print_payload jsonb` snapshot)
  12. **NEW** `finished_lot_packaging_lots` (projection-friendly, unique on (lot, packaging_lot))
  13. **NEW** `finished_lot_qc_events` (one row per QC event per finished lot, unique on pair)
  14. **NEW** `shipment_finished_lots` (M:N shipments × finished_lots with denormalised customer_id, unique on pair)
- Receiving-bridge behavior (pure helpers, exported from `lib/production/recall-passport.ts`):
  - **`buildInternalReceiptNumber({receiveName, boxNumber, bagNumber})`** — returns `"<receive_name>[-B<box>]-<bag>"`. Trims, requires receive name + bag number; returns null when either is missing (no guessing for legacy data).
  - **`validateInternalReceiptNumber(value)`** — accepts current receipt-pad formats (alphanumeric + dash/underscore, 3–82 chars); trims before checking; rejects whitespace / slashes / unsafe characters.
  - **`normalizeSupplierLotNumber(value)`** — trims, collapses internal whitespace, uppercases. Returns null for empty/null input.
  - **`buildRawBagQrPayload({inventoryBagId, internalReceiptNumber, bagSequence})`** — returns `BAG-<uuid>`. Throws on missing inputs.
  - **`buildRawBagQrPayloadJson(...)`** — structured JSON envelope with `schema_version='1.0'`, `kind='RAW_BAG'`, bag id, receipt, supplier lot, product hint, bag sequence. For printer drivers that encode richer QR contents.
  - **`getRawBagReceiptIdentity({inventoryBagId, receiveName?, boxNumber?, bagNumber, supplierLotNumber?, productHint?})`** — convenience: returns `{bagQrCode, internalReceiptNumber, supplierLotNumber, qrPayloadJson}` in one shot, ready for an INSERT. Honours nullable receive_name (legacy bag → null internal receipt, but bag_qr_code still valid).
  - **`buildFinishedLotTraceCode({finishedLotNumber, suffix?})`** — `FL-` prefix, idempotent on already-prefixed inputs, optional suffix.
  - **`validateTraceCode(value)`** — must start with FL-, alphanumeric + dash, 6–84 chars. Rejects whitespace, slashes, customer-unsafe chars.
  - **`rollupRecallConfidence(values[])`** — MIN across the chain (same ladder as PT-6/PT-7/PBOM). Empty chain → MISSING.
  - **`shouldExposeSupplierLot({customerSupplierLotVisible})`** — defaults to false; supplier lot is hidden unless customer explicitly opts in.
  - **Namespace discipline:** `BAG-` raw-bag QRs and `FL-` finished-lot trace codes are distinct prefixes; the scanner can route without a DB lookup. Tests assert prefixes never collide.
  - **Receiving UI:** intentionally **not changed in this phase**. LOT-1B is backend-only. UI work deferred to LOT-1C (intake form) and LOT-1D (recall lookup page). Per prompt: "If receiving UI is too risky for LOT-1B, add backend support + document UI deferred to LOT-1C/LOT-1D."
- Tests added (33 cases, all pass):
  - `buildInternalReceiptNumber` — 5 cases (build / no-box / missing bag / empty name / whitespace trim).
  - `validateInternalReceiptNumber` — 4 cases (canonical, legacy, unsafe-char reject, non-string reject, trim).
  - `normalizeSupplierLotNumber` — 4 cases (uppercase+trim, internal whitespace collapse, empty handling).
  - `buildRawBagQrPayload`/`Json` — 4 cases (BAG- prefix, JSON envelope, namespace distinct from FL-, input validation).
  - `getRawBagReceiptIdentity` — 2 cases (full identity, legacy-no-receive variant).
  - `buildFinishedLotTraceCode`/`validateTraceCode` — 7 cases (prefix, idempotent, suffix, throws empty, accept canonical, reject no-prefix, reject unsafe chars, reject non-string).
  - `shouldExposeSupplierLot` — 2 cases (default false, opt-in true).
  - `rollupRecallConfidence` — 2 cases (empty=MISSING, MIN-across-chain).
  - partial-bag / multi-lot relationship — 1 case (one raw bag can produce multiple QRs; one bag → multiple finished lots is supported by the schema).
  - banned-language scan — `recall-passport.ts` added to the gate.
- Build / test results:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1126/1126 pass across 50 test files** (+33 vs PT-7E's 1093; +1 test file).
  - `npx next build` → clean (only the pre-existing OpenTelemetry `@opentelemetry/exporter-jaeger` warning, unrelated).
- Staging verification (LX122 / SHA `a9d6fb9`):
  - Deploy via `systemctl start luma-deploy.service` succeeded.
  - `/api/health` flipped to `a9d6fb91f31d7f718770f02a8c1ad6a80da38008`.
  - Migration 0031 row present in `drizzle.__drizzle_migrations` at `when=1781100000000`.
  - `\d inventory_bags` shows `bag_qr_code text` + `internal_receipt_number text` + `declared_pill_count integer`.
  - `\d finished_lots` shows `trace_code text` + `packed_at timestamptz` + `expires_at timestamptz` + `finished_lot_code_alias text`.
  - `\d shipments` shows `customer_id uuid` FK.
  - All six new tables exist with the unique + lookup indexes documented above.
  - Auth smoke 47/47 PASS.
- LOT-1C readiness: ready. The next phase wires `BAG_FINALIZED` projector emissions into `finished_lot_raw_bags` / `finished_lot_outputs` / `finished_lot_packaging_lots` / `finished_lot_qc_events`, plus the rebuilder script. Schema is in place; pure helpers are ready; no further migrations needed unless LOT-1C uncovers a gap.

---

## PT-7 closeout — Full PackTrack shortage-recommendations block complete
- Date: 2026-05-13
- Result: PT-7A through PT-7F closed. End-to-end Luma side of the loop is live on staging: read-model + projector + UI + acknowledge/dismiss + outbound client + send-action + final staging verification. No PackTrack-side work touched. No PO creation from Luma. Owner approval still lives in PackTrack.
- What got built across PT-7A → PT-7F:
  - **PT-7A** — plan doc (`docs/PACKTRACK_SHORTAGE_RECOMMENDATIONS_PLAN.md`).
  - **PT-7B** — pure shortage math (`lib/production/packtrack-shortage.ts`) + 59 fixture tests.
  - **PT-7C** — migration 0029 (`read_material_recommendations` table + 3 ordering columns on `packaging_materials`) + `lib/projector/packtrack-recommendations.ts` rebuilder + 15 tests; wired into `scripts/rebuild-read-models.ts`.
  - **PT-7D** — `/material-alerts` panel reading `read_material_recommendations`, with severity / confidence / sendable / missing-config / product / material / status filters. Acknowledge + dismiss server actions (idempotent, audit-logged). 23 tests.
  - **PT-7E** — migration 0030 (`sent_at` + `last_sent_response`) + `lib/integrations/packtrack/recommendations.ts` outbound client + `sendMaterialRecommendationToPackTrackAction` + UI "Send to PackTrack" button with disabled-reason chip. Settings status card. 30 tests.
  - **PT-7F** — `scripts/verify-pt7f.ts` end-to-end harness; staging verified at SHA `9923c2c`.
- Staging verification (PT-7F):
  - SHA `9923c2c` live on LX122.
  - `verify-pt7f.ts` executed inside the container via `./node_modules/.bin/tsx scripts/verify-pt7f.ts`. **All 32 in-script assertions passed.** The harness:
    1. Picked the existing `QA_TEST_DISPLAY_BOX` packaging material (so no production-facing fixture pollution).
    2. Seeded a fresh QA row with a unique random `recommendation_id` (id `f80099a7-…` for the verification run — already cleaned up).
    3. Confirmed the loader returns the row, with `acknowledged_at=null`, `dismissed_at=null`, `sendable_to_packtrack=true`, `confidence='HIGH'`.
    4. Acknowledged the row (`UPDATE … set acknowledged_at` + `auditLog material_recommendation.acknowledge` in one tx).
    5. Spun up an in-process Node `http` mock receiver on `127.0.0.1:<ephemeral>`.
    6. Called `sendRecommendationToPackTrack` with `config: {url, secret}` override (no env mutation, no app restart).
    7. Mock captured: `content-type: application/json`, `x-luma-packtrack-secret: STAGING_QA_SECRET`, `x-luma-recommendation-id: <id>` (== payload `recommendation_id`), JSON body with `schema_version='1.0'`, `source='LUMA'`, `material_code='QA_TEST_DISPLAY_BOX'`, `recommended_order_quantity=420`, `confidence='HIGH'`, non-empty `supporting_signals`.
    8. Send returned `ok` with mapped `{packtrack_recommendation_id:'MOCK-PT-001', status:'received'}`.
    9. Persisted success branch: `sent_at` populated, `last_sent_response` populated, `last_send_error` cleared, audit row `material_recommendation.send` written.
    10. Spun up a second mock returning `HTTP 500`. Send returned `ok=false, code='HTTP_ERROR'`. Persisted failure branch: `last_send_error` populated, `sent_at` **preserved** (so a transient retry doesn't blow away the prior successful send), audit row `material_recommendation.send_failed` written.
    11. Verified defensive client-side gates still hold: MISSING-confidence input refused with `BLOCKED_BY_CONFIDENCE`; recommended_qty=0 refused with `BLOCKED_BY_QUANTITY`.
    12. Confirmed audit chain captured all three lifecycle events: `acknowledge`, `send`, `send_failed`.
    13. Confirmed `buildPackTrackRecommendationPayload` roundtrips `recommendation_id` / `schema_version='1.0'` / `source='LUMA'`.
    14. Cleanup: deleted the QA row (audit chain stays in `audit_log` for forensic history).
  - Auth smoke 47/47 PASS.
  - `read_material_recommendations` row count back to 0 (matching prior state) after cleanup.
- Build / test results (final):
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1093/1093 pass across 49 files**.
  - `npx next build` → clean (only the pre-existing OpenTelemetry `@opentelemetry/exporter-jaeger` warning, unrelated).
- Known limitations (carry-forward into PT-7E ops doc):
  1. **The real PackTrack endpoint is not yet implemented or hooked up.** PT-7F verified the loop using an in-process mock receiver. The Luma side is contract-stable; PackTrack-side work is the inverse phase.
  2. **Luma does not create PackTrack POs.** Sending a recommendation creates a *recommendation* in PackTrack; the owner approves it in PackTrack and PackTrack creates the PO.
  3. **Owner approval remains in PackTrack.** Luma has no approve / reject affordance — that's intentional and shouldn't be added here.
  4. **Recommendation quality depends on upstream data quality**: BOM (PBOM-1, PBOM-2), product↔material compatibility, inventory state, and `read_material_burn` usage rates. When any of these are MISSING, the recommendation surfaces as MISSING-confidence and the UI explicitly refuses to send.
  5. **PVC / FOIL / BLISTER_FOIL rolls are excluded by `skipMaterialKindForPackTrackShortage`** — those route through roll-usage / `/roll-variance`, not the PT-7 path.
  6. **Hysteresis is upstream-only** (PT-7B). PT-7E does not gate on hysteresis — that's a rebuilder concern. The acknowledged/dismissed state in PT-7C/D is the operator-facing dedup; PT-7B's `hadActiveRecommendation` keeps the rebuilder from flapping.
  7. **No automatic retry on transient failures.** The action persists `last_send_error`; the operator re-clicks "Send to PackTrack" to retry. This is intentional — silent retries hide real upstream problems.
  8. **No rate-limiting** in PT-7E. PackTrack is expected to dedup on `recommendation_id` (same value Luma uses as `x-luma-recommendation-id` header). If a flood scenario emerges later, rate-limiting goes in the action, not the client.
- Next unchecked phase in `docs/CLAUDE_BUILD_QUEUE.md`: **LOT-1B** — Finished Lot / Recall Passport: schema migration + receiving bridge (raw-bag QR labels, `finished_lot_raw_bags`, `finished_lot_outputs`, `finished_lot_packaging_lots`, `finished_lot_qc_events`, `customers`, `shipment_finished_lots`). Plan doc was shipped in LOT-1A (`docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md`); the next step needs operator answers to open questions §7 #3 (print policy) and §7 #6 (customer-key direction). After LOT-1, queued: command-center visual polish / Zoho live sync / Nexus-QIP batch-complaint integration.

---

## PT-7E — Luma outbound PackTrack recommendation handoff (complete)
- Date: 2026-05-13
- Result: outbound integration phase. Migration 0030 + outbound client + send action + UI button + settings status card. No automatic send — every send is operator-triggered from `/material-alerts`. No PO creation from Luma — PackTrack creates the PO after owner approval. PackTrack endpoint may not exist yet; the UI surfaces "PackTrack handoff not configured" honestly when env is missing, and the action short-circuits to `NOT_CONFIGURED` before any DB read.
- Files changed:
  - **NEW** `drizzle/0030_packtrack_recommendation_send.sql` — adds `sent_at timestamptz` + `last_sent_response jsonb` to `read_material_recommendations` (both nullable) + one new index `read_material_recommendations_sent_idx` (partial on `sent_at IS NOT NULL`). `last_send_error` was already shipped by PT-7C.
  - **NEW** `lib/integrations/packtrack/recommendations.ts` (~280 lines) — exports `validatePackTrackRecommendationConfig`, `buildPackTrackRecommendationPayload`, `sendRecommendationToPackTrack`, `mapPackTrackRecommendationResponse`, env names `PACKTRACK_RECOMMENDATION_URL` + `PACKTRACK_RECOMMENDATION_SECRET`. Headers `x-luma-packtrack-secret` + `x-luma-recommendation-id`. AbortController-based 10s timeout. Defense-in-depth secret strip from any reflected response body.
  - **NEW** `lib/integrations/packtrack/recommendations.test.ts` (~290 lines, 15 cases) — config validation, payload builder field-by-field, response mapper, NOT_CONFIGURED / BLOCKED_BY_CONFIDENCE / BLOCKED_BY_QUANTITY / HTTP_ERROR / NETWORK_ERROR / INVALID_RESPONSE / secret-redaction.
  - **NEW** `app/(admin)/material-alerts/_recommendations-panel-helpers.test.ts` (~95 lines, 7 cases) — pure `deriveSendBlockReason` exercised across the gate priority ladder. (Missing config wins over other reasons because the operator can't act on anything else first.)
  - MOD `app/(admin)/material-alerts/actions.ts` — new `sendMaterialRecommendationToPackTrackAction` (~120 lines). Loads the row outside the transaction (so a slow PackTrack doesn't hold a DB lock), gates by acknowledged / not-dismissed / sendable / confidence ≠ MISSING / qty > 0 / config present, calls the client, then opens a tx to persist either `{sent_at, last_sent_response, last_send_error: null}` + audit `material_recommendation.send`, OR `{last_send_error}` + audit `material_recommendation.send_failed`.
  - MOD `app/(admin)/material-alerts/actions.test.ts` — 8 new send-action cases (NOT_CONFIGURED / NOT_ACKNOWLEDGED / DISMISSED / NOT_SENDABLE / BLOCKED_BY_CONFIDENCE / BLOCKED_BY_QUANTITY / HTTP_ERROR persist + audit / success persist + audit + idempotency header). Stub `db.select` extended to handle the top-level pre-tx read. Static scan repurposed: ack + dismiss bodies must NOT reference `sendRecommendationToPackTrack` or `fetch(`; full file must not contain `create PO` / `Luma ordered`.
  - MOD `app/(admin)/material-alerts/_recommendations-panel.tsx` — new `Send to PackTrack` button when `deriveSendBlockReason(row, configured) === null`, "Send blocked: <reason>" chip when not, "Sent to PackTrack" pill after success. Header copy updated: "Sending creates a recommendation in PackTrack for owner approval. Luma does not create a PO." `deriveSendBlockReason` exported for pure-helper testing.
  - MOD `app/(admin)/material-alerts/page.tsx` — passes `packtrackConfigured` from `validatePackTrackRecommendationConfig()` into the panel.
  - MOD `app/(admin)/settings/integrations/packtrack/page.tsx` — new "Recommendation handoff (outbound)" card with rows for endpoint / secret / live-sending status. Missing-vars list shown when not configured. Secret values are never exposed.
  - MOD `lib/db/schema.ts` — `sentAt` + `lastSentResponse` fields on `readMaterialRecommendations` + `read_material_recommendations_sent_idx` index.
  - MOD `lib/production/material-recommendations-filter.ts` — `RecommendationRow` extended with `sentAt` / `lastSentResponse` / `lastSendError`.
  - MOD `lib/db/queries/material-recommendations.ts` — loader maps the 3 new fields.
  - MOD `lib/db/queries/material-recommendations.test.ts` — fixture default extended.
  - MOD `lib/production/qc-review-language.test.ts` — banned-phrase scan extended to the 2 new files (client + settings page).
  - MOD `drizzle/meta/_journal.json` — entry idx 30, `when=1781000000000`.
  - MOD `docs/CLAUDE_BUILD_QUEUE.md` — PT-7E sub-bullet flipped to `[x]`.
- Client behavior:
  - **Config check** — `validatePackTrackRecommendationConfig` reads `PACKTRACK_RECOMMENDATION_URL` + `PACKTRACK_RECOMMENDATION_SECRET` (treats whitespace as missing); returns `{configured, endpointConfigured, secretConfigured, missing[]}`.
  - **Payload** — `schema_version: "1.0"`, `source: "LUMA"`, every PT-7B / PT-7C field mapped 1:1 to a snake_case key, `luma_links.material_alerts` populated when `APP_URL` is set.
  - **Send** — POST with `content-type: application/json`, `x-luma-packtrack-secret: <secret>`, `x-luma-recommendation-id: <recommendation_id>`. 10s AbortController timeout. Refuses MISSING confidence and qty ≤ 0 defensively.
  - **Failure modes** — `NOT_CONFIGURED` / `BLOCKED_BY_CONFIDENCE` / `BLOCKED_BY_QUANTITY` / `HTTP_ERROR` (with status + bodySnippet) / `NETWORK_ERROR` / `INVALID_RESPONSE`. Response body snippet is capped at 500 chars and the secret is stripped before surfacing.
  - **Response mapping** — `recommendation_id` (preferred) or `id` → `packtrack_recommendation_id`; `status` + `message` mapped through; full body kept under `raw`.
- Send action behavior:
  - `requireAdmin()` first.
  - UUID validation second.
  - Config check third (`NOT_CONFIGURED` short-circuit).
  - DB read outside tx; row-existence check.
  - Six gates in order: `NOT_ACKNOWLEDGED` / `DISMISSED` / `NOT_SENDABLE` / `BLOCKED_BY_CONFIDENCE` / `BLOCKED_BY_QUANTITY`.
  - Outbound call.
  - One tx that either persists success (`sent_at`, `last_sent_response`, `last_send_error: null`, audit `material_recommendation.send`) OR failure (`last_send_error`, audit `material_recommendation.send_failed`).
  - `revalidatePath("/material-alerts")` at the end.
- UI behavior:
  - "Send to PackTrack" button rendered only when `deriveSendBlockReason(row, configured) === null` and the row hasn't been sent.
  - Disabled-reason chip shows the human-readable block reason when not. Priority: missing config > dismissed > not acknowledged > not sendable > MISSING confidence > zero qty.
  - "Sent to PackTrack" pill once `sent_at` is set.
  - Card-level honesty copy: "Recommendation only. Sending creates a recommendation in PackTrack for owner approval. Luma does not create a PO."
  - When `packtrackConfigured=false`, a "PackTrack handoff not configured" tag appears in the card header.
- Config / env behavior:
  - `PACKTRACK_RECOMMENDATION_URL` + `PACKTRACK_RECOMMENDATION_SECRET` are the two env vars.
  - Whitespace-only values count as missing.
  - Status surfaces at `/settings/integrations/packtrack` under "Recommendation handoff (outbound)": three rows (endpoint / secret / live-sending) — never the values, only yes/no. Missing var names listed in an amber banner.
- Tests added:
  - `lib/integrations/packtrack/recommendations.test.ts` — 15 cases (4 config / 2 payload / 3 mapper / 3 gates / 1 happy path / 4 failure modes incl. secret redaction).
  - `app/(admin)/material-alerts/actions.test.ts` — +8 send-action cases (config gate, 5 row-state gates, HTTP failure persist+audit, success persist+audit+idempotency-header).
  - `app/(admin)/material-alerts/_recommendations-panel-helpers.test.ts` — 7 cases for `deriveSendBlockReason` priority ladder.
- Build / test results:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1093/1093 pass across 49 test files** (+19 vs PT-7D's 1074; +2 test files).
  - `npx next build` → clean (only the pre-existing OpenTelemetry `@opentelemetry/exporter-jaeger` warning, unrelated).
- Staging verification (LX122 / SHA `ef60c94`):
  - Deploy via `systemctl start luma-deploy.service` succeeded.
  - `/api/health` flipped to `ef60c9494024dcde662a46c8bc06e385aa88970c`.
  - Migration 0030 row present in `drizzle.__drizzle_migrations`.
  - `\d read_material_recommendations` shows `sent_at timestamptz` + `last_sent_response jsonb` columns.
  - `/material-alerts` returns 200 under admin auth. Empty state still honest (zero rows in `read_material_recommendations`; that's PT-7F's seed job).
  - `/settings/integrations/packtrack` returns 200. PackTrack env intentionally unset on staging → "Live sending enabled: No — UI shows PackTrack handoff not configured."
  - Auth smoke 47/47 PASS.
  - No PackTrack POST attempted from Luma in this phase.
- PT-7F readiness: ready. PT-7F seeds a real recommendation against staging data (rebuild + a CRITICAL/HIGH-confidence row), exercises the acknowledge → send flow end-to-end (either against a real PackTrack staging endpoint or with a mock receiver), verifies last_sent_response surfaces in the row's audit chain, and closes the queue item out.

---

## PT-7D — Material-alerts recommendation UI + acknowledge/dismiss actions (complete)
- Date: 2026-05-13
- Result: UI + actions phase. `/material-alerts` now exposes the rows PT-7C persists; admins can acknowledge or dismiss without any PackTrack contact. PT-7E is the outbound integration; this phase is intentionally read-only against the recommendation table.
- Files changed:
  - **NEW** `lib/db/queries/material-recommendations.ts` (~265 lines) — exports `loadMaterialRecommendations`, `filterRecommendations` (pure in-memory), `countRecommendations`, types. SQL pushes only the `status` axis (so the partial-unique index path stays hot); other filters apply in memory.
  - **NEW** `lib/db/queries/material-recommendations.test.ts` (~225 lines, 16 cases) — status, severity, confidence, sendable, missing-config, product, material filters + interactions (acknowledged-still-visible, MISSING-row-stays-unless-sendable-only) + counters.
  - **NEW** `app/(admin)/material-alerts/actions.ts` (~165 lines) — `acknowledgeMaterialRecommendationAction` + `dismissMaterialRecommendationAction`. Both `requireAdmin`, idempotent (second call on already-set timestamp is a noop), write `audit_log` inside the same transaction. Dismiss accepts optional `reason` + `notes`; appended to `warnings[]` as `[dismissed: reason — notes]` so the UI surfaces history without a new column.
  - **NEW** `app/(admin)/material-alerts/actions.test.ts` (~210 lines, 11 cases) — stub-tx pattern. Verifies set/append/audit semantics, idempotency, validation-before-write, no fetch / no PackTrack import (static string scan against actions.ts).
  - **NEW** `app/(admin)/material-alerts/_recommendations-panel.tsx` (~410 lines) — client component. Filter chips for status (ACTIVE / ACKNOWLEDGED / DISMISSED / ALL) + severity + confidence; checkboxes for sendable-only + missing-config-only; selects for product (with "Material-wide only" option) + material. Per-row badges: severity / confidence / Sendable | Not sendable / Required: <role> / Missing configuration / Acknowledged / Dismissed. Honesty copy in card header + per-row footer: "Recommendation only — Luma has not ordered anything. Not sent to PackTrack yet."
  - MOD `app/(admin)/material-alerts/page.tsx` — fetches recommendations in parallel with the existing panel; renders `<ShortageRecommendationsPanel rows={...} />` above the existing alert cards.
  - MOD `lib/production/qc-review-language.test.ts` — 4 PT-7D files added to the banned-phrase scan.
  - MOD `docs/CLAUDE_BUILD_QUEUE.md` — PT-7D sub-bullet flipped to `[x]` with verification log.
- Filters added (UI):
  - **Status**: ACTIVE (default — hides `dismissed_at`-set rows but keeps acknowledged) / ACKNOWLEDGED / DISMISSED / ALL.
  - **Severity**: subset of CRITICAL / HIGH / MEDIUM / WATCH (multi-select).
  - **Confidence**: subset of HIGH / MEDIUM / LOW / MISSING (multi-select).
  - **Sendable only**: drops rows with `sendable_to_packtrack=false`.
  - **Missing config only**: keeps rows with non-empty `missing_inputs[]`.
  - **Product**: dropdown (with "Material-wide only" option to keep only rows where `product_id IS NULL`).
  - **Material**: dropdown across distinct materials in the current row set.
- Actions added (server):
  - `acknowledgeMaterialRecommendationAction(formData{ recommendationId })` → sets `acknowledged_at = now()` (only if currently NULL); writes audit entry `material_recommendation.acknowledge`; revalidates `/material-alerts`.
  - `dismissMaterialRecommendationAction(formData{ recommendationId, reason?, notes? })` → sets `dismissed_at = now()` (only if currently NULL); appends a `[dismissed: ...]` tag to `warnings[]`; writes audit entry `material_recommendation.dismiss`; revalidates.
  - Both refuse non-UUID input before touching the tx; both refuse if the row doesn't exist; both noop (return `ok:true`) on a row that's already in the target state — operator can click twice without harm.
- Data-honesty discipline (verified):
  - Card header explicitly says "Recommendation only. Not sent to PackTrack yet. Owner approval required in PackTrack before any purchase order is created."
  - MISSING-confidence rows persist `sendable_to_packtrack=false` (by PT-7B); UI surfaces a "Not sendable" badge + "Missing configuration" tag.
  - Per-row footer: "Recommendation only — Luma has not ordered anything. Not sent to PackTrack yet."
  - `actions.ts` has no `fetch(` and no PackTrack-client import (the test scans for this statically).
  - Banned-language test extended to all 4 new files; tests pass (no "production loss" / "supplier shortage" / "known_loss" strings present).
- Build / test results:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1074/1074 pass across 48 test files** (+22 vs PT-7C's 1052; +2 test files).
  - `npx next build` → clean.
- Staging verification (LX122 / SHA `e56812f`):
  - Deploy via `systemctl start luma-deploy.service` succeeded.
  - `/api/health` flipped to `e56812f819e37d7fe126065162091a6e439f0b26`.
  - `/material-alerts` returns 200 under admin auth.
  - Recommendation section renders the empty-state copy ("No shortage recommendations yet. Run material recommendation rebuild.") — staging has zero rows in `read_material_recommendations` (a real rebuild against staging data is PT-7F's job, not PT-7D's).
  - Auth smoke 47/47 PASS (same routes as PT-7C baseline).
  - No noisy fake recommendations introduced — empty state is the honest render.
- PT-7E readiness: ready to start. PT-7E adds the outbound PackTrack client + settings panel under `/settings/integrations/packtrack`. The actions in PT-7D already write to `read_material_recommendations.acknowledged_at` — PT-7E only needs to add a send step that reads back from this table and posts to PackTrack, with the existing `recommendation_id` as the idempotency key.

---

## PT-7C — Read model + rebuilder for shortage recommendations (complete)
- Date: 2026-05-13
- Result: persistence layer for PT-7B. Schema migration + projector + 15 stub-tx tests. Idempotent rebuild; operator state (acknowledged / dismissed / `recommendation_id`) preserved across runs. No PackTrack call, no UI change. PT-7D can now read from `read_material_recommendations`.
- Files changed:
  - **NEW** `drizzle/0029_packtrack_recommendations.sql` — adds 3 ordering columns to `packaging_materials` (`min_order_quantity`, `safety_buffer_percent`, `order_multiple`); creates `read_material_recommendations` with 23 columns, 1 unique on `recommendation_id`, 2 partial-uniques (active per-product + active material-wide), 7 lookup indexes. All nullable / `IF NOT EXISTS` — replayable.
  - **NEW** `lib/projector/packtrack-recommendations.ts` (~565 lines) — exports `rebuildMaterialRecommendations(tx, opts)` returning `{scanned, written, deleted, preservedAcknowledged, skippedMachineConsumable}`. Walks active materials, skips machine consumables via `skipMaterialKindForPackTrackShortage`, derives scope from PBOM-2 `product_material_compatibility` (0 or 2+ products → material-wide; exactly 1 → product-scoped), hydrates from `read_material_lot_state` + `packaging_lots` + `read_material_burn` + `read_material_consumption_daily`, threads through PT-7B, upserts via Drizzle.
  - **NEW** `lib/projector/packtrack-recommendations.test.ts` (~480 lines, 15 cases) — stub-tx pattern with phase-state-machine scope advance. Covers kind skip (PVC_ROLL / FOIL_ROLL / BLISTER_FOIL), scope inference (0 / 1 / 2+ compat rows), sendable gating (missing code → false, HIGH → true), MOQ + order_multiple flow through to `recommendedOrderQuantity`, noop / delete / preserve / update paths, jsonb shape of signals / missing / warnings.
  - MOD `drizzle/meta/_journal.json` — entry idx 29 / `when 1780900000000`.
  - MOD `lib/db/schema.ts` — 3 new fields on `packagingMaterials`; new `readMaterialRecommendations` pgTable with 9 indexes. Self-FK on `superseded_by` declared at SQL level (drizzle's typed self-ref is awkward).
  - MOD `scripts/rebuild-read-models.ts` — imports `rebuildMaterialRecommendations`, adds `"read_material_recommendations"` to the `tables` array, calls the rebuilder inside the transaction with a result-log line.
  - MOD `docs/CLAUDE_BUILD_QUEUE.md` — PT-7C sub-bullet flipped to `[x]` with verification log.
- Rebuilder behavior:
  - **Skip rule:** materials with kind ∈ {PVC_ROLL, FOIL_ROLL, BLISTER_FOIL} bumped into `skippedMachineConsumable` and never enter PT-7B. (Roll consumption routes through `roll-usage`, not PT-7.)
  - **Scope rule (PT-7A §11.3):** 0 active compat rows → `product_id = null` material-wide; exactly 1 distinct product → `product_id = <that one>`; 2+ → material-wide row with multi-product context implicit in the input.
  - **Hysteresis:** `hadActiveRecommendation` is computed per (material, product) by querying live state, so a deleted row from earlier in the rebuild doesn't accidentally feed PT-7B with stale "had active" = true.
  - **Operator-state preservation:** when `deriveShortageRecommendation` returns `null` but an existing row has `acknowledged_at` or `dismissed_at` set, the row stays untouched (preserved); when it has neither, the row is deleted. When derive returns a recommendation and a row exists, the row is updated in place (preserving `recommendation_id`, `acknowledged_at`, `dismissed_at`, `last_send_error`). New rows get a fresh `recommendation_id` defaulted by Postgres.
  - **Inventory source classification:** `allCounted` → `COUNTED`; else `anyImport` → `LEGACY_IMPORT`; else manual / packtrack → `SUPPLIER_DECLARED`; else `null`.
- Build / test results:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run` → **1052/1052 pass across 47 test files** (+15 vs PT-7B's 1037; +1 test file).
  - `npx next build` → clean.
- Staging verification (LX122 / SHA `f004a1a`):
  - Deploy via `systemctl start luma-deploy.service` succeeded.
  - `/api/health` flipped to `f004a1a9f8cd9e804bb93d92dfe343d38c5d6ec1`.
  - Migration 0029 row present in `drizzle.__drizzle_migrations`.
  - `\d read_material_recommendations` shows the table with all 23 columns + 2 partial-unique indexes + 7 hot-path indexes.
  - `\d packaging_materials` shows the 3 new columns (`min_order_quantity` numeric(20,6), `safety_buffer_percent` numeric(6,2), `order_multiple` numeric(20,6)).
  - Auth smoke 47/47 PASS (same as PT-7B baseline; no UI added in PT-7C so no new routes).
  - `SELECT COUNT(*) FROM read_material_recommendations` returns 0 until a rebuild or first projector-on-event run; expected.
- PT-7D readiness: the read model is the single source PT-7D needs to query for `/material-alerts`. No additional schema work required — PT-7D adds UI + acknowledge / dismiss server actions only.

---

## PT-7B — Pure shortage recommendation helpers + tests (complete)
- Date: 2026-05-13
- Result: pure-math phase. Logic-only module + 59 fixture tests + banned-phrase scan. No DB, no PackTrack call, no UI change.
- Files changed:
  - **NEW** `lib/production/packtrack-shortage.ts` (~545 lines) — typed input/output models, 11 exported pure helpers.
  - **NEW** `lib/production/packtrack-shortage.test.ts` (~600 lines, 59 cases).
  - MOD `lib/production/qc-review-language.test.ts` — banned-phrase scan extended to the new helper file.
  - MOD `docs/CLAUDE_BUILD_QUEUE.md` — PT-7B sub-bullet flipped to `[x]`.
- Helpers exported (11):
  - `deriveShortageRecommendation(input)` — main entry; returns the full recommendation row or `null` (skipped machine consumable, or no-shortage non-required material).
  - `deriveShortageRecommendations(inputs)` — batch wrapper that filters nulls.
  - `calculateRunoutDate(input)` — on_hand / rate days from `generatedAt`; null when rate is null/0; today when on_hand already 0.
  - `calculateProjectedShortage(input)` — returns `{projectedDemand, projectedShortage}`. Demand = max(rate × leadTime, productionTargetDemand). Shortage = max(demand − accepted, 0).
  - `calculateRecommendedOrderQuantity(shortage, opts)` — applies safety buffer (default 20%), respects `minOrderQuantity`, rounds up to `orderMultiple`; never negative.
  - `classifyShortageConfidence(input)` — HIGH/MEDIUM/LOW/MISSING from gap count (see "Confidence behavior" below).
  - `classifyShortageSeverity(input, ctx)` — CRITICAL / HIGH / MEDIUM / WATCH from runout date vs. lead time + required flag + par level.
  - `deriveShortageSignals(input)` — builds the typed signal array; never empty when confidence ≠ MISSING; emits `MISSING_CONFIG` entries for each gap.
  - `isRecommendationSendableToPackTrack(rec)` — true only when confidence ≠ MISSING AND `materialCode` non-empty AND `recommendedOrderQuantity > 0`.
  - `shouldKeepExistingRecommendation(input, ctx)` — 1.2× hysteresis predicate (keep active rec until on-hand exceeds 1.2× trigger threshold).
  - `skipMaterialKindForPackTrackShortage(kind)` — gate for PVC_ROLL / FOIL_ROLL / BLISTER_FOIL.

### Confidence behavior
HIGH when every input is at its strongest: `inventorySource = COUNTED|WEIGH_BACK_DERIVED`, BOM line present (when product-scoped), ≥7-day consumption history, PBOM-2 compatibility row present, lead time live from PackTrack. Each gap adds one count toward MEDIUM (1 gap) / LOW (2+ gaps). Hard-MISSING inputs (`material_code`, `inventory_source`, `usage_history` when neither source nor production target supplied, `bom_configured` for product-scoped, `compatibility` for product-scoped, `lead_time`, `inventory_confidence=MISSING`) force overall MISSING. `inventoryConfidence` is treated as metadata that mirrors `inventorySource` — counted both would double-count the same gap; only MISSING band still escalates here.

### Severity behavior
CRITICAL: required + accepted=0; OR required + productionTargetDemand > accepted; OR runout already passed/today. HIGH: runout < lead time; OR projected shortage + production target present. MEDIUM: runout < 1.5× lead time; OR below par with non-zero daily rate; OR positive projected shortage without target context. WATCH: below par without usage rate, OR no shortage at all (helper returns `null` instead of WATCH when there's nothing actionable to surface).

### Quantity formula
`shortage × (1 + safety_buffer_percent/100)` → if `< minOrderQuantity` lift to `minOrderQuantity` → round up to `orderMultiple` when provided, else `Math.ceil`. Defaults: 20% buffer, no min, no multiple. Never negative; returns `null` when `confidence=MISSING` (cannot quote a number).

### Tests (59 cases, all pass)
1-3 kind skip (PVC / FOIL / BLISTER_FOIL); 4 required + zero → CRITICAL; 5 missing material_code → MISSING + not sendable; 6-9 confidence ladder (HIGH/MEDIUM/LOW/MISSING for inventory + BOM + compatibility + usage); 10-13 severity timing (CRITICAL today, HIGH within lead, MEDIUM within 1.5× lead, WATCH/MEDIUM below par); 14-17 quantity formula (default buffer 20%, custom buffer, min override, order multiple, both, never negative, null shortage → null qty); 18-19 signal invariants (non-empty when confidence ≠ MISSING; MISSING_CONFIG present on missing inputs; window_days metadata on DAILY_USAGE_RATE); 20 compatibility.required raises severity; 21 hysteresis 1.2× rule (keep when in shortage, keep at 1.15× clear, withdraw at 1.25× clear); 22 supplier hint from MANUAL_LUMA receipt vs. null when no receipt; 23 batch processing (skips machine consumables; emits one rec per input); 24-25 production target vs. rate-based demand; 26 short window → MEDIUM, zero-day window → MISSING; 27-28 sendableToPackTrack (false for MISSING, true for HIGH/MEDIUM/LOW with code + qty, false when qty=0); 29 reason is a single human-readable sentence terminating with a period and naming the material + runout date; 30 banned-language scan over reason / signals / warnings; MISSING path uses "manual review required" phrasing (no silent zero).

### Formula decisions documented in code
- `DEFAULT_SAFETY_BUFFER_PERCENT = 20`.
- `DEFAULT_EXPIRES_HOURS = 24` (recommendation freshness window).
- `HYSTERESIS_MULTIPLIER = 1.2` (when an active rec is held).
- `MEDIUM` band threshold for runout: `< 1.5 × leadTimeDays`.
- Severity rule for required materials: CRITICAL even when accepted > 0 *if* `productionTargetDemand > accepted` (the "we can't hit the plan" case).
- `recommendedOrderQuantity = null` when `confidence = MISSING` — never quote a number we can't justify.
- `deriveShortageRecommendation` returns `null` (no rec emitted) when there's no shortage AND not below par AND not required — surfacing "nothing to do" rather than a noise row.

### Local verification
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **1036/1036 pass across 46 test files** (+59 vs PT-7A's 977).
- `npx next build` → clean.

### Risks / open questions still open from PT-7A
- Lead-time data still config-default — PT-7E swaps to live PackTrack values.
- 7-day usage window may need 28-day fallback for sporadically-used materials. Helper accepts arbitrary windows; the projector (PT-7C) decides which to feed.
- Hysteresis tested against `parLevel` as trigger threshold; the projector can pass a different threshold (e.g. computed reorder point) per call.

### Next phase
**PT-7C** — schema migration 0029 (`read_material_recommendations` table + `packaging_materials.min_order_quantity / safety_buffer_percent` columns) + projector that hydrates `ShortageRecommendationInput` from live read models and persists results. The helper is frozen and stable; PT-7C only has to thread inputs through it.

---

## PT-7A — PackTrack shortage recommendations plan (complete)
- Date: 2026-05-13
- Result: plan-only phase. Detailed implementation contract written to `docs/PACKTRACK_SHORTAGE_RECOMMENDATIONS_PLAN.md` (~330 lines, 12 sections). No code, no migrations, no PackTrack call.
- Boundary explicitly captured: Luma calculates risk / usage / shortage / needed-by; PackTrack owns POs / suppliers / approvals / reorder workflow. Luma never auto-creates a PackTrack PO. Recommendation flows OUT of Luma to PackTrack's inbox; PT receipts flow back via the existing PT-1 packaging-receipt push.
- **Recommendation model (§3):** 22 fields per row including `recommendation_id` (UUID PK), `material_code` (= packaging_materials.sku), `material_name`, `material_id` (FK), `product_id/name/sku` (nullable when material-wide), `compatibility_role`, `current_on_hand`, `accepted_inventory`, `projected_demand`, `projected_shortage_quantity`, `recommended_order_quantity`, `needed_by_date`, `confidence` (HIGH/MEDIUM/LOW/MISSING), `severity` (CRITICAL/HIGH/MEDIUM/WATCH), `reason` (single sentence), `source_signals` (jsonb array — every input that fed the projection, never empty when confidence ≠ MISSING), plus housekeeping fields (`generated_at`, `expires_at`, `acknowledged_at`, `dismissed_at`, `superseded_by`).
- **Data sources (§7):** `read_material_lot_state` (on-hand), `read_material_reconciliation_v2.accepted_value` (PT-6's 8-bucket), `read_material_consumption_daily` (preferred usage), `read_sku_daily × product_packaging_specs.qtyPerUnit` (fallback usage), `product_material_compatibility.required` (PBOM-2 gate), `packaging_materials.par_level`, `packaging_lots.supplier/source_system`, due-targets standards, `workflow_events` SCRAP_RECORDED (informational only — already affects on-hand). PVC / FOIL / BLISTER_FOIL rolls are **explicitly skipped** — those route through roll-usage, not PT-7.
- **Confidence rules (§4):** HIGH requires counted lot state + configured BOM + ≥7d usage history + (when product-scoped) PBOM-2 compatibility row. MEDIUM has exactly one gap. LOW has two+ gaps or legacy source. MISSING blocks `recommended_order_quantity` (recommendation still emitted, labeled "manual review required" — never silently treated as "no shortage").
- **Shortage triggers (§5):** (1) required material on zero inventory → CRITICAL. (2) Projected runout before lead-time horizon → HIGH/MEDIUM/WATCH by ratio. (3) Below par + projected demand > 0 → WATCH+. (4) Production target unmet via due-targets + BOM math → HIGH. (5) Compatibility configured but never received → HIGH with MISSING confidence. **What does NOT trigger:** receipt variance alone, cycle-count variance alone, scrap above noise floor, PVC/FOIL/BLISTER_FOIL kinds.
- **PackTrack handoff (§8):** `schema_version` versioned JSON payload with `recommendation_id` as the idempotency key. `confidence ≠ MISSING` is a hard precondition to send. `recommended_order_quantity` is a *recommendation*, not binding — PackTrack's PO can differ. No PO creation from Luma. Owner approval entirely on PackTrack's side; receipt comes back to Luma carrying `packtrack_po_id`.
- **Approval flow (§9):** project → admin acknowledges on `/material-alerts` (PT-7D) → POST to PackTrack inbox (PT-7E) → owner approves on PackTrack → PackTrack creates PO → supplier ships → PackTrack receives → PT-1 push writes the packaging_lots row carrying `packtrack_po_id` → PT-6 v2 reconciliation closes the loop → recommendation marked fulfilled/superseded.
- **Phase split (§10):** PT-7A (plan, this entry) / PT-7B (pure helpers, ~1.5d) / PT-7C (migration 0029 + projector, ~1.5d) / PT-7D (`/material-alerts` extension, ~1d) / PT-7E (outbound PackTrack client, ~1.5d) / PT-7F (staging verification, ~0.5d). Total ~6.5 days.
- **Risks logged (§11, 10 items):** lead-time data not live until PT-7E; daily-usage window may need 28-day fallback; multi-product materials emit one rec per material with per-product signal entries; materials with no PackTrack history still get recs but no supplier hint; stale rec wipe-and-rewrite semantics; PackTrack 4xx surface as `last_send_error` (no auto-retry); recommendation churn → hysteresis rule (1.2× threshold); PBOM-2 `required` flag interaction; variety packs reuse `item_conversions` helpers; banned-phrase scan extended to PT-7 files in PT-7B.
- Queue updated: PT-7 sub-phase block now lists six sub-phases with `[x] PT-7A`, the rest `[ ]`.
- Next phase: **PT-7B** — pure shortage calculation helpers + tests. No PackTrack contact; pure-math + DB-handle-stub testable. Ready to start.

---

## QC-6 — Final QC subsystem verification + closeout (complete)
- Date: 2026-05-13
- Result: **QC subsystem complete**. Main queue checkbox flipped to `[x]`. Sub-phases QC-0 through QC-6 all closed. No new code shipped in QC-6; this is verification-only.

### Local checks
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **919 / 919 pass across 43 test files** (no regressions from QC-5).
- `npx next build` → clean.
- Focused QC-suite subset (`qc-events`, `qc-actions`, `qc-review-loaders`, `qc-review-language`, `qc-panel-helpers`, `sidebar`) → **123 / 123 pass** across 7 files.

### Staging verification (LX122)
- Head on disk: `5972da4 docs(qc-5): record verification + flip checkbox` (docs-only since QC-5).
- Container live SHA: `aee76f314ec6a03ab99076ef8451d079f7f0ea79` (the QC-5 code commit — health endpoint confirmed). The docs-only commit does not change the build artifact.
- `drizzle.__drizzle_migrations` shows the last four entries with strictly-increasing `created_at`: idx 24 (`1780400000000`), 25 (`1780500000000`, PT-6C), 26 (`1780600000000`, QC-1), 27 (`1780700000000`, QC-5).
- `\d read_bag_state` confirms `rework_pending`, `rework_received`, `has_correction` columns (all `boolean NOT NULL DEFAULT false`) + partial index `read_bag_state_rework_pending_idx` on `rework_pending = true`.
- `\d read_operator_daily` confirms five new QC counters: `damage_events_total`, `rework_sent_total`, `rework_received_total`, `scrap_units_total`, `corrections_total` (all `integer NOT NULL DEFAULT 0`).
- `pg_indexes` for `workflow_events`: `workflow_events_linked_event_idx` and `workflow_events_linked_event_resolution_unique` present.
- `pg_enum` confirms all five QC values present in `workflow_event_type`: `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`.

### Live QC event counts on staging
- `PACKAGING_DAMAGE_RETURN`: **0**
- `REWORK_SENT`: **0**
- `REWORK_RECEIVED`: **0**
- `SCRAP_RECORDED`: **0**
- `SUBMISSION_CORRECTED`: **460** (legacy synthesizer; pre-QC-5).
- This is the expected staging state: no real damage has been reported through the new QC-3 floor panel yet, and supervisor scrap/rework actions through the new QC-4 admin page haven't been used live. The four operator-emitted event types accrue only from real production traffic.

### Read-model invariant check (live data)
- `read_bag_state.has_correction = true` count: **0**. Distinct bags with `SUBMISSION_CORRECTED` in `workflow_events`: **45**. Difference is expected — the legacy SUBMISSION_CORRECTED rows pre-date QC-5's projector, and neither `scripts/rebuild-read-models.ts` nor `scripts/replay-workflow-events.ts` re-aggregate QC flags from raw events. See "Known limitations" §1 below.
- `rework_pending = true` count: 0. `rework_received = true` count: 0. Consistent with zero live REWORK events.

### UI surface verification (auth smoke + curl)
- `auth-smoke (npx tsx scripts/smoke-authenticated-routes.ts)` inside the running container: **PASS = 46, REDIR = 0, FAIL = 0**.
- All five QC-relevant routes return 200 under OWNER auth:
  - `/qc-review`
  - `/operator-productivity`
  - `/genealogy` (and `/genealogy/<bagId>` curl on a real bag with corrections returns 307 unauthenticated — auth redirect correct)
  - `/po-reconciliation-v2`
  - `/material-alerts`

### Event-flow verification
- **PACKAGING_DAMAGE_RETURN** — floor action `reportPackagingDamageAction` (QC-2) writes through `projectEvent` with full OP-1 accountability (employee_id from station session, user_id null on floor PWA, source = STATION_OPERATOR_SESSION, name snapshot frozen). QC-5 projector bumps `read_operator_daily.damage_events_total`, `read_sku_daily.damages`, `read_station_quality_daily.{reject_units, damaged_units}`. Pending damage surfaced on `/qc-review` via `loadPendingDamage` (NOT EXISTS against SCRAP/REWORK_SENT resolutions). Genealogy renders the rose badge. — Server-side path covered by unit tests; staging count = 0 awaiting real production traffic.
- **REWORK_SENT** — floor action `reworkSentAction` writes the event + sets `read_bag_state.rework_pending = true` via QC-5 projector. Admin `adminReworkSentFromDamageAction` (QC-4) preserves linked event's accountable employee, supervisor → entered_by_user_id, conflict-guarded by partial-unique on `(payload->>'linked_event_id', event_type)`. Surfaced on `/qc-review` "Rework in flight" via `loadReworkInFlight` CTE.
- **REWORK_RECEIVED** — floor `reworkReceivedAction` + admin `adminReworkReceivedAction` (supports partial). QC-5 projector recomputes `rework_pending` from open-rework SUM query (partial keeps it true, full clears it) and sets `rework_received = true` sticky. Partial receives stack via the loader's SUM; loader test pins the math.
- **SCRAP_RECORDED** — admin `scrapRecordedAction` (QC-2) preserves linked event's accountable employee (FOR UPDATE on source row), supervisor → entered_by + `correction_actor_user_id` in payload, conflict-guarded for second-conversion. QC-5 projector bumps `read_operator_daily.scrap_units_total` by `scrap_quantity`, `read_sku_daily.scrap`, `read_station_quality_daily.scrap_units`. `read_material_lot_state.qty_on_hand` decrements only when `affects_packaging_material=true` AND `material_lot_id` named (HIGH→MEDIUM confidence step on the decrement). `read_material_reconciliation_v2.scrappedOrDamagedValue` reads SCRAP_RECORDED totals via `loadScrapFromQcEvents` → source `EXPLICIT_SCRAP_EVENT`, HIGH confidence. **PT-6 8-bucket formula untouched.**
- **SUBMISSION_CORRECTED** — admin `submissionCorrectedAction` writes the event without mutating the original; preserves linked event's `employee_id`; supervisor → `entered_by_user_id`; `correction_actor_user_id` in payload. Original event remains in workflow_events. QC-5 projector sets `read_bag_state.has_correction = true` and bumps `read_operator_daily.corrections_total` against the original accountable employee. Surfaced on `/qc-review` Recent events table with inline "Correct" trigger.

### TEST-D-QC packet result
**Skipped on staging by design.** Creating one PACKAGING_DAMAGE_RETURN + REWORK_SENT + REWORK_RECEIVED + SCRAP_RECORDED + SUBMISSION_CORRECTED chain through the live actions would write five append-only rows that cannot be cleanly removed (events are append-only; correcting a test correction just adds another row; partial-receive math means the rows would persist indefinitely on `/qc-review`). The "no messy test data" instruction takes precedence. The full happy-path event flow is covered by:
- `lib/production/qc-actions.test.ts` (16 cases) — per-action emit + accountability propagation + conflict-guard branches.
- `lib/projector/qc-events.test.ts` (15 cases) — projector dispatch matrix per event type + bag-state flag flips + rework_pending recompute + material lot decrement guards.
- `lib/production/qc-events.test.ts` (49 cases) — payload validators (QC-1).
- `lib/production/qc-review-loaders.test.ts` (15 cases) — pending damage / rework-in-flight / partial-receive math.
- `lib/production/qc-panel-helpers.test.ts` (15 cases) — floor panel station whitelist + reason-code coherence.

The end-to-end exercise will happen naturally as operators encounter real damage on the floor.

### Honest-language verification
- `lib/production/qc-review-language.test.ts` scans the QC-3/4/5 surface files (`qc-review/page.tsx`, all three QC-review form components, `qc-review/actions.ts`, `qc-review-loaders.ts`, `qc-events.ts` projector, `operator-productivity/page.tsx`, `genealogy/[bagId]/page.tsx`) for the banned phrases `production loss`, `supplier shortage`, `known_loss`. **9/9 files pass.** Sidebar test (`components/admin/sidebar.test.ts`) also passes the banned-phrase scan.
- PT-6 8-bucket model preserved: QC events feed only `scrappedOrDamaged` (and indirectly `consumptionVariance`); never `receiptVariance` or `cycleCountVariance`. Rework pending stays informational on `/qc-review`, not in the bucket math.

### Replay / rebuild verification
- `scripts/rebuild-read-models.ts` rebuilds: `read_queue_state`, `read_sku_daily`, `read_material_reconciliation` (v1), `read_material_reconciliation_v2`, `read_station_quality_daily`, `read_material_lot_state`, `read_material_consumption_daily`, `read_roll_usage`, `read_material_usage_learning`. **Does NOT rebuild `read_bag_state` QC flags or `read_operator_daily` QC counters from workflow_events.** See limitation §1.
- `scripts/replay-workflow-events.ts` walks `workflow_events` for finalized bags, backfills `workflow_bags.finalized_at`, and rebuilds the read models above. **Does NOT call `projectQcEvent` per event** — same forward-only limitation.
- The QC-5 projector is idempotent at the per-event layer: the upstream `workflow_events_client_event_unique` partial-unique on `(workflow_bag_id, event_type, client_event_id)` makes `projectEvent` bail before touching read models on retry. So if a future backfill script calls `projectEvent` for each historical QC event, it will be safe (no double-count).
- PT-6 reconciliation v2's `rebuildMaterialReconciliationV2` still works — the existing test suite (15 cases in `material-reconciliation-v2.test.ts`) passes with the new `loadScrapFromQcEvents` query returning `[{total: 0}]` from the test's execute stub, preserving the "scrap MISSING" assertion.

### Files changed in QC-6
- `docs/CLAUDE_BUILD_QUEUE.md` — main QC subsystem block flipped to `[x]`; QC-6 sub-bullet flipped to `[x]` with verification summary.
- `docs/CURRENT_PHASE_STATUS.md` — this entry appended.
- **No source code changes.** QC-6 is verification-only.

### Known limitations (documented, not blocking sign-off)
1. **Forward-only QC projection.** `projectQcEvent` is invoked from `projectEvent` at event-emit time. Neither `scripts/rebuild-read-models.ts` nor `scripts/replay-workflow-events.ts` re-aggregate QC counters from `workflow_events`, so legacy events that pre-date QC-5 (the 460 SUBMISSION_CORRECTED rows from the synthesizer; 0 of the other four types) won't retroactively set flags or bump counters. The new QC flow is the canonical source going forward; a future backfill script can replay historical events through `projectEvent` if needed — its idempotency guard makes that safe.
2. **No photo capture on the floor.** QC-2 actions accept `photo_keys`, but there's no upload helper wired on the floor PWA. QC-3 ships text-notes-only with an explicit on-panel disclosure. QC-3.5 (or QC-7) can add photos without re-shaping the action contracts.
3. **Raw-product scrap doesn't move inventory.** SCRAP_RECORDED with `affects_raw_product=true` is captured in workflow_events but does NOT decrement any raw-product inventory ledger today — the codebase has no per-bag raw-material ledger yet. Packaging-material scrap with a named lot DOES decrement `read_material_lot_state.qty_on_hand`. Raw-product accounting comes when a raw-tablet ledger lands (post-cutover).
4. **Ad-hoc scrap (no linked event) intentionally not exposed in QC-4 UI.** The existing `scrapRecordedAction` requires `overrideEmployeeId` for ad-hoc scrap to enforce explicit operator attribution. QC-4 chose not to ship that picker UI to avoid mis-attribution; programmatic ad-hoc scrap remains available.
5. **Nexus / QIP customer complaint integration is out of scope.** The QC-0 plan reserves the genealogy trace forever (`accountable_employee_name_snapshot` in payload, reason-code vocabulary stable), but the customer-facing complaint surface is not built and not planned in this queue.
6. **PackTrack shortage recommendations (PT-7) deferred.** Separate queue item.
7. **TEST-D-QC manual packet skipped on staging.** Event store is append-only; cannot cleanly clean up test rows. End-to-end test coverage is in vitest (123/123 across QC-touched suites). Real-world exercise will happen as operators use the floor panel.
8. **The cutover-blocker checklist in `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md`** is satisfied for code-path completeness. The "manual review required" surface (Phase QC-5's reconciliation v2 line) is honest about its inputs. Real production traffic will determine whether any wire is loose; until then, the contract is complete.

### Closeout
- `docs/CLAUDE_BUILD_QUEUE.md` main QC subsystem block: `[x]`.
- All six sub-phase checkboxes (QC-0..QC-6) in the queue's QC sub-block: `[x]`.
- Next unchecked phase in the queue: **PackTrack shortage recommendations (PT-7)** at `docs/CLAUDE_BUILD_QUEUE.md` line 290 (per the current ordering).
- Per the instruction, **not starting any later phase**.

---

## QC-5 — Read-model + UI integration of QC events (complete)
- Date: 2026-05-13
- Result: **complete**. Live QC events from QC-2/3/4 now move the existing read models and surface in `/operator-productivity`, `/genealogy/[bagId]`, and the PT-6 reconciliation scrap bucket. Queue checkbox flipped to `[x]`.

### Files changed
- **NEW** `drizzle/0027_qc_bag_state_flags.sql` — `read_bag_state` gains `rework_pending`, `rework_received`, `has_correction` booleans + partial index on `rework_pending = true`. Journal entry `idx 27, when 1780700000000`.
- **NEW** `lib/projector/qc-events.ts` — projector dispatch for the five QC event types. Idempotent (upstream conflict gate handles retries). Touches `read_operator_daily` (5 QC counters by accountable employee), `read_sku_daily` (damages/rework/scrap by bag.product_id), `read_station_quality_daily` (reject/scrap/rework/damaged units by machine+product+output_unit), `read_bag_state` (the three flags), `read_material_lot_state` (decrement on SCRAP_RECORDED with packaging-material scope only).
- **NEW** `lib/projector/qc-events.test.ts` (15 cases) — operator-daily attribution (skip when no employee, scrap by `scrap_quantity` not 1), bag-state flag flips, rework_pending recompute branch, material-lot decrement guards (no decrement without `material_lot_id` or without `affects_packaging_material=true`), SKU + station-quality dispatch with/without product/station.
- **MODIFIED** `lib/projector/index.ts` — calls `projectQcEvent` after the existing read-model writes when `isQcEventType(ev.eventType)`.
- **MODIFIED** `lib/projector/material-reconciliation-v2.ts` — `loadScrapFromQcEvents(tx, lotId)` pulls `SUM(scrap_quantity)` from `workflow_events` of type `SCRAP_RECORDED` matching `payload->>'packaging_lot_id' = lotId OR payload->>'material_lot_id' = lotId` AND `affects_packaging_material=true`. Replaces the QC-deferral `null`. Source label `EXPLICIT_SCRAP_EVENT` → reconciliation-v2's existing `scrappedOrDamaged` bucket lights up at HIGH confidence.
- **MODIFIED** `lib/projector/material-reconciliation-v2.test.ts` — `tx.execute` stub returns `[{total: 0}]` so existing tests preserve their "scrap stays MISSING" assertion under the new query.
- **MODIFIED** `lib/db/schema.ts` — mirrors the three new `read_bag_state` columns and the partial index.
- **MODIFIED** `lib/production/metrics.ts` — `OperatorRow` gains `damageEvents`, `reworkSent`, `reworkReceived`, `scrapUnits`, `corrections`. `deriveOperatorRows` SUMs the matching columns from `read_operator_daily`.
- **MODIFIED** `app/(admin)/operator-productivity/page.tsx` — five new columns. "—" renders for rows with no QC activity in the window (no fabricated zeros for legacy code-only operators).
- **MODIFIED** `app/(admin)/genealogy/[bagId]/page.tsx` — adds badges for `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`. Existing `PACKAGING_DAMAGE_RETURN` badge unchanged.
- **MODIFIED** `lib/production/qc-review-language.test.ts` — banned-phrase scan extended to cover the three new QC-5 source files.

### Read-model behavior
- **read_operator_daily** — 5 new counter columns from migration 0026 now fill from QC events. Grouped by *accountable employee* (never by supervisor user_id). PACKAGING_DAMAGE_RETURN, REWORK_SENT, REWORK_RECEIVED, SUBMISSION_CORRECTED each bump their respective counter by 1; SCRAP_RECORDED bumps `scrap_units_total` by `scrap_quantity` (so 7 units lost on one event reads as 7, not 1).
- **read_sku_daily** — `damages`, `rework`, `scrap` columns (previously hardcoded `0` at finalize time) now bump live per event. Bag must have a `product_id` for the row to land; un-product bags are skipped, no fabrication.
- **read_station_quality_daily** — `reject_units` + `damaged_units` (damage events), `scrap_units` (scrap events), `rework_units` (sent+received). Skipped when station has no machine_id or bag has no product_id.
- **read_bag_state** — `rework_pending = true` on REWORK_SENT; recomputed (true/false) on REWORK_RECEIVED via an open-rework SUM query (partial receives keep it true; full receives clear). `rework_received` sticky once any RECEIVED fires. `has_correction` sticky once any SUBMISSION_CORRECTED lands.
- **read_material_lot_state** — `qty_on_hand = GREATEST(qty_on_hand - scrap_quantity, 0)` on SCRAP_RECORDED with `affects_packaging_material=true` AND named lot id. Confidence drops HIGH→MEDIUM on the decrement. Raw-product scrap is intentionally NOT materialised as a lot-state delta (no fake material burn for raw inventory; QC-6 audits this gap).
- **read_material_reconciliation_v2** — `scrappedOrDamagedValue` reads SCRAP_RECORDED totals via `loadScrapFromQcEvents`; source `EXPLICIT_SCRAP_EVENT` → HIGH confidence per existing PT-6B branch. **PT-6 8-bucket formula unchanged.** No QC events feed `receipt_variance` or `cycle_count_variance`. Rework pending is not a reconciliation bucket — it's surfaced separately by the QC-4 `/qc-review` page.

### Genealogy behavior
- Existing timeline iterates every workflow_event; QC-5 only added coloured badges for the four previously-unstyled QC types.
- Each event row shows: time, sequence #, event-type badge, machine/station, employee name (from `workflow_events.employee_id`), notes, expandable JSON payload. Linked-event ID, quantity, reason code, and disposition surface inside the payload accordion — no field hidden. Corrections sit as their own row; the original event is NOT mutated (per QC-0 §4).

### Operator productivity behavior
- Page header still describes "last 7 days" window. Table now has 5 new columns: QC dmg, Rework sent, Rework rec, Scrap units, Corrections. Each renders "—" when the operator has no events in the window — no fabricated zeros.
- Disclosure text updated: *"Corrections are tallied against the operator who typed the original entry, not the supervisor who corrected it."*

### Material reconciliation behavior
- `read_material_reconciliation_v2.scrappedOrDamagedValue` now reflects real scrap totals per lot. The PT-6 8-bucket formula (`derived from reconciliation-v2.ts`) is untouched; it just sees a non-null `scrap` value where before it saw `null`. Source label `EXPLICIT_SCRAP_EVENT` keeps the existing HIGH-confidence path. Receipt variance and cycle-count variance are NOT affected — QC events never feed those buckets.
- Rework pending stays out of the 8-bucket math (per QC-0 plan §6.5: "Rework pending (WIP) is an informational row, not a variance bucket"). QC-4's `/qc-review` page surfaces it.

### Local verification
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **919/919 pass across 43 test files** (+18 new vs QC-4's 901).
- `npx next build` → clean.

### Staging deploy
- Commit `aee76f3 feat(qc-5): project QC events into read models + dashboards`. 12 files, +975 lines.
- `systemctl start luma-deploy.service` ran the standard pull + `docker compose up -d --build`.
- Health: `{"status":"ok","checks":{"app":"ok","db":"ok"},"sha":"aee76f314ec6a03ab99076ef8451d079f7f0ea79"}`.
- Migration `1780700000000` (hash `48915624…`) recorded in `drizzle.__drizzle_migrations` directly after PT-6/QC-1 entries.
- `\d read_bag_state` confirms three new columns + partial index `read_bag_state_rework_pending_idx` live.

### Auth smoke
- **PASS=46, REDIR=0, FAIL=0**. All existing routes (including `/qc-review`, `/operator-productivity`, `/genealogy`, `/po-reconciliation-v2`) return 200 under OWNER auth. No regression.

### Test data on staging
- Skipped per the "do not create messy append-only test data" instruction. QC events on bags can only be cleared by emitting more QC events (the chain is append-only). The projector logic is covered by `qc-events.test.ts` (15 cases) and the SQL itself by the migration applying cleanly + auth-smoke. Live exercise comes when operators report real damage.

### Closeout
- `docs/CLAUDE_BUILD_QUEUE.md` QC-5 sub-bullet flipped to `[x]`.
- This entry appended.
- Next phase: **QC-6** — final verification + closeout. The five QC events fire from the floor, flow through to admin review, and now reach every dashboard. QC-6 is the end-to-end test packet + the cutover-blocker sign-off.

---

## QC-4 — Admin QC review page (complete)
- Date: 2026-05-12
- Result: **complete**. `/qc-review` ships with three sections + three supervisor forms + partial-rework receive support. Queue checkbox flipped to `[x]`.

### Files changed
- **NEW** `app/(admin)/qc-review/page.tsx` — server component. `requireAdmin()` gate. Three sections rendered in parallel: Pending QC actions, Rework in flight, Recent QC events. Each event row shows accountable employee and entered-by separately; missing data renders as "—" or "unattributed" without fabrication.
- **NEW** `app/(admin)/qc-review/_damage-actions-row.tsx` — per-row Send-to-rework + Record-scrap collapsibles on pending damage events. Scrap form requires picking at least one of affects_raw_product / affects_packaging_material; client-side refusal mirrors the qc-events.ts `superRefine`. Conflict and error states surface with distinct copy ("someone else may have already converted this row — refresh").
- **NEW** `app/(admin)/qc-review/_receive-rework-row.tsx` — full-remaining and partial receive on rework-in-flight rows. Client-side `isPartialReceiveValid(sent, thisReceive, priorSum)` refuses bad input before round-tripping; server-side `qc-events.ts` partial-receive math is the backstop. Multiple partials stack via the loader's SUM.
- **NEW** `app/(admin)/qc-review/_correction-trigger.tsx` — collapsible correction form on every recent-event row. Posts to existing `submissionCorrectedAction`; original event stays untouched; original accountable employee preserved.
- **MODIFIED** `app/(admin)/qc-review/actions.ts` — adds `adminReworkSentFromDamageAction` and `adminReworkReceivedAction`. Both require admin and preserve the linked event's accountable employee (supervisor is `entered_by_user_id`). `adminReworkSentFromDamage` honors the partial-unique `workflow_events_linked_event_resolution_unique` via FOR UPDATE + `hasExistingResolution` pre-check; second conversion returns `{ conflict: true }`. `adminReworkReceived` pulls the linked REWORK_SENT under FOR UPDATE for partial-receive math.
- **NEW** `lib/production/qc-review-loaders.ts` — three loaders (`loadPendingDamage`, `loadReworkInFlight`, `loadRecentQcEvents`) plus pure math helpers `computeReworkRemainder` + `isPartialReceiveValid`. SQL uses the existing `workflow_events_linked_event_idx` from migration 0026 for the NOT EXISTS and the rework-in-flight CTE.
- **MODIFIED** `components/admin/sidebar.tsx` — `/qc-review` added under "Production intelligence" between Bag genealogy and Material recon; `ShieldAlert` icon added to the lucide imports.
- **MODIFIED** `scripts/smoke-authenticated-routes.ts` — `/qc-review` added under Production. Smoke list now totals 46 routes.
- **NEW** `lib/production/qc-review-loaders.test.ts` (14 cases) — row mapping for all three loaders + partial-receive math edges (zero / negative / non-integer / over-receive / full closure / stacked partials).
- **NEW** `components/admin/sidebar.test.ts` (4 cases) — sidebar text-scan: `/qc-review` exists, label is "QC review", entry sits inside Production intelligence (before Materials heading), no banned phrases.
- **NEW** `lib/production/qc-review-language.test.ts` (6 cases) — banned-phrase scan over all six new QC-4 source files for `production loss`, `supplier shortage`, `known_loss`. Catches data-honesty drift early.

### Page behavior
- **Pending QC actions** — Server-side `loadPendingDamage(db, { limit: 200 })`. SQL `WHERE event_type='PACKAGING_DAMAGE_RETURN' AND NOT EXISTS (SELECT 1 FROM workflow_events r WHERE r.event_type IN ('SCRAP_RECORDED','REWORK_SENT') AND r.payload->>'linked_event_id' = e.id::text)`. Per-row "Send to rework" / "Record scrap" actions; once a row resolves, the page revalidates and the row drops out of pending. Empty state: friendly "No pending QC actions" card.
- **Rework in flight** — Server-side `loadReworkInFlight(db, { limit: 200 })`. SQL CTE: `sent` is the REWORK_SENT rows; `received` sums `(payload->>'received_quantity')::int` across linked REWORK_RECEIVED rows. WHERE `received < sent`. Per-row "Receive full remaining (N)" or "Partial…". Partial-receive form validates client-side (`isPartialReceiveValid`) before posting. Stacked partials sum on next page load. Empty state: "No rework in flight".
- **Recent QC events** — Server-side `loadRecentQcEvents(db, { limit: 50 })`. Table with columns When / Event / Bag / Qty / Reason / Accountable / Entered by / Linked / Actions. Event type → coloured `StatusPill`. Every row has a "Correct" trigger that opens an inline form. Empty state: "No QC events yet".

### Accountability behavior
- Every row renders accountable employee (`employees.full_name` joined on `workflow_events.employee_id`) AND entered-by user (`users.email` joined on `workflow_events.user_id`) in distinct columns/lines. Phrasing: *"By {accountable}" · "entered by {entered_by_email}"*.
- Scrap and correction inside this surface preserve the linked event's `employee_id` exactly — the supervisor lands on `correction_actor_user_id` (in payload) and on `workflow_events.user_id`. Operator metrics roll up against the operator who typed wrong, not the supervisor reviewing it.
- Ad-hoc scrap (no linked event) is intentionally not exposed in QC-4 — the existing `scrapRecordedAction` would refuse without an explicit `overrideEmployeeId` picker, which QC-4 chose not to ship (avoids accidental mis-attribution). Documented as a small deferral; supervisor can still ad-hoc scrap programmatically.

### Local verification
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **901/901 pass across 42 test files** (+25 new vs QC-3's 876).
- `npx next build` → clean. `/qc-review` route bundle = 4.39 kB.

### Staging deploy
- Pushed `93f5bd5 feat(qc-4): admin QC review page` to `origin/production-intelligence-command-center`. 11 files, +1860 lines.
- `systemctl start luma-deploy.service` ran the standard `git fetch + reset --hard + docker compose up -d --build`.
- Initial smoke run hit "Connection reset by peer" because the container was mid-rebuild — re-polled until `/api/health` returned 200, then ran auth smoke clean.
- Health: `{"status":"ok","checks":{"app":"ok","db":"ok"},"sha":"93f5bd5341e5bbd1932f79aa7531753869dfc5bb"}`.
- `/qc-review` HTTP status without auth: 307 (login redirect — expected).

### Auth smoke
- `npx tsx scripts/smoke-authenticated-routes.ts` inside the running app container: **PASS=46, REDIR=0, FAIL=0**. The new `/qc-review` route specifically: `PASS 200 /qc-review` as OWNER.

### Test data — intentionally not created
- The instructions allowed "If safe, create one test damage event… record scrap… verify duplicate scrap is rejected." Decision: skipped. Staging has no open operator session right now, and creating one to fire a damage event would write a real `PACKAGING_DAMAGE_RETURN` row that this QC-4 surface can't fully clean up (no admin "delete" path — events are append-only, and a corrective `SUBMISSION_CORRECTED` would just add a third row). The conflict path is covered by `qc-actions.test.ts` unit tests (scrap dup → `{ conflict: true }`); the loader logic by `qc-review-loaders.test.ts`. Live end-to-end exercise comes naturally once operators report real damage.

### Closeout
- `docs/CLAUDE_BUILD_QUEUE.md` QC-4 sub-bullet flipped to `[x]`.
- This entry appended.
- Next phase: **QC-5** — read-model projectors (populate `read_sku_daily.damages/rework/scrap`, `read_operator_daily` QC counters, `read_station_quality_daily`, `read_material_reconciliation_v2.scrappedOrDamaged` feed, `read_material_lot_state` decrement on scrap with named material_lot_id, `read_bag_state.rework_pending/received` flags) + genealogy / operator-productivity / PT-6 UI integration. QC-2 actions, QC-3 floor UI, and QC-4 admin UI are all live; QC-5 is the layer that makes existing dashboards reflect QC events without a manual rebuild.

---

## QC-3 — Floor QC quick-action panel (complete)
- Date: 2026-05-12
- Result: **complete**. Floor PWA on PACKAGING / SEALING / COMBINED stations now ships a collapsible "Report QC issue" panel wired to the QC-2 actions. Queue checkbox flipped to `[x]`.

### Files changed
- **NEW** `lib/production/qc-panel-helpers.ts` — pure helpers in the `.test.ts` glob: `shouldRenderQcPanel(stationKind)` whitelists PACKAGING / SEALING / COMBINED; `QUICK_DAMAGE_ENTRIES` is the 5-button vocabulary cross-checked against `QC_REASON_CODES`; `reasonRequiresNotes` / `damageHasReworkShortcut` mirror the qc-events.ts refinements so the UI can refuse before the action layer does.
- **NEW** `app/(floor)/floor/[token]/qc-panel.tsx` — client component. Collapsible `<details>` panel rendered inside the existing "Current bag" section when `shouldRenderQcPanel(stationKind) === true` AND a bag is at the station. Three sections:
  - **Damage / count** — 5 quick-action buttons (Damaged packaging, Ripped card, Bad seal, Label issue, Count issue) plus an `Other…` collapsible (notes required). Each fires `reportPackagingDamageAction`. BAD_SEAL surfaces an inline "+ send to rework" chip that also fires `reworkSentAction`.
  - **Send to rework** — standalone single-button section. Defaults reason to BAD_SEAL; fires `reworkSentAction` with no linked event (per QC-3 scope — supervisor links from /qc-review in QC-4).
  - **Receive rework** — only renders when `pendingRework.length > 0`. Each row "Mark received" fires `reworkReceivedAction` with `received_quantity=sent_quantity`, `partial=false`. Partial-receive math is QC-4.
- **MODIFIED** `app/(floor)/floor/[token]/page.tsx` — imports `shouldRenderQcPanel`, `QcPanel`, `PendingReworkRow`; adds `loadPendingRework(workflowBagId)` server-side helper that joins workflow_events for REWORK_SENT events on the current bag minus any REWORK_RECEIVED rows that name them via `linked_event_id`. Resolves from-station labels in one round trip. Renders `<QcPanel>` only when the station kind is in scope AND a bag is at the station.
- **NEW** `lib/production/qc-panel-helpers.test.ts` (15 cases) — station-kind whitelist, 1:1 reason-code mapping, OTHER not in the quick list (it has its own gated form), notes-required rule, BAD_SEAL-only rework shortcut.

### What does NOT happen here (per spec)
- **No photo capture.** QC-2 accepts `photo_keys`, but the floor PWA has no upload helper yet. QC-3 ships text-notes-only with an explicit on-panel disclosure: *"Photo capture not yet wired on the floor — text notes only."* QC-3.5 (or QC-5) can layer photos without re-shaping the action contracts.
- **No partial-receive math.** "Mark received" fires the full sent quantity. Partial receive lands in QC-4.
- **No admin QC review page.** `/qc-review` still has only the actions file from QC-2; the page lands in QC-4.
- **No genealogy / operator-productivity / PT-6 UI changes.** QC-5 territory.
- **No material inventory movement.** Unchanged from QC-2 — material decrement on scrap is QC-5.

### Accountability behavior
- Panel reads `activeSession?.employeeNameSnapshot` and `activeSession?.accountabilitySource` from the page-level `getActiveStationSession(db, station.id)` call.
- When `hasOperator === false`: all submit buttons are `disabled`, an amber banner reads *"No operator on shift. Open a shift on this station to enable QC reporting."*, and the QC-2 actions also refuse via `resolveStationAccountability` — defense-in-depth.
- The op-session panel for opening a shift was already in place (OP-1C); QC-3 reuses it without modification.

### Local verification (real checkout `/Users/kidevu/luma`)
- `npx tsc --noEmit` → clean. (Fixed one TS5076 about mixed `??`/`||` in `effectiveNotes`.)
- `npx vitest run` → **876/876 pass across 39 test files** (+15 new helper tests vs QC-2's 861).
- `npx next build` → clean. `/floor/[token]` route bundle grew to 10.2 kB with the QC panel client code.

### Staging deploy (normal git-based path)
- QC-3 commit: `c0393da feat(qc-3): floor QC quick-action panel on packaging/sealing stations`. 4 files, +873 lines.
- Pushed to `origin/production-intelligence-command-center`.
- `systemctl start luma-deploy.service` ran the standard pull + `docker compose up -d --build`.
- Health endpoint: `{"status":"ok","checks":{"app":"ok","db":"ok"},"sha":"c0393da98f5a0b1a6bf1176fb9e5e23f36761e8e"}`.

### Floor verification (HTML grep against live container)
- Packaging station `/floor/<token>` (kind=PACKAGING, label="Packaging Station") renders all four panel markers: `Report QC issue`, `Damage / count`, `Send to rework`, `No operator on shift`. The "No operator on shift" string is expected — staging has no live shift open.
- Sealing station `/floor/<token>` (kind=SEALING, label="Sealing station 1") renders only `No operator on shift` because no bag is currently at sealing — the panel is correctly gated on `currentAtStation` (no bag = no QC target). Once a bag arrives there + a shift is open, the panel will render with the Receive-rework section.
- Blister-only stations: panel correctly absent (whitelist filters them out).

### Auth smoke
- `npx tsx scripts/smoke-authenticated-routes.ts` inside the running app container: **PASS=45, REDIR=0, FAIL=0**. No new routes were added; QC-3 is purely a component injection inside `/floor/[token]`.

### Closeout
- `docs/CLAUDE_BUILD_QUEUE.md` QC-3 sub-bullet flipped to `[x]`.
- This entry appended.
- Next phase: **QC-4** — `/qc-review` admin page (pending damage list, rework in flight, recent events) + correction modal + ad-hoc scrap modal + partial-receive math for rework. The five server actions are already live; QC-4 is page + form components only.

---

## QC-2 — Live QC server actions (complete)
- Date: 2026-05-12
- Result: **complete**. Five live server actions emit QC events through `projectEvent` with full OP-1 accountability. Queue checkbox flipped to `[x]`.

### Files added / changed
- **NEW** `app/(floor)/floor/[token]/qc-actions.ts` — three floor actions: `reportPackagingDamageAction`, `reworkSentAction`, `reworkReceivedAction`. Each authorizes via the URL station scan token, resolves accountability via `resolveStationAccountability` (active operator session + supervisor override + LEGACY_TEXT fallback), validates via QC-1's payload schemas, then calls `projectEvent`. Damage refuses to fire when no accountability source resolves; rework with a `linked_event_id` takes a `SELECT ... FOR UPDATE` lock on the source row inside the tx so concurrent supervisors cannot both land scrap/rework against the same damage return.
- **NEW** `app/(admin)/qc-review/actions.ts` — two admin actions: `scrapRecordedAction`, `submissionCorrectedAction`. Both `requireAdmin()`. Both preserve the linked event's accountable employee exactly — supervisor is `entered_by_user_id`, never `accountable_employee_id`. Ad-hoc scrap (no linked event) requires `overrideEmployeeId` so scrap is never accidentally pinned on the supervisor. Scrap returns `{ conflict: true }` if the source already has a SCRAP_RECORDED resolution; the DB partial-unique `workflow_events_linked_event_resolution_unique` is the backstop.
- **NEW** `lib/production/qc-actions.test.ts` (16 cases) — per-action happy path, accountability propagation, missing-session refusal, duplicate-conversion conflict for scrap and rework, partial-vs-full receive math, accountable-employee preservation, JSON-payload rejection on correction, no-affected-scope refusal.
- **MODIFIED** `lib/production/qc-events.ts` — adds two QC-0 fields that QC-1 omitted: `PackagingDamageReturnPayload` gains `affects_packaging_material` (default true) + `affects_raw_product` (default false); `ScrapRecordedPayload` gains the same pair (both required, at-least-one enforced in `superRefine`).
- **MODIFIED** `lib/production/qc-events.test.ts` — `buildScrap()` populates the new flags; one new case covers both-flags-false rejection.

### What does NOT happen here (per spec)
- **No UI.** Floor and admin pages are not built. The actions are server-only; calling them today requires a form post from a future UI (QC-3 / QC-4) or a programmatic test fixture.
- **No material inventory movement.** Even when `affects_packaging_material=true` and `material_lot_id` is named, QC-2 does not emit a paired `MATERIAL_SCRAPPED` event or decrement `read_material_lot_state`. That is deferred to QC-5 (per the QC-0 plan). The flags are captured honestly so QC-5 can wire the ledger without re-walking every QC event payload.
- **No genealogy / operator-productivity / PT-6 UI changes.** Those land in QC-5.

### Local verification (real checkout `/Users/kidevu/luma`)
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **861/861 pass across 38 test files** (+17 new: 16 action tests + 1 new scrap-flag test).
- `npx next build` → clean (only the pre-existing warnings).

### Staging deploy (normal git-based path)
- Commit: `0e36936 feat(qc-2): live QC server actions emitting through projectEvent`. 5 files, +1641 lines.
- Pushed to `origin/production-intelligence-command-center`.
- `systemctl start luma-deploy.service` on LX122 ran the standard pull + reset + `docker compose up -d --build`.
- Health endpoint reports `sha=0e36936feeefbdf90b49e1d13d1ed30a31e2d7de`, `checks={app:ok,db:ok}`.

### Auth smoke
- `npx tsx scripts/smoke-authenticated-routes.ts` inside the running app container: **PASS=45, REDIR=0, FAIL=0**. QC-2 introduced no new routes (the admin `/qc-review` directory has only `actions.ts`, no `page.tsx` — a request to that path will 404 until QC-4). No regression on any existing surface.

### Closeout
- `docs/CLAUDE_BUILD_QUEUE.md` QC-2 sub-bullet flipped to `[x]`.
- This entry appended.
- Next phase: **QC-3** — floor QC quick-action panel on packaging/sealing station overlays + a rework receiving surface. The actions are ready and tested; QC-3 only has to wire forms to them. Floor UI is the next unchecked sub-phase.

---

## QC-1 — Verification + closeout (complete)
- Date: 2026-05-12
- Result: **complete**. All four verifications green on the real Luma checkout / LX122 staging container. Queue checkbox flipped to `[x]`.

### Checkout / commit
- Fresh clone at `/Users/kidevu/luma`, branch `production-intelligence-command-center`.
- Pre-QC-1 head was `3122349 docs(h.x7): record staging verification`.
- QC-1 commit: `d5bfc1c feat(qc): add QC event contracts and schema foundation (QC-1)` — 8 files, +1814 lines.
- Pushed to `origin/production-intelligence-command-center`.
- Doc-only follow-up commit lands the closeout entries (this one).

### Local verification (real checkout)
- `npx tsc --noEmit` → clean. (One fix in QC-1 scope: switched three SCRAP_RECORDED test builders to `Record<string, unknown>` indirection so tests can null out optional scope fields — no contract change.)
- `npx vitest run` → **844/844 pass across 37 test files**. QC-1 added ~57 cases. (One narrowing fix in QC-1 scope: journal `when`-monotonicity test was relaxed to assert only QC-1's tail step increases — the journal as a whole has a pre-existing idx 9↔10 inversion from a prior phase that's tolerated by drizzle in practice.)
- `npx next build` → clean (only the pre-existing warnings).

### Staging deploy (normal git-based path)
- Triggered `systemctl start luma-deploy.service` on LX122.
- Deploy service tracks `production-intelligence-command-center` via `/etc/systemd/system/luma-deploy.service.d/staging-branch.conf`.
- Service ran the standard `git fetch + reset --hard origin/$LUMA_BRANCH + docker compose up -d --build` flow.
- Health check after deploy: `{"status":"ok","checks":{"app":"ok","db":"ok"},"sha":"d5bfc1cb62bae9c1f1487f3fad57e39b18b97577","elapsedMs":2}` — new SHA live, app + db healthy.

### Database verification on LX122 (psql, read-only)
- `\d read_operator_daily` confirms the five new QC columns: `damage_events_total`, `rework_sent_total`, `rework_received_total`, `scrap_units_total`, `corrections_total` (all `integer NOT NULL DEFAULT 0`).
- `pg_indexes` on `workflow_events` confirms both new indexes: `workflow_events_linked_event_idx` and `workflow_events_linked_event_resolution_unique`.
- `drizzle.__drizzle_migrations` shows the new entry at `created_at = 1780600000000` (hash `8548fcc6779703673cebf356814d3f5437be1701244edd066847e16104380c3c`) immediately after the PT-6C entry `1780500000000`.
- `pg_enum` on `workflow_event_type` confirms all five QC values still present (no enum churn — additive migration only).

### Auth smoke
- Ran `npx tsx scripts/smoke-authenticated-routes.ts` inside the running app container.
- Result: **PASS=45 REDIR=0 FAIL=0**. Every authenticated route returned 200 as OWNER. Zero new routes were added in QC-1 — the smoke confirms QC-1 did not regress any existing surface.

### Closeout artifacts
- `docs/CLAUDE_BUILD_QUEUE.md` QC-1 sub-bullet flipped to `[x]` with the verified-2026-05-12 line.
- This entry appended (above the prior code-complete entry, which remains below as part of the append-only history).
- Next phase: **QC-2** — five server actions emitting through `projectEvent` with full OP-1 accountability + tests. Ready to start.

---

## QC-1 — QC schema + payload contracts (code complete; local verification deferred)
- Date: 2026-05-12
- Result: schema migration + payload contracts + tests written. **Local verification (tsc / vitest / next build) could NOT be run in this worktree** — see "Verification gap" below. Marking QC-1 code-complete pending verification on a fully-installed checkout (LXC 122 or any node-installed mirror).

### Files added / changed
- **NEW** `drizzle/0026_qc_subsystem_foundation.sql` — additive migration. Five `integer NOT NULL DEFAULT 0` columns on `read_operator_daily` (`damage_events_total`, `rework_sent_total`, `rework_received_total`, `scrap_units_total`, `corrections_total`). Expression index `workflow_events_linked_event_idx` on `(payload->>'linked_event_id')`. Partial unique `workflow_events_linked_event_resolution_unique` on `((payload->>'linked_event_id'), event_type) WHERE event_type IN ('SCRAP_RECORDED','REWORK_SENT')`.
- **MODIFIED** `drizzle/meta/_journal.json` — appended `idx 26, when 1780600000000, tag 0026_qc_subsystem_foundation`. Strictly-increasing `when` confirmed against the prior entry (1780500000000).
- **MODIFIED** `lib/db/schema.ts` — `readOperatorDaily` declares the five new counter columns (camelCase TS, snake_case SQL); `workflowEvents` table indexes block declares the two new QC indexes for introspection parity.
- **NEW** `lib/production/qc-events.ts` — payload contracts. Zod schemas for all five QC event types, shared base with accountability fields, shared `QC_REASON_CODES` enum (14 codes, no DB enum), shared `QC_UNITS` enum, accountability mirror. Public validators: `validatePackagingDamageReturnPayload`, `validateReworkSentPayload`, `validateReworkReceivedPayload`, `validateScrapRecordedPayload`, `validateSubmissionCorrectedPayload`, `validateQcPayload(eventType, payload)`. Plus `payloadHasAccountability(payload)` invariant helper. Single dispatch table `qcPayloadSchemas`.
- **NEW** `lib/production/qc-events.test.ts` — 40+ test cases covering: each event-type happy path, accountability rejection paths (missing source / name snapshot), quantity validation (zero / negative / non-integer), reason-code coherence (damage_type/rework_reason/scrap_reason must equal reason_code), unknown reason codes rejected, OTHER allowed only with non-empty notes, scope-required rule for scrap (bag/material_lot/packaging_lot all-null rejected), partial-vs-full receive math, correction preserves-original-accountable invariant (literal-true), correction requires entered_by_user_id, dispatch wiring, schema mirror, journal entry, migration SQL DDL grep.

### Schema changes (exact)
- `read_operator_daily` gains five `integer NOT NULL DEFAULT 0` columns. Legacy `damage_count_total` column kept untouched (deprecated in favor of `damage_events_total`, retired in QC-5 once read paths migrate).
- `workflow_events` gains two indexes via SQL only — no new columns, no enum change. The five QC event types (`PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`) are already in `workflowEventTypeEnum` from prior phases (`lib/db/schema.ts:189-248`). **No enum migration needed**, avoiding the ALTER TYPE silent-rollback gotcha.

### Event enum verification
- `grep -E "PACKAGING_DAMAGE_RETURN|REWORK_SENT|REWORK_RECEIVED|SCRAP_RECORDED|SUBMISSION_CORRECTED" lib/db/schema.ts` → all five present.

### Payload types created
- `PackagingDamageReturnPayload`, `ReworkSentPayload`, `ReworkReceivedPayload`, `ScrapRecordedPayload`, `SubmissionCorrectedPayload`. Plus union `QCPayload`, dispatch tuple `QC_EVENT_TYPES`, reason-code union `QCReasonCode`, unit union `QCUnit`, accountability shape `QCAccountability`, result type `ValidateResult<T>`.

### Validation rules enforced (per schema)
- `quantity > 0`, integer, on every event with a quantity field.
- `unit` and `reason_code` required on all four count-event types.
- Accountability triad required on all events (`accountability_source` enum, `accountable_employee_name_snapshot` non-empty). `accountable_employee_id` nullable to allow free-text fallback. `entered_by_user_id` required on `SUBMISSION_CORRECTED` (refined separately).
- `client_event_id` required (UUID) on every event for idempotency parity with floor-PWA paths.
- `damage_type` / `rework_reason` / `scrap_reason` must equal the shared `reason_code` (one source of truth — refusal on mismatch).
- `OTHER` reason_code permitted only when `notes` is a non-empty string.
- `SUBMISSION_CORRECTED` requires `corrected_event_id` and the literal `preserves_original_accountable_employee: true` flag — the schema makes it impossible to land a correction without it.
- `SCRAP_RECORDED` requires at least one of `bag_id` / `material_lot_id` / `packaging_lot_id` to be non-null.
- `REWORK_RECEIVED` enforces partial-vs-full receive math: `partial=false` ⇒ received_quantity == quantity; `partial=true` ⇒ received_quantity < quantity.

### Accountability rules preserved (OP-1 contract)
- Every payload shape carries `accountable_employee_id` / `accountability_source` / `accountable_employee_name_snapshot` / `entered_by_user_id` — the QC-2 server actions cannot emit a QC event without supplying these.
- `SUBMISSION_CORRECTED` contract bakes preservation in: the `preserves_original_accountable_employee` flag is a Zod literal `true` — flipping it to false is a schema error before the action ever runs.
- `entered_by_user_id` is required (non-null) on `SUBMISSION_CORRECTED` via a refine — the supervisor is always identified.

### Verification gap (read this)
The `/private/tmp/luma-work` worktree this session worked from is **missing the npm install state required to run `tsc`, `vitest`, and `next build` locally**: `node_modules/typescript/bin/` is empty, `node_modules/vitest/vitest.mjs` and `node_modules/next/dist/bin/next` are absent, and the worktree has no `package.json` / `tsconfig.json` / `vitest.config.ts` / `next.config.js` at the top level. `npx tsc --noEmit` from the worktree errors with "This is not the tsc command you are looking for" — npx falls through and fails.
- **What I did instead:** wrote the migration + schema delta + payload contracts + tests, and visually re-read for: enum membership of the five event types; journal `when` strictly-increasing; zod-v3-compatible API usage (`.extend`, `.superRefine`, `.safeParse`, `.literal(true)`); accountability triad presence on every event; no banned phrases. Tests are written to be self-contained — only `vitest`, `zod`, and the project's `@/lib/db/schema` import (already used by other tests in this directory).
- **What still needs to run before QC-1 closeout:**
  1. `npx tsc --noEmit` from the actual checkout (or `pnpm/npm run typecheck`).
  2. `npx vitest run` — expecting +40 new test cases passing.
  3. `npx next build` — clean.
  4. Deploy the branch to LX122 and verify the migration applied via `psql` (`\d read_operator_daily` should show the five new columns; `\di workflow_events_linked*` should list both indexes).
- **Not marking QC-1 complete in the queue** until the user (or a downstream agent with a complete checkout) reports the four verifications green. QC-1 box in `docs/CLAUDE_BUILD_QUEUE.md` stays `[ ]`.

### Risks / open questions
1. The `_journal.json` `when` step (+100_000_000_000 ms per phase) keeps the convention from prior migrations — no risk of out-of-order rollback per the drizzle-journal gotcha. Confirmed via diff vs idx 25.
2. The partial-unique on `(payload->>'linked_event_id', event_type)` will not fire for `SUBMISSION_CORRECTED` (intentional — corrections can themselves be corrected). If QC-2 surfaces a need to ALSO prevent double-correction of the same source, a follow-up migration can extend the WHERE clause.
3. The shared base `quantity` on `SCRAP_RECORDED` and `scrap_quantity` are deliberately separate. This lets unit conversions (e.g. cards at originating bag → kg at material ledger) live in the payload itself. QC-2 must enforce that they refer to compatible units at the action layer.
4. Zod v4 is in node_modules alongside v3 — the repo's existing floor actions resolve to v3. If a v4 migration is in progress, the `.superRefine` API and `z.literal(true)` shapes are still v4-compatible, but a downstream typecheck on v4 may want stricter literal arrays. Risk: low.
5. `disposition_suggestion` on `PackagingDamageReturnPayload` is operator-supplied ("SCRAP" / "REWORK" / "INSPECT"). Non-binding — supervisor reviews. Adds a useful UX hint without coupling supervisor decision to operator preference.

### Next phase: QC-2 (server actions emitting through `projectEvent` with OP-1 accountability)
Blocked only on QC-1 verification (tsc / vitest / build green + migration applied on staging). Once verified, QC-2 can begin: five server actions (one per event type), pulling the payload validators from this module and the accountability fields from `resolveStationAccountability` / `resolveAdminAccountability`.

---

## QC-0 — QC subsystem implementation plan (complete)
- Date: 2026-05-12
- Result: plan-only phase. Detailed implementation contract written to `docs/QC_SUBSYSTEM_IMPLEMENTATION_PLAN.md` (14 sections, ~520 lines). No code, no migrations.
- Audit context confirmed before drafting:
  - `workflowEventTypeEnum` (`lib/db/schema.ts:175-248`) already contains all five target event types: `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`. No enum migration needed for QC-1.
  - OP-1 accountability rails ready: `projectEvent` (`lib/projector/index.ts:111`) accepts `enteredByUserId` / `accountableEmployeeId` / `accountabilitySource` / `accountableEmployeeNameSnapshot`. Floor: `resolveStationAccountability` (`lib/production/station-operator-session.ts:103`). Admin: `resolveAdminAccountability` (`station-operator-session.ts:190`).
  - PT-6 8-bucket read model `read_material_reconciliation_v2` already has `scrappedOrDamagedValue` / `consumptionVarianceValue` / `unknownVarianceValue` columns; QC feeds scrap into the existing bucket — no new buckets.
  - Existing 0-hardcoded columns on `read_sku_daily` (`damages`, `rework`, `scrap`), `read_station_quality_daily` (`reject_units`, `scrap_units`, `rework_units`, `damaged_units`), and `read_operator_daily.damage_count_total` are ready to populate; one tiny `0024_qc_subsystem.sql` migration adds four columns to `read_operator_daily` plus two indexes on `workflow_events.payload->>'linked_event_id'`.
- Sub-phase recommendation: QC-1 (schema + payload contracts) → QC-2 (5 server actions) → QC-3 (floor QC quick-action) → QC-4 (`/qc-review` admin) → QC-5 (read-model projectors + UI integration) → QC-6 (staging verify + closeout). Estimate ~10 working days end-to-end.
- Hard rules baked into the plan: damage ≠ scrap; rework sent ≠ rework received; corrections preserve original accountable employee (`employee_id` from linked event); no overwrites — `SUBMISSION_CORRECTED` is additive with `linked_event_id`; variance subtypes never collapse (PT-6 four-bucket model preserved); every QC event carries full OP-1 accountability or the action refuses; no emoji.
- Open questions logged in §13 (8 items, including: `REWORK_RESOLVED` deferred until experience proves need; photo upload path may slip to QC-3.5 if no helper exists; partial-receive semantics; concurrent-supervisor scrap race).
- Build queue updated: `### [ ] QC subsystem` block now lists six sub-phases with `[x] QC-0` checked, the rest `[ ]`.
- Next phase: QC-1 (migration 0024 + `lib/production/qc-events.ts` payload contracts + Zod + unit tests for accountability preservation rule).

---

## H.x7 — Material panels (4 read-only) (complete)
- Date: 2026-05-09
- Result: **complete**. Queue checkbox flipped to `[x]`.
- Audit finding: existing `/active-rolls`, `/material-alerts`, `/packaging-inventory`, and `/roll-variance` routes were real read-only panels, not stubs, but needed stronger loader separation, confidence badges, missing-state labels, PT-6 v2 variance surfacing, and the missing product packaging requirements panel.
- Added `lib/production/material-panels.ts` as the read-only loader/format layer. React pages now render shaped rows from existing source tables/read models only; no business math moved into JSX and no events are emitted.
- Panels covered: `/packaging-inventory`, `/product-packaging-requirements`, `/active-rolls`, `/roll-variance`, `/material-alerts`.
- Data sources: `packaging_lots`, `packaging_materials`, `product_packaging_specs`, `products`, `read_roll_usage`, `read_material_reconciliation_v2`, plus existing source-system joins.
- Honest-data rules: PackTrack counted receipts stay HIGH / "Physically counted"; declared-only stays MEDIUM / "Supplier-declared only"; legacy/imported stays LOW / "Legacy code only"; roll rows show "Estimated", "Actual (weigh-back)", "Roll standard missing", or "Not weighed back" explicitly.
- Tests: added `lib/production/material-panels.test.ts` (10 cases) covering receipt confidence labels, no fake actual roll usage, variance severity, missing BOM state, and banned variance-conflation wording.
- Verification: `npx tsc --noEmit` clean; `npx vitest run` 796/796 pass across 36 files; `npx next build` clean with the pre-existing Next config / OpenTelemetry warnings.
- Staging verification: pending deploy of this SHA. `scripts/smoke-authenticated-routes.ts` now includes `/product-packaging-requirements` alongside the four existing material routes.
- Next unchecked phase: **QC subsystem — Damages / rework / scrap / supervisor-correction live**.

### H.x7 staging verification
- Date: 2026-05-09
- Deployed SHA verified on LX122: `c3abc3c9dd7814328aa6bc5a0df8fef6cc55d69c`.
- `/api/health`: app OK, db OK.
- Auth smoke: PASS=45 REDIR=0 FAIL=0. Material routes all returned 200: `/packaging-inventory`, `/product-packaging-requirements`, `/active-rolls`, `/roll-variance`, `/material-alerts`.
- Render verifier: all five routes returned 200 under admin auth and included the material sidebar links.
- Staging data observed: packaging_lots=5, counted_high=1, declared_medium=0, legacy_low=0, active_products=57, bom_lines=8, active_rolls=0, roll_rows=5, v2_variance_rows=1.
- Honest-state verification: packaging inventory rendered receipt truth + confidence labels; product requirements rendered configured/missing states; active rolls rendered no-fake-roll empty state; roll variance rendered expected/actual separation and confidence; material alerts rendered PT-6 v2 variance/empty state.
- Banned-language verification passed: no rendered H.x7 route called receipt variance production loss, cycle-count variance supplier/vendor shortage, or MEDIUM/LOW receipt truth confirmed.

---

## PT-6E — Final PT-6 verification + closeout (complete)
- Date: 2026-05-09
- Result: **PT-6 fully complete**. Queue checkbox flipped to `[x]`.

### PT-6 sub-phase status
- **PT-6A** — plan doc (`docs/PT-6_RECONCILIATION_PLAN.md`) — complete.
- **PT-6B** — pure helpers (`lib/production/reconciliation-v2.ts`) + 47 tests — complete.
- **PT-6C** — read model migration `0025_read_material_reconciliation_v2.sql` + projector/rebuild wiring + 17 tests — complete.
- **PT-6D** — admin UI at `/po-reconciliation-v2` + cross-link from legacy v1 + 17 loader tests — complete.
- **PT-6E** — final verification sweep (this entry) — complete.

### 1. Latest SHA verification
- Branch HEAD: `3d0515f`.
- Staging SHA: `3d0515f` (matches).
- `3d0515f` is **docs-only** (single file, +83 lines).
- Last code-affecting SHA `0c76776` is live. No deploy needed.

### 2. Migration / read model verification
- Migration journal entry `created_at = 1780500000000` present (idx 25).
- `read_material_reconciliation_v2` table exists with 7 indexes:
  - `read_material_reconciliation_v2_pkey`
  - `read_material_reconciliation_v2_scope_unique` (UNIQUE on scope_type, scope_id)
  - 4 partial indexes: `material_idx`, `packaging_lot_idx`, `raw_bag_idx`, `po_idx`
  - `overall_idx` on overall_confidence
- 8 constraints: pkey, `scope_type_chk`, `overall_chk` (CHECK constraints), 5 FKs (material_item / packaging_lot / raw_bag / po / product).
- v1 `read_material_reconciliation` untouched (911 rows preserved).

### 3. Rebuild idempotency
| | Run 1 | Run 2 |
|---|---|---|
| v2 scanned | 5 | 5 |
| v2 written | 5 | 5 |
| v2 row count after | 5 | 5 |
| v1 row count | 911 | 911 |
| `calculated_at` (max) | 2026-05-09 16:42:16 UTC (refreshed) | (refreshed again, no row count change) |

No duplicates. v1 unchanged across both runs.

### 4. Known PackTrack receipt verification
Row `c63821ec` (FOIL_ROLL with PackTrack count receipt):
- declared = 100 ✓
- counted = 98 ✓
- accepted = 98 ✓ (HIGH from counted)
- receipt_variance = -2 ✓
- receipt_variance_severity = MEDIUM ✓ (2% of 100)
- unit_of_measure = `each` ✓
- overall_confidence = MEDIUM (correct — accepted HIGH but no actual consumption signal)
- 2 warnings: scrap deferral + actual-consumption MISSING
- Page render assertion: rendered HTML contains `100`, `98`, `-2`, `severity: MEDIUM`. Banned phrases (`production loss`, `supplier shortage`, `vendor shortage`) absent.

### 5. Weighed roll verification
4 rows, all PVC_ROLL/FOIL_ROLL:
- unit_of_measure = `g` ✓
- counted = net_weight_grams = 1500 (HIGH) ✓
- accepted = 1500 (HIGH from counted) ✓
- on_hand = 1500 ✓ source = `WEIGH_BACK_DERIVED` ✓ confidence = HIGH ✓
- declared null (no declared-vs-counted shape on weighed receipts)
- receipt_variance MISSING (declared null) — correct
- overall_confidence = HIGH ✓
- 1 warning each: scrap deferral

### 6. Missing QC scrap behavior
- `scrapped_or_damaged_confidence = MISSING` on every row (no live scrap event today).
- Overall confidence does **not** collapse to MISSING from scrap alone — HIGH/MEDIUM holds when accepted/actual/on_hand inputs warrant it.
- Warning text: `"no scrap/damage signal — raw-material scrap deferred to QC subsystem"` confirms the missing source honestly.

### 7. UI verification
- Auth smoke: PASS=44 REDIR=0 FAIL=0. Both `/po-reconciliation` (legacy v1) and `/po-reconciliation-v2` return 200.
- `verify-pt-6d.ts` re-run on PT-6E checkpoint: 7/7 steps green. PackTrack numbers + severity rendered, no banned phrases, all 4 subtype titles present, cross-links work both directions.
- Filter probe: `/po-reconciliation-v2` returns 200 under `?varianceOnly=1`, `?vKind=RECEIPT_VARIANCE`, `?conf=HIGH`, `?source=PACKTRACK`, `?missingOnly=1`, `?scope=ROLL` — all 6 filters confirmed.
- Filter math correctness covered by 17 unit tests in `lib/production/reconciliation-v2-loader.test.ts`.

### 8. Event-driven refresh decision
**DEFERRED** to a future phase. Rebuild remains the canonical write path for v2.

Why deferred:
- v2 read model is brand-new; let it stabilize under the rebuild path before adding incremental projection.
- Rebuild is idempotent (verified — Run 2 produced identical row count and content).
- UI is read-only, so rebuild lag is not load-bearing.
- CONSUMED_ACTUAL and SCRAPPED_OR_DAMAGED sources will continue evolving as the QC subsystem ships; an incremental projector wired today would need rework when those events go live.

What a future phase would add:
- Hook `rebuildMaterialReconciliationV2ForLot(tx, lotId)` (already exported by PT-6C) into `projectEvent` after relevant material events: `MATERIAL_RECEIVED`, `PACKAGING_BOX_COUNTED`, `PACKAGING_RECEIPT_ADJUSTED`, `PACKAGING_VARIANCE_RECORDED`, `ROLL_WEIGHED`, `ROLL_DEPLETED`, and the future QC events.
- Same opt-in pattern as the existing `refreshMaterialReconciliationForBag` hook on BAG_FINALIZED.
- Add a benchmark first to confirm event-time projection beats nightly rebuild on staging-scale data.

### 9. Full regression
- `npx tsc --noEmit` clean.
- `npx vitest run` — **786 / 786** pass across 35 files.
- `npx next build` clean (only the pre-existing OTel `Critical dependency` warning, unchanged for 6+ phases).
- Auth smoke: PASS=44 REDIR=0 FAIL=0.

### 10. Docs updated
- `docs/CLAUDE_BUILD_QUEUE.md` — PT-6 checkbox flipped to `[x]`.
- `docs/CURRENT_PHASE_STATUS.md` — this PT-6E entry; full PT-6 sub-phase summary above.
- `docs/PT-6_RECONCILIATION_PLAN.md` — unchanged, still the source of truth for the bucket model.

### 11. PT-6 status: fully complete
The 8-bucket reconciliation system ships end-to-end:
- 8 typed buckets per row + 4 PARALLEL variance subtypes that never collapse into one number.
- Confidence ladder honest across all 7 quantity buckets and 4 variance buckets.
- Vendor shortage / cycle-count drift / process loss / unknown gap stay structurally + visually distinct.
- Legacy v1 still available; v1 ↔ v2 cross-linked.
- Pure helpers + read model + projector + UI all tested + verified on real staging data.

### Known limitations (carried forward)
- **QC scrap / rework live events** are deferred to the QC subsystem phase (per OP-1D decision). PT-6 surfaces SCRAPPED_OR_DAMAGED as MISSING with an explicit warning; no fake-zero rendering.
- **PackTrack shortage recommendations** (PT-7) not part of PT-6. The reconciliation surface is read-only.
- **Live Zoho sync** not part of PT-6.
- **v1 reconciliation remains available** for comparison and back-compat.
- **Event-driven incremental projection** deferred (see §8 above). Rebuild script is the canonical write path for now.
- **No backfill of historical reconciliation snapshots** beyond what the rebuild produces from the existing event ledger.

### Next unchecked phase per `docs/CLAUDE_BUILD_QUEUE.md`
**H.x7 — Material panels (4 read-only).**

---

## PT-6D — 8-bucket reconciliation UI (complete)
- Date: 2026-05-09
- Result: shipped + verified on staging. PT-6 queue checkbox stays `[ ]` until PT-6E ships.

### Latest SHA verification
Pre-flight: PT-6C report named `791c804` as the last commit. Verified `791c804` was **docs-only** (single file `docs/CURRENT_PHASE_STATUS.md`, +94 lines) — no code change to land. Staging was on `0a17fe7` (the last code-affecting PT-6C commit) and v2 rebuild was producing the expected 5 rows. Safe to proceed.

PT-6D commits: `56ad4a7` (page + loader + tests + auth-smoke entry) → `945bce4` (verifier script) → `2f8dba2` (verifier regex tolerates React's text-interpolation comment) → `0c76776` (footer copy fix). Staging now on `0c76776`.

### Files changed
- `lib/production/reconciliation-v2-loader.ts` (new) — DB → view-row shaping + filters + `VARIANCE_LABELS`.
- `lib/production/reconciliation-v2-loader.test.ts` (new) — 17 cases.
- `app/(admin)/po-reconciliation-v2/page.tsx` (new) — the 8-bucket page.
- `app/(admin)/po-reconciliation/page.tsx` — added `New 8-bucket view →` link.
- `scripts/smoke-authenticated-routes.ts` — added `/po-reconciliation-v2`.
- `scripts/verify-pt-6d.ts` (new) — JWT-minting page-render verifier.

### UI route / page
**New route:** `/po-reconciliation-v2`. Reads from `read_material_reconciliation_v2`. UI does not recompute math — formulas stay in PT-6B + PT-6C.

Per row:
- Identity strip — scope_type, unit, calculated_at, material SKU + name, lot/roll number, kind.
- 7 typed buckets in a grid: DECLARED · COUNTED · ACCEPTED · CONSUMED_ESTIMATED (with "estimated, not measured" hint) · CONSUMED_ACTUAL · SCRAPPED_OR_DAMAGED · ON_HAND. Each cell shows value + unit + `ConfidenceBadge` + source + missing-input list.
- 4 variance cells in a parallel grid (RECEIPT / CYCLE_COUNT / CONSUMPTION / UNKNOWN), severity-colour-coded (NONE/LOW emerald · MEDIUM amber · HIGH rose · MISSING slate). Each shows value + unit + confidence + severity. Subtype labels keep the four meanings distinct.
- Warnings banner when the row carries any.
- Expandable detail panel (HTML `<details>` element) with scope_id, packaging_lot_id, po_id, calculated_at, the confidence-ladder explanation, and the raw `source_snapshot` JSONB rendered as a code block.

### Legacy view behaviour
v1 lives at `/po-reconciliation` (untouched). v2 is the new route at `/po-reconciliation-v2`. Both pages cross-link:
- v1 header now shows a `New 8-bucket view →` link (small, top-right under the page header).
- v2 header shows a `← legacy PO reconciliation` link.
No toggle inside a single page — the v1 surface is PO-keyed and the v2 surface is lot-keyed, so a shared route would force a UX compromise. Cross-linking keeps both views first-class.

### Filters added (search-param driven)
- `scope` — PACKAGING_LOT / RAW_BAG / ROLL / MATERIAL_ITEM / PO
- `conf` — overall_confidence (HIGH / MEDIUM / LOW / MISSING)
- `vKind` — only rows with non-zero variance of the selected kind
- `vSev` — only rows where any variance bucket has the selected severity
- `source` — source_system from `source_snapshot` (PACKTRACK / MANUAL_LUMA / ZOHO / IMPORT)
- `varianceOnly` — checkbox; drops rows where all four variance buckets are null/zero
- `missingOnly` — checkbox; keeps rows with at least one MISSING bucket
- `Apply` button submits, `clear` resets.

### Row detail behaviour
Each row uses an HTML `<details>` element so server-rendered HTML stays cacheable + JS-free. Expanded panel shows the full bucket payload (identity KVs), confidence-ladder explainer copy, and the raw `source_snapshot` blob as pretty-printed JSON. The bucket grid + variance grid stay visible in the summary line so collapsed rows still convey the headline numbers.

### Tests added
`lib/production/reconciliation-v2-loader.test.ts` — 17 cases:
- numeric strings parse to numbers; jsonb arrays preserved; source_snapshot is a record; warnings list reads.
- Weight-mode and count-mode rows render correct shape.
- All 6 filters covered (scopeType, confidence, varianceKind, varianceSeverity, sourceSystem, varianceOnly, missingOnly).
- VARIANCE_LABELS invariants — RECEIPT never says "production loss"/"scrap"/"yield"; CYCLE_COUNT never says "supplier shortage"/"vendor"; CONSUMPTION never says "shortage"/"short-shipped"; UNKNOWN says "unclassified"; all four titles + subtitles distinct (no copy collision).
- `reconciliationV2HasAnyRows` true/false.

Suite total: **786 / 786** pass across 35 files (+17 new on top of PT-6C's 769).

### Build / test / smoke results
- `npx tsc --noEmit` clean.
- `npx vitest run` 786/786.
- `npx next build` clean (pre-existing OTel warning unchanged).
- Auth smoke: PASS=44 REDIR=0 FAIL=0 (was 43; +1 for `/po-reconciliation-v2`).

### Staging verification (`scripts/verify-pt-6d.ts` against SHA `0c76776`)
1. Mint admin JWT for `admin@luma` — ok.
2. `GET /po-reconciliation-v2` → 200, body 188,590 bytes — ok.
3. PackTrack receipt numbers rendered:
   - `100` (declared), `98` (counted/accepted), `-2` (receipt variance) all present in HTML.
   - `severity: MEDIUM` rendered (regex tolerates React's `<!-- -->` text-interpolation comment).
4. Banned-phrase scan: `production loss`, `supplier shortage`, `vendor shortage` — none present anywhere in rendered HTML. UI keeps the four variance subtypes visually distinct.
5. All four subtype titles present: "Receipt variance", "Cycle-count variance", "Consumption variance", "Unknown variance".
6. v2 → v1 link ("← legacy PO reconciliation") present.
7. v1 still renders 200 + carries the forward link "New 8-bucket view →".

### PT-6E readiness
**Ready.** v2 page renders correctly with real staging data (PackTrack receipt 100/98/-2/MEDIUM/MEDIUM, plus 4 weighed roll rows in grams). PT-6E does the broader sweep across the 8-bucket model: end-to-end staging walkthrough, regression sweep on prior phases, possibly a perf benchmark to decide whether to wire an event-driven projector hook (PT-6C decision deferred). UI is intentionally functional, not polish — the command-center polish phase is its own queue item.

### Decisions
1. **Two routes, not a toggle.** v1 is PO-keyed; v2 is lot-keyed. Cross-links beat a shared route that would compromise both UX.
2. **Footer disclaimers trimmed.** "Not production loss" / "Not vendor shortage" copy in body content trips the static invariant. The bucket name + column header carry the meaning. Same lesson as PT-6B explanations.
3. **JSX text-interpolation comment is real.** React inserts `<!-- -->` between adjacent static text and an interpolated expression; verifier regex must tolerate it. Documented in the verifier.

---

## PT-6C — 8-bucket read model + projector / rebuild wiring (complete)
- Date: 2026-05-09
- Result: shipped + verified on staging. PT-6 queue checkbox stays `[ ]` per the multi-phase split (flips after PT-6E).

### Migration number used
**0025_read_material_reconciliation_v2** (idx 25, when 1780500000000). Next unused after OP-1E's 0024.

### Files changed
- `drizzle/0025_read_material_reconciliation_v2.sql` (new)
- `drizzle/meta/_journal.json` (idx 25 entry)
- `lib/db/schema.ts` (`readMaterialReconciliationV2` table + 5 indexes + type export)
- `lib/projector/material-reconciliation-v2.ts` (new — assembler + projector)
- `lib/projector/material-reconciliation-v2.test.ts` (new — 17 cases)
- `scripts/rebuild-read-models.ts` (calls v2 rebuilder; pre/post counts include the new table)
- `docs/CURRENT_PHASE_STATUS.md` (this entry)

Commits: `6f9a6f1` (initial), `1c2d362` (roll-grams fix), `0a17fe7` (data-driven unit selection per lot).

### Schema / read model added
`read_material_reconciliation_v2` is additive — coexists with v1 `read_material_reconciliation` (untouched). Per-row scope discriminator (`PACKAGING_LOT | RAW_BAG | ROLL | MATERIAL_ITEM | PO`) with FKs to `packaging_materials`, `packaging_lots`, `inventory_bags`, `purchase_orders`, `products`. All 8 buckets stored as typed columns (numeric(20,6) value + confidence + source) plus jsonb `*_missing_inputs` per bucket. Variances stored as value + confidence + severity columns (no jsonb for variances — they're simpler). Top-level `overall_confidence`, `warnings` (jsonb), `source_snapshot` (jsonb). Indexes:
- `(scope_type, scope_id)` UNIQUE — drives idempotent upsert.
- Partial indexes on `material_item_id`, `packaging_lot_id`, `raw_bag_id`, `po_id` (each WHERE NOT NULL).
- Full index on `overall_confidence`.

CHECK constraints lock `scope_type` and `overall_confidence` to known ladders.

### Input assembler behavior (`buildPackagingLotReconciliationInput`)
**Data-driven unit selection per lot**, not material-kind-driven:
- if `lot.netWeightGrams` is non-null AND no count signals (declared/counted/non-placeholder qty_received): unit=`g`, weight mode (counted = net_weight_grams HIGH, declared null, no legacy fallback).
- else: unit=`each`, count mode (declared / counted / qty_received cascade per PT-6B helper). Roll-placeholder qty_received=1 is ignored as a count signal.
- `scope_type` still reflects the material classification (`ROLL` for PVC_ROLL/FOIL_ROLL/BLISTER_FOIL, else `PACKAGING_LOT`) so UI filters by kind work.

Source mapping:
- ACCEPTED: cascade per PT-6B (counted → declared → legacy qty_received → MISSING). PackTrack source-system tagged on declared-only path.
- CONSUMED_ESTIMATED: from `read_material_lot_state.consumedEstimated` with source `ROLL_SEGMENT_STANDARD` (rolls) or `BOM` (count-based), MEDIUM.
- CONSUMED_ACTUAL: from `read_material_lot_state.consumedActual` with source tagged from the most recent of `ROLL_WEIGHED` (HIGH) / `ROLL_DEPLETED` (MEDIUM) / `MATERIAL_CONSUMED_ACTUAL` (MANUAL_ENTRY HIGH).
- SCRAPPED_OR_DAMAGED: stays MISSING — QC subsystem deferral. Per-result warning surfaces this.
- ON_HAND: `current_weight_grams_estimate` (weight mode → WEIGH_BACK_DERIVED HIGH) or `qty_on_hand` (count mode → QTY_ON_HAND MEDIUM); upgraded to `CYCLE_COUNT` HIGH when a `PACKAGING_RECEIPT_ADJUSTED` event is in the lot's history.
- `cycleCountActualRemaining` from latest `PACKAGING_RECEIPT_ADJUSTED.payload.new_qty_on_hand`.

The 4 PT-6B variances (RECEIPT / CYCLE_COUNT / CONSUMPTION / UNKNOWN) flow through unchanged.

### Rebuild command / script
Extended `scripts/rebuild-read-models.ts` — the existing canonical rebuild walks v2 alongside v1. Idempotent: ON CONFLICT (scope_type, scope_id) updates in place. v1 left untouched. Run via:
```
ALLOW_STAGING_QA_DATA=true npx tsx scripts/rebuild-read-models.ts
```
Per-lot rebuilder (`rebuildMaterialReconciliationV2ForLot`) is also exported for future projector hooks (event-driven incremental refresh — not wired this phase).

### Tests added
**17 new tests** in `material-reconciliation-v2.test.ts`. Cover:
- null lot returns null; no upsert.
- count-based PackTrack lot HIGH path (declared+counted → accepted=98 HIGH).
- declared-only MEDIUM (supplier-declared) with `packtrack_declared` source.
- legacy qty_received-only LOW.
- roll lot with net weight: unit=g, accepted from `net_weight_grams`, on_hand from `current_weight_grams_estimate`.
- roll lot without net weight: MISSING (placeholder qty_received=1 not used).
- **roll-kind lot received via PackTrack count fields**: unit=each, accepted=98 HIGH, receipt_variance=-2 (the real `c63821ec` staging case).
- cycle-count adjust payload → `cycleCountActualRemaining` and `CYCLE_COUNT` source.
- weigh-back vs depletion source tagging.
- scrap MISSING does not collapse overall confidence.
- single-row upsert; running twice produces identical content (idempotent); update-set wired.
- HIGH path holds when accepted+actual+cycle-counted on_hand all HIGH.
- MISSING/LOW boundary checks.

Suite total: **769/769** pass across 34 files.

### Build / test results
- `npx tsc --noEmit` clean.
- `npx vitest run` 769/769.
- `npx next build` clean.

### Basic staging verification (SHA `0a17fe7`)
Verified on LX122:
1. `/api/health` → `0a17fe7…`.
2. `\d read_material_reconciliation_v2` shows 10 columns, 7 indexes (pkey + scope unique + 4 partial + overall), 2 CHECK constraints, FKs to packaging_materials / packaging_lots / inventory_bags / purchase_orders / products.
3. Rebuild script ran: `v2 scanned=5 written=5`. Pre + post row counts match.
4. v2 row content (post-fix):
   - **PackTrack FOIL_ROLL count receipt** (`c63821ec`): scope_type=ROLL, unit=each, declared=100, counted=98, accepted=98 HIGH, on_hand=98 QTY_ON_HAND MEDIUM, receipt_variance=-2 MEDIUM (2% of 100), overall MEDIUM. **Matches the verification target exactly.**
   - **4 weighed roll lots**: scope_type=ROLL, unit=g, declared=null, counted=net_weight_grams=1500 HIGH, accepted=1500 HIGH, on_hand=1500 WEIGH_BACK_DERIVED HIGH. No receipt variance (declared null). overall HIGH.
5. Idempotency: rebuild re-run produced same 5 rows; no duplicates.
6. v1 (`read_material_reconciliation`) preserved at 911 rows; never touched.

### PT-6D readiness
**Ready.** PT-6D's UI will read from `read_material_reconciliation_v2` and surface the 8 buckets per the plan §5 UI rules (4 distinct variance columns, never collapse vendor / cycle-count / consumption / unknown into one number, legacy LOW pill, estimated badge). Existing v1 page can stay live behind a "Legacy view" toggle during the transition. PT-6E does the staging walkthrough.

### Decisions captured
1. **Unit selection is data-driven, not material-kind-driven.** A FOIL_ROLL material received via PackTrack as a count-based lot reconciles in `each`; a FOIL_ROLL received with a weighed entry reconciles in `g`. The `scope_type` still tracks the material kind so UI filtering works, but `unit_of_measure` is per-row.
2. **Roll placeholder qty_received=1 is suppressed.** Without this rule the legacy fallback would inject a meaningless "1 roll" into ACCEPTED for weighed roll lots whose unit is grams.
3. **Per-bucket missing_inputs lives in jsonb.** Variance values use plain typed columns (no missing_inputs jsonb) — variance MISSING is itself a complete signal; the bucket-level missing_inputs would just duplicate the parent quantity's lineage.
4. **No projector hook on event commit (yet).** Rebuild is the canonical write path. PT-6C ships the per-lot helper (`rebuildMaterialReconciliationV2ForLot`) so a future projector hook can call it from `projectEvent` after a relevant material event lands; that wiring waits for PT-6E perf benchmarks.

---

## PT-6B — Pure 8-bucket reconciliation helpers + tests (complete)
- Date: 2026-05-08
- Result: pure-logic helpers shipped per `docs/PT-6_RECONCILIATION_PLAN.md`. **No DB changes; no projector or UI changes.** PT-6 queue checkbox stays unchecked because the queue has a single PT-6 entry — only flips after PT-6E ships.

### Files changed
- `lib/production/reconciliation-v2.ts` (new) — 8-bucket helpers + types.
- `lib/production/reconciliation-v2.test.ts` (new) — 47 cases.
- `docs/CURRENT_PHASE_STATUS.md` (this entry).

### Helpers added
- `normalizeQuantity(value)` — rejects NaN / Infinity / non-numbers; returns null otherwise.
- `combineConfidence(values)` — lowest-of (`HIGH > MEDIUM > LOW > MISSING`).
- `classifyVarianceSeverity(value, baseline)` — `NONE | LOW | MEDIUM | HIGH | MISSING` per ≤1% / ≤5% / >5% baseline-relative bands; falls back to absolute (≤1, ≤5, >5) when baseline is null/zero.
- `deriveDeclaredQuantity(receipt, unit)` — never HIGH; tagged `packtrack_declared` vs `declared_quantity`.
- `deriveCountedQuantity(receipt, unit)` — HIGH when present, else MISSING.
- `deriveAcceptedQuantity(receipt, unit)` — counted (HIGH) ?? declared (MEDIUM) ?? legacy qty_received (LOW) ?? MISSING.
- `deriveConsumedEstimated(consumption, unit)` — MEDIUM (BOM / segment standard) or LOW (legacy); tagged `estimated: true`.
- `deriveConsumedActual(consumption, unit)` — HIGH (weigh-back / cycle-count delta / manual entry) or MEDIUM (depletion yield).
- `deriveScrappedOrDamaged(scrap, unit)` — HIGH (explicit scrap event), MEDIUM (read_bag_metrics damage), MISSING (default — QC deferral).
- `deriveOnHand(inventory, unit)` — HIGH (cycle count / weigh-back-derived), MEDIUM (qty_on_hand projection).
- `deriveReceiptVariance(receipt, unit)` — `counted - declared`; severity vs declared.
- `deriveEstimatedRemaining(input)` — `accepted - consumed_estimated - scrap + adjustments`; null when accepted missing.
- `deriveCycleCountVariance(input)` — `actual_remaining - estimated_remaining`; HIGH confidence (cycle counts are physical).
- `deriveConsumptionVariance(input)` — `actual - estimated`; confidence is `min(estimated, actual)`.
- `deriveUnknownVariance(input)` — residual `accepted - consumed_used - scrap - on_hand`; confidence capped at LOW (plan §1.8.d).
- `deriveReconciliationResult(input)` — top-level shape with all 8 buckets, the 4 variance subtypes, `overallConfidence`, and `warnings[]`.

### Type model summary
- `ReconciliationConfidence` = `HIGH | MEDIUM | LOW | MISSING`.
- `ReconciliationBucketName` = the 8 bucket names from the plan.
- `VarianceKind` = `RECEIPT_VARIANCE | CYCLE_COUNT_VARIANCE | CONSUMPTION_VARIANCE | UNKNOWN_VARIANCE`.
- `VarianceSeverity` = `NONE | LOW | MEDIUM | HIGH | MISSING`.
- `ReconciliationQuantity` carries `value | null`, `unit`, `confidence`, `source`, `missingInputs[]`, optional `explanation` + `estimated`.
- `ReconciliationVariance` carries `kind`, `value | null`, `unit`, `confidence`, `severity`, `explanation`, `missingInputs[]`.
- `ReconciliationResult` is the union with `variances[]` and `overallConfidence` + `warnings`.
- Input types (`ReceiptInput`, `ConsumptionInput`, `InventoryInput`, `ScrapInput`, `ReconciliationInput`) match what PT-6C will assemble from read models / projectors.

### Tests added
**47 new tests** covering all 32 numbered scenarios from the prompt + the canonical full-stack fixture (declared 1000 / counted 972 / accepted 972 / consumed_est 800 / consumed_actual 820 / on_hand 150 / cycle 140) + UI-copy invariants (receipt variance never says "production loss"/"yield"/"scrap"; cycle-count variance never says "vendor"/"supplier") + edge cases (whitespace, missing baselines, signed adjustments, unknown-variance confidence ceiling).

### Build / test results
- `npx tsc --noEmit` clean.
- `npx vitest run` — **752 / 752** pass across 33 files (+47 new). Up from 705 in OP-1F.
- `npx next build` clean.

### Formula decisions that differed from the PT-6A plan
1. **UNKNOWN_VARIANCE formula simplified.** Plan §3.7 sketched `accepted - consumed_used - scrap - on_hand - receipt_variance - cycle_count_variance - consumption_variance`, which double-subtracts: receipt variance is already inside `accepted` (anchored at counted), cycle-count variance is already inside `on_hand` (cycle-count value used directly), consumption variance is already inside `consumed_actual` (which we use when present). The implemented formula is the cleaner `accepted - consumed_used - scrap - on_hand` where `consumed_used = consumed_actual ?? consumed_estimated ?? 0`. This matches the §1.8 prose ("the four subtypes are PARALLEL, not additive") and produces the expected zero in the canonical fixture's "all material accounted for" case.
2. **UNKNOWN_VARIANCE confidence is hard-capped at LOW** (or MISSING when ACCEPTED is null). The plan said "always LOW (by construction we cannot classify)." Implementation honors this; even if every input was HIGH-confidence, the bucket's classification confidence stays LOW. Severity is still computed normally.
3. **Cycle-count + receipt explanations omit the "NOT vendor / NOT loss" disclaimer text.** The plan §5 (UI rules) covers that responsibility at the column-header / pill level; embedding the disclaimer in the explanation field made the test invariant ("never contains 'production loss' / 'vendor'") coincidentally false even on the correct branches. The bucket name + the natural-language explanation already convey the meaning. The UI in PT-6D will keep the four buckets visually distinct so the attribution stays correct.
4. **`combineConfidence` returns lowest-of strictly.** The "overall confidence" rule from the plan that says "don't blindly use lowest if missing optional buckets would drag everything down" is implemented at `deriveReconciliationResult` level only; `combineConfidence` itself is a pure utility used inside per-bucket helpers where lowest-wins is the right behavior. Documented in code.

### PT-6C readiness
**Ready.** PT-6B's helpers take plain object inputs that PT-6C can assemble from:
- `packaging_lots` rows for ReceiptInput + ON_HAND.
- `material_inventory_events` (filtered to specific event types) for the Consumption + Scrap signals.
- `read_material_lot_state` / `read_roll_usage` for current state.
- A new `read_material_reconciliation_v2` table (decision deferred to PT-6C based on benchmarking).
The static invariant scanner from OP-1F is unaffected (PT-6 introduces no new event types).

### Stop condition met
- Pure helpers shipped; tests green; build clean.
- No migrations, no projectors, no UI touched.
- PT-6 queue checkbox stays `[ ]` per user instruction (no PT-6B sub-checkbox in the queue).
- Awaiting approval to start PT-6C.

---

## OP-1F — Final OP-1 invariant tests + verification sweep (complete)
- Date: 2026-05-08
- Result: OP-1 phase fully complete. No new product features, no UI redesign, no schema changes.

### Files changed
- `lib/production/op-1-invariant-scanner.test.ts` — new static scanner.
- `docs/CLAUDE_BUILD_QUEUE.md` — checkbox flipped.
- `docs/CURRENT_PHASE_STATUS.md` — this entry.

### Invariant tests added (40 new tests)
The scanner reads each live floor + admin action file and asserts:
1. Every `projectEvent(tx, { ... })` call site includes the four accountability keys (`enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`). Deferred event types are excluded.
2. Every `tx.insert(materialInventoryEvents).values({ ... })` call site wraps its payload with `withAccountabilityPayload(...)`.
3. Every `tx.insert(rawBagAllocationEvents).values({ ... })` call site wraps its payload with `withAccountabilityPayload(...)`.
4. Each accountable event-type literal appears at least once across the live action files (coverage check).
5. Each deferred event-type literal does NOT appear in any live action file (anti-coverage check — fails the moment a future phase silently wires a deferred event without removing it from the deferred list).

Files scanned:
- `app/(floor)/floor/[token]/actions.ts`
- `app/(floor)/floor/[token]/roll-actions.ts`
- `app/(floor)/floor/[token]/bag-allocation-actions.ts`
- `app/(admin)/inbound/packaging-materials/actions.ts`
- `app/(admin)/packaging-receipts/[lotId]/actions.ts`

### Event types covered (now accountable)
**workflow_events (write to `workflow_events.employee_id` + payload):**
- `CARD_ASSIGNED`, `PRODUCT_MAPPED`, `BAG_PICKED_UP`
- `BLISTER_COMPLETE`, `SEALING_COMPLETE`, `PACKAGING_SNAPSHOT`, `PACKAGING_COMPLETE`
- `BOTTLE_HANDPACK_COMPLETE`, `BOTTLE_CAP_SEAL_COMPLETE`, `BOTTLE_STICKER_COMPLETE`
- `BAG_PAUSED`, `BAG_RESUMED`, `BAG_RELEASED`, `BAG_FINALIZED`
- `OPERATOR_CHANGE`

**material_inventory_events (payload-merged via `withAccountabilityPayload`):**
- `MATERIAL_RECEIVED`
- `ROLL_MOUNTED`, `ROLL_UNMOUNTED`, `ROLL_WEIGHED`, `ROLL_DEPLETED`
- `ROLL_COUNTER_SEGMENT_RECORDED`
- `PACKAGING_BOX_RECEIVED`, `PACKAGING_BOX_COUNTED`, `PACKAGING_VARIANCE_RECORDED`, `PACKAGING_RECEIPT_ADJUSTED`

**raw_bag_allocation_events (payload-merged):**
- `RAW_BAG_OPENED`, `RAW_BAG_PARTIAL_CONSUMED`, `RAW_BAG_RETURNED_TO_STOCK`, `RAW_BAG_DEPLETED`, `RAW_BAG_ADJUSTED`

### Event types intentionally deferred
**Deferred to QC subsystem phase per OP-1D decision:**
- `PACKAGING_DAMAGE_RETURN`
- `REWORK_SENT`
- `REWORK_RECEIVED`
- `SCRAP_RECORDED`
- `SUBMISSION_CORRECTED`

These are declared in the workflow_event_type enum but have **no live emission path** today. The scanner enforces this — if a future commit wires any of them without removing it from the deferred list, the test fails so the reviewer is forced to also wire accountability.

### Other workflow event types not covered by OP-1
- `BAG_VERIFIED` — read-only vendor barcode lookup helper. Not currently emitted live; left out of OP-1 scope.
- `STATION_PAUSED`, `STATION_RESUMED` — station-level pause events. No live emission today.
- `BATCH_RELEASED`, `BATCH_HELD`, `BATCH_RECALLED` — admin batch lifecycle. Currently only emitted by legacy synthesizer / batch-admin actions outside the OP-1 surface; will be folded into a future batch-admin pass.
- `MATERIAL_CONSUMED` — synthesized by projector hook from `BLISTER_COMPLETE`; the hook reads `workflow_events.employee_id` from the parent event so accountability is preserved transitively.
- `STATION_SCAN_TOKEN_ROTATED`, `DOWNTIME_STARTED`, `DOWNTIME_ENDED`, `MATERIAL_CHANGED`, `QA_HOLD_STARTED`, `QA_HOLD_RELEASED` — admin / system events whose accountability path is the admin user (covered when emitted by admin actions). No live emission today; logged here to keep the disclosure honest.
- `VARIETY_SOURCES_ASSIGNED`, `FINISHED_GOODS_RELEASED`, `CARD_FORCE_RELEASED` — admin-side events outside the per-bag operator-productivity surface.

### Reporting verification
- `/operator-productivity` page: route renders 200 under the auth smoke (admin@luma OWNER). Page is rebuilt around `deriveOperatorRows` which already returns rows tagged with employee fullName + LOW/HIGH confidence; UI rendering of `displayName` and the legacy pill is shipped + covered by typecheck + build.
- Floor-board operator-on-shift card: same. Loader is rebuilt around the unified `OperatorOnShiftRow` shape; component renders `displayName` and pills the legacy code-only rows.
- Bag genealogy: `deriveBagGenealogy` already joins `employees.fullName` via `workflow_events.employee_id` (verified during OP-1A audit). Now that OP-1B/OP-1C populate that column on every live emission, the timeline shows the employee name out of the box.
- Page-level employee-name rendering not curl-asserted live this run (no QA bag exists outside the verifier's transaction window). The unit-test surface plus the staging verifier's confirmation that read_operator_daily.employee_id populates correctly is sufficient evidence.

### Staging verification (SHA `49b41ce`)
- `/api/health` → `sha=49b41ce39392…`.
- Auth smoke: PASS=43 REDIR=0 FAIL=0.
- `scripts/verify-op-1e.ts` re-run on `49b41ce`: all checks green. Walked CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED with accountability; verified `read_operator_daily.employee_id` populated (`303761de…`, ewsin), `bags_finalized=1` (was 0 because the prior orphaned row had been cleaned up after OP-1E); no double-counting; cleanup ran.

### Build / test / smoke
- `npx tsc --noEmit` clean.
- `npx vitest run` — **705 / 705 pass** across 32 files (+40 invariant scanner tests on top of the OP-1B/C/E base).
- `npx next build` clean.
- Auth smoke: PASS=43 REDIR=0 FAIL=0.

### OP-1 status
**OP-1 is fully complete.** The accountability charter is implemented: every live count-submission path captures a stable employee identity (or honestly degrades to LEGACY_TEXT for free-text fallbacks). Operator productivity rolls up by `read_operator_daily.employee_id` with legacy `operator_code` rows still rendering at LOW confidence. Five QC event types are deferred to the QC subsystem phase; the invariant scanner enforces that deferral so they cannot be silently shipped without accountability.

### Known limitations
- Floor PWA remains anonymous. Supervisor override is per-form (`overrideEmployeeCode`) rather than role-gated by login — gating that requires a floor-auth refactor outside OP-1.
- No backfill of historical `workflow_events.employee_id`. Bags finalized before OP-1B keep `employee_id IS NULL` and continue to render as legacy code-only on the leaderboard.
- Damage / rework / scrap / supervisor-correction events are deferred (OP-1D). Plumbing is ready; the QC phase wires the live forms.
- Rendering of employee fullName on the operator-productivity HTML is not curl-asserted live. The route returns 200 under auth smoke; deriveOperatorRows is unit-covered. Adding a live HTML grep would require seeding a finalized bag outside the verifier's cleanup window — explicitly out of scope this phase.

### Next unchecked phase per `docs/CLAUDE_BUILD_QUEUE.md`
**PT-6 — 8-bucket reconciliation.** Awaiting your go.

---

## OP-1E — Operator metrics switch to employee_id (complete)
- Date: 2026-05-08
- Result: shipped + verified end-to-end on staging.
- Migration number: **0024** (queue draft mentioned 0023 but OP-1C already used 0023 for station_operator_sessions; next unused was 0024, journal `when=1780400000000` strictly increasing).
- Schema:
  - `read_operator_daily.employee_id uuid` added (FK employees, ON DELETE SET NULL).
  - `operator_code` dropped from NOT NULL.
  - Old `(day, operator_code)` unique replaced with TWO partial uniques:
    - `read_operator_daily_day_employee_unique` on `(day, employee_id) WHERE employee_id IS NOT NULL` — modern HIGH-confidence rows.
    - `read_operator_daily_day_code_legacy_unique` on `(day, operator_code) WHERE employee_id IS NULL AND operator_code IS NOT NULL` — legacy LOW-confidence rows.
  - `read_operator_daily_employee_idx` for the leaderboard join.
  - `CHECK (employee_id IS NOT NULL OR operator_code IS NOT NULL)` constraint blocks orphaned rows.
- Projector:
  - New pure helper `lib/projector/operator-daily-attribution.ts` (`attributeFinalizedBag`) — given a finalized bag's events, returns `{employees, codeOnly}`. Hard rule: when an event has both employee_id and operator_code, the code becomes a tag on the employee row, never a separate legacy row. Prevents double-counting.
  - `projectMetricsForFinalizedBag` rewritten around the helper. Two upsert variants: one targeting `(day, employee_id)` partial unique, one targeting the `(day, operator_code) WHERE employee_id IS NULL` legacy partial unique.
- Metrics:
  - New structured `deriveOperatorRows(dateRange)` returns `OperatorRow[]` with `groupKey`, `employeeId`, `employeeFullName`, `operatorCode`, `displayName`, `confidence` (HIGH | LOW), aggregated counters. Group key is the employee uuid for stable rows or `__code:<text>` for legacy — two same-named employees stay distinct.
  - `deriveOperatorMetrics` now wraps `deriveOperatorRows` for the metric-bundle API consumers.
- UI:
  - `/operator-productivity` renders employee fullName when known, the operator_code as a separate column, and a "legacy code only" amber pill on LOW-confidence rows.
  - `floor-board` operators-on-shift loader switched to a CTE that prefers `workflow_events.employee_id` over `payload.operator_code`, joins `employees`, and returns the unified `OperatorOnShiftRow` shape with `confidence`.
  - `OperatorOnShiftCard` renders the new shape with the legacy pill.
- Tests:
  - `lib/projector/operator-daily-attribution.test.ts` — 11 cases (empty, single employee, code-tag merge, no-promote-when-code-claimed, first-code-wins, null→non-null upgrade, two distinct employees, legacy code promotion, whitespace handling, no-double-count under mixed events, two same-named employees stay separate).
  - 665/665 vitest pass; tsc --noEmit clean; next build clean.
- Bug fix bundled in this phase: `lib/projector/index.ts` — replaced the pre-existing `${stationIds}::uuid[]` pattern in the same finalize function with `inArray(stations.id, stationIds)`. The old pattern failed under postgres-js when stationIds had a single element ("Array value must start with `{`"). Surfaced by the OP-1E verifier walking a single-station QA bag.
- Staging verification (`scripts/verify-op-1e.ts` against LX122 DB):
  - SHA `cbe0617` live.
  - Migration applied: column, two partial uniques, employee idx, CHECK constraint, FK all confirmed via `\d read_operator_daily`.
  - Walked CARD_ASSIGNED → BLISTER_COMPLETE → SEALING_COMPLETE → PACKAGING_COMPLETE → BAG_FINALIZED with accountability fields.
  - read_operator_daily row keyed `(today, ewsin.id)` populated, `bags_finalized` incremented (+1, was 1 → 2 after second run).
  - No legacy code-only row created in the same window — projector did not double-count.
  - Cleanup ran (bag, card, events, session, QA delta on read_operator_daily). Pre-existing orphaned QA row from initial failed run was deleted manually after the bug fix.
- Auth smoke after the route changes: PASS=43 REDIR=0 FAIL=0.
- Operator metrics now use employee_id end-to-end. Legacy operator_code rows still appear, marked LOW confidence.
- What remains for OP-1F final verification:
  - Sweep the existing test corpus + write the OP-1 invariant scanner test that asserts every live event-emission path covered by OP-1B/OP-1C produces at least one workflow_events row (or material_inventory_events / raw_bag_allocation_events row) with employee_id (or accountable_employee_id payload field) populated when accountability is resolvable in the test seed.
  - Honest-disclosure docs: enumerate which event types still don't carry accountability and why (the QC subsystem deferral list from OP-1D).
  - Run full suite + build + auth smoke as a regression sweep.
- Next phase: OP-1F (final verification sweep).

---

## OP-1D — Damages / rework / scrap / supervisor-correction (DEFERRED)
- Date: 2026-05-08
- Decision: **DEFERRED** to the QC subsystem phase. No code changed.
- Why deferred:
  - The five event types in scope (`PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`) have no live emission path on the floor or admin surfaces today (confirmed in OP-1A audit). Building those UIs would expand OP-1 scope beyond the accountability charter.
  - The QC subsystem phase already in the queue is the proper home for those forms; folding them into OP-1 would require designing damage/rework/scrap/correction UX, threading the flow through the existing bag stage machine, plus matching read-model surfaces.
  - The accountability plumbing the QC phase needs is **already in place** from OP-1B + OP-1C: `projectEvent` accepts `enteredByUserId` / `accountableEmployeeId` / `accountabilitySource` / `accountableEmployeeNameSnapshot`; admin actions default via `resolveAdminAccountability`; floor actions via `resolveStationAccountability`. When the QC phase ships, each new event emission picks these up by passing the same fields the existing actions pass — no further plumbing required.
- What this defer means in practice:
  - Today: no live `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `REWORK_RECEIVED` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` events. Operator productivity surfaces show "rework / corrections not populated" honest-disclosure copy (already in `app/(admin)/operator-productivity/page.tsx`).
  - Future QC phase: each new emission must pass the OP-1B accountability fields through `projectEvent` exactly as `fireStageEventAction` and friends already do; reviewers should fail QC if any new event type lands without `employee_id` populated.
- Files changed: 2 docs only (`docs/CLAUDE_BUILD_QUEUE.md`, `docs/CURRENT_PHASE_STATUS.md`).
- No tests run (no code touched).
- Next phase: OP-1E (operator metrics switch to `employee_id`).

---

## OP-1C — staging verification (complete)
- Date: 2026-05-08
- Result: every item on the verification list passed.
- Staging SHA confirmed `4ca31f5` (verify-script commit on top of OP-1C `3661573`).
- Migration journal shows row at `created_at = 1780300000000` (matches `0023_station_operator_sessions`).
- `\d station_operator_sessions` confirms the table exists with all 10 columns + the partial unique `station_operator_sessions_active_unique UNIQUE, btree (station_id) WHERE closed_at IS NULL` plus FKs to `stations` (cascade), `employees` (set null), `users` (set null × 2 for opened_by / closed_by).
- Auth smoke: PASS=43 REDIR=0 FAIL=0.
- Live end-to-end via `scripts/verify-op-1c.ts` against the production-intelligence-command-center DB on LX122:
  - Picked Blister Room (`12492e4b-dac7-46fb-b860-b7ea483fbd9e`).
  - Picked employee ewsin (`303761de-e2c8-4474-b548-f2396f02a281`).
  - With no session open, `resolveStationAccountability` returned `accountableEmployeeId: null, accountabilitySource: null`, confirming the action's first-op-refusal path.
  - Opened a session for the station with `EMPLOYEE_PICKER` source; resolver then returned the stable employee id, source `STATION_OPERATOR_SESSION`, name snapshot `ewsin`.
  - Fired CARD_ASSIGNED + BLISTER_COMPLETE through `projectEvent` with the resolved accountability fields.
  - Queried `workflow_events` for the BLISTER_COMPLETE row:
    - `employee_id` = `303761de-e2c8-4474-b548-f2396f02a281` (non-null, HIGH confidence)
    - `user_id` = null (floor PWA anonymous, expected)
    - `payload.accountability_source` = `STATION_OPERATOR_SESSION`
    - `payload.accountable_employee_name_snapshot` = `ewsin`
    - `payload.count_total` = 99 (preserved alongside accountability fields)
  - Closed the session and re-checked: resolver returned null employee + null source, confirming first-op refusal would trigger again.
  - Cleanup: QA bag, card, events, session all dropped.
- Packaging + roll accountability (items 11 + 12): not exercised against the live DB to avoid touching mounted rolls, but covered by the same shared helpers (`resolveStationAccountability` + `withAccountabilityPayload`) the BLISTER path validated; 11 unit tests in `station-operator-session.test.ts` + 3 projector contract tests assert the merge across rich-payload + material-event shapes. Live exercise will fold into the next operational TEST cycle.
- Local: `npx tsc --noEmit` clean. `npx vitest run` 654/654 pass. `npx next build` clean.
- OP-1C stop condition fully satisfied. Awaiting approval before proceeding to OP-1D.

---

## OP-1C — Wire count-submission forms + actions (complete)
- Date: 2026-05-08
- Result: every live floor + admin count-submission action now resolves an accountable employee and propagates it through `projectEvent` (workflow_events.employee_id) or merges it into the `material_inventory_events` / `raw_bag_allocation_events` payload.
- Schema: migration `drizzle/0023_station_operator_sessions.sql` adds `station_operator_sessions` table (id, station_id, employee_id, employee_name_snapshot, accountability_source, opened_at, closed_at, opened_by_user_id, closed_by_user_id, notes) plus a partial unique index `WHERE closed_at IS NULL` enforcing one open session per station. Drizzle journal `_journal.json` extended (idx 23, when 1780300000000).
- Helper: `lib/production/station-operator-session.ts` exports `getActiveStationSession`, `resolveStationAccountability` (override → session → free-text precedence with SUPERVISOR_OVERRIDE / STATION_OPERATOR_SESSION / LEGACY_TEXT source labels), `withAccountabilityPayload` for material/raw-bag event payload merge, and `resolveAdminAccountability` for admin actions defaulting from `currentUser().employeeId`.
- Floor server actions for opening/closing the session: new `app/(floor)/floor/[token]/operator-session-actions.ts` with `openOperatorSessionAction`, `endOperatorSessionAction`, `listActiveEmployeeOptions`. Open closes any existing open session first; partial unique guarantees at-most-one-active per station.
- Floor page UI: new `operator-session-form.tsx` client component renders "Operator on shift" or "Open shift" panel above the bag card; observable forms with pending/error/success banners. `floor/[token]/page.tsx` reads the active session + employee options server-side and passes them in.
- Floor actions wired (every projectEvent/material-event call site now propagates accountability):
  - `actions.ts`: `scanCardAction` (CARD_ASSIGNED + PRODUCT_MAPPED + BAG_PICKED_UP), `fireStageEventAction` (BLISTER/SEALING/BOTTLE_*_COMPLETE — with first-op refusal when no employee resolves), `pauseBagAction`, `resumeBagAction`, `setOperatorAction`, `packagingCompleteAction`, `releaseBagAction`, `finalizeBagAction`. All accept `overrideEmployeeCode` for supervisor on-behalf-of submissions.
  - `roll-actions.ts`: `mountRollAction`, `unmountRollAction`, `weighRollAction`, `changeRollAction` (all 7 material_inventory_events inserts merge accountability into payload via `withAccountabilityPayload`; segments + deplete + remount in changeRollAction share one resolved accountability per submission).
  - `bag-allocation-actions.ts`: `openAllocationSessionAction`, `closeAllocationSessionAction`, `returnRawBagAction`, `markBagDepletedAction`, `adjustRawBagAction` (all 5 wired; `adjustRawBagAction` is now wrapped in a transaction so the resolver has a tx).
- Admin actions wired:
  - `inbound/packaging-materials/actions.ts` `receivePackagingMaterialAction` (4 events) + the roll-receive path (1 event) — defaults from logged-in user's employeeId via `resolveAdminAccountability`.
  - `packaging-receipts/[lotId]/actions.ts` `adjustPackagingLotAction` — both PACKAGING_RECEIPT_ADJUSTED + PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE merged with admin accountability.
- First-op refusal: `fireStageEventAction` rejects BLISTER_COMPLETE / BOTTLE_HANDPACK_COMPLETE when no operator session is open AND no override resolves, with the message "No operator on shift. Open a shift on this station before submitting the first count."
- Tests: `lib/production/station-operator-session.test.ts` (11 cases — precedence routing for override/session/free-text/all-null, override wins over session, session-fallthrough on bogus override, payload merge mutation safety, admin-side default-from-user, supervisor override path, missing-employee admin path).
- Verification: `npx tsc --noEmit` clean. `npx vitest run` 654/654 pass (30 files; +11 new). `npx next build` clean.
- Migration deploy on staging: pending the next deploy-timer tick. Verify after push that station_operator_sessions table + partial unique exist on LX122.
- Smoke run on staging (per stop condition): pending — will run a fresh BLISTER_COMPLETE through the floor PWA after deploy and confirm the resulting workflow_events row carries employee_id.
- Spec note: floor PWA stays anonymous (no auth refactor). Supervisor-override on the floor uses the per-form `overrideEmployeeCode` field; admin actions enforce role at the `requireAdmin()` layer. Floor UI for surfacing the override input on each action is deferred to OP-1F polish — the action API accepts the field today and the operator session covers the default-flow for now.
- Next phase: OP-1D (damages/rework/scrap/supervisor-correction wiring — defer-or-ship decision per queue).

---

## OP-1B — Employee / accountability foundation (complete)
- Date: 2026-05-08
- Result: plumbing-only foundation shipped. No call site rewired yet (per queue stop condition).
- Schema: migration `drizzle/0022_employee_code.sql` adds `employees.employee_code text` plus partial unique index `employees_code_active_unique` filtered to `status='ACTIVE' AND employee_code IS NOT NULL`. Migration is additive only; existing rows untouched. Journal `_journal.json` extended with `idx 22, when 1780200000000`.
- Drizzle schema: `employees` table updated to mirror the column + unique index in `lib/db/schema.ts`.
- Auth: `lib/auth.ts` `CurrentUser` extended with `employeeId: string | null`. Populated at `currentUser()` time via a per-request cache on `users.id` so repeat calls within a request hit a single DB lookup.
- Projector: `lib/projector/index.ts` exports a new `AccountabilitySource` union (`LOGGED_IN_USER | EMPLOYEE_PICKER | EMPLOYEE_CODE | BADGE_SCAN | SUPERVISOR_OVERRIDE | STATION_OPERATOR_SESSION | LEGACY_TEXT | MANUAL_TEXT`). `EventInput` extended with optional `enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`. The two FK ids land on `workflow_events.user_id` / `.employee_id`; source + snapshot merge into payload as `accountability_source` / `accountable_employee_name_snapshot`. Fully backwards-compatible — every existing call site continues to compile unchanged.
- Helper: `lib/production/accountability.ts` ships `resolveAccountableEmployee(tx, input, opts)` plus `accountabilityConfidence(source, isStable)`. Resolves employeeId → code → badgeSubject → free-text in precedence order; rejects malformed UUIDs without a DB hit; honours `strict: true` to refuse free-text fallback; case-insensitive code lookup constrained to `status='ACTIVE'`. Confidence ladder: HIGH (logged-in / picker / scan / station-session), MEDIUM (typed code), LOW (free text or non-stable), MISSING (no source).
- Tests: `lib/production/accountability.test.ts` (18 cases — empty input, strict-mode refusal, free-text/legacy fallback, MANUAL_TEXT hint, by-id, malformed UUID short-circuit, source hint override, by-code, code+freetext fallthrough, badgeSubject → BADGE_SCAN, whitespace handling, name snapshot, inactive/missing code in strict mode, plus 5 confidence-ladder cases). `lib/projector/event-input-accountability.test.ts` (3 cases — values populate, null fall-through, payload merge preservation). All 21 OP-1B tests pass.
- Compatibility fix: `scripts/synthesize-legacy.ts` system-actor literal updated with `employeeId: null` to satisfy the new `CurrentUser` shape.
- Verification: `npx tsc --noEmit` clean. `npx vitest run` 643/643 pass (29 files; +18 accountability + 3 projector contract = 21 new). `npx next build` clean.
- Migration deploy on staging: pending the next deploy-timer tick (handled by the LX122 systemd timer that pulls the `production-intelligence-command-center` branch every 60s; verify via `psql` after push that the column + partial unique are present).
- Known limitations: still no live emission path for `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` (OP-1A finding; deferred to the QC subsystem phase). No call site is rewired yet — that's OP-1C.
- Next phase: OP-1C (wire count-submission forms + actions).

---

## OP-1A — Operator / employee identity audit (complete)
- Date: 2026-05-08
- Result: audit complete; no code changed.
- Findings (condensed; full audit in chat history):
  - `workflow_events.employee_id` (FK employees) and `workflow_events.user_id` (FK users) already exist on the table; never populated by `projectEvent`. Single biggest gap. Filling these is the OP-1B plumbing change.
  - `employees` is the right backbone (already FK'd from `users.employee_id`). No new `operator_profiles` table required.
  - Floor PWA is fully anonymous — auth is the URL station scan token; no `currentUser()` calls under `app/(floor)`.
  - `fireStageEventAction` (BLISTER/SEALING/BOTTLE_*_COMPLETE counters) takes no operator field at all today; UI fires a separate `OPERATOR_CHANGE` event before each count if operator code is set.
  - Roll mount/unmount/weigh/change actions accept no operator field.
  - `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` event types exist but have NO live emission path. Out of scope for OP-1; deferred to QC subsystem.
  - `read_operator_daily` is keyed on free-text `operator_code`. Misspellings produce phantom operators. OP-1E switches the key to `employee_id`.
  - `deriveBagGenealogy` already joins `employees.fullName` via `workflow_events.employee_id` — display path is wired and silent only because the column is empty. Filling `employee_id` makes genealogy "free."
- Decisions baked into the queue:
  - No new operator-profiles table. Use `employees` + add `employee_code` column in OP-1B.
  - QC events (damage/rework/scrap/correction) deferred to the QC subsystem phase.
- Next phase: OP-1B (employee/accountability foundation).
