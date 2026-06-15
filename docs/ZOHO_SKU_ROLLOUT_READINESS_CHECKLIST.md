# Zoho SKU rollout readiness checklist

Use this checklist **before** enabling live bag-finish receive or production-output commit for any **new SKU**. Every item must be satisfied or explicitly waived by PM with written rationale.

**Policy:** Preview first. One PM-approved commit window per action. Close gates immediately. Revoke commit capability after the window.

---

## A. Zoho master data

| # | Requirement | Verify | FIX Relax pilot ref |
|---|-------------|--------|---------------------|
| A1 | Raw tablet item exists in Zoho Inventory | Item ID resolvable; active | `5254962000001258058` |
| A2 | Packaging item exists (mylar/foil/etc.) | Item ID resolvable; active | `5254962000000679541` |
| A3 | Unit composite item exists | Composite ID on product | `5254962000001258190` |
| A4 | Composite BOM is correct | Inspect via Zoho / integration inspect | 1 tablet + 1 bag per unit |
| A5 | Composite is **active** | Not inactive/archived | Confirmed pre-pilot |
| A6 | `combo_type` is **assembly** (not just bundle label) | Zoho item metadata | Assembly path used |
| A7 | Batch tracking expectations documented | Per component `track_batch_number` | FIX Relax: **not** batch-tracked |
| A8 | Family registry maps raw PO line → finished unit family | `product_family.match=true` in preview | `fix_relax_raw` → `fix_relax_finished_unit` |
| A9 | Packaging component accepted in BOM | Appears in composite line items | Mylar bag line present |

---

## B. Luma product data

| # | Requirement | Verify |
|---|-------------|--------|
| B1 | `tablets_per_unit` populated | Product master |
| B2 | `default_shelf_life_days` populated | Product master |
| B3 | `displays_per_case` populated if case output used | Product master |
| B4 | `product_family` populated | Matches Zoho family registry |
| B5 | `zoho_item_id_unit` populated | Same as unit composite |
| B6 | Packaging structure / BOM spec populated | `product_packaging_specs` or pilot contract module |
| B7 | QR / floor card exists for workflow | Station can scan bag |
| B8 | Finished-lot auto-issue rules satisfied | Backlog/eligibility green or PM override |

For SKU-specific pilot contracts (normalized BOM overrides), add a `lib/zoho/v1206-*-pilot-contract.ts` only when generic resolution is insufficient — then wire through `sourceAllocationBuildOptsForSku()`.

---

## C. Bag receive prerequisites

| # | Requirement | Verify |
|---|-------------|--------|
| C1 | Bag linked to `purchaseorder_id` | Zoho PO ID on PO line |
| C2 | Bag linked to `purchaseorder_line_item_id` | Zoho line item ID |
| C3 | Bag linked to `raw_item_id` | Tablet type Zoho item |
| C4 | Human lot number present | Batch/lot on bag |
| C5 | **Declared physical quantity** exists | `declared_pill_count` — **not** consumed qty |
| C6 | Receive date exists | Intake/receive metadata |
| C7 | No existing committed receive row for this bag | `zoho_raw_bag_receives` not COMMITTED duplicate |
| C8 | Idempotency key deterministic | `luma-bag-finish-receive:{inventory_bag_id}` |
| C9 | Bag-finish eligibility policy satisfied | AVAILABLE bag + closed allocation where required |

**Critical:** Receive **full declared bag quantity** (e.g. 500), never the smaller output/consumed quantity (e.g. 10).

---

## D. Production-output prerequisites

| # | Requirement | Verify |
|---|-------------|--------|
| D1 | Finished lot exists | `finished_lots` row |
| D2 | Allocation session **closed** | Ledger consumed qty frozen |
| D3 | Source receipt proof `RECEIVED_BY_LUMA` | Durable `zoho_raw_bag_receives` row with PR ID |
| D4 | Normalized BOM quantities resolve | No `BOM_QUANTITY_PENDING` |
| D5 | Product family matches PO/source family | Preview `product_family.match=true` |
| D6 | `preview_valid=true` | HTTP 200, empty blockers |
| D7 | Planned sequence has **no purchase-receive step** | `planned_commit_sequence=["unit_assembly"]` when bag already received |
| D8 | Component consumption math correct | raw × units, packaging × units per BOM |
| D9 | Operation idempotency key stable | `luma-production-output:{finishedLotId}` |
| D10 | No duplicate COMMITTED op for lot | One consolidated op per finished lot |

---

## E. Live-write gate policy

| # | Requirement | Action |
|---|-------------|--------|
| E1 | Preview completed and PM-reviewed | Save preview response / blockers |
| E2 | **PM approval** for each commit window | Written approval with IDs and quantities |
| E3 | Open **only** the gate needed for **one** action | Receive **or** output — not both unless PM says so |
| E4 | Close gates **immediately** after attempt | Success or failure |
| E5 | Revoke `luma.production_output.commit` / `luma.raw_intake.commit` after window | DB capability `disabled` |
| E6 | Verify commit returns **403** / guard after closure | Smoke with gate off |
| E7 | `ENABLE_LIVE_INVENTORY_WRITES=false` on Zoho after window | `.env` on CT 9503 |
| E8 | Luma commit env flags `false` | `/etc/luma/.env` |

### Gate reference

| Layer | Receive | Production output |
|-------|---------|-------------------|
| Luma env | `ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED` | `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED` |
| Zoho env | `ENABLE_LIVE_INVENTORY_WRITES` | same |
| Zoho capability | `luma.raw_intake.commit` | `luma.production_output.commit` |
| Preview (stay on) | `luma.raw_intake.preview` | `luma.production_output.preview` |

---

## Sign-off template (per SKU)

```
SKU: _______________
PM approval date: _______________
Bag ID (if receive): _______________
Finished lot ID (if output): _______________
Expected PR qty (physical): _______________
Expected assembly qty: _______________
Preview idempotency / op ID: _______________
Window opened (UTC): _______________
Window closed (UTC): _______________
Result: SUCCESS / FAILED_SAFE / BLOCKED
```
