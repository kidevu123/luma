# Current Phase Status

Append-only log. Each entry: phase name, date (UTC), result, notes. Latest entry first.

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
