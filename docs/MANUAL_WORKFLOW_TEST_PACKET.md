# Manual workflow test packet — staging

**Phase:** VALIDATION-2B
**Audience:** human QA tester driving a tablet/browser; AI agent acting as auditor between steps.
**Updated:** 2026-05-08 against deployed sha `6da0085`.

This packet is the script for end-to-end manual validation of every Luma workflow before any PillTracker cutover. The human runs the actions in order; the AI runs `npm run validation:snapshot` between steps and reports what changed in the database.

If at any point the snapshot shows an unexpected value, a duplicate session, a roll status mismatch, or a server error, **stop the test run and report**. Do not continue past a bad signal.

---

## 1. Test environment

| Field | Value |
|---|---|
| Staging URL | `http://192.168.1.134:3000` |
| LXC | 122 (Proxmox host `192.168.1.190`) |
| Deployed SHA | `6da00852ec323e74a6dd1e37a64bcf2c9fc6ac2b` |
| Branch | `production-intelligence-command-center` |
| Pre-test backup | `/opt/luma/backups/staging-pre-v2a-6da0085-20260508-005004.sql.gz` |
| QA seed | applied (`QA_TEST_*` records present, 8 stations on UUID tokens) |
| Test bed cleanup | `ALLOW_STAGING_QA_DATA=true npm run staging:cleanup` (run AFTER full test pass to reset for the next run) |
| Snapshot command | `ALLOW_STAGING_QA_DATA=true npm run validation:snapshot` |

If the deploy SHA changes during a test run, restart the run from TEST A. Don't mix evidence across builds.

---

## 2. Floor station URLs

All tokens are UUIDs (post `--rotate-tokens`). Each station has four URLs:
- station overview: `/floor/<token>`
- rolls: `/floor/<token>/rolls`
- bag allocation: `/floor/<token>/bag-allocation`
- variety pack: `/floor/<token>/variety-pack`

The Blister Room is the primary station for TESTS A–G (PVC + foil rolls live there). Other stations are available for cross-machine testing.

| Station | Kind | Token | Floor URL |
|---|---|---|---|
| Blister Room | BLISTER | `4da43c47-b9e4-4710-9b6c-68014e4bd4ee` | `/floor/4da43c47-b9e4-4710-9b6c-68014e4bd4ee` |
| Sealing station 1 | SEALING | `82f1c8cf-9d71-4f60-9aef-42cd50300906` | `/floor/82f1c8cf-9d71-4f60-9aef-42cd50300906` |
| Sealing station 2 | SEALING | `8381a149-c607-4e79-ac8f-0778df71d21e` | `/floor/8381a149-c607-4e79-ac8f-0778df71d21e` |
| Sealing Station 3 | SEALING | `a2a50b09-6fb6-4674-aec3-992c966a880f` | `/floor/a2a50b09-6fb6-4674-aec3-992c966a880f` |
| Packaging Station | PACKAGING | `ba2d44e1-8953-405b-8230-96888a76b282` | `/floor/ba2d44e1-8953-405b-8230-96888a76b282` |
| Bottle Packing Station | BOTTLE_HANDPACK | `51b45f0f-5eec-4280-a403-f5e1812be252` | `/floor/51b45f0f-5eec-4280-a403-f5e1812be252` |
| Bottle Sealer | BOTTLE_CAP_SEAL | `dd3b1119-b087-4637-aaeb-0671a090708a` | `/floor/dd3b1119-b087-4637-aaeb-0671a090708a` |
| Bottle Stickering | BOTTLE_STICKER | `2e95ebe9-ea52-4f97-85a6-1998ea091ff8` | `/floor/2e95ebe9-ea52-4f97-85a6-1998ea091ff8` |

The full URLs (incl. `/rolls`, `/bag-allocation`, `/variety-pack`) are linked from each station page's nav row. Bookmark the Blister Room set on whatever tablet you're using for the run.

Admin URLs (login first at `/login` → admin@luma):

- `/workflow-validation` — readiness board
- `/po-reconciliation` and `/po-reconciliation/<QA-PO-id>` (find the QA PO id in the snapshot output)
- `/packaging-inventory`, `/active-rolls`, `/roll-variance`, `/material-alerts`

---

## 3. Test order

Run sequentially. A failed test halts the run.

| # | Test | Why it's first |
|---|---|---|
| A | Packaging inventory pre-state | Anchor — confirms QA seed loaded, no events yet |
| B | Mount PVC + foil rolls | Roll lifecycle entry point |
| C | Weigh roll | Confirms ROLL_WEIGHED + estimate update |
| D | Single bag allocation to card product | Allocation entry point |
| E | Return same bag to stock | Validates the multi-mount lifecycle |
| F | Reopen same bag for bottle product | Validates split usage across products |
| G | Deplete bag | Closes the bag's life cycle |
| H | Variety pack multi-component allocation | Multi-bag for one finished product |
| I | PO reconciliation report | End-to-end visibility |
| J | Material panels after events | Read-side correctness |
| K | Negative / missing-state checks | Honest failure paths |

Snapshot loop for each test:

```bash
# AUDITOR: capture pre-state
ALLOW_STAGING_QA_DATA=true npm run validation:snapshot

# HUMAN: perform the action listed below
# (open the URL on a tablet, fill the form, submit)

# AUDITOR: capture post-state
ALLOW_STAGING_QA_DATA=true npm run validation:snapshot

# AUDITOR: tail recent app logs
docker compose logs app --tail=200
```

Compare the two snapshots. The diff should match the "Expected DB result" rows below.

---

## 4. Per-test actions, expectations, and verification queries

### TEST A — Packaging inventory pre-state

| Field | Value |
|---|---|
| Human action | Open admin `/packaging-inventory` after login. Visually scan rows. |
| Expected UI | Two QA roll lots (`QA_TEST_PVC_ROLL_001`, `QA_TEST_FOIL_ROLL_001`) listed under PVC_ROLL / FOIL_ROLL kinds. Status = `AVAILABLE` for both. Other QA materials (display, case, bottle, cap, label, induction seal) appear with 0 lots. |
| Expected DB result | `packaging_lots` count for QA = 2 · `read_material_lot_state` ≥ 2 · `read_roll_usage` = 2 · all `material_inventory_events.event_type` counts = 0 except `MATERIAL_RECEIVED` ≥ 0 |
| Verification query | `npm run validation:snapshot` — "Roll lots" section shows 2 AVAILABLE rolls; "Material events" shows no ROLL_* and no MATERIAL_CONSUMED_*. |
| PASS criteria | Roll-lots block matches; material-events block has 0 ROLL_MOUNTED. |
| FAIL criteria | Any roll already IN_USE; any ROLL_* event already present; any MATERIAL_CONSUMED_ESTIMATED. |
| Evidence | Screenshot of `/packaging-inventory` + snapshot stdout. |

### TEST B — Mount PVC + foil rolls

| Field | Value |
|---|---|
| Human action | 1. Open `/floor/<Blister Room token>/rolls`. 2. Section "Mount roll" → pick `QA_TEST_PVC_ROLL_001` → select role `PVC` → submit. 3. Repeat for `QA_TEST_FOIL_ROLL_001` with role `FOIL`. |
| Expected UI | "Active rolls" section shows two rows immediately. Each row shows roll number, role, mounted-at timestamp, confidence (`MEDIUM` initially — no weigh-back yet). |
| Expected DB result | `material_inventory_events` `ROLL_MOUNTED` = 2; both lots' status = `IN_USE`. After rebuild, `read_roll_usage` rows for both have non-null `mounted_at`. |
| Verification query | `npm run validation:snapshot`: "Material events" shows `ROLL_MOUNTED 2`; "Active rolls (per machine)" shows 2 rows for "Blister Machine". Pass-fail hint "Active roll count matches mount/unmount delta" = PASS. |
| PASS criteria | 2 ROLL_MOUNTED events; both rolls IN_USE; active-rolls panel shows 2. |
| FAIL criteria | Server returned an error toast; second mount blocked unexpectedly; lot still AVAILABLE. |
| Evidence | Screenshots of both mounts + snapshot. |

### TEST C — Roll segment ledger (VALIDATION-2C model, replaces weigh-back-as-primary)

The blister machine counter is reset between segments. Each counter value entered IS the segment count for that span. Roll yield is the sum of segments allocated to the roll. Same segment is allocated to BOTH active rolls (PVC + FOIL) AND the active workflow bag.

The flow exercises one bag with no roll change, then one bag with a mid-bag PVC change, matching the worked example in the spec.

#### Setup (already done from TEST B)
- PVC Roll 1 (`QA_TEST_PVC_ROLL_001`, net 5000 g) — IN_USE on Blister Machine
- Foil Roll 1 (`QA_TEST_FOIL_ROLL_001`, net 1500 g) — IN_USE on Blister Machine

**Note for the staging test:** the spec's example uses arbitrary roll numbering (PVC Roll 1, PVC Roll 2). On staging we only have one PVC roll lot seeded, so the "PVC Roll 2" step requires receiving a second PVC roll first via `/inbound/packaging-materials` (or extending the seed). For the first run, you can shorten this test to exercise just **Bag 1 → Bag 2 segment 1** (skip the actual roll change) and confirm the segment math matches.

#### Step C1 — Bag 1 completes at 20,324

| | |
|---|---|
| Human action | 1. Scan a card at `/floor/<Blister Room token>` to start a workflow bag. 2. Run blister production (the operator side; we don't simulate it). 3. Fire BLISTER_COMPLETE for that bag with counter = `20324`. |
| Expected DB result | `material_inventory_events` `ROLL_COUNTER_SEGMENT_RECORDED` count += 2 (one for PVC Roll 1, one for Foil Roll 1), each with `payload.counter_segment_count = 20324`, `payload.segment_reason = 'BAG_COMPLETE'`, `payload.workflow_bag_id` = the new bag, `payload.bag_segment_sequence = 1`, `payload.roll_segment_sequence = 1`. |
| Verification | `npm run validation:snapshot` — "Material events" shows `ROLL_COUNTER_SEGMENT_RECORDED 2`. Then run `psql` query: `SELECT roll_role, counter_segment_count, roll_total_after_segment, active_bag_total_after_segment FROM (SELECT (payload->>'roll_role') AS roll_role, (payload->>'counter_segment_count')::int AS counter_segment_count, (payload->>'roll_total_after_segment')::int AS roll_total_after_segment, (payload->>'active_bag_total_after_segment')::int AS active_bag_total_after_segment FROM material_inventory_events WHERE event_type='ROLL_COUNTER_SEGMENT_RECORDED' ORDER BY id) sub;` |
| PASS criteria | 2 segment rows. PVC's `roll_total_after_segment = 20324`. FOIL's `roll_total_after_segment = 20324`. Bag total = 20324. |

#### Step C2 — Bag 2 starts (scan a second card)

Bag 2 is now the active bag. Operator resets counter (mental, no system action).

#### Step C3 — Mid-bag PVC change at counter = 15,238

| | |
|---|---|
| Human action | At `/floor/<Blister Room token>/rolls` → "Change roll mid-bag" → role=PVC → counter=`15238` → new roll = (a second PVC roll lot you've received in advance). Submit. |
| Expected DB result | `ROLL_COUNTER_SEGMENT_RECORDED` += 2 (PVC Roll 1, Foil Roll 1) with `payload.counter_segment_count = 15238`, `payload.segment_reason = 'ROLL_CHANGE'`. `ROLL_DEPLETED` += 1 (PVC Roll 1) with `payload.final_roll_yield_blisters = 35562` and `payload.grams_per_blister ≈ 0.04218`. `ROLL_MOUNTED` += 1 (PVC Roll 2). PVC Roll 1 status → DEPLETED, PVC Roll 2 status → IN_USE. |
| Verification | `npm run validation:snapshot` — "Material events" shows additional 2 `ROLL_COUNTER_SEGMENT_RECORDED`, 1 `ROLL_DEPLETED`, 1 `ROLL_MOUNTED`. "Roll lots" shows PVC Roll 1 = DEPLETED, PVC Roll 2 = IN_USE. |
| PASS criteria | After this step: PVC Roll 1 yield = 20324 + 15238 = **35,562**. Foil Roll 1 yield = 20324 + 15238 = **35,562** (still in production). PVC Roll 2 yield = 0 (just mounted). |

#### Step C4 — Bag 2 completes at counter = 4,500

| | |
|---|---|
| Human action | Fire BLISTER_COMPLETE for Bag 2 with counter = `4500`. |
| Expected DB result | `ROLL_COUNTER_SEGMENT_RECORDED` += 2 (PVC Roll 2, Foil Roll 1) with `payload.counter_segment_count = 4500`, `payload.segment_reason = 'BAG_COMPLETE'`. |
| Verification | `npm run validation:snapshot`. Then SQL: `SELECT pl.roll_number, SUM((ev.payload->>'counter_segment_count')::int) AS yield FROM material_inventory_events ev JOIN packaging_lots pl ON pl.id = ev.packaging_lot_id WHERE ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED' GROUP BY pl.roll_number;` |
| PASS criteria | PVC Roll 1 yield = **35,562**. PVC Roll 2 yield = **4,500**. Foil Roll 1 yield = **40,062** (= 20324 + 15238 + 4500). Bag 2 total in last segment payload `active_bag_total_after_segment` = **19,738** (= 15238 + 4500). |
| FAIL criteria | Any of those numbers off; double-counting; foil roll yield not equal to bag1 total + bag2 total. |
| Evidence | Snapshot diff + SQL output of the yield query. |

#### Step C5 — Verify learned standard (auto-derived, no weigh-back required)

| | |
|---|---|
| Human action | None. Just run `npm run rebuild:read-models` and observe. |
| Expected DB result | `read_roll_usage` row for PVC Roll 1: `blisters_produced = 35562`, `actual_used_grams = 1500` (full net since DEPLETED), `confidence = HIGH`. The implied `grams_per_blister = 1500 / 35562 ≈ 0.04218` is calculable in the metric API. `read_material_usage_learning` may pick up PVC Roll 1 as a sample once a future rebuild captures it (this depends on whether the learning rebuilder includes DEPLETED-without-weigh-back rolls; verify behavior and report). |
| PASS criteria | DEPLETED PVC Roll 1 contributes a HIGH-confidence sample to learned standards without requiring a weigh-back. |
| FAIL criteria | Sample only counted with weigh-back present (would be a regression from VALIDATION-2C). |

### TEST D — Single bag allocation to card product

| Field | Value |
|---|---|
| Human action | 1. Open `/floor/<Blister Room token>/bag-allocation`. 2. Section 2 "Open a new session" → pick a QA bulk bag (e.g. bag #1 with vendor barcode `QA_TEST_VBC_BULK_001`) → product `QA_TEST_CARD_A` → leave route blank (uses product default) → leave starting balance blank (defaults to vendor declared 20000). Submit. 3. Page refreshes; section 1 now shows the open session. 4. On that session card → "Close session (record consumed quantity)" → enter `12000`, source `MANUAL_ENTRY`, leave ending blank. Submit. |
| Expected UI | After step 2: session appears in section 1 with `OPEN`, starting `20000 units`. After step 4: session card disappears (status flipped to CLOSED). |
| Expected DB result | `raw_bag_allocation_sessions` row 1 with `status='CLOSED'`. `raw_bag_allocation_events` `RAW_BAG_OPENED` = 1, `RAW_BAG_PARTIAL_CONSUMED` = 1. `inventory_bags.status` for the bulk bag = `IN_USE` after step 2; remains `IN_USE` after close (closing a session does NOT flip the bag back — only return / deplete do). |
| Verification query | `npm run validation:snapshot`: "Allocation sessions" `CLOSED 1`; "Allocation events" `RAW_BAG_OPENED 1` + `RAW_BAG_PARTIAL_CONSUMED 1`; "Inventory bags" QA `IN_USE 1`. |
| PASS criteria | One closed session with 12 000 consumed. |
| FAIL criteria | Two open sessions (concurrent OPEN should be partial-unique-blocked); RAW_BAG_PARTIAL_CONSUMED not emitted; quantity mismatch. |
| Evidence | Snapshot diff. |

### TEST E — Return same bag to stock

| Field | Value |
|---|---|
| Human action | TEST D closed the session. To exercise return, open a NEW session against the same bag (any product). Then on that session → "Return to stock" → enter remaining qty (e.g. `8000`, since 20000 declared − 12000 already consumed in TEST D). Submit. |
| Expected UI | After return: session disappears from section 1. Bag re-appears in the available-bags dropdown of section 2. |
| Expected DB result | `raw_bag_allocation_sessions` count: 1 CLOSED (from D) + 1 RETURNED_TO_STOCK (from E). `raw_bag_allocation_events` `RAW_BAG_OPENED` = 2 (one new from this test), `RAW_BAG_RETURNED_TO_STOCK` = 1. `inventory_bags.status` for the bulk bag = `AVAILABLE`. |
| Verification query | `npm run validation:snapshot`: sessions `CLOSED=1, RETURNED_TO_STOCK=1`; events include `RAW_BAG_RETURNED_TO_STOCK 1`. |
| PASS criteria | Bag back to AVAILABLE; one RETURNED_TO_STOCK event; ledger balances. |
| FAIL criteria | Bag still IN_USE; duplicate sessions; missing event. |
| Evidence | Snapshot diff. |

### TEST F — Reopen same bag for bottle product

| Field | Value |
|---|---|
| Human action | Section 2 "Open a new session" → same bag → product `QA_TEST_BOTTLE_A` → submit. Then close with consumed = `5000` (just to register a non-zero value for the bottle leg). |
| Expected UI | Session card shows `QA_TEST_BOTTLE_A` as the product. After close: section 1 empties for that bag. |
| Expected DB result | sessions: 1 CLOSED-from-D + 1 RETURNED-from-E + 1 CLOSED-from-F = 3 rows for the same `inventory_bag_id`. `raw_bag_allocation_events` `RAW_BAG_OPENED` = 3, `RAW_BAG_PARTIAL_CONSUMED` = 2 (D and F), `RAW_BAG_RETURNED_TO_STOCK` = 1. |
| Verification query | `npm run validation:snapshot`: sessions `CLOSED=2, RETURNED_TO_STOCK=1`; "PO reconciliation summary" `closed=3` for QA PO. |
| PASS criteria | Same `inventory_bag_id` shows 3 distinct allocation_session rows (D, E, F). PO split usage will report both card and bottle products with bagsTouched = 1 each. |
| FAIL criteria | Duplicate inventory_bag_id created; sessions belong to different bags; bottle product not visible. |
| Evidence | Snapshot diff + admin `/po-reconciliation/<QA-PO-id>` section 5. |

### TEST G — Deplete bag

| Field | Value |
|---|---|
| Human action | Open a NEW session against the same bag → close it → then on that session use "Mark bag depleted". Or alternately use a different bag for clarity. |
| Expected UI | Session disappears; bag does NOT re-appear in available list; appears only in any "depleted" surfaces. |
| Expected DB result | Session count for that bag: prior 3 (or 4) + 1 DEPLETED. `raw_bag_allocation_events` `RAW_BAG_DEPLETED` = 1. `inventory_bags.status` = `EMPTIED`. |
| Verification query | `npm run validation:snapshot`: sessions `DEPLETED=1`; events `RAW_BAG_DEPLETED 1`; "Inventory bags" QA `EMPTIED=1`. |
| PASS criteria | Bag in EMPTIED; can't be reopened; ledger still balances. |
| FAIL criteria | Bag still AVAILABLE/IN_USE; reopened successfully (should be blocked). |
| Evidence | Snapshot diff. |

### TEST H — Variety pack multi-component allocation

| Field | Value |
|---|---|
| Human action | 1. Open `/floor/<Blister Room token>/variety-pack`. 2. Pick `QA_TEST_VARIETY_3PK` from the product dropdown. 3. Three slots render: `FLAVOR_A`, `FLAVOR_B`, `FLAVOR_C`. For each slot, the bag dropdown only shows bags whose tablet_type matches that flavor. 4. Open each slot with the matching flavor bag. 5. Close each slot with consumed = `400` (= 100 finished × 4 per role). |
| Expected UI | After step 4: each slot's badge flips EMPTY → FILLED. After step 5: each slot's open session moves to closed. |
| Expected DB result | `raw_bag_allocation_sessions` for `QA_TEST_VARIETY_3PK`: 3 rows with `component_role` = FLAVOR_A / FLAVOR_B / FLAVOR_C. After closing: all 3 in `CLOSED` status. `raw_bag_allocation_events` `RAW_BAG_PARTIAL_CONSUMED` += 3, each tagged with the role in payload. |
| Verification query | `npm run validation:snapshot`: "Variety pack products" row for QA shows `open=0, closed=3, consume=3` after the test sequence. |
| PASS criteria | 3 sessions, 3 distinct roles, each tied to the right tablet_type. UI did NOT offer a wrong-flavor bag for any slot. |
| FAIL criteria | A slot accepts a wrong-flavor bag; component_role missing on session; duplicate sessions for the same role. |
| Evidence | Snapshot + UI screenshot of the slot picker showing role-filtered bags. |

### TEST I — PO reconciliation report

| Field | Value |
|---|---|
| Human action | 1. Open `/po-reconciliation` (admin). 2. Click into `QA_TEST_PO_VAL_0001`. 3. Walk through all 8 sections. 4. Click "Download CSV" on the detail page. |
| Expected UI | All 8 sections populate. Section 5 (Raw bag allocation ledger) lists the QA bags with their lifecycle, including the bulk bag's three sessions across card + bottle. Section 5b (PO split usage by product) shows two rows: card and bottle. Section 6 (Vendor dispute / audit packet) reads in neutral language — no "shortage" / "scrap" / "spoilage" wording. Section 7 (Supplier settlement) shows `MANUAL_REVIEW` if combined confidence is LOW or MISSING (likely, since some bags will have OPEN allocations or unresolved counts). |
| Expected DB result | The SQL behind `derivePoRawMaterialReconciliation` returns non-empty allocation + product allocation for the QA PO. CSV file downloads successfully and contains every section. |
| Verification query | `npm run validation:snapshot` "PO reconciliation summary" shows the QA PO with `bags=4, vendor=50000, weight=25000g, lots=0, open=N, closed=M`. |
| PASS criteria | Every section renders with no "—" where data should exist. Card and bottle both present in section 5b. Settlement source is one of `VENDOR_DECLARED`, `ACCOUNTED_OUTPUT`, or `MANUAL_REVIEW` per the rules. |
| FAIL criteria | Any section says "Vendor shortage", "spoilage", "scrap" without explicit policy. Section 7 asserts a payable quantity in spite of LOW confidence. CSV download fails. |
| Evidence | The downloaded CSV + screenshot of section 6 narrative. |

### TEST J — Material panels after events

| Field | Value |
|---|---|
| Human action | After completing TESTS B–H (so events exist), visit `/packaging-inventory`, `/active-rolls`, `/roll-variance`, `/material-alerts`. |
| Expected UI | Packaging inventory: 2 roll lots with their post-event status (mounted ones IN_USE, depleted-via-unmount might be DEPLETED). Active rolls: only currently mounted rolls (could be 0, 1, or 2 depending on whether you unmounted in TEST C). Roll variance: rolls with weigh-back show `actual_used_grams` and a variance %; rolls without weigh-back show `—` for actual and confidence MEDIUM. Material alerts: any par-level shortages visible; rolls running low. |
| Expected DB result | All read models reflect the events emitted. After `npm run rebuild:read-models`, counts match. |
| Verification query | `npm run validation:snapshot` "Read models" section. |
| PASS criteria | Estimated and actual columns are clearly labeled and not mixed. Empty states are honest ("No active rolls mounted" if 0; "No rolls tracked yet" if no roll-usage events). |
| FAIL criteria | Roll variance reports actual without a weigh-back. Alert page reports a fake shortage. Active-rolls page lists rolls that have been unmounted. |
| Evidence | Screenshots of each panel. |

### TEST K — Negative / missing-state checks

For each negative case, expect the UI / server to refuse cleanly. No 500s; clear error message.

| K# | Try | Expected response |
|---|---|---|
| K1 | Open same bag in TWO sessions concurrently | Second open fails with "Bag already has an open allocation. Close it first." (server-action error). Snapshot's "One OPEN session per bag" hint stays PASS. |
| K2 | Mount same roll twice | Second mount fails with "Roll is already mounted — unmount it first." |
| K3 | Mount second PVC on same machine | Second mount fails with "A PVC roll (...) is already mounted on this machine. Unmount it first." |
| K4 | Mark a CLOSED/RETURNED session as depleted | Server returns "Session is CLOSED — cannot deplete." or similar; no event written. |
| K5 | Open a variety pack slot without a matching component item | Slot says "No AVAILABLE bags match this component" and the picker is suppressed for that slot. |
| K6 | Submit adjustment without a reason | Server-side schema rejects. |

If any negative case results in a 500 error, capture the digest from logs (`docker compose logs app --tail=400 | grep -i digest`) and stop. Otherwise mark each PASS.

---

## 5. After the run

When all 11 tests are complete:

```bash
# AUDITOR: final snapshot for the report
ALLOW_STAGING_QA_DATA=true npm run validation:snapshot > /tmp/snapshot-final.txt

# AUDITOR: final auth route smoke
ALLOW_STAGING_QA_DATA=true tsx scripts/smoke-authenticated-routes.ts

# Rebuild read models so every panel reflects the post-test state
npm run rebuild:read-models
```

Then write the final report covering:

- Tests completed
- Pass / fail per test
- Screenshots / route evidence
- DB event counts before / after (capture from snapshots)
- Roll status changes
- Raw bag status changes
- Allocation ledger result
- PO reconciliation result
- Material panel result
- Server errors (if any)
- Employee UI confusion points
- Data issues found
- Blocking bugs
- Recommended fixes before more testing

---

## 6. Reset for the next run

When the test cycle is complete and you want to reset the bed:

```bash
ALLOW_STAGING_QA_DATA=true npm run staging:cleanup
ALLOW_STAGING_QA_DATA=true npm run staging:seed -- --rotate-tokens
ALLOW_STAGING_QA_DATA=true npm run validation:snapshot
```

The cleanup is FK-safe and removes only `QA_TEST_*` records and their descendants. The seed re-creates everything. The post-run snapshot should match TEST A's pre-state.

---

## 7. Stop conditions

The auditor halts the run if any of these triggers fire:

1. A snapshot shows duplicate OPEN sessions for one bag (DB unique violated).
2. A `MATERIAL_CONSUMED_ESTIMATED` event appears with no preceding `ROLL_MOUNTED` for the same lot.
3. A `MATERIAL_CONSUMED_ACTUAL` event appears (H.x3 should never emit this).
4. The /po-reconciliation page renders the word "shortage" or asserts a payable quantity at LOW/MISSING confidence.
5. A 500 or unhandled server exception surfaces in `docker compose logs app`.
6. A bag re-appears as AVAILABLE after being marked DEPLETED.
7. A read-model rebuild loses any of the existing 910 reconciliation rows.

In every case: stop, capture the snapshot + log excerpt, and report. Do not continue past a bad signal.
